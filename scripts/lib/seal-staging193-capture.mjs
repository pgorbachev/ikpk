import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readPublishedSqlite } from './server-capture-sqlite.mjs';

const [directoryArg, operationId, sourceSha, schemaRootArg, profile = 'staging194', runIdRaw, attemptRaw] = process.argv.slice(2);
if (!directoryArg || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId ?? '')
    || !/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !schemaRootArg
    || !['staging194', 'initial-prod', 'production-static'].includes(profile)
    || (profile === 'initial-prod' && (operationId !== 'initial-prod-20261019-A-01'
        || !/^[1-9][0-9]*$/.test(runIdRaw ?? '') || !/^[1-9][0-9]*$/.test(attemptRaw ?? '')))) {
  throw new Error('usage: node seal-staging193-capture.mjs BUNDLE OPERATION_ID SOURCE_SHA SCHEMA_ROOT');
}
const directory = resolve(directoryArg);
const schemaRoot = resolve(schemaRootArg);
const rootStat = lstatSync(directory);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('capture directory must be a real directory');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function readSealable(relative) {
  if (relative.startsWith('/') || relative.split(/[\\/]/).includes('..')) throw new Error('unsafe capture path');
  const path = resolve(directory, relative);
  if (!path.startsWith(`${directory}${sep}`)) throw new Error('capture path escaped bundle');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`capture member is not a regular file: ${relative}`);
  return { path, bytes: readFileSync(path), stat };
}
const database = readSealable('database.sqlite');
const mediaFile = readSealable('media-manifest.json');
const mediaDocument = JSON.parse(mediaFile.bytes.toString('utf8'));
const media = Array.isArray(mediaDocument) ? mediaDocument : mediaDocument?.media;
if (!Array.isArray(media)) throw new Error('media manifest must be a JSON array');
const knownUrls = new Set();
for (const item of media) {
  if (!item || typeof item.url !== 'string' || !/^\/(uploads|media)\/[A-Za-z0-9._~!$&()*+,;=@%/-]+$/.test(item.url)
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || knownUrls.has(item.url)) {
    throw new Error('media entry malformed or duplicated');
  }
  knownUrls.add(item.url);
  const copied = readSealable(item.file);
  if (hash(copied.bytes) !== item.sha256 || copied.bytes.length !== item.size) throw new Error(`media copy changed: ${item.url}`);
}
const projected = readPublishedSqlite(database.path, schemaRoot);
const referenced = new Set();
function findMedia(value) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/(?:^|["'])((?:\/uploads\/|\/media\/)[A-Za-z0-9._~!$&()*+,;=@%/-]+)/g)) referenced.add(match[1]);
  } else if (Array.isArray(value)) value.forEach(findMedia);
  else if (value && typeof value === 'object') Object.values(value).forEach(findMedia);
}
findMedia(projected.collections);
for (const url of referenced) if (!knownUrls.has(url)) throw new Error(`media referenced by database is missing: ${url}`);
const manifest = {
  version: 1,
  ...(profile !== 'staging194' ? { profile, host: '89.111.184.196', siteUrl: 'https://ikpk.su',
    sourceId: 'initial-prod-server-db', runId: Number(runIdRaw), attempt: Number(attemptRaw) }
    : { host: '194.226.99.10', siteUrl: 'https://194.226.99.10', sourceId: 'demo193-cms' }),
  operationId,
  sourceSha,
  capturedAt: new Date().toISOString(),
  schemaDigest: projected.schemaDigest,
  databaseSha256: hash(database.bytes),
  mediaManifestSha256: hash(mediaFile.bytes),
};
const manifestPath = join(directory, 'manifest.json');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o440 });
function seal(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`capture symlink forbidden: ${path}`);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) seal(join(path, name));
    chmodSync(path, 0o550);
  } else if (stat.isFile() && stat.nlink === 1) chmodSync(path, 0o440);
  else throw new Error(`unsupported capture member: ${path}`);
}
seal(directory);
console.log(JSON.stringify({ operationId, sourceSha, databaseSha256: manifest.databaseSha256,
  schemaDigest: manifest.schemaDigest, mediaCount: media.length }));
