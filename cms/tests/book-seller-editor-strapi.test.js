import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const cmsRoot = path.join(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ikpk-book-editor-strapi-'));
let app, base, editorJwt, multiRoleJwt, contentAdminJwt, superAdminJwt, outsideRoleJwt, pageDocumentId, otherDocumentId;

async function login(email, password) {
  const response = await fetch(`${base}/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text).data.accessToken;
}
async function call(method, route, token, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

before(async () => {
  execFileSync(path.join(cmsRoot, 'node_modules/.bin/tsc'), ['--pretty', 'false', '--incremental', 'false'], { cwd: cmsRoot, stdio: 'inherit' });
  Object.assign(process.env, {
    NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '0', STRAPI_TELEMETRY_DISABLED: 'true',
    APP_KEYS: 'book-editor-one,book-editor-two', ADMIN_JWT_SECRET: 'book-editor-admin-jwt',
    JWT_SECRET: 'book-editor-users-jwt', API_TOKEN_SALT: 'book-editor-api-token',
    TRANSFER_TOKEN_SALT: 'book-editor-transfer-token', ENCRYPTION_KEY: 'book-editor-encryption',
    DATABASE_CLIENT: 'sqlite', DATABASE_FILENAME: path.join(work, 'data.db'),
  });
  for (const key of ['CMS_TOKEN', 'CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP']) delete process.env[key];
  const { createStrapi } = require('@strapi/strapi');
  app = createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
  app.dirs.static.public = path.join(work, 'public');
  fs.mkdirSync(path.join(work, 'public/uploads'), { recursive: true });
  await app.load();
  app.config.set('admin.autoOpen', false);
  await app.listen();
  base = `http://127.0.0.1:${app.server.httpServer.address().port}`;

  const pages = app.documents('api::page.page');
  const seed = {
    title: 'Книги и учебные материалы', slug: 'knigi-i-uchebnye-materialy', legacy_id: 'knigi-i-uchebnye-materialy',
    body: 'Исходный опубликованный текст', seo: { seo_title: 'Исходный SEO', seo_description: 'SEO описание' },
  };
  const created = await pages.create({ status: 'published', data: seed });
  pageDocumentId = created.documentId;
  const other = await pages.create({ status: 'published', data: {
    title: 'Другая страница', slug: 'unrelated-book-editor-test', legacy_id: 'unrelated-book-editor-test',
    body: 'Не менять', seo: { seo_title: 'Чужое SEO', seo_description: 'Чужое описание' },
  } });
  otherDocumentId = other.documentId;

  const editorRole = await app.service('admin::role').findOne({ code: 'strapi-editor' });
  const adminRole = await app.service('admin::role').findOne({ code: 'content-admin' });
  const superAdminRole = await app.service('admin::role').findOne({ code: 'strapi-super-admin' })
    ?? await app.service('admin::role').create({ name: 'Super admin test', code: 'strapi-super-admin' });
  const outsideRole = await app.service('admin::role').create({ name: 'Other content role', code: 'other-content-role' });
  const credentials = async (name, roles) => {
    const email = `${name}@example.invalid`, password = `Book-editor-test-${name}-password-2026`;
    await app.service('admin::user').create({ email, password, firstname: 'Book', lastname: name, isActive: true, roles: roles.map((role) => role.id) });
    return { email, password };
  };
  const editor = await credentials('editor', [editorRole]);
  const multi = await credentials('multi', [editorRole, adminRole]);
  const contentAdmin = await credentials('content-admin-only', [adminRole]);
  const superAdmin = await credentials('super-admin', [superAdminRole]);
  const outside = await credentials('outside', [outsideRole]);
  editorJwt = await login(editor.email, editor.password);
  multiRoleJwt = await login(multi.email, multi.password);
  contentAdminJwt = await login(contentAdmin.email, contentAdmin.password);
  superAdminJwt = await login(superAdmin.email, superAdmin.password);
  outsideRoleJwt = await login(outside.email, outside.password);
}, { timeout: 360_000 });

after(async () => {
  await app?.destroy();
  fs.rmSync(work, { recursive: true, force: true });
});

test('real Strapi narrow form saves a draft, detects stale writes and publishes only body', async () => {
  const read = await call('GET', '/admin/site-books', editorJwt);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.draft, 'Исходный опубликованный текст');
  assert.equal(read.body.published, 'Исходный опубликованный текст');
  const noOpPublish = await call('POST', '/admin/site-books/publish', editorJwt,
    { body: read.body.published }, { 'if-match': `"${read.body.revision}"` });
  assert.equal(noOpPublish.status, 200, noOpPublish.text);
  const initialVersions = await app.db.query('api::page.page').findMany({
    where: { documentId: pageDocumentId }, select: ['id', 'publishedAt'],
  });
  const initialTimes = await app.db.connection('pages').select('id', 'updated_at').whereIn('id', initialVersions.map(({ id }) => id));
  assert.equal(initialTimes[0].updated_at, initialTimes[1].updated_at,
    'matching draft and published metadata should not manufacture a pending draft');

  const draft = await call('PUT', '/admin/site-books/draft', editorJwt, { body: 'Черновик ИП Первый & Партнёры <script>текст</script>' }, {
    'if-match': `"${noOpPublish.body.revision}"`,
  });
  assert.equal(draft.status, 200, draft.text);
  assert.equal(draft.body.published, 'Исходный опубликованный текст');
  assert.equal((await app.documents('api::page.page').findOne({ documentId: pageDocumentId, status: 'published' })).body, 'Исходный опубликованный текст');
  assert.equal((await app.documents('api::page.page').findOne({ documentId: pageDocumentId, status: 'draft' })).body, 'Черновик ИП Первый & Партнёры <script>текст</script>');

  const conflict = await call('POST', '/admin/site-books/publish', editorJwt, { body: 'Устаревшая запись' }, {
    'if-match': `"${read.body.revision}"`,
  });
  assert.equal(conflict.status, 409);
  await app.documents('api::page.page').update({ documentId: pageDocumentId, status: 'draft', data: {
    title: 'Редакторский заголовок черновика',
    seo: { seo_title: 'SEO черновика', seo_description: 'Описание черновика' },
  } });
  const beforePublish = await call('GET', '/admin/site-books', editorJwt);
  const publish = await call('POST', '/admin/site-books/publish', editorJwt, { body: draft.body.draft }, {
    'if-match': `"${beforePublish.body.revision}"`,
  });
  assert.equal(publish.status, 200, publish.text);
  for (const status of ['draft', 'published']) {
    const page = await app.documents('api::page.page').findOne({ documentId: pageDocumentId, status, populate: ['seo'] });
    assert.equal(page.body, draft.body.draft);
    assert.equal(page.title, status === 'draft' ? 'Редакторский заголовок черновика' : 'Книги и учебные материалы');
    assert.equal(page.seo.seo_title, status === 'draft' ? 'SEO черновика' : 'Исходный SEO');
  }
  const updated = await app.db.query('api::page.page').findMany({ where: { documentId: pageDocumentId }, select: ['id', 'publishedAt'] });
  const raw = await app.db.connection('pages').select('id', 'updated_at').whereIn('id', updated.map(({ id }) => id));
  const draftTime = new Date(raw.find(({ id }) => !updated.find((row) => row.id === id).publishedAt)?.updated_at).getTime();
  const publishedTime = new Date(raw.find(({ id }) => updated.find((row) => row.id === id).publishedAt)?.updated_at).getTime();
  assert.ok(draftTime > publishedTime, 'unpublished title and SEO must keep the draft newer than publication');
  const rejected = await call('POST', '/admin/site-books/publish', editorJwt, { body: 'Подмена', slug: 'unrelated-book-editor-test' }, {
    'if-match': `"${publish.body.revision}"`,
  });
  assert.equal(rejected.status, 400);
  assert.equal((await app.documents('api::page.page').findOne({ documentId: otherDocumentId, status: 'published' })).body, 'Не менять');
});

test('real Strapi enforces refresh capability boundaries by stored roles, including multiple roles', async () => {
  const status = await call('GET', '/admin/site-refresh', editorJwt);
  assert.equal(status.status, 200, status.text);
  assert.equal(status.body.canRestore, false);
  for (const action of [{ action: 'restore' }, { action: 'cancel-starting', token: 'a'.repeat(32), ownerPid: process.pid }]) {
    const denied = await call('POST', '/admin/site-refresh', editorJwt, action);
    assert.equal(denied.status, 403);
  }
  const multi = await call('GET', '/admin/site-refresh', multiRoleJwt);
  assert.equal(multi.status, 200, multi.text);
  assert.equal(multi.body.canRestore, true);
  const post = await call('POST', '/admin/site-refresh', editorJwt, { action: 'invalid' });
  assert.equal(post.status, 400);
  assert.equal(post.body.canRestore, false);
});

test('Pages-menu server capability permits the three editor roles and rejects an unrelated role', async () => {
  for (const token of [editorJwt, contentAdminJwt, superAdminJwt]) {
    const response = await call('GET', '/admin/site-books', token);
    assert.equal(response.status, 200, response.text);
  }
  const refused = await call('GET', '/admin/site-books', outsideRoleJwt);
  assert.equal(refused.status, 403);
});

test('clean import creates the seed through Strapi and a replay preserves editor draft and publication', async () => {
  await app.documents('api::page.page').delete({ documentId: pageDocumentId });
  await app.db.query('api::address-history.address-history').deleteMany({ where: { address: '/knigi-i-uchebnye-materialy' } });
  const token = await app.service('admin::api-token').create({
    name: 'book-import-test', description: 'test import', type: 'full-access', kind: 'content-api', lifespan: null,
  });
  const transfer = path.join(work, 'transfer');
  const bundleDir = path.join(work, 'scripts');
  fs.mkdirSync(transfer, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.mkdirSync(path.join(work, 'migration'), { recursive: true });
  fs.writeFileSync(path.join(work, 'migration/legacy-transfer-dir.json'), JSON.stringify({ relativeDir: 'transfer' }));
  for (const name of ['articles', 'course_groups', 'institutes', 'news', 'promotions', 'schedule_entries', 'seminars', 'static_pages', 'teachers', 'video_playlists']) {
    fs.writeFileSync(path.join(transfer, `${name}.json`), '[]\n');
  }
  const importer = path.join(bundleDir, 'import.mjs');
  execFileSync(path.join(cmsRoot, 'node_modules/.bin/esbuild'), [
    path.join(cmsRoot, '..', 'scripts/import.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${importer}`,
  ], { cwd: cmsRoot, stdio: 'inherit' });
  fs.symlinkSync(path.join(cmsRoot, 'node_modules'), path.join(work, 'node_modules'));
  const runImport = async () => {
    try {
      await execFileAsync(process.execPath, [importer, '--skip-media'], {
        cwd: work, timeout: 90_000, env: { ...process.env, STRAPI_URL: base, STRAPI_API_TOKEN: token.accessKey },
      });
    } catch (error) {
      throw new Error(`clean importer failed: ${error.stderr || error.message}`, { cause: error });
    }
  };
  await runImport();
  const pages = app.documents('api::page.page');
  const seeded = await app.db.query('api::page.page').findMany({ where: { slug: 'knigi-i-uchebnye-materialy' }, select: ['id', 'documentId', 'publishedAt', 'body'] });
  assert.equal(seeded.length, 2);
  const published = await pages.findOne({ documentId: seeded[0].documentId, status: 'published', populate: ['seo'] });
  const draft = await pages.findOne({ documentId: seeded[0].documentId, status: 'draft', populate: ['seo'] });
  assert.ok(published, `clean import must create published version: ${JSON.stringify(seeded)}`);
  assert.equal(published.body, 'Издательский дом ИКПК выпускает книги и учебные материалы. Продавец книг — ИП Тучанфа В.А.');
  assert.equal(draft.body, published.body);
  pageDocumentId = seeded[0].documentId;

  const view = await call('GET', '/admin/site-books', editorJwt);
  const draftEdit = await call('PUT', '/admin/site-books/draft', editorJwt, { body: 'Редакторский черновик' }, { 'if-match': `"${view.body.revision}"` });
  assert.equal(draftEdit.status, 200, draftEdit.text);
  await runImport();
  assert.equal((await pages.findOne({ documentId: pageDocumentId, status: 'published' })).body, published.body);
  assert.equal((await pages.findOne({ documentId: pageDocumentId, status: 'draft' })).body, 'Редакторский черновик');
});
