import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const root = join(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const { chromium } = createRequire(join(root, '../web/package.json'))('playwright');
const uid = 'api::page.page';
const center = 'Телефон центра';
const manager = 'Мобильный телефон менеджера';

describe('site phone fields in the Strapi admin', { timeout: 360_000 }, () => {
  let app, browser, base, pages, contacts, another, work;

  before(async () => {
    work = mkdtempSync(join(tmpdir(), 'ikpk-phone-ui-'));
    Object.assign(process.env, {
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '0', STRAPI_TELEMETRY_DISABLED: 'true',
      APP_KEYS: 'phone-ui-one,phone-ui-two', ADMIN_JWT_SECRET: 'phone-ui-admin', JWT_SECRET: 'phone-ui-jwt',
      API_TOKEN_SALT: 'phone-ui-api', TRANSFER_TOKEN_SALT: 'phone-ui-transfer', ENCRYPTION_KEY: 'phone-ui-encryption',
      DATABASE_CLIENT: 'sqlite', DATABASE_FILENAME: join(work, 'db.sqlite'),
    });
    for (const key of ['CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN', 'IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP']) delete process.env[key];
    if (!process.env.E2E_REUSE_ADMIN_BUILD) execFileSync(join(root, 'node_modules/.bin/strapi'), ['build'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
    });
    mkdirSync(join(root, 'public/uploads'), { recursive: true });
    app = require('@strapi/strapi').createStrapi({ appDir: root, distDir: join(root, 'dist') });
    await app.load();
    app.config.set('admin.autoOpen', false);
    await app.listen();
    base = 'http://127.0.0.1:' + app.server.httpServer.address().port;
    pages = app.documents(uid);
    const page = (slug, extra) => pages.create({ status: 'published', data: {
      title: 'Тест ' + slug, slug, legacy_id: slug, body: 'Публичный текст с телефоном +7 981 038-77-97',
      seo: { seo_title: slug, seo_description: 'Описание' }, ...extra,
    } });
    contacts = await page('kontakty', { center_phone: '+78126465450', manager_phone: '+79810387797' });
    another = await page('another-page', {});
    const editor = await app.service('admin::role').findOne({ code: 'strapi-editor' });
    for (const action of ['read', 'update']) {
      await app.db.query('admin::permission').create({ data: {
        action: 'plugin::content-manager.explorer.' + action,
        subject: uid,
        properties: { fields: ['title', 'slug', 'body', 'center_phone', 'manager_phone'] },
        conditions: [],
        role: editor.id,
      } });
    }
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    await app?.destroy();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  async function login(code) {
    const role = await app.service('admin::role').findOne({ code });
    const email = code + '@example.invalid';
    const password = 'Phone-only-test-password-2026';
    await app.service('admin::user').create({ email, password, firstname: 'Test', lastname: 'Phones', isActive: true, preferedLanguage: 'ru', roles: [role.id] });
    const page = await browser.newPage({ locale: 'ru-RU' });
    await page.goto(base + '/admin/auth/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/admin(?!\/auth)/);
    return page;
  }

  test('content-admin finds and publishes each independent field', async () => {
    const page = await login('content-admin');
    try {
      await page.getByRole('link', { name: 'Редактор контента', exact: true }).click();
      assert.equal(await page.getByRole('link', { name: 'Страницы → Контакты сайта', exact: true }).count(), 0);
      const authorized = page.waitForRequest(request => request.url().endsWith('/admin/site-phones'));
      await page.getByRole('link', { name: 'Страницы', exact: true }).click({ timeout: 15_000 });
      await page.waitForURL('**/admin/content-manager/collection-types/site-contact-phones');
      await page.getByRole('heading', { name: 'Контакты сайта' }).waitFor();
      const authorization = (await authorized).headers().authorization;
      const response = await page.request.get(base + '/content-manager/collection-types/' + uid, { headers: { authorization } });
      assert.equal(response.status(), 403);
      await page.goto(base + '/admin/site-contact-phones');
      await page.waitForURL('**/admin/content-manager/collection-types/site-contact-phones');
      await page.reload();
      await page.getByRole('heading', { name: 'Контакты сайта' }).waitFor();
      await page.route('**/admin/site-phones', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
      await page.goto(base + '/admin/content-manager');
      await page.getByRole('link', { name: 'Страницы', exact: true }).click();
      await page.getByRole('button', { name: 'Загрузить актуальные значения' }).waitFor();
      await page.unroute('**/admin/site-phones');
      await page.getByRole('button', { name: 'Загрузить актуальные значения' }).click();
      await page.getByRole('textbox', { name: center }).waitFor();
      for (const [label, number, field] of [[center, '+78125550101', 'center_phone'], [manager, '+79815550202', 'manager_phone']]) {
        await page.getByRole('textbox', { name: label }).fill(number);
        const completed = page.waitForResponse((r) => r.url().endsWith('/site-phones/publish') && r.request().method() === 'POST');
        await page.getByRole('button', { name: /опубликовать/i }).click();
        assert.ok((await completed).ok());
        const published = await pages.findOne({ documentId: contacts.documentId, status: 'published' });
        assert.equal(published[field].replace(/[ ()-]/g, ''), number);
      }
    } finally { await page.close(); }
  });

  test('другая роль с доступом к Page сохраняет свою карточку без доступа к форме телефонов', async () => {
    const page = await login('strapi-editor');
    try {
      await page.goto(base + '/admin/content-manager');
      await page.getByRole('link', { name: 'Страницы', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Страницы → Контакты сайта' }).count(), 0);
      const deniedForm = page.waitForResponse(r => r.url().endsWith('/admin/site-phones') && r.status() === 403);
      await page.goto(base + '/admin/site-contact-phones');
      await deniedForm;
      assert.equal(await page.getByRole('textbox', { name: center }).count(), 0);
      const form = base + '/admin/content-manager/collection-types/' + uid + '/';
      const denied = page.waitForResponse(r => r.url().endsWith('/admin/site-phones'));
      await page.goto(form + contacts.documentId);
      assert.equal((await denied).status(), 403);
      await page.locator('input[name="slug"]').waitFor();
      assert.equal(await page.locator('input[name="slug"]').inputValue(), 'kontakty');
      assert.equal(await page.locator('input[name="slug"]').isEditable(), false);
      assert.ok(await page.getByText('Текст страницы', { exact: true }).isVisible());
      assert.ok(await page.getByRole('textbox', { name: center }).isVisible());
      assert.ok(await page.getByRole('textbox', { name: manager }).isVisible());
      await page.goto(form + another.documentId);
      await page.locator('input[name="slug"]').waitFor();
      assert.ok(await page.locator('input[name="slug"]').isEditable());

      assert.match(page.url(), new RegExp(another.documentId));
      await page.route('**/admin/site-phones', route => route.fulfill({
        status: 500, contentType: 'application/json', body: '{"error":{"status":500}}',
      }));
      await page.goto(form + contacts.documentId);
      await page.getByText(/Что-то пошло не так|Something went wrong/i).first().waitFor();
      assert.equal(await page.locator('input[name="slug"]').isVisible(), false);
      assert.match(page.url(), new RegExp(contacts.documentId));
      await page.unroute('**/admin/site-phones');

    } finally { await page.close(); }
  });

  test('старая ссылка и список страниц ведут супер-администратора в единую форму', async () => {
    const page = await login('strapi-super-admin');
    try {
      const form = base + '/admin/content-manager/collection-types/' + uid + '/';
      const phone = page.getByRole('textbox', { name: center });
      const mobile = page.getByRole('textbox', { name: manager });

      await page.goto(form + contacts.documentId);
      await page.waitForURL('**/admin/content-manager/collection-types/site-contact-phones');
      await phone.waitFor();
      assert.ok(await mobile.isVisible());
      assert.equal(await page.getByText('Текст страницы', { exact: true }).isVisible(), false);
      assert.equal(await page.getByText('Публичный текст с телефоном +7 981 038-77-97').isVisible(), false);

      await phone.fill('+78125550303');
      const completed = page.waitForResponse(r => r.url().endsWith('/site-phones/publish') && r.request().method() === 'POST');
      await page.getByRole('button', { name: /опубликовать/i }).click();
      assert.ok((await completed).ok());
      const published = await pages.findOne({ documentId: contacts.documentId, status: 'published' });
      assert.equal(published.center_phone.replace(/[ ()-]/g, ''), '+78125550303');
      assert.equal(published.body, 'Публичный текст с телефоном +7 981 038-77-97');

      await page.goto(form.slice(0, -1));
      await page.getByText('Тест kontakty', { exact: true }).click();
      await page.waitForURL('**/admin/content-manager/collection-types/site-contact-phones');
      await phone.waitFor();
      assert.ok(await phone.isVisible());

      for (const [path, expectedSlug] of [[another.documentId, 'another-page'], ['create', '']]) {
        await page.goto(form + path);
        const slug = page.locator('input[name="slug"]');
        await slug.waitFor();
        assert.equal(await slug.inputValue(), expectedSlug);
        assert.ok(await slug.isEditable());
        assert.ok(await page.getByText('Текст страницы', { exact: true }).isVisible());
        assert.equal(await phone.isVisible(), false);
        assert.equal(await mobile.isVisible(), false);
      }

      await page.goto(form + 'clone/' + contacts.documentId);
      await page.locator('input[name="slug"]').waitFor();
      assert.ok(await page.getByText('Текст страницы', { exact: true }).isVisible());
      assert.match(page.url(), /\/clone\//);
    } finally { await page.close(); }
  });
});
