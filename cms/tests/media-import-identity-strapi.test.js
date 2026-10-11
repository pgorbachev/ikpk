import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const loadCommonjs = createRequire(import.meta.url);
const cmsRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(cmsRoot, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ikpk-media-identity-'));
const dbFile = path.join(work, 'data.db');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

describe('media import identity in Strapi 5.51.2', { timeout: 360000 }, () => {
  /** @type {import('@strapi/strapi').Core.Strapi} */
  let app;
  let base;
  let token;
  let mediaId;
  let uploadPath;

  const call = async (method, url, auth, body, contentType) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      body,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };
  const fullToken = async (strapi) => (await strapi.service('admin::api-token').create({
    name: 'media-identity-test-full-access',
    description: 'media identity integration test',
    type: 'full-access',
    kind: 'content-api',
    lifespan: null,
  })).accessKey;
  const start = async () => {
    const { createStrapi } = loadCommonjs('@strapi/strapi');
    app = createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
    app.dirs.static.public = path.join(work, 'public');
    fs.mkdirSync(path.join(app.dirs.static.public, 'uploads'), { recursive: true });
    await app.load();
    app.config.set('admin.autoOpen', false);
    await app.listen();
    base = `http://127.0.0.1:${process.env.PORT}`;
  };
  const uploadedImage = async (bytes, name) => {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: 'image/png' }), name);
    const response = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await response.text();
    assert.equal(response.status, 201, `upload ${name}: ${response.status} ${text}`);
    const payload = JSON.parse(text);
    const file = Array.isArray(payload) ? payload[0] : payload;
    assert.ok(file?.id, `upload returned no file ID: ${text}`);
    return file;
  };

  before(async () => {
    const [major] = process.versions.node.split('.').map(Number);
    assert.ok(major >= 20 && major <= 24, `Node from cms engines required, got ${process.version}`);
    const env = {
      NODE_ENV: 'development', JWT_SECRET: 'media-identity-test-jwt', HOST: '127.0.0.1',
      PORT: String(await freePort()), APP_KEYS: 'media-identity-one,media-identity-two',
      ADMIN_JWT_SECRET: 'media-identity-admin', API_TOKEN_SALT: 'media-identity-token',
      TRANSFER_TOKEN_SALT: 'media-identity-transfer', ENCRYPTION_KEY: 'media-identity-encryption',
      DATABASE_CLIENT: 'sqlite', DATABASE_FILENAME: dbFile, STRAPI_TELEMETRY_DISABLED: 'true',
    };
    Object.assign(process.env, env);
    delete process.env.CONTENT_ADMIN_EMAIL;
    delete process.env.CONTENT_ADMIN_PASSWORD;
    await start();
    token = await fullToken(app);
  });

  after(async () => {
    if (app) await app.destroy();
    for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('authenticated endpoint fingerprints actual bytes, persists across restart, and detects built-in replace', async () => {
    const source = fs.readFileSync(path.join(repoRoot, 'media-originals/legacy/logo-v2.png'));
    const replacement = fs.readFileSync(path.join(repoRoot, 'media-originals/legacy/logo-upledger-inst.png'));
    const sourceUrl = 'https://ikpk.su/media/legacy/logo-v2.png';
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const uploaded = await uploadedImage(source, 'identity-original.png');
    mediaId = uploaded.id;
    const storedFile = await app.db.query('plugin::upload.file').findOne({ where: { id: mediaId } });
    uploadPath = path.join(app.dirs.static.public, storedFile.url.replace(/^\//, ''));

    const unauthenticated = await call('PUT', `/api/media-import-identities/${mediaId}`, null, JSON.stringify({
      sourceUrl, sourceSha256,
    }), 'application/json');
    assert.equal(unauthenticated.status, 403, unauthenticated.text);

    const saved = await call('PUT', `/api/media-import-identities/${mediaId}`, token, JSON.stringify({
      sourceUrl, sourceSha256,
    }), 'application/json');
    assert.equal(saved.status, 200, saved.text);
    const originalStoredSha = createHash('sha256').update(fs.readFileSync(uploadPath)).digest('hex');
    assert.equal(saved.body.data.storedSha256, originalStoredSha, 'fingerprint comes from local stored bytes');
    let row = await app.db.query('plugin::upload.file').findOne({ where: { id: mediaId } });
    let identity = row.provider_metadata.ikpk_media_import.sources[sourceUrl];
    assert.deepEqual(identity, { version: 1, sha256: sourceSha256, storedSha256: originalStoredSha });
    const stalePrecondition = await call('PUT', `/api/media-import-identities/${mediaId}`, token, JSON.stringify({
      sourceUrl, sourceSha256, expectedStoredSha256: 'f'.repeat(64),
    }), 'application/json');
    assert.equal(stalePrecondition.status, 409, stalePrecondition.text);

    await app.destroy();
    app = undefined;
    await start();
    row = await app.db.query('plugin::upload.file').findOne({ where: { id: mediaId } });
    identity = row.provider_metadata.ikpk_media_import.sources[sourceUrl];
    assert.equal(identity.storedSha256, originalStoredSha, 'SQLite retained the identity after restart');

    const replaceForm = new FormData();
    replaceForm.append('files', new Blob([replacement], { type: 'image/png' }), 'identity-replacement.png');
    const replaced = await fetch(`${base}/api/upload?id=${mediaId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: replaceForm,
    });
    const replacedText = await replaced.text();
    assert.equal(replaced.status, 200, `built-in Strapi replace: ${replaced.status} ${replacedText}`);
    const afterReplace = await app.db.query('plugin::upload.file').findOne({ where: { id: mediaId } });
    const replacementStoredSha = createHash('sha256').update(fs.readFileSync(uploadPath)).digest('hex');
    assert.notEqual(replacementStoredSha, originalStoredSha, 'built-in replace changed stored bytes');
    assert.equal(afterReplace.provider_metadata.ikpk_media_import.sources[sourceUrl].storedSha256, originalStoredSha,
      'Strapi preserved provider_metadata while replacing file bytes');
    assert.notEqual(afterReplace.provider_metadata.ikpk_media_import.sources[sourceUrl].storedSha256, replacementStoredSha,
      'old source identity is now stale and inventory must reject it');
  });
});
