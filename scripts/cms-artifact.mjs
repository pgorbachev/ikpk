import { createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';

const fail = (message) => { throw new Error(`cms-artifact-${message}`); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || path.startsWith('/') ||
      /^[A-Za-z]:/.test(path) || Buffer.byteLength(path) > 4096) fail('unsafe-path');
  const directory = path.endsWith('/');
  const clean = directory ? path.slice(0, -1) : path;
  if (!clean || clean.split('/').some((part) => !part || part === '.' || part === '..')) fail('unsafe-path');
  if (clean.split('/').includes('node_modules')) fail('unexpected-node-modules');
  const parts = clean.split('/');
  if (parts[0] === 'public' && parts[1] === 'uploads' &&
      !((directory && parts.length === 2) || (parts.length === 3 && parts[2] === '.gitkeep'))) fail('unexpected-upload-payload');
  return { path: clean, directory };
}
function zipEntries(archive, maxExpandedBytes) {
  if (!Buffer.isBuffer(archive) || archive.length < 22) fail('invalid-zip');
  const first = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= first; offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50 && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) {
      eocd = offset; break;
    }
  }
  if (eocd < 0) fail('invalid-zip');
  const disk = archive.readUInt16LE(eocd + 4), centralDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8), totalEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12), centralOffset = archive.readUInt32LE(eocd + 16);
  if (disk || centralDisk || diskEntries !== totalEntries || totalEntries === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize !== eocd) fail('unsupported-zip-layout');
  const entries = [], names = new Set(); let cursor = centralOffset, expanded = 0;
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== 0x02014b50) fail('invalid-zip-directory');
    const madeBy = archive.readUInt16LE(cursor + 4) >>> 8;
    const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16), compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24), nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30), commentLength = archive.readUInt16LE(cursor + 32);
    const startDisk = archive.readUInt16LE(cursor + 34), external = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42), end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || startDisk || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
        (flags & 1) || (flags & 0x40) || ![0, 8].includes(method)) fail('unsupported-zip-entry');
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    let rawName;
    try { rawName = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { fail('invalid-path-encoding'); }
    if (!(flags & 0x800) && [...nameBytes].some((byte) => byte > 0x7f)) fail('invalid-path-encoding');
    const path = safePath(rawName);
    const unixMode = external >>> 16, fileType = unixMode & 0xf000;
    if (madeBy === 3 && ![0, 0x8000, 0x4000].includes(fileType)) fail('special-zip-entry');
    if (fileType === 0xa000) fail('symlink-entry');
    if (names.has(path.path)) fail('duplicate-path');
    names.add(path.path);
    if (path.directory && (compressedSize || uncompressedSize || checksum)) fail('invalid-directory-entry');
    expanded += uncompressedSize;
    if (!Number.isSafeInteger(expanded) || expanded > maxExpandedBytes) fail('expanded-size-limit');
    entries.push({ ...path, flags, method, checksum, compressedSize, uncompressedSize, localOffset });
    cursor = end;
  }
  if (cursor !== eocd) fail('invalid-zip-directory');
  for (const entry of entries) {
    const { localOffset } = entry;
    if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) fail('invalid-local-header');
    const localFlags = archive.readUInt16LE(localOffset + 6), localMethod = archive.readUInt16LE(localOffset + 8);
    const nameLength = archive.readUInt16LE(localOffset + 26), extraLength = archive.readUInt16LE(localOffset + 28);
    const name = archive.subarray(localOffset + 30, localOffset + 30 + nameLength);
    const centralName = Buffer.from(entry.path + (entry.directory ? '/' : ''));
    if (localFlags !== entry.flags || localMethod !== entry.method || !name.equals(centralName)) fail('local-central-mismatch');
    const start = localOffset + 30 + nameLength + extraLength, end = start + entry.compressedSize;
    if (end > centralOffset) fail('invalid-compressed-range');
    const compressed = archive.subarray(start, end);
    let data;
    try { data = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) }); }
    catch { fail('decompression-failed'); }
    if (data.length !== entry.uncompressedSize || crc32(data) !== entry.checksum) fail('entry-integrity-mismatch');
    entry.data = data;
  }
  return entries;
}

export function validateCmsArtifact({ request, archiveBytes, policy, runtime }) {
  const artifact = request?.cmsArtifact, evidence = request?.sourceCiEvidence;
  if (!policy || !Number.isSafeInteger(policy.maxArchiveBytes) || policy.maxArchiveBytes <= 0 || policy.maxArchiveBytes > bufferConstants.MAX_LENGTH - 8 * 1024 * 1024 - 16 ||
      !Number.isSafeInteger(policy.maxExpandedBytes) || policy.maxExpandedBytes <= 0 || policy.maxExpandedBytes > bufferConstants.MAX_LENGTH ||
      !Number.isSafeInteger(policy.freeSpaceReserveBytes) || policy.freeSpaceReserveBytes <= 0) fail('policy-unconfigured');
  if (!runtime || !Number.isSafeInteger(runtime.nodeMajor) || !/^\d+$/.test(runtime.nodeAbi ?? '') ||
      runtime.nodeMajor !== policy.nodeMajor || runtime.nodeAbi !== policy.nodeAbi) fail('server-runtime-policy-mismatch');
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length === 0 || archiveBytes.length > policy.maxArchiveBytes ||
      !artifact || !Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired !== false ||
      artifact.name !== `release-cms-artifact-${evidence?.runAttempt}` || artifact.size_in_bytes !== archiveBytes.length ||
      artifact.runAttempt !== evidence?.runAttempt || artifact.workflow_run?.id !== evidence?.runId ||
      artifact.workflow_run?.head_sha !== request?.sourceSha || artifact.digest !== `sha256:${sha256(archiveBytes)}`) fail('native-identity-mismatch');
  const entries = zipEntries(archiveBytes, policy.maxExpandedBytes);
  const files = new Map(entries.filter((entry) => !entry.directory).map(({ path, data }) => [path, data]));
  const manifestBytes = files.get('cms-artifact-manifest.json');
  if (!manifestBytes) fail('manifest-missing');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('invalid-manifest'); }
  if (!['main', 'dev'].includes(evidence.sourceRef)) fail('unsupported-source-ref');
  const expectedSource = { sha: request.sourceSha, ref: `refs/heads/${evidence.sourceRef}`, runId: evidence.runId, runAttempt: evidence.runAttempt };
  if (!manifest || manifest.schemaVersion !== 1 || JSON.stringify(manifest.source) !== JSON.stringify(expectedSource) ||
      !manifest.runtime || !Number.isSafeInteger(manifest.runtime.nodeMajor) || !/^\d+$/.test(manifest.runtime.nodeAbi ?? '') ||
      !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.runtime.nodeVersion ?? '') ||
      Number(manifest.runtime.nodeVersion.slice(1).split('.')[0]) !== manifest.runtime.nodeMajor ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.runtime.npmVersion ?? '') ||
      !Array.isArray(manifest.files) || !/^[a-f0-9]{64}$/.test(manifest.packageLockSha256 ?? '')) fail('manifest-identity-mismatch');
  if (manifest.runtime.nodeMajor !== runtime.nodeMajor) fail('runtime-major-mismatch');
  if (manifest.runtime.nodeAbi !== runtime.nodeAbi) fail('runtime-abi-mismatch');
  const expected = new Map();
  for (const item of manifest.files) {
    const safe = safePath(item?.path);
    if (safe.directory || safe.path === 'cms-artifact-manifest.json' || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || expected.has(safe.path)) fail('invalid-inventory');
    expected.set(safe.path, item.sha256);
  }
  if (files.size !== expected.size + 1) fail('inventory-mismatch');
  for (const [path, digest] of expected) {
    const bytes = files.get(path);
    if (!bytes || sha256(bytes) !== digest) fail('inventory-digest-mismatch');
  }
  const lock = files.get('package-lock.json');
  if (!lock || sha256(lock) !== manifest.packageLockSha256) fail('lockfile-mismatch');
  const expectedMigrationsText = files.get('database/.migrations-expected')?.toString('utf8');
  const migrationFiles = [...files.keys()].filter((path) => {
    const relative = path.slice('database/migrations/'.length);
    return path.startsWith('database/migrations/') && !relative.includes('/') && /\.(?:js|sql)$/.test(path);
  });
  if (!/^(?:0|[1-9][0-9]*)\n$/.test(expectedMigrationsText ?? '') ||
      migrationFiles.length !== Number(expectedMigrationsText.trim())) fail('migration-inventory-mismatch');
  for (const path of ['dist/build/index.html', 'dist/src/index.js', 'dist/config/database.js', 'package.json', 'package-lock.json', 'tsconfig.json',
    'database/.migrations-expected', 'database/migrations/target-schema/seminar.json',
    'scripts/run-data-migrations.mjs', 'scripts/audit-data-migration.mjs', 'scripts/audit-schema-snapshot.mjs',
    'scripts/institute-method-author-classification.mjs', 'scripts/normalize-null-documents-state.mjs',
    'src/lib/demo193-source-empty-fields.json']) {
    if (!files.has(path)) fail('required-file-missing');
  }
  return { manifest, entries: files.size };
}
