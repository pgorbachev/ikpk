import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const loadCommonjs = createRequire(import.meta.url);
const cmsRoot = path.join(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ikpk-upload-extension-'));
const dbFile = path.join(work, 'data.db');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

describe('upload extension allowlist in Strapi', { timeout: 360000 }, () => {
  /** @type {import('@strapi/strapi').Core.Strapi | undefined} */
  let app;
  let base;
  let token;

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

  before(async () => {
    const [major] = process.versions.node.split('.').map(Number);
    assert.ok(major >= 20 && major <= 24, `Node from cms engines required, got ${process.version}`);
    execFileSync(path.join(cmsRoot, 'node_modules/.bin/tsc'), ['--pretty', 'false'], {
      cwd: cmsRoot,
      stdio: 'inherit',
    });
    Object.assign(process.env, {
      NODE_ENV: 'development',
      JWT_SECRET: 'upload-extension-test-jwt',
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
      APP_KEYS: 'upload-extension-one,upload-extension-two',
      ADMIN_JWT_SECRET: 'upload-extension-admin',
      API_TOKEN_SALT: 'upload-extension-token',
      TRANSFER_TOKEN_SALT: 'upload-extension-transfer',
      ENCRYPTION_KEY: 'upload-extension-encryption',
      DATABASE_CLIENT: 'sqlite',
      DATABASE_FILENAME: dbFile,
      STRAPI_TELEMETRY_DISABLED: 'true',
    });
    delete process.env.CONTENT_ADMIN_EMAIL;
    delete process.env.CONTENT_ADMIN_PASSWORD;
    await start();
    token = (await app.service('admin::api-token').create({
      name: 'upload-extension-test',
      description: 'upload extension integration test',
      type: 'full-access',
      kind: 'content-api',
      lifespan: null,
    })).accessKey;
  });

  after(async () => {
    if (app) await app.destroy();
    for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('png bytes named x.html and declared as octet-stream are rejected', async () => {
    const uploadsDir = path.join(work, 'public', 'uploads');
    const before = walk(uploadsDir);
    const form = new FormData();
    form.append('files', new Blob([PNG], { type: 'application/octet-stream' }), 'x.html');
    const response = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await response.text();
    assert.equal(response.status, 400, text);
    const after = walk(uploadsDir);
    assert.deepEqual(after, before, `upload directory changed:\n${after.join('\n')}`);
    assert.equal(after.some((file) => file.endsWith('.html')), false);

    const accepted = new FormData();
    accepted.append('files', new Blob([PNG], { type: 'application/octet-stream' }), 'x.png');
    const ok = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: accepted,
    });
    assert.equal(ok.status, 201, await ok.text());
  });
});
