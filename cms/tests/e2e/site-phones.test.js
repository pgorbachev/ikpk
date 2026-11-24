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
      title: 'Тест ' + slug, slug, legacy_id: slug, body: 'Публичный текст',
      seo: { seo_title: slug, seo_description: 'Описание' }, ...extra,
    } });
    contacts = await page('kontakty', { center_phone: '+78126465450', manager_phone: '+79810387797' });
    another = await page('another-page', {});
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
      await page.getByRole('link', { name: /Контакты сайта/i }).click({ timeout: 15_000 });
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

  test('super-admin sees both fields and the Body hint only on the canonical page', async () => {
    const page = await login('strapi-super-admin');
    try {
      const form = base + '/admin/content-manager/collection-types/' + uid + '/';
      await page.goto(form + contacts.documentId);
      await page.getByRole('textbox', { name: center }).waitFor();
      assert.ok(await page.getByRole('textbox', { name: manager }).isVisible());
      assert.match(await page.locator('main').innerText(), /body/i);
      await page.goto(form + another.documentId);
      await page.locator('input[name="title"]').waitFor();
      assert.equal(await page.getByRole('textbox', { name: center }).isVisible(), false);
      assert.equal(await page.getByRole('textbox', { name: manager }).isVisible(), false);
    } finally { await page.close(); }
  });
});
