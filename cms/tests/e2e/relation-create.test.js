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

describe('связь проведения с семинаром: content-admin', { timeout: 360000 }, () => {
  let app, browser, page, base, seminarId, otherId;
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
    const seminar = await create('api::seminar.seminar', { name: 'Семинар', slug: 'test-seminar', legacy_id: 'test-seminar', course_group: group.documentId, description: 'Описание', documents_state: 'not-issued' });
    seminarId = seminar.documentId;
    const teacher = await create('api::teacher.teacher', { name: 'Единственный преподаватель', slug: 'teacher', legacy_id: 'teacher', trait: 'teacher' });
    await app.documents('api::seminar.seminar').update({ documentId: seminarId, data: { teachers: [teacher.documentId] } });
    otherId = (await create('api::seminar.seminar', { name: 'Другой семинар', slug: 'other', legacy_id: 'other', course_group: group.documentId, description: 'Описание', documents_state: 'not-issued' })).documentId;
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
  const seminarUrl = () => `${base}/admin/content-manager/collection-types/api::seminar.seminar/${seminarId}`;
  async function openSeminar() {
    await page.goto(seminarUrl());
    await page.locator('input[name="name"]').waitFor();
  }
  async function createFromSeminar() {
    await openSeminar();
    await page.getByRole('button', { name: /создать проведение|добавить проведение/i }).click({ timeout: 5000 });
    await page.locator('input[name="seminar"]').waitFor({ timeout: 5000 });
  }
  async function selectSeminar(name) {
    await page.locator('input[name="seminar"]').click();
    await page.locator('input[name="seminar"]').fill(name);
    await page.getByRole('option', { name: new RegExp(name) }).first().click();
  }
  async function assertLocked() {
    const picker = page.locator('input[name="seminar"]');
    assert.ok(await picker.isDisabled() || await picker.getAttribute('aria-disabled') === 'true' || await picker.getAttribute('readonly') !== null, 'связь должна быть доступна только для чтения');
  }
  test('из семинара предвыбраны семинар и единственный преподаватель, связь заблокирована', async () => {
    await createFromSeminar();
    await page.getByText('Семинар', { exact: true }).last().waitFor({ timeout: 10000 });
    await assertLocked();
    await page.getByRole('region', { name: 'Преподаватели проведения' }).getByText('Единственный преподаватель').waitFor({ timeout: 10000 });
  });
  test('первый POST содержит связь с семинаром и сохраняет её', async () => {
    await createFromSeminar();
    const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/content-manager/collection-types/${uid}`), { timeout: 5000 });
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const response = await saved;
    assert.ok(JSON.stringify(response.request().postDataJSON()).includes(seminarId), 'первый POST содержит documentId семинара');
    assert.ok(response.ok(), `сохранение: ${response.status()} ${await response.text()}`);
    const data = await response.json();
    const entry = await app.documents(uid).findOne({ documentId: data.data.documentId, populate: ['seminar'] });
    assert.equal(entry.seminar.documentId, seminarId);
    const entryTeachers = await app.documents(uid).findOne({ documentId: data.data.documentId, populate: ['teachers'] });
    assert.equal(entryTeachers.teachers.length, 1);
  });
  test('отмена возвращает в семинар без бесхозного проведения', async () => {
    const before = await app.documents(uid).count();
    await createFromSeminar();
    await page.locator('input[name="city"]').fill('Москва');
    await page.getByRole('button', { name: /отмена/i }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor({ timeout: 3000 });
    await dialog.getByRole('button', { name: /отмен|cancel/i }).click();
    assert.ok(page.url().includes('/create'));
    await page.getByRole('button', { name: /отмена/i }).click();
    await dialog.getByRole('button', { name: /подтвердить|confirm/i }).click();
    await page.waitForURL(url => url.pathname.endsWith(seminarId), { timeout: 5000 });
    assert.equal(await app.documents(uid).count(), before);
  });
  test('стрелка возврата из проведения открывает исходный семинар', async () => {
    await app.documents(uid).create({ data: { seminar: seminarId, city: 'Казань' } });
    await openSeminar();
    await page.getByText('Казань', { exact: false }).first().click({ timeout: 5000 });
    await page.locator('input[name="seminar"]').waitFor();
    await page.reload();
    await page.locator('input[name="seminar"]').waitFor();
    await page.getByRole('link', { name: 'Назад' }).click();
    await page.waitForURL(url => url.pathname.endsWith(seminarId), { timeout: 5000 });
  });
  test('из общего списка семинар меняется до сохранения и фиксируется после', async () => {
    await page.goto(`${base}/admin/content-manager/collection-types/${uid}/create`);
    await page.locator('input[name="seminar"]').waitFor();
    await selectSeminar('Семинар');
    await selectSeminar('Другой семинар');
    const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/content-manager/collection-types/${uid}`), { timeout: 5000 });
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const response = await saved;
    assert.ok(response.ok(), `сохранение: ${response.status()} ${await response.text()}`);
    const data = await response.json();
    const entry = await app.documents(uid).findOne({ documentId: data.data.documentId, populate: ['seminar'] });
    assert.equal(entry.seminar.documentId, otherId);
    await assertLocked();
  });
  test('несохранённый семинар предлагает сохранение и не теряет изменения', async () => {
    await page.goto(`${base}/admin/content-manager/collection-types/api::seminar.seminar/create`);
    const name = page.locator('input[name="name"]');
    await name.fill('Несохранённое название');
    await page.getByRole('button', { name: /создать проведение|добавить проведение/i }).click({ timeout: 5000 });
    assert.match(await page.locator('body').innerText(), /сохраните|сохранить.*семинар/i);
    assert.equal(await name.inputValue(), 'Несохранённое название');
  });
  test('только преподаватели семинара, порядок и историческое назначение сохраняются', async () => {
    const teacherType = 'api::teacher.teacher';
    const first = (await app.documents(teacherType).findMany({ filters: { slug: 'teacher' } }))[0];
    const second = await app.documents(teacherType).create({ data: { name: 'Второй преподаватель', slug: 'teacher-two', legacy_id: 'teacher-two', trait: 'teacher' } });
    await app.documents(teacherType).create({ data: { name: 'Посторонний преподаватель', slug: 'teacher-other', legacy_id: 'teacher-other', trait: 'teacher' } });
    await app.documents('api::seminar.seminar').update({ documentId: seminarId, data: { teachers: [first.documentId, second.documentId] } });
    await createFromSeminar();
    const box = page.getByRole('region', { name: 'Преподаватели проведения' });
    await box.getByRole('button', { name: 'Добавить Второй преподаватель' }).click();
    await box.getByRole('button', { name: 'Добавить Единственный преподаватель' }).click();
    assert.equal(await box.getByText('Посторонний преподаватель').count(), 0);
    const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/content-manager/collection-types/${uid}`), { timeout: 5000 });
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const response = await saved;
    assert.ok(response.ok(), `сохранение: ${response.status()} ${await response.text()}`);
    const entryId = (await response.json()).data.documentId;
    let entry = await app.documents(uid).findOne({ documentId: entryId, populate: ['teachers'] });
    assert.deepEqual(entry.teachers.map(teacher => teacher.documentId), [second.documentId, first.documentId]);
    await page.reload();
    await box.locator('li').first().getByText('Второй преподаватель').waitFor();
    await box.getByRole('button', { name: 'Опустить Второй преподаватель' }).click();
    const reordered = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(`/content-manager/collection-types/${uid}`), { timeout: 5000 });
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    assert.ok((await reordered).ok());
    entry = await app.documents(uid).findOne({ documentId: entryId, populate: ['teachers'] });
    assert.deepEqual(entry.teachers.map(teacher => teacher.documentId), [first.documentId, second.documentId]);
    await app.documents('api::seminar.seminar').update({ documentId: seminarId, data: { teachers: [first.documentId] } });
    await page.reload();
    await box.getByText(/ранее назначен/).waitFor();
    const historical = box.locator('li').filter({ hasText: 'Второй преподаватель' });
    await historical.getByRole('button', { name: 'Удалить' }).click();
    assert.equal(await box.getByRole('button', { name: 'Добавить Второй преподаватель' }).count(), 0);
    const updated = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(`/content-manager/collection-types/${uid}`), { timeout: 5000 });
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const putResponse = await updated;
    assert.ok(putResponse.ok(), `сохранение: ${putResponse.status()} ${await putResponse.text()}`);
    entry = await app.documents(uid).findOne({ documentId: entryId, populate: ['teachers'] });
    assert.deepEqual(entry.teachers.map(teacher => teacher.documentId), [first.documentId]);
  });

  test('клон семинара нужно сохранить до создания проведения', async () => {
    await page.goto(`${base}/admin/content-manager/collection-types/api::seminar.seminar/clone/${seminarId}`);
    await page.locator('input[name="name"]').waitFor();
    await page.getByRole('button', { name: /создать проведение/i }).click();
    await page.getByRole('alert').getByText(/сначала сохраните семинар/i).waitFor();
    assert.ok(page.url().includes('/clone/'));
  });
  test('переход из изменённого семинара предупреждает и сохраняет форму при отмене', async () => {
    await openSeminar();
    const name = page.locator('input[name="name"]');
    await name.fill('Несохранённое изменение');
    await page.getByRole('button', { name: /создать проведение/i }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: /отмен|cancel/i }).click();
    assert.equal(await name.inputValue(), 'Несохранённое изменение');
    assert.ok(page.url().includes(seminarId));
  });

});
