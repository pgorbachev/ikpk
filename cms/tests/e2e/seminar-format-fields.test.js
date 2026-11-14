// Browser-level contract for the occurrence editor. Run separately from `npm test`:
// node --test tests/e2e/seminar-format-fields.test.js (requires cms and web dependencies).
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

describe('формат проведения в админке', { timeout: 360000 }, () => {
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
    const teacher = await create('api::teacher.teacher', { name: 'Преподаватель', slug: 'format-teacher', legacy_id: 'format-teacher', trait: 'teacher' });
    const seminar = await create('api::seminar.seminar', { name: 'Семинар', slug: 'test-seminar', legacy_id: 'test-seminar', course_group: group.documentId, description: 'Описание', documents_state: 'not-issued', duration: '24 часа', teachers: [teacher.documentId] });
    seminarId = seminar.documentId;
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
  async function openDraft(city = 'Казань') {
    const entry = await app.documents(uid).create({ data: { seminar: seminarId, city, startAt: '2027-04-01T09:00:00.000Z', endAt: '2027-04-02T15:00:00.000Z', entry_status: 'active' } });
    await page.goto(`${base}/admin/content-manager/collection-types/${uid}/${entry.documentId}`);
    await page.locator('input[name="city"]').waitFor();
    await page.waitForFunction(value => globalThis.document.querySelector('input[name="city"]')?.value === value, city);
    return entry;
  }
  test('онлайн доступен как флажок с понятной меткой', async () => {
    await openDraft();
    const checkbox = page.getByRole('checkbox', { name: 'Онлайн', exact: true });
    assert.equal(await checkbox.count(), 1, 'поле Онлайн должно быть флажком с доступной меткой');
    assert.equal(await checkbox.isChecked(), false);
  });
  test('включение онлайн сразу очищает город', async () => {
    await openDraft();
    const city = page.locator('input[name="city"]');
    assert.equal(await city.inputValue(), 'Казань');
    await page.getByRole('checkbox', { name: 'Онлайн', exact: true }).check();
    assert.equal(await city.inputValue(), '', 'город очищается до сохранения');
  });
  test('город недоступен при онлайн и снова доступен при офлайн', async () => {
    await openDraft();
    const city = page.locator('input[name="city"]');
    const online = page.getByRole('checkbox', { name: 'Онлайн', exact: true });
    await online.check();
    assert.equal(await city.isDisabled(), true, 'город недоступен при онлайн');
    await online.uncheck();
    assert.equal(await city.isEnabled(), true, 'город снова доступен при офлайн');
    assert.equal(await city.inputValue(), '', 'старый город не восстанавливается');
  });
  test('после выключения онлайн город редактируется, пустой черновик сохраняется, но публикация отклоняется', async () => {
    const entry = await openDraft();
    const city = page.locator('input[name="city"]');
    const online = page.getByRole('checkbox', { name: 'Онлайн', exact: true });
    await online.check();
    await online.uncheck();
    assert.equal(await city.isEnabled(), true, 'город доступен при офлайн');
    await city.fill('');
    const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(entry.documentId));
    await page.getByRole('button', { name: 'Сохранить' }).click();
    assert.ok((await saved).ok(), 'пустой город допускается в черновике');
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/actions/publish'));
    await page.getByRole('button', { name: 'Опубликовать' }).click();
    const publication = await response;
    assert.equal(publication.ok(), false, 'публикация офлайн без города должна быть отклонена');
    assert.match(await publication.text(), /city|город/i, 'ошибка должна указывать на город');
  });
});
