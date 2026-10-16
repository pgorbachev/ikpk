/** Root helper core. Caller owns the existing global publication/migration flock. */
import { createHash } from 'node:crypto';
import { closeSync, openSync, fsyncSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync, realpathSync, renameSync, unlinkSync, chmodSync, chownSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import * as sqlite from 'node:sqlite';
const { DatabaseSync, backup } = sqlite;
import { execFileSync } from 'node:child_process';
import { readPublishedSqlite, schemaContractDigest } from './server-capture-sqlite.mjs';

export const DEMO_BINDING = Object.freeze({ sourcePolicy: 'demo-publication-only', sourceId: 'demo193-cms', host: '193.124.115.99', siteUrl: 'https://staging.ikpk.su', deployMode: 'stand', paymentRole: 'ci' });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => hash(readFileSync(path));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const serviceControl = {
  isActive(unit) {
    // is-active distinguishes active/activating/deactivating/failed; only a stable stopped unit is fenced.
    const output = execFileSync('/usr/bin/systemctl', ['show', '--property=ActiveState,LoadState,KillMode,TriggeredBy', unit], { encoding: 'utf8', timeout: 30_000 });
    const properties = Object.fromEntries(output.trim().split('\n').map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (properties.LoadState !== 'loaded' || !['control-group', 'mixed'].includes(properties.KillMode) || properties.TriggeredBy) throw new Error(`writer unit cannot be fenced safely: ${unit}`);
    const state = properties.ActiveState;
    if (!['active', 'inactive', 'failed'].includes(state)) throw new Error(`writer has transitional state: ${unit}: ${state}`);
    return state === 'active';
  },
  stop: (unit) => execFileSync('/usr/bin/systemctl', ['stop', unit], { timeout: 120_000 }),
  start: (unit) => execFileSync('/usr/bin/systemctl', ['start', unit], { timeout: 120_000 }),
};
export function assertCaptureId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)) throw new Error('invalid capture ID');
}
export function assertConfig(config, { checkPaths = true } = {}) {
  for (const [key, value] of Object.entries(DEMO_BINDING)) if (config[key] !== value) throw new Error(`DEMO source-target binding mismatch: ${key}`);
  for (const key of ['database', 'schemaRoot', 'uploadsRoot', 'staticDocumentsRoot', 'bundleRoot', 'leaseRoot']) {
    if (typeof config[key] !== 'string' || !config[key].startsWith('/') || resolve(config[key]) !== config[key]) throw new Error(`invalid configured path: ${key}`);
    if (checkPaths) assertNoSymlinks(config[key]);
  }
  if (!Array.isArray(config.writerUnits) || !config.writerUnits.length || config.writerUnits.some((u) => !/^[a-zA-Z0-9_-]+\.service$/.test(u)) || new Set(config.writerUnits).size !== config.writerUnits.length) throw new Error('invalid configured writer units');
  if (config.staticDocumentsPrefix !== '/media/') throw new Error('invalid static document prefix');
  const paths = ['database', 'uploadsRoot', 'staticDocumentsRoot', 'bundleRoot', 'leaseRoot'].map((k) => config[k]);
  for (const [i, a] of paths.entries()) for (const b of paths.slice(i + 1)) if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) throw new Error('configured capture paths overlap');
}
export function assertNoSymlinks(path) {
  const full = resolve(path);
  let current = sep;
  for (const part of full.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink forbidden: ${current}`);
  }
}
export function assertProtected(path) {
  assertNoSymlinks(path);
  let current = resolve(path);
  for (;;) {
    const st = lstatSync(current);
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) throw new Error(`protected root-owned path required: ${current}`);
    if (current === sep) break;
    current = dirname(current);
  }
}
function durableWrite(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function tree(root) {
  const entries = [];
  function visit(path, relative) {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error(`symlink forbidden: ${path}`);
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), relative ? `${relative}/${name}` : name);
    else if (st.isFile() && st.nlink === 1) entries.push({ relative, size: st.size, digest: fileHash(path) });
    else throw new Error(`non-regular or hardlinked source file: ${path}`);
  }
  visit(root, ''); return entries;
}
function databaseWitness(path) {
  return [path, `${path}-wal`].map((p) => {
    if (!existsSync(p)) return null;
    assertNoSymlinks(p);
    if (!lstatSync(p).isFile() || lstatSync(p).nlink !== 1) throw new Error('database must be a regular unlinked file');
    return fileHash(p);
  });
}
function localRefs(value, prefix) {
  const refs = new Set();
  function walk(node) {
    if (typeof node === 'string') {
      // All quoted HTML root references as well as fields consisting of a URL.
      for (const m of node.matchAll(/(?:^|["'])((?:\/uploads\/|\/[A-Za-z0-9_-]+\/)[^"'\s<>?#]*)/g)) if (m[1].startsWith('/uploads/') || m[1].startsWith(prefix)) refs.add(m[1]);
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  }
  walk(value); return refs;
}
export function recoverWriters(config, id, { services = serviceControl } = {}) {
  assertConfig(config, { checkPaths: false }); assertCaptureId(id);
  const path = join(config.leaseRoot, `${id}.json`);
  if (!existsSync(path)) return;
  assertNoSymlinks(path);
  const lease = JSON.parse(readFileSync(path, 'utf8'));
  if (lease.version !== 1 || lease.captureId !== id || !Array.isArray(lease.activeUnits) || lease.activeUnits.some((u) => !config.writerUnits.includes(u))) throw new Error('invalid recovery lease');
  const errors = [];
  for (const unit of lease.activeUnits) {
    try { services.start(unit); if (!services.isActive(unit)) throw new Error(`writer did not resume: ${unit}`); } catch (e) { errors.push(e); }
  }
  // Retain the lease when any restart failed; ExecStopPost or an operator can retry it.
  if (errors.length) throw new AggregateError(errors, 'CMS writer recovery failed');
  unlinkSync(path); syncDirectory(config.leaseRoot);
}
export async function captureBundle(config, id, { services = serviceControl } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16) || typeof backup !== 'function') throw new Error('server capture requires Node >=22.16 with node:sqlite backup');
  assertConfig(config); assertCaptureId(id);
  const destination = join(config.bundleRoot, id);
  const temporary = join(config.bundleRoot, `.${id}.partial`);
  if (existsSync(destination) || existsSync(temporary)) throw new Error('capture bundle already exists; refuse overwrite');
  const lease = join(config.leaseRoot, `${id}.json`);
  const activeUnits = config.writerUnits.filter((unit) => services.isActive(unit));
  durableWrite(lease, json({ version: 1, captureId: id, activeUnits }));
  let result;
  try {
    for (const unit of activeUnits) services.stop(unit);
    if (config.writerUnits.some((unit) => services.isActive(unit))) throw new Error('CMS writer fence did not close');
    mkdirSync(temporary, { mode: 0o700 });
    mkdirSync(join(temporary, 'media'), { mode: 0o700 });
    const beforeDb = databaseWitness(config.database);
    const beforeUploads = tree(config.uploadsRoot);
    const beforeDocuments = tree(config.staticDocumentsRoot);
    const source = new DatabaseSync(config.database, { readOnly: true });
    try { await backup(source, join(temporary, 'database.sqlite')); } finally { source.close(); }
    const { collections, schemaDigest } = readPublishedSqlite(join(temporary, 'database.sqlite'), config.schemaRoot);
    const media = [];
    for (const [root, prefix, inventory] of [[config.uploadsRoot, '/uploads/', beforeUploads], [config.staticDocumentsRoot, config.staticDocumentsPrefix, beforeDocuments]]) {
      for (const entry of inventory) {
        if (!/^[A-Za-z0-9._~!$&()*+,;=@%/-]+$/.test(entry.relative) || entry.relative.split('/').some((p) => p === '.' || p === '..')) throw new Error('unsupported media path');
        const bytes = readFileSync(join(root, entry.relative));
        if (hash(bytes) !== entry.digest || bytes.length !== entry.size) throw new Error(`media changed during capture: ${entry.relative}`);
        const target = join(temporary, 'media', `sha256:${entry.digest}`);
        if (!existsSync(target)) durableWrite(target, bytes);
        media.push({ url: `${prefix}${entry.relative}`, verifiedStoredSha256: entry.digest, size: entry.size });
      }
    }
    media.sort((a, b) => a.url.localeCompare(b.url, 'en'));
    const available = new Set(media.map((m) => m.url));
    for (const ref of localRefs(collections, config.staticDocumentsPrefix)) if (!available.has(ref)) throw new Error(`media missing from coherent capture: ${ref}`);
    if (config.writerUnits.some((unit) => services.isActive(unit))) throw new Error('CMS writer fence reopened during capture');
    if (JSON.stringify(beforeDb) !== JSON.stringify(databaseWitness(config.database)) || JSON.stringify(beforeUploads) !== JSON.stringify(tree(config.uploadsRoot)) || JSON.stringify(beforeDocuments) !== JSON.stringify(tree(config.staticDocumentsRoot))) throw new Error('source changed during coherent capture');
    const capturedAt = new Date().toISOString();
    const readback = { version: 1, schemaContractDigest: schemaContractDigest(config.schemaRoot), sourceId: config.sourceId, captureId: id, capturedAt, staticDocumentsPrefix: config.staticDocumentsPrefix, collections, media };
    durableWrite(join(temporary, 'readback.json'), json(readback));
    durableWrite(join(temporary, 'media-manifest.json'), json(media));
    const manifest = { version: 1, ...DEMO_BINDING, captureId: id, capturedAt, schemaDigest, database: { file: 'database.sqlite', sha256: fileHash(join(temporary, 'database.sqlite')) }, readback: { file: 'readback.json', sha256: fileHash(join(temporary, 'readback.json')) }, media: { file: 'media-manifest.json', sha256: fileHash(join(temporary, 'media-manifest.json')) } };
    durableWrite(join(temporary, 'manifest.json'), json(manifest));
    result = { bundleDirectory: destination };
  } finally { recoverWriters(config, id, { services }); }
  // Seal only after CMS recovery. A sealed manifest never claims successful recovery prematurely.
  seal(temporary, config.publisherGid);
  renameSync(temporary, destination); syncDirectory(config.bundleRoot);
  return result;
}
function seal(path, gid) {
  const st = lstatSync(path);
  if (st.isDirectory()) for (const name of readdirSync(path)) seal(join(path, name), gid);
  if (gid !== undefined) chownSync(path, 0, gid);
  chmodSync(path, st.isDirectory() ? 0o550 : 0o440);
}
/**
 * @param {string} bundleDirectory
 * @param {{ requireProtected?: boolean; schemaRoot?: string }} [options]
 */
export function verifyBundle(bundleDirectory, { requireProtected = true, schemaRoot } = {}) {
  if (requireProtected) assertProtected(bundleDirectory);
  else assertNoSymlinks(bundleDirectory);
  const sealedRead = (file) => {
    const path = join(bundleDirectory, file);
    if (requireProtected) assertProtected(path); else assertNoSymlinks(path);
    const st = lstatSync(path);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o222) !== 0) throw new Error('capture bundle is not sealed');
    return readFileSync(path);
  };
  const manifestBytes = sealedRead('manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  for (const [key, value] of Object.entries(DEMO_BINDING)) if (manifest[key] !== value) throw new Error(`capture binding mismatch: ${key}`);
  assertCaptureId(manifest.captureId);
  if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.schemaDigest) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(manifest.capturedAt)) throw new Error('invalid capture manifest');
  const values = {};
  for (const [key, file] of [['database', 'database.sqlite'], ['readback', 'readback.json'], ['media', 'media-manifest.json']]) {
    if (manifest[key]?.file !== file || !/^[a-f0-9]{64}$/.test(manifest[key]?.sha256)) throw new Error('invalid capture manifest identity');
    const bytes = sealedRead(file);
    if (hash(bytes) !== manifest[key].sha256) throw new Error(`capture ${key} digest mismatch`);
    if (key !== 'database') values[key] = JSON.parse(bytes.toString('utf8'));
  }
  const readback = values.readback;
  if (readback.version !== 1 || readback.sourceId !== manifest.sourceId || readback.captureId !== manifest.captureId || readback.capturedAt !== manifest.capturedAt || JSON.stringify(values.media) !== JSON.stringify(readback.media)) throw new Error('capture readback identity mismatch');
  if (!/^[a-f0-9]{64}$/.test(readback.schemaContractDigest) || (schemaRoot && readback.schemaContractDigest !== schemaContractDigest(schemaRoot))) throw new Error('capture schema contract mismatch');
  if (readback.staticDocumentsPrefix !== '/media/') throw new Error('capture static media binding mismatch');
  const urls = new Set();
  for (const media of values.media) {
    if (typeof media.url !== 'string' || !/^\/(uploads|media)\/[A-Za-z0-9._~!$&()*+,;=@%/-]+$/.test(media.url) || urls.has(media.url) || !/^[a-f0-9]{64}$/.test(media.verifiedStoredSha256)) throw new Error('invalid capture media manifest');
    urls.add(media.url);
    const bytes = sealedRead(`media/sha256:${media.verifiedStoredSha256}`);
    if (hash(bytes) !== media.verifiedStoredSha256 || bytes.length !== media.size) throw new Error('capture media digest mismatch');
  }
  return { readback, mediaDirectory: join(bundleDirectory, 'media'), proof: { version: 1, method: 'quiesced-sqlite-backup', sourceId: manifest.sourceId, captureId: manifest.captureId, schemaDigest: manifest.schemaDigest, databaseDigest: manifest.database.sha256, mediaManifestDigest: manifest.media.sha256, bundleDigest: hash(manifestBytes) } };
}
