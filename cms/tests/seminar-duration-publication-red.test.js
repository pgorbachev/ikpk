import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
const loadCommonjs = createRequire(import.meta.url);
const cmsRoot = path.join(import.meta.dirname, '..');
const dbFile = path.join(cmsRoot, '.tmp', `seminar-model-red-${process.pid}.db`);
const validCourseGroupPublicationFields = {
  description: 'Описание программы для теста',
  seo: {
    seo_title: 'Программа подготовки',
    seo_description: 'Описание образовательной программы для сайта',
  },
};
const validSeminarPublicationFields = {
  description: 'Описание семинара для теста',
  seo: {
    seo_title: 'Семинар подготовки',
    seo_description: 'Описание семинара для сайта',
  },
  documents_state: 'not-issued',
};

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

describe('семинары в собранном Strapi', { timeout: 360000 }, () => {
  /** @type {import('@strapi/strapi').Core.Strapi} */
  let app;
  let base;
  let token;
  let publishedInstitute;
  let publishedProgram;

  before(async () => {
    const [major] = process.versions.node.split('.').map(Number);
    assert.ok(
      major >= 20 && major <= 24,
      `сборка CMS проверяется на Node из engines (>=20 <=24), сейчас ${process.version}`,
    );

    execFileSync(path.join(cmsRoot, 'node_modules/.bin/tsc'), ['--pretty', 'false'], {
      cwd: cmsRoot,
      stdio: 'inherit',
    });
    const rulesPath = path.join(cmsRoot, 'dist/src/seminar-management/rules.js');
    assert.equal(fs.existsSync(rulesPath), true);
    const loaded = loadCommonjs(path.join(cmsRoot, 'dist/src/index.js'));
    assert.equal(typeof loaded.default.register, 'function');

    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'review-only-users-permissions-jwt';
    process.env.HOST = '127.0.0.1';
    process.env.PORT = String(await freePort());
    process.env.APP_KEYS = 'review-test-one,review-test-two';
    process.env.ADMIN_JWT_SECRET = 'review-only-admin-jwt';
    process.env.API_TOKEN_SALT = 'review-only-api-token';
    process.env.TRANSFER_TOKEN_SALT = 'review-only-transfer-token';
    process.env.ENCRYPTION_KEY = 'review-only-encryption';
    process.env.DATABASE_CLIENT = 'sqlite';
    process.env.DATABASE_FILENAME = dbFile;
    process.env.STRAPI_TELEMETRY_DISABLED = 'true';
    delete process.env.IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP;
    delete process.env.CMS_TOKEN;
    delete process.env.CONTENT_ADMIN_EMAIL;
    delete process.env.CONTENT_ADMIN_PASSWORD;

    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.mkdirSync(path.join(cmsRoot, 'public/uploads'), { recursive: true });
    const { createStrapi } = loadCommonjs('@strapi/strapi');
    app = createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
    await app.load();
    assert.ok(!process.env.CMS_TOKEN, 'обычный запуск не должен выдавать токен съёма');
    assert.equal(Boolean(await app.service('admin::api-token').getByName('site-refresh-capture')), false,
      'обычный запуск не должен сохранять токен съёма');
    // В development Strapi сам открывает админку в браузере разработчика при каждом запуске.
    app.config.set('admin.autoOpen', false);
    await app.listen();
    base = `http://127.0.0.1:${process.env.PORT}`;

    const role = await app.service('admin::role').findOne({ code: 'content-admin' });
    assert.equal(role.code, 'content-admin');
    assert.notEqual(role.code, 'strapi-super-admin');
    const email = `probe-${Date.now()}@example.invalid`;
    const password = 'Review-only-test-password-274';
    await app.service('admin::user').create({
      email,
      firstname: 'Probe',
      lastname: 'Review',
      password,
      isActive: true,
      preferedLanguage: 'ru',
      roles: [role.id],
    });
    const login = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200, JSON.stringify(loginBody));
    token = loginBody.data.accessToken;
    assert.equal(typeof token, 'string');

    publishedInstitute = await app.documents('api::institute.institute').create({
      status: 'published',
      data: {
        name: 'Институт для теста',
        slug: 'institut-dlya-testa',
        legacy_id: 'institut-dlya-testa',
        description: 'Описание института для теста',
        order: 1,
        seo: { seo_title: 'Институт для теста', seo_description: 'Описание для поиска' },
      },
    });
    publishedProgram = await app.documents('api::course-group.course-group').create({
      status: 'published',
      data: {
        name: 'Программа для теста',
        slug: 'programma-dlya-testa',
        legacy_id: 'programma-dlya-testa',
        ...validCourseGroupPublicationFields,
        institute: publishedInstitute.documentId,
      },
    });
  });

  after(async () => {
    if (app) await app.destroy();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      fs.rmSync(dbFile + suffix, { force: true });
    }
  });

  let seq = 0;
  async function fixture(defaultDuration) {
    const id = `duration-${++seq}`;
    const teacher = await app.documents('api::teacher.teacher').create({ status: 'published', data: { name: id, slug: id, legacy_id: id, trait: 'teacher' } });
    const seminars = app.documents('api::seminar.seminar');
    const seminar = await seminars.create({ status: 'published', data: { name: id, ...validSeminarPublicationFields, course_group: publishedProgram.documentId, teachers: [teacher.documentId], ...(defaultDuration === undefined ? {} : { duration: defaultDuration }) } });
    return { seminar, teacher, seminars, entries: app.documents('api::schedule-entry.schedule-entry') };
  }
  function fields(f, extra = {}) {
    return { seminar: f.seminar.documentId, teachers: [f.teacher.documentId], city: 'Москва', startAt: '2026-12-01T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z', entry_status: 'active', isFree: false, price: 500, ...extra };
  }
  test('семинар сохраняет и публикует текстовую продолжительность', async () => {
    const f = await fixture('24 часа');
    const draft = await f.seminars.findOne({ documentId: f.seminar.documentId });
    const published = await f.seminars.findOne({ documentId: f.seminar.documentId, status: 'published' });
    assert.equal(draft.duration, '24 часа');
    assert.equal(published.duration, '24 часа');
  });
  test('проведение без override публикуется с продолжительностью семинара', async () => {
    const f = await fixture('24 часа');
    const draft = await f.entries.create({ data: fields(f) });
    assert.equal(draft.duration ?? null, null);
    await f.entries.publish({ documentId: draft.documentId });
    const published = await f.entries.findOne({ documentId: draft.documentId, status: 'published', populate: ['seminar'] });
    assert.ok(published?.publishedAt);
    assert.equal(published.duration ?? null, null);
    assert.equal(published.seminar?.duration, '24 часа');
  });
  test('override публикуется без default и сохраняется отдельно', async () => {
    const f = await fixture();
    const draft = await f.entries.create({ data: fields(f, { duration: '12 часов' }) });
    await f.entries.publish({ documentId: draft.documentId });
    const published = await f.entries.findOne({ documentId: draft.documentId, status: 'published', populate: ['seminar'] });
    assert.equal(published.duration, '12 часов');
    assert.equal(published.seminar?.duration ?? null, null);
  });
  test('override проведения сохраняется при наличии другого default', async () => {
    const f = await fixture('24 часа');
    assert.equal((await f.seminars.findOne({ documentId: f.seminar.documentId, status: 'published' })).duration, '24 часа', 'предусловие: опубликован default');
    const draft = await f.entries.create({ data: fields(f, { duration: '12 часов' }) });
    await f.entries.publish({ documentId: draft.documentId });
    const published = await f.entries.findOne({ documentId: draft.documentId, status: 'published', populate: ['seminar'] });
    assert.equal(published.duration, '12 часов');
    assert.equal(published.seminar.duration, '24 часа');
  });
  test('без обеих продолжительностей черновик сохраняется, публикация отклоняется', async () => {
    const f = await fixture();
    const draft = await f.entries.create({ data: fields(f) });
    assert.ok(draft.documentId);
    await assert.rejects(() => f.entries.publish({ documentId: draft.documentId }), /продолжительност|duration/i);
    assert.equal(await f.entries.findOne({ documentId: draft.documentId, status: 'published' }), null);
  });
  test('без преподавателей черновик сохраняется, публикация отклоняется', async () => {
    const f = await fixture();
    const draft = await f.entries.create({ data: fields(f, { duration: '12 часов', teachers: [] }) });
    assert.ok(draft.documentId);
    await assert.rejects(() => f.entries.publish({ documentId: draft.documentId }), /преподавател|teacher/i);
    assert.equal(await f.entries.findOne({ documentId: draft.documentId, status: 'published' }), null);
  });
  test('удаление default нельзя опубликовать при зависимом опубликованном проведении', async () => {
    const f = await fixture('24 часа');
    assert.equal((await f.seminars.findOne({ documentId: f.seminar.documentId, status: 'published' })).duration, '24 часа', 'предусловие: опубликован default');
    const entry = await f.entries.create({ data: fields(f) });
    await f.entries.publish({ documentId: entry.documentId });
    await f.seminars.update({ documentId: f.seminar.documentId, data: { duration: null } });
    await assert.rejects(() => f.seminars.publish({ documentId: f.seminar.documentId }), (error) => {
      assert.match(error.message, /продолжительност|duration/i);
      assert.ok(error.message.includes(entry.documentId) || error.message.includes(String(entry.id)) || error.message.includes('Москва'), 'ошибка должна указать затронутое проведение');
      return true;
    });
    const published = await f.seminars.findOne({ documentId: f.seminar.documentId, status: 'published' });
    assert.equal(published.duration, '24 часа');
  });
  test('черновое изменение default не меняет опубликованную версию семинара', async () => {
    const f = await fixture('24 часа');
    await f.seminars.update({ documentId: f.seminar.documentId, data: { duration: '48 часов' } });
    const draft = await f.seminars.findOne({ documentId: f.seminar.documentId });
    const published = await f.seminars.findOne({ documentId: f.seminar.documentId, status: 'published' });
    assert.equal(draft.duration, '48 часов');
    assert.equal(published.duration, '24 часа');
  });
  test('черновой default не позволяет публиковать проведение без override', async () => {
    const f = await fixture();
    await f.seminars.update({ documentId: f.seminar.documentId, data: { duration: '24 часа' } });
    assert.equal((await f.seminars.findOne({ documentId: f.seminar.documentId })).duration, '24 часа', 'предусловие: default в черновике');
    const draft = await f.entries.create({ data: fields(f) });
    await assert.rejects(() => f.entries.publish({ documentId: draft.documentId }), /продолжительност|duration/i);
    assert.equal(await f.entries.findOne({ documentId: draft.documentId, status: 'published' }), null);
  });
});
