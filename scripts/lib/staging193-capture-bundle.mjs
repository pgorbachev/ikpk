import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readPublishedSqlite } from './server-capture-sqlite.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/;

function sealedFile(root, relative, expected) {
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.split(/[\\/]/).includes('..')) {
    throw new Error('capture manifest contains an unsafe relative path');
  }
  const base = resolve(root);
  const path = resolve(base, relative);
  if (!path.startsWith(`${base}${sep}`)) throw new Error('capture file escaped its bundle');
  let parent = base;
  for (const part of relative.split(/[\\/]/).slice(0, -1)) {
    parent = join(parent, part);
    if (lstatSync(parent).isSymbolicLink()) throw new Error(`capture path traverses a symlink: ${relative}`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o222) !== 0) throw new Error(`capture file is not sealed: ${relative}`);
  const bytes = readFileSync(path);
  if (expected !== undefined && hash(bytes) !== expected) throw new Error(`capture digest mismatch: ${relative}`);
  return { path, bytes, stat };
}

export function verifyStaging193Bundle(directory, schemaRoot) {
  const root = resolve(directory);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o222) !== 0) throw new Error('capture bundle directory is not sealed');
  const manifestBytes = sealedFile(root, 'manifest.json', undefined).bytes;
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.version !== 1 || manifest.host !== '193.124.115.99' || manifest.sourceId !== 'demo193-cms'
      || !/^[a-f0-9]{40}$/.test(manifest.sourceSha) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.operationId)
      || !SHA.test(manifest.databaseSha256) || !SHA.test(manifest.mediaManifestSha256) || !SHA.test(manifest.schemaDigest)) {
    throw new Error('capture manifest identity is invalid');
  }
  const database = sealedFile(root, 'database.sqlite', manifest.databaseSha256);
  const mediaBytes = sealedFile(root, 'media-manifest.json', manifest.mediaManifestSha256).bytes;
  const mediaDocument = JSON.parse(mediaBytes.toString('utf8'));
  const media = Array.isArray(mediaDocument) ? mediaDocument : mediaDocument?.media;
  if (!Array.isArray(media)) throw new Error('capture media manifest is malformed');
  const mediaByUrl = new Map();
  for (const item of media) {
    if (!item || typeof item.url !== 'string' || !/^\/(uploads|media)\/[A-Za-z0-9._~!$&()*+,;=@%/-]+$/.test(item.url)
        || !SHA.test(item.sha256) || !Number.isSafeInteger(item.size) || mediaByUrl.has(item.url)) {
      throw new Error('capture media entry is malformed or duplicated');
    }
    const copy = sealedFile(root, item.file, item.sha256);
    if (copy.bytes.length !== item.size) throw new Error(`capture media size mismatch: ${item.url}`);
    mediaByUrl.set(item.url, item);
  }
  const projected = readPublishedSqlite(database.path, schemaRoot);
  if (projected.schemaDigest !== manifest.schemaDigest) throw new Error('capture database schema digest mismatch');
  const referenced = new Set();
  const findMedia = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/(?:^|["'])((?:\/uploads\/|\/media\/)[A-Za-z0-9._~!$&()*+,;=@%/-]+)/g)) referenced.add(match[1]);
    } else if (Array.isArray(value)) value.forEach(findMedia);
    else if (value && typeof value === 'object') Object.values(value).forEach(findMedia);
  };
  findMedia(projected.collections);
  for (const url of referenced) if (!mediaByUrl.has(url)) throw new Error(`referenced media missing from sealed capture: ${url}`);
  const proof = {
    version: 1,
    method: 'quiesced-sqlite-backup',
    sourceId: 'demo193-cms',
    captureId: manifest.operationId,
    schemaDigest: manifest.schemaDigest,
    databaseDigest: manifest.databaseSha256,
    mediaManifestDigest: manifest.mediaManifestSha256,
    bundleDigest: hash(manifestBytes),
  };
  return { manifest, readback: { collections: projected.collections, schemaDigest: projected.schemaDigest }, media, proof, directory: root };
}
