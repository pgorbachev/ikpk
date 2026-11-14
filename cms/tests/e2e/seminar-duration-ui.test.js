// Browser-level contract for the occurrence editor. Run separately from `npm test`:
// node --test tests/e2e/relation-create.test.js (requires cms and web dependencies).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const cmsRoot = path.join(import.meta.dirname, '../..');
const repoRoot = path.join(cmsRoot, '..');
const require = createRequire(import.meta.url);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ikpk-format-ui-'));
const db = path.join(work, 'db.sqlite');
const email = 'format-ui@example.invalid';
const password = 'Format-only-test-password-2026';
const uid = 'api::schedule-entry.schedule-entry';

describe('опубликованная продолжительность семинара в форме проведения', { timeout: 360000 }, () => {
  let app, browser, page, base, seminarId;
  before(async () => {
    if (!process.env.E2E_REUSE_ADMIN_BUILD) execFileSync(path.join(cmsRoot, 'node_modules/.bin/strapi'), ['build'], {
      cwd: cmsRoot, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', STRAPI_TELEMETRY_DISABLED: 'true' },
    });
    // Capture the address before closing the temporary port reservation.
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
    });
    Object.assign(process.env, {
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port),
      JWT_SECRET: 'format-test-jwt', APP_KEYS: 'format-one,format-two', ADMIN_JWT_SECRET: 'format-admin-jwt',
      API_TOKEN_SALT: 'format-api-token', TRANSFER_TOKEN_SALT: 'format-transfer-token', ENCRYPTION_KEY: 'format-encryption',
      DATABASE_CLIENT: 'sqlite', DATABASE_FILENAME: db, STRAPI_TELEMETRY_DISABLED: 'true',
    });
    for (const key of ['CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN', 'IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP']) delete process.env[key];
    fs.mkdirSync(path.join(cmsRoot, 'public/uploads'), { recursive: true });
    app = require('@strapi/strapi').createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
    await app.load();
    app.config.set('admin.autoOpen', false);
    await app.listen();
    base = `http://127.0.0.1:${port}`;
    const role = await app.service('admin::role').findOne({ code: 'content-admin' });
    await app.service('admin::user').create({ email, password, firstname: 'Test', lastname: 'Editor', isActive: true, preferedLanguage: 'ru', roles: [role.id] });
    const create = (type, data) => app.documents(type).create({ status: 'published', data });
    const institute = await create('api::institute.institute', { name: 'Институт', slug: 'test-institute', legacy_id: 'test-institute', description: 'Описание', order: 1, seo: { seo_title: 'Институт', seo_description: 'Описание института' } });
    const group = await create('api::course-group.course-group', { name: 'Программа', slug: 'test-program', legacy_id: 'test-program', description: 'Описание', institute: institute.documentId, seo: { seo_title: 'Программа', seo_description: 'Описание программы' } });
    const seminar = await create('api::seminar.seminar', { name: 'Семинар', slug: 'test-seminar', legacy_id: 'test-seminar', course_group: group.documentId, description: 'Описание', documents_state: 'not-issued', duration: '24 часа' });
    seminarId = seminar.documentId;
    const teacher = await create('api::teacher.teacher', { name: 'Единственный преподаватель', slug: 'teacher', legacy_id: 'teacher', trait: 'teacher' });
    await app.documents('api::seminar.seminar').update({ documentId: seminarId, data: { teachers: [teacher.documentId], duration: '32 часа' } });
    await create('api::seminar.seminar', { name: 'Другой семинар', slug: 'other', legacy_id: 'other', course_group: group.documentId, description: 'Описание', documents_state: 'not-issued' });
    const { chromium } = createRequire(path.join(repoRoot, 'web/package.json'))('playwright');
    browser = await chromium.launch();
    page = await browser.newPage({ locale: 'ru-RU' });
    await page.goto(`${base}/admin/auth/login`);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/admin(?!\/auth)/);
  });
  after(async () => {
    await browser?.close();
    await app?.destroy();
    fs.rmSync(work, { recursive: true, force: true });
  });
  async function openFromSeminar() {
    await page.goto(`${base}/admin/content-manager/collection-types/${uid}/create?fromSeminar=${seminarId}`);
    await page.locator('input[name="duration"]').waitFor();
  }
  async function selectSeminar(name) {
    await page.locator('input[name="seminar"]').click();
    await page.locator('input[name="seminar"]').fill(name);
    await page.getByRole('option', { name: new RegExp(name) }).first().click();
  }
  test('из семинара показывает только опубликованные 24 часа и сохраняет пустой override', async () => {
    await openFromSeminar();
    const input = page.locator('input[name="duration"]');
    await page.getByText('Из опубликованного семинара: 24 часа', { exact: true }).waitFor({ timeout: 7000 });
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.getByText('32 часа', { exact: false }).count(), 0, 'черновое значение семинара недоступно для наследования');
    const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/content-manager/collection-types/${uid}`));
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const response = await saved; assert.equal(response.ok(), true);
    const entry = await app.documents(uid).findOne({ documentId: (await response.json()).data.documentId });
    assert.equal(entry.duration, null);
  });
  test('сохранённое проведение с переопределением показывает опубликованную базу', async () => {
    const entry = await app.documents(uid).create({ data: { seminar: seminarId, city: 'Москва', duration: '12 часов' } });
    await page.goto(`${base}/admin/content-manager/collection-types/${uid}/${entry.documentId}`);
    await page.getByText('Из опубликованного семинара: 24 часа', { exact: true }).waitFor({ timeout: 7000 });
    assert.equal(await page.locator('input[name="duration"]').inputValue(), '12 часов');
  });
  test('в общем списке подсказка реагирует на смену семинара и отсутствие продолжительности', async () => {
    await page.goto(`${base}/admin/content-manager/collection-types/${uid}/create`);
    await page.locator('input[name="seminar"]').waitFor();
    await selectSeminar('Семинар');
    await page.getByText('Из опубликованного семинара: 24 часа', { exact: true }).waitFor({ timeout: 7000 });
    await page.locator('input[name="duration"]').fill('12 часов');
    await selectSeminar('Другой семинар');
    await page.getByText('В опубликованном семинаре продолжительность не указана.', { exact: true }).waitFor({ timeout: 7000 });
    assert.equal(await page.getByText('Из опубликованного семинара: 24 часа', { exact: true }).count(), 0);
    assert.equal(await page.locator('input[name="duration"]').inputValue(), '12 часов', 'ручное переопределение не должно изменяться');
  });
  test('для неопубликованного семинара не выдаёт продолжительность черновика за опубликованную', async () => {
    await app.documents('api::seminar.seminar').create({ data: { name: 'Черновой семинар', slug: 'draft-only', legacy_id: 'draft-only', description: 'Описание', documents_state: 'not-issued', duration: '99 часов' } });
    await page.goto(`${base}/admin/content-manager/collection-types/${uid}/create`);
    await page.locator('input[name="seminar"]').waitFor();
    await selectSeminar('Черновой семинар');
    await page.getByText('Опубликованная версия семинара отсутствует.', { exact: true }).waitFor({ timeout: 7000 });
    assert.equal(await page.getByText('99 часов', { exact: false }).count(), 0);
  });
  test('отказ загрузки явно сообщается, а сохранённое переопределение не меняется', async () => {
    const entry = await app.documents(uid).create({ data: { seminar: seminarId, city: 'Москва', duration: '12 часов' } });
    const pattern = /api::seminar\.seminar\/[^/?]+\?status=published/;
    await page.route(pattern, route => route.fulfill({ status: 403, body: '{}' }));
    try {
      await page.goto(`${base}/admin/content-manager/collection-types/${uid}/${entry.documentId}`);
      await page.getByText('Не удалось загрузить опубликованную продолжительность. Обновите страницу.', { exact: true }).waitFor({ timeout: 7000 });
      assert.equal(await page.locator('input[name="duration"]').inputValue(), '12 часов');
    } finally { await page.unroute(pattern); }
  });
  test('во время загрузки преподавателей не показывает их историческими и не предлагает старый список', async () => {
    const entry = await app.documents(uid).create({ data: { seminar: seminarId, city: 'Москва' } });
    const pattern = new RegExp(`/relations/api::seminar\\.seminar/${seminarId}/teachers`);
    let unblock, complete, invoked = false;
    const waiting = new Promise(resolve => { unblock = resolve; });
    const finished = new Promise(resolve => { complete = resolve; });
    await page.route(pattern, async route => { invoked = true; try { await waiting; await route.continue(); } finally { complete(); } });
    let response;
    try {
      const entered = page.waitForRequest(pattern, { timeout: 7000 });
      response = page.waitForResponse(pattern, { timeout: 7000 });
      await page.goto(`${base}/admin/content-manager/collection-types/${uid}/${entry.documentId}`);
      await entered;
      const region = page.getByRole('region', { name: 'Преподаватели проведения' });
      await region.getByText('Единственный преподаватель', { exact: false }).waitFor({ timeout: 7000 });
      assert.equal(await region.getByText(/ранее назначен/).count(), 0);
    } finally { unblock(); if (invoked) { await finished; await response; } await page.unroute(pattern); }
  });
});
