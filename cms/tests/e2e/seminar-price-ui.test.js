// Browser-level contract for the occurrence editor. Run separately from `npm test`:
// node --test tests/e2e/seminar-price-ui.test.js (requires cms and web dependencies).
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

describe('цена проведения в админке', { timeout: 360000 }, () => {
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
  async function openDraft(price = null, isFree = false) {
    const entry = await app.documents(uid).create({ data: { seminar: seminarId, city: 'Казань', price, isFree, startAt: '2027-04-01T09:00:00.000Z', endAt: '2027-04-02T15:00:00.000Z', entry_status: 'active' } });
    await page.goto(`${base}/admin/content-manager/collection-types/${uid}/${entry.documentId}`);
    await page.locator('input[name="city"]').waitFor();
    return entry;
  }
  test('в окне семинара цена доступна без ожидания отдельного файла поля', async () => {
    const pattern = '**/OccurrencePrice-*.js';
    await page.route(pattern, async route => {
      await new Promise(resolve => setTimeout(resolve, 3000));
      await route.continue();
    });
    try {
      await page.goto(`${base}/admin/content-manager/collection-types/api::seminar.seminar/${seminarId}`);
      await page.locator('input[name="schedule_entries"]').click();
      await page.getByRole('option', { name: 'Create a relation' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('input[name="price"][type="number"]').waitFor({ timeout: 1500 });
      assert.equal(await dialog.locator('input[name="price"][type="number"]').isEnabled(), true);
    } finally {
      await page.unroute(pattern);
    }
  });
  test('в окне создания проведения цена видна и сохраняется для платного формата', async () => {
    await page.goto(`${base}/admin/content-manager/collection-types/api::seminar.seminar/${seminarId}`);
    await page.getByText('Проведения', { exact: true }).first().waitFor();
    await page.locator('input[name="schedule_entries"]').click();
    await page.getByRole('option', { name: 'Create a relation' }).click();
    const dialog = page.getByRole('dialog');
    const price = dialog.locator('input[name="price"][type="number"]');
    const free = dialog.getByRole('checkbox', { name: 'Бесплатно', exact: true });
    await price.waitFor();
    assert.equal(await free.isChecked(), false);
    assert.equal(await price.isEnabled(), true);
    await price.pressSequentially('1500');
    assert.equal(await price.inputValue(), '1500');
    const style = await price.evaluate(input => ({ color: input.ownerDocument.defaultView.getComputedStyle(input).color, background: input.ownerDocument.defaultView.getComputedStyle(input).backgroundColor }));
    assert.notEqual(style.color, style.background);
    await free.check();
    assert.equal(await price.inputValue(), '0');
    assert.equal(await price.isDisabled(), true);
    await free.uncheck();
    assert.equal(await price.isEnabled(), true);
    assert.equal(await price.inputValue(), '');
    await price.pressSequentially('2500');
    assert.equal(await price.inputValue(), '2500');
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(uid));
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const saved = await response;
    assert.ok(saved.ok());
    const body = await saved.json();
    const entry = await app.documents(uid).findOne({ documentId: body.data.documentId });
    assert.equal(entry.isFree, false);
    assert.equal(Number(entry.price), 2500);
  });
  test('новое платное проведение: цифры цены видны и сохраняются при последовательном вводе', async () => {
    await page.goto(`${base}/admin/content-manager/collection-types/${uid}/create?fromSeminar=${seminarId}`);
    const price = page.locator('input[name="price"]');
    const free = page.getByRole('checkbox', { name: 'Бесплатно', exact: true });
    await price.waitFor();
    assert.equal(await free.isChecked(), false);
    assert.equal(await price.isEnabled(), true);
    await price.pressSequentially('1500');
    assert.equal(await price.inputValue(), '1500');
    const style = await price.evaluate((input) => {
      const css = input.ownerDocument.defaultView.getComputedStyle(input);
      return { color: css.color, background: css.backgroundColor, opacity: css.opacity };
    });
    assert.notEqual(style.color, style.background, 'цифры должны отличаться от фона');
    assert.notEqual(style.opacity, '0', 'цифры должны быть видимы');
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(uid));
    await page.getByRole('button', { name: 'Сохранить' }).click();
    const saved = await response;
    assert.ok(saved.ok());
    const body = await saved.json();
    const entry = await app.documents(uid).findOne({ documentId: body.data.documentId });
    assert.equal(entry.isFree, false);
    assert.equal(Number(entry.price), 1500);
  });
  test('бесплатно немедленно устанавливает ноль и блокирует цену', async () => {
    await openDraft(1250);
    const price = page.locator('input[name="price"]');
    const free = page.getByRole('checkbox', { name: 'Бесплатно', exact: true });
    // The custom field is loaded asynchronously after the built-in city field.
    await page.waitForFunction('document.querySelector(\'input[name="price"]\')?.value === "1250"');
    assert.equal((await price.inputValue()).replace(/\s/g, ''), '1250');
    await free.check();
    assert.equal(await price.inputValue(), '0', 'ноль устанавливается до сохранения');
  });
  test('цена бесплатного проведения заблокирована до сохранения', async () => {
    await openDraft(1250);
    await page.getByRole('checkbox', { name: 'Бесплатно', exact: true }).check();
    assert.equal(await page.locator('input[name="price"]').isDisabled(), true, 'цену бесплатного проведения нельзя редактировать');
  });
  test('историческая противоречивая цена не меняется при открытии или обычном сохранении', async () => {
    const entry = await openDraft(1250);
    await app.db.connection('schedule_entries').where({ document_id: entry.documentId }).update({ is_free: true, price: 1250 });
    await page.reload();
    const price = page.locator('input[name="price"]');
    await price.waitFor();
    await page.waitForFunction('document.querySelector(\'input[name="price"]\')?.value === "1250"');
    assert.equal(await price.inputValue(), '1250');
    await assert.rejects(app.documents(uid).update({ documentId: entry.documentId, data: { city: 'Москва' } }), /бесплатн|цен/i);
    const stored = await app.documents(uid).findOne({ documentId: entry.documentId });
    assert.equal(Number(stored.price), 1250);
  });
  test('переход на платно очищает ноль и разблокирует цену', async () => {
    await openDraft(0, true);
    const price = page.locator('input[name="price"]');
    const free = page.getByRole('checkbox', { name: 'Бесплатно', exact: true });
    await free.uncheck();
    assert.equal(await price.isEnabled(), true);
    assert.equal(await price.inputValue(), '', 'ноль очищается до сохранения');
  });
  test('после сохранения бесплатного и обратного переключения цена остаётся неопределённой', async () => {
    const entry = await openDraft(1500);
    const price = page.locator('input[name="price"]');
    const free = page.getByRole('checkbox', { name: 'Бесплатно', exact: true });
    await free.check();
    let saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(entry.documentId));
    await page.getByRole('button', { name: 'Сохранить' }).click();
    assert.ok((await saved).ok());
    await free.uncheck();
    assert.equal(await price.inputValue(), '');
    saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(entry.documentId));
    await page.getByRole('button', { name: 'Сохранить' }).click();
    assert.ok((await saved).ok());
    const stored = await app.documents(uid).findOne({ documentId: entry.documentId });
    assert.equal(stored.isFree, false);
    assert.equal(stored.price ?? null, null);
  });
  test('платное проведение с пустой ценой сохраняется', async () => {
    const entry = await openDraft(1500);
    const price = page.locator('input[name="price"]');
    await price.fill('');
    const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(entry.documentId));
    await page.getByRole('button', { name: 'Сохранить' }).click();
    assert.ok((await saved).ok(), 'пустая цена допускается при сохранении');
    await page.reload();
    await price.waitFor();
    assert.equal(await price.inputValue(), '');
  });
  test('платное проведение с нулевой ценой не сохраняется с понятной ошибкой', async () => {
    const entry = await openDraft(1500);
    await page.locator('input[name="price"]').fill('0');
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(entry.documentId), { timeout: 5000 }).catch(() => null);
    await page.getByRole('button', { name: 'Сохранить' }).click();
    const saved = await response;
    if (saved) assert.equal(saved.ok(), false, 'нельзя сохранить платное проведение с нулевой ценой');
    await page.getByText(/цена.*(ноль|нулев|0|платн)|(ноль|нулев|0|платн).*цена/i).first().waitFor({ timeout: 5000 });
    const stored = await app.documents(uid).findOne({ documentId: entry.documentId });
    assert.notEqual(Number(stored.price), 0, 'цена не должна измениться на ноль');
  });
  test('положительная цена сохраняется', async () => {
    const entry = await openDraft(1500);
    const price = page.locator('input[name="price"]');
    await price.fill('2750');
    const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(entry.documentId));
    await page.getByRole('button', { name: 'Сохранить' }).click();
    assert.ok((await saved).ok());
    await page.reload();
    await price.waitFor();
    await page.waitForFunction('document.querySelector(\'input[name="price"]\')?.value === "2750"');
    assert.equal((await price.inputValue()).replace(/\s/g, ''), '2750');
  });
  test('проведение из семинара: связь, преподаватели и возврат', async () => {
    const teachers = app.documents('api::teacher.teacher');
    const first = await teachers.create({ status: 'published', data: { name: 'Ведущий Первый', slug: 'ui-first', legacy_id: 'ui-first', trait: 'teacher' } });
    const second = await teachers.create({ status: 'published', data: { name: 'Ведущий Второй', slug: 'ui-second', legacy_id: 'ui-second', trait: 'teacher' } });
    await teachers.create({ status: 'published', data: { name: 'Чужой Преподаватель', slug: 'ui-foreign', legacy_id: 'ui-foreign', trait: 'teacher' } });
    await app.documents('api::seminar.seminar').update({ documentId: seminarId, data: { teachers: [first.documentId, second.documentId] } });
    await page.goto(`${base}/admin/content-manager/collection-types/api::seminar.seminar/${seminarId}`);
    await page.locator('input[name="schedule_entries"]').click();
    await page.getByRole('option', { name: 'Create a relation' }).click();
    const dialog = page.getByRole('dialog');
    const city = dialog.locator('input[name="city"]');
    await city.fill('Казань');
    await dialog.getByRole('button', { name: 'Назад', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.getByRole('button', { name: 'Отменить', exact: true }).click();
    assert.equal(await city.inputValue(), 'Казань', 'отмена возврата сохраняет несохранённое значение');
    await dialog.getByRole('button', { name: 'Назад', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(page.url().includes(`/api::seminar.seminar/${seminarId}`));
    await page.locator('input[name="schedule_entries"]').click();
    await page.getByRole('option', { name: 'Create a relation' }).click();
    const seminar = dialog.locator('input[name="seminar"]');
    await seminar.waitFor();
    assert.equal(await seminar.isDisabled(), true, 'семинар в окне должен быть заблокирован');
    await dialog.getByText('Семинар', { exact: true }).first().waitFor();
    await dialog.getByText('Из опубликованного семинара: 24 часа', { exact: true }).waitFor({ timeout: 7000 });
    const region = dialog.getByRole('region', { name: 'Преподаватели проведения' });
    await region.getByRole('button', { name: 'Добавить Ведущий Первый' }).waitFor();
    await region.getByRole('button', { name: 'Добавить Ведущий Второй' }).waitFor();
    assert.equal(await region.getByText('Чужой Преподаватель', { exact: false }).count(), 0);
    await region.getByRole('button', { name: 'Добавить Ведущий Второй' }).click();
    const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(uid));
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const response = await saved;
    assert.ok(response.ok());
    const entry = await app.documents(uid).findOne({ documentId: (await response.json()).data.documentId, populate: ['seminar', 'teachers'] });
    assert.equal(entry.seminar.documentId, seminarId);
    assert.deepEqual(entry.teachers.map(row => row.documentId), [second.documentId]);
    await page.goto(`${base}/admin/content-manager/collection-types/${uid}/create?fromSeminar=${seminarId}`);
    await page.locator('input[name="seminar"]').waitFor();
    await page.getByRole('link', { name: 'Назад', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await page.waitForURL(url => url.pathname.endsWith(`/api::seminar.seminar/${seminarId}`), { timeout: 7000 });
  });
});
