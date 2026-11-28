import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const cmsRoot = path.join(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ikpk-form-doc-service-'));
const db = path.join(work, 'cms.sqlite');
const uid = 'api::page.page';
const address = 'https://b24-cbqwqo.bitrix24site.ru/crm_form_k5ush/?telemetry_sign=original';
let app;
let base;
let adminToken;

async function login(email, password) {
  const response = await fetch(`${base}/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text).data.accessToken;
}

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '0', STRAPI_TELEMETRY_DISABLED: 'true',
    APP_KEYS: 'student-form-one,student-form-two', ADMIN_JWT_SECRET: 'student-form-admin',
    JWT_SECRET: 'student-form-jwt', API_TOKEN_SALT: 'student-form-api', TRANSFER_TOKEN_SALT: 'student-form-transfer',
    ENCRYPTION_KEY: 'student-form-encryption', DATABASE_CLIENT: 'sqlite', DATABASE_FILENAME: db,
  });
  for (const key of ['CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN', 'IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP']) delete process.env[key];
  if (!process.env.E2E_REUSE_ADMIN_BUILD) execFileSync(path.join(cmsRoot, 'node_modules/.bin/strapi'), ['build'], {
    cwd: cmsRoot, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
  });
  app = require('@strapi/strapi').createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
  await app.load();
  app.config.set('admin.autoOpen', false);
  await app.listen();
  base = `http://127.0.0.1:${app.server.httpServer.address().port}`;
  const role = await app.service('admin::role').findOne({ code: 'strapi-super-admin' });
  const email = 'student-form-super-admin@example.invalid';
  const password = 'Student-form-super-admin-password-2026';
  await app.service('admin::user').create({ email, password, firstname: 'Student', lastname: 'Form', isActive: true, roles: [role.id] });
  adminToken = await login(email, password);
});

after(async () => {
  await app?.destroy();
  fs.rmSync(work, { recursive: true, force: true });
});

test('real Document Service create, publish and discard preserve the restricted field', async () => {
  const documents = app.documents(uid);
  const entry = await documents.create({ status: 'published', data: {
    title: 'Оплата', slug: 'oplata', legacy_id: 'oplata', body: 'Опубликованный текст',
    student_document_form_url: address,
    seo: { seo_title: 'Оплата', seo_description: 'Описание оплаты' },
  } });
  let [draft, published] = await Promise.all(['draft', 'published'].map(status => documents.findOne({ documentId: entry.documentId, status })));
  assert.equal(draft.student_document_form_url, address);
  assert.equal(published.student_document_form_url, address);

  await documents.update({ documentId: entry.documentId, data: { student_document_form_url: `${address}&draft=unpublished` } });
  draft = await documents.findOne({ documentId: entry.documentId, status: 'draft' });
  assert.notEqual(draft.student_document_form_url, address);
  await documents.discardDraft({ documentId: entry.documentId });
  draft = await documents.findOne({ documentId: entry.documentId, status: 'draft' });
  assert.equal(draft.student_document_form_url, address);

  const next = 'https://b24-cbqwqo.bitrix24site.ru/crm_form_new9/?telemetry_sign=published';
  await documents.update({ documentId: entry.documentId, data: { student_document_form_url: next } });
  await documents.publish({ documentId: entry.documentId });
  [draft, published] = await Promise.all(['draft', 'published'].map(status => documents.findOne({ documentId: entry.documentId, status })));
  assert.equal(draft.student_document_form_url, next);
  assert.equal(published.student_document_form_url, next);

  const configRow = await app.db.connection('strapi_core_store_settings')
    .select('value').where({ key: 'plugin_content_manager_configuration_content_types::api::page.page' }).first();
  assert.ok(configRow, 'Strapi should persist Page Content Manager metadata after schema sync');
  const config = JSON.parse(configRow.value);
  assert.equal(config.metadatas.student_document_form_url.edit.label, 'Ссылка на форму заполнения документов');
  assert.equal(config.metadatas.student_document_form_url.list.label, 'student_document_form_url');
  assert.ok(config.layouts.edit.some(row => row.some(cell => cell.name === 'student_document_form_url' && cell.size === 6)),
    'Strapi should generate a size-6 string field in its edit layout');
  assert.ok(!config.layouts.edit.some(row => row.some(cell => cell.name === 'student_document_form_url' && cell.size === 12)),
    'the synchronized layout must not be replaced by a hand-built size-12 fixture');

  for (const body of [
    { data: { student_document_form_url: 'https://attacker.example/nested' } },
    { data: {}, student_document_form_url: 'https://attacker.example/top-level' },
  ]) {
    const response = await fetch(`${base}/admin/content-manager/collection-types/api::page.page/${entry.documentId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, await response.text());
    const unchanged = await documents.findOne({ documentId: entry.documentId, status: 'published' });
    assert.equal(unchanged.student_document_form_url, next, 'authorized Content Manager bypass must not mutate the stored field');
  }
});

test('direct Page REST writes with the field are rejected by the configured request guard', async () => {
  const payload = JSON.stringify({ data: {
    title: 'Неавторизованная оплата', slug: 'unauthorized-oplata', legacy_id: 'unauthorized-oplata',
    student_document_form_url: address,
  } });
  for (const [url, method] of [[`${base}/api/pages`, 'POST'],
    [`${base}/admin/content-manager/collection-types/api::page.page/unauthorized-oplata`, 'PUT']]) {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: payload });
    assert.equal(response.status, 400, `${method} ${url}`);
    assert.match(await response.text(), /student_document_form_url/);
  }
});
