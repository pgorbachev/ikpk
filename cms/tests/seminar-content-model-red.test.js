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

  test('клонирование семинара не переносит его сохранённое проведение', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const source = await seminars.create({ data: { name: 'Семинар A', slug: 'seminar-a' } });
    const entry = await entries.create({ data: { seminar: source.documentId } });
    const beforeClone = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
    assert.equal(beforeClone.seminar?.documentId, source.documentId);

    const clone = await seminars.clone({ documentId: source.documentId, data: { name: 'Клон A', slug: 'clone-a' } });
    const cloneId = clone.entries[0].documentId;
    assert.notEqual(cloneId, source.documentId);
    const afterClone = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
    assert.equal(afterClone.seminar?.documentId, source.documentId,
      `проведение перенесено: исходный семинар ${source.documentId}, клон ${cloneId}, фактически ${afterClone.seminar?.documentId}`);
  });

  test('первое сохранение проведения требует семинар', async () => {
    const entries = app.documents('api::schedule-entry.schedule-entry');
    await assert.rejects(() => entries.create({ data: { city: 'Тула' } }));
  });

  test('сохранённое проведение нельзя перенести на другой семинар', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const source = await seminars.create({ data: { name: 'Исходный семинар' } });
    const target = await seminars.create({ data: { name: 'Другой семинар' } });
    const entry = await entries.create({ data: { seminar: source.documentId } });
    await assert.rejects(() => entries.update({ documentId: entry.documentId, data: { seminar: target.documentId } }));
    const saved = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
    assert.equal(saved.seminar.documentId, source.documentId);
  });

  test('неканонические id и служебные pivot-поля не обходят проверки связей', async () => {
    const teachers = app.documents('api::teacher.teacher');
    const allowed = await teachers.create({ data: { name: 'Разрешённый pivot' } });
    const foreign = await teachers.create({ data: { name: 'Чужой pivot' } });
    const seminars = app.documents('api::seminar.seminar');
    const source = await seminars.create({ data: { name: 'Исходный pivot', teachers: [allowed.documentId] } });
    const target = await seminars.create({ data: { name: 'Другой pivot' } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: source.documentId, teachers: [allowed.documentId] } });
    for (const data of [
      { seminar: { id: `${target.id}.0` } },
      { seminar: { set: [{ id: source.id, __pivot: { seminar_id: target.id } }] } },
      { teachers: { connect: [{ id: allowed.id, __pivot: { teacher_id: foreign.id } }] } },
      { teachers: [{ id: `${foreign.id}.0` }] },
    ]) await assert.rejects(() => entries.update({ documentId: entry.documentId, data }));
    await assert.rejects(() => seminars.update({ documentId: source.documentId, data: { schedule_entries: { disconnect: [`${entry.id}.0`] } } }));
    const saved = await entries.findOne({ documentId: entry.documentId, populate: ['seminar', 'teachers'] });
    assert.equal(saved.seminar.documentId, source.documentId);
    assert.deepEqual(saved.teachers.map((teacher) => teacher.documentId), [allowed.documentId]);
  });

  test('публикация сохраняет подпись онлайн при заполнении имени проведения', async () => {
    const teacher = await app.documents('api::teacher.teacher').create({ status: 'published', data: { name: 'Для онлайн подписи', slug: 'online-label-teacher', legacy_id: 'online-label-teacher', trait: 'teacher' } });
    const seminars = app.documents('api::seminar.seminar');
    const seminar = await seminars.create({ data: { name: '', teachers: [teacher.documentId] } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId, teachers: [teacher.documentId], isOnline: true, duration: '24 часа', startAt: '2026-12-01T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z', entry_status: 'active', isFree: false, price: 500 } });
    await seminars.update({ documentId: seminar.documentId, data: { name: 'Название после создания', ...validSeminarPublicationFields, course_group: publishedProgram.documentId } });
    await seminars.publish({ documentId: seminar.documentId });
    await entries.publish({ documentId: entry.documentId });
    const saved = await entries.findOne({ documentId: entry.documentId, status: 'published' });
    assert.match(saved.admin_label, /Онлайн/);
    assert.doesNotMatch(saved.admin_label, /город не указан/);
  });

  test('переключение на бесплатное обнуляет сохранённую цену', async () => {
    const seminar = await app.documents('api::seminar.seminar').create({ data: { name: 'Цена' } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId, isFree: false, price: 500 } });
    const updated = await entries.update({ documentId: entry.documentId, data: { isFree: true } });
    assert.notEqual(updated.price, null);
    assert.equal(Number(updated.price), 0);
  });

  test('нельзя добавить преподавателя, отсутствующего в семинаре', async () => {
    const teachers = app.documents('api::teacher.teacher');
    const allowed = await teachers.create({ data: { name: 'Разрешённый' } });
    const foreign = await teachers.create({ data: { name: 'Другой' } });
    const seminar = await app.documents('api::seminar.seminar').create({ data: { name: 'Состав', teachers: [allowed.documentId] } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId, teachers: [allowed.documentId] } });
    await assert.rejects(() => entries.update({ documentId: entry.documentId, data: { teachers: [foreign.documentId] } }));
    const saved = await entries.findOne({ documentId: entry.documentId, populate: ['teachers'] });
    assert.deepEqual(saved.teachers.map((teacher) => teacher.documentId), [allowed.documentId]);
  });
  test('платное проведение без цены сохраняется и публикуется', async () => {
    const teacher = await app.documents('api::teacher.teacher').create({ status: 'published', data: { name: 'Преподаватель цены', slug: 'prepodavatel-tseny', legacy_id: 'prepodavatel-tseny', trait: 'teacher' } });
    const seminar = await app.documents('api::seminar.seminar').create({ status: 'published', data: { name: 'Семинар цены', ...validSeminarPublicationFields, course_group: publishedProgram.documentId, teachers: [teacher.documentId] } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const fields = { seminar: seminar.documentId, teachers: [teacher.documentId], city: 'Москва', duration: '24 часа', startAt: '2026-12-01T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z', entry_status: 'active', isFree: false };
    const control = await entries.create({ status: 'published', data: { ...fields, price: 500 } });
    assert.ok(control.publishedAt, 'контроль: положительная цена публикуется');
    const draft = await entries.create({ data: fields });
    assert.equal(draft.price ?? null, null);
    await entries.publish({ documentId: draft.documentId });
    const published = await entries.findOne({ documentId: draft.documentId, status: 'published' });
    assert.ok(published?.publishedAt);
    assert.equal(published.price ?? null, null);
  });

  for (const price of [0, -1]) {
    test(`платная цена ${price} отклоняется при сохранении`, async () => {
      const seminar = await app.documents('api::seminar.seminar').create({ data: { name: `Недопустимая цена ${price}` } });
      const entries = app.documents('api::schedule-entry.schedule-entry');
      const draft = await entries.create({ data: { seminar: seminar.documentId, isFree: false, price: 500 } });
      await assert.rejects(() => entries.update({ documentId: draft.documentId, data: { price } }), /цен|price/i);
      const saved = await entries.findOne({ documentId: draft.documentId });
      assert.equal(Number(saved.price), 500);
    });
  }

  test('переключение с бесплатного на платное очищает нулевую цену', async () => {
    const seminar = await app.documents('api::seminar.seminar').create({ data: { name: 'Цена после переключения' } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId, isFree: true } });
    assert.equal(Number(entry.price), 0);
    const updated = await entries.update({ documentId: entry.documentId, data: { isFree: false } });
    assert.equal(updated.price ?? null, null);
  });

  for (const price of [0, '0']) {
    test(`полный payload: бесплатное стало платным с ценой ${JSON.stringify(price)} — цена очищается`, async () => {
      const seminar = await app.documents('api::seminar.seminar').create({ data: { name: `Полный payload ${JSON.stringify(price)}` } });
      const entries = app.documents('api::schedule-entry.schedule-entry');
      const entry = await entries.create({ data: { seminar: seminar.documentId, isFree: true } });
      assert.equal(Number(entry.price), 0);
      const updated = await entries.update({ documentId: entry.documentId, data: { isFree: false, price } });
      assert.equal(updated.price ?? null, null);
      const saved = await entries.findOne({ documentId: entry.documentId });
      assert.equal(saved.price ?? null, null);
    });
  }

  test('полный payload: бесплатное стало платным с указанной положительной ценой — цена сохраняется', async () => {
    const seminar = await app.documents('api::seminar.seminar').create({ data: { name: 'Полный payload с положительной ценой' } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId, isFree: true } });
    assert.equal(Number(entry.price), 0);
    const updated = await entries.update({ documentId: entry.documentId, data: { isFree: false, price: 500 } });
    assert.equal(Number(updated.price), 500);
    const saved = await entries.findOne({ documentId: entry.documentId });
    assert.equal(Number(saved.price), 500);
  });

  test('изменение цены и платности черновика не меняет опубликованную версию до публикации', async () => {
    const teacher = await app.documents('api::teacher.teacher').create({ status: 'published', data: { name: 'Преподаватель версий', slug: 'prepodavatel-versiy', legacy_id: 'prepodavatel-versiy', trait: 'teacher' } });
    const seminar = await app.documents('api::seminar.seminar').create({ status: 'published', data: { name: 'Семинар версий цены', ...validSeminarPublicationFields, course_group: publishedProgram.documentId, teachers: [teacher.documentId] } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const published = await entries.create({ status: 'published', data: { seminar: seminar.documentId, teachers: [teacher.documentId], city: 'Москва', duration: '24 часа', startAt: '2026-12-01T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z', entry_status: 'active', isFree: false, price: 500 } });
    assert.ok(published.publishedAt);
    const draft = await entries.update({ documentId: published.documentId, data: { isFree: true } });
    assert.equal(draft.isFree, true);
    assert.equal(Number(draft.price), 0);
    const unchanged = await entries.findOne({ documentId: published.documentId, status: 'published' });
    assert.equal(unchanged.isFree, false);
    assert.equal(Number(unchanged.price), 500);
  });

  test('исторический преподаватель сохраняется при правке, но после удаления не выбирается повторно', async () => {
    const teachers = app.documents('api::teacher.teacher');
    const teacher = await teachers.create({ data: { name: 'Исторический преподаватель' } });
    const seminars = app.documents('api::seminar.seminar');
    const seminar = await seminars.create({ data: { name: 'Исторический состав', teachers: [teacher.documentId] } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId, teachers: [teacher.documentId] } });
    await seminars.update({ documentId: seminar.documentId, data: { teachers: [] } });
    await entries.update({ documentId: entry.documentId, data: { city: 'Казань', teachers: [teacher.documentId] } });
    let saved = await entries.findOne({ documentId: entry.documentId, populate: ['teachers'] });
    assert.deepEqual(saved.teachers.map((row) => row.documentId), [teacher.documentId]);
    await entries.update({ documentId: entry.documentId, data: { teachers: [] } });
    saved = await entries.findOne({ documentId: entry.documentId, populate: ['teachers'] });
    assert.deepEqual(saved.teachers, []);
    await assert.rejects(() => entries.update({ documentId: entry.documentId, data: { teachers: [teacher.documentId] } }));
    saved = await entries.findOne({ documentId: entry.documentId, populate: ['teachers'] });
    assert.deepEqual(saved.teachers, []);
  });

  test('обратная связь семинара не может отсоединить сохранённое проведение', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const seminar = await seminars.create({ data: { name: 'Обратная связь' } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId } });
    await assert.rejects(() => seminars.update({ documentId: seminar.documentId, data: { schedule_entries: { disconnect: [entry.documentId] } } }));
    const saved = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
    assert.equal(saved.seminar.documentId, seminar.documentId);
  });
  test('включение онлайн сохраняет формат и очищает прежний город', async () => {
    const seminar = await app.documents('api::seminar.seminar').create({ data: { name: 'Формат проведения' } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId, city: 'Москва', isOnline: false } });
    await entries.update({ documentId: entry.documentId, data: { isOnline: true } });
    const saved = await entries.findOne({ documentId: entry.documentId });
    assert.equal(saved.isOnline, true);
    assert.ok(saved.city == null || saved.city === '', 'город должен быть очищен');
  });
  async function formatFixture(suffix) {
    const teacher = await app.documents('api::teacher.teacher').create({
      status: 'published', data: { name: `Преподаватель ${suffix}`, slug: `format-${suffix}`, legacy_id: `format-${suffix}`, trait: 'teacher' },
    });
    const seminar = await app.documents('api::seminar.seminar').create({
      status: 'published', data: { name: `Формат ${suffix}`, ...validSeminarPublicationFields, course_group: publishedProgram.documentId, teachers: [teacher.documentId] },
    });
    return {
      seminar: seminar.documentId, teachers: [teacher.documentId], duration: '24 часа', price: 500, isFree: false,
      startAt: '2026-12-01T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z', entry_status: 'active',
    };
  }

  test('офлайн без города сохраняется черновиком, но не публикуется', async () => {
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const fields = await formatFixture('offline');
    const control = await entries.create({ status: 'published', data: { ...fields, isOnline: false, city: 'Москва' } });
    assert.ok(control.publishedAt, 'контроль: остальные поля допускают публикацию');
    const draft = await entries.create({ data: { ...fields, isOnline: false, city: '' } });
    assert.equal(draft.publishedAt ?? null, null);
    await assert.rejects(() => entries.publish({ documentId: draft.documentId }), /город|city/i);
    assert.equal(await entries.findOne({ documentId: draft.documentId, status: 'published' }), null);
  });

  test('онлайн без города публикуется при остальных валидных полях', async () => {
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const fields = await formatFixture('online');
    const control = await entries.create({ status: 'published', data: { ...fields, isOnline: false, city: 'Москва' } });
    assert.ok(control.publishedAt, 'контроль: остальные поля допускают публикацию');
    const draft = await entries.create({ data: { ...fields, isOnline: true, city: '' } });
    await entries.publish({ documentId: draft.documentId });
    const published = await entries.findOne({ documentId: draft.documentId, status: 'published' });
    assert.ok(published?.publishedAt);
    assert.equal(published.isOnline, true);
    assert.ok(published.city == null || published.city === '');
  });

  test('после выключения онлайн город можно заполнить и он обязателен для публикации', async () => {
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const fields = await formatFixture('toggle');
    const control = await entries.create({ status: 'published', data: { ...fields, isOnline: false, city: 'Москва' } });
    assert.ok(control.publishedAt, 'контроль: остальные поля допускают публикацию');
    const draft = await entries.create({ data: { ...fields, isOnline: true, city: '' } });
    await entries.update({ documentId: draft.documentId, data: { isOnline: false } });
    await assert.rejects(() => entries.publish({ documentId: draft.documentId }), /город|city/i);
    assert.equal(await entries.findOne({ documentId: draft.documentId, status: 'published' }), null);
    await entries.update({ documentId: draft.documentId, data: { city: 'Казань' } });
    const saved = await entries.findOne({ documentId: draft.documentId });
    assert.equal(saved.isOnline, false);
    assert.equal(saved.city, 'Казань');
    await entries.publish({ documentId: draft.documentId });
    const published = await entries.findOne({ documentId: draft.documentId, status: 'published' });
    assert.ok(published?.publishedAt);
    assert.equal(published.city, 'Казань');
  });
  for (const [name, relation] of [['null', null], ['set null', { set: null }]]) {
    test(`обратная связь ${name} не отвязывает сохранённое проведение`, async () => {
      const seminars = app.documents('api::seminar.seminar');
      const entries = app.documents('api::schedule-entry.schedule-entry');
      const seminar = await seminars.create({ data: { name: `Обратная связь ${name}` } });
      const entry = await entries.create({ data: { seminar: seminar.documentId } });
      let error;
      try {
        await seminars.update({ documentId: seminar.documentId, data: { schedule_entries: relation } });
      } catch (caught) {
        error = caught;
      }
      const saved = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
      assert.equal(saved.seminar?.documentId, seminar.documentId);
      assert.ok(error, 'попытка отсоединения должна отклоняться');
    });
  }
  test('set из прежнего и другого семинара не переносит сохранённое проведение', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const source = await seminars.create({ data: { name: 'Исходный для set' } });
    const other = await seminars.create({ data: { name: 'Другой для set' } });
    const entry = await entries.create({ data: { seminar: source.documentId } });
    let error;
    try {
      await entries.update({ documentId: entry.documentId, data: { seminar: { set: [source.documentId, other.documentId] } } });
    } catch (caught) {
      error = caught;
    }
    const saved = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
    assert.equal(saved.seminar?.documentId, source.documentId);
    assert.ok(error, 'попытка переноса должна отклоняться');
  });

  test('клон не получает преподавателя, удалённого из состава семинара', async () => {
    const teachers = app.documents('api::teacher.teacher');
    const teacher = await teachers.create({ data: { name: 'Преподаватель исходного проведения' } });
    const seminars = app.documents('api::seminar.seminar');
    const seminar = await seminars.create({ data: { name: 'Семинар для клона', teachers: [teacher.documentId] } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId, teachers: [teacher.documentId] } });
    await seminars.update({ documentId: seminar.documentId, data: { teachers: [] } });
    const original = await entries.findOne({ documentId: entry.documentId, populate: ['teachers'] });
    assert.deepEqual(original.teachers.map((row) => row.documentId), [teacher.documentId]);
    let clone;
    try {
      clone = await entries.clone({ documentId: entry.documentId });
    } catch (error) {
      assert.match(error.message, /преподавател|teacher/i);
      return;
    }
    const saved = await entries.findOne({ documentId: clone.entries[0].documentId, populate: ['teachers'] });
    assert.equal(saved.teachers.some((row) => row.documentId === teacher.documentId), false);
  });
  for (const field of ['isFree', 'isOnline']) {
    test(`строковое false для ${field} не обнуляет цену и не очищает город`, async () => {
      const seminar = await app.documents('api::seminar.seminar').create({ data: { name: `Строковый ${field}` } });
      const entries = app.documents('api::schedule-entry.schedule-entry');
      const entry = await entries.create({ data: { seminar: seminar.documentId, isFree: false, isOnline: false, city: 'Москва', price: 500 } });
      let accepted = true;
      try { await entries.update({ documentId: entry.documentId, data: { [field]: 'false' } }); }
      catch { accepted = false; /* Отказ неверного типа допустим. */ }
      const saved = await entries.findOne({ documentId: entry.documentId });
      assert.equal(Number(saved.price), 500);
      assert.equal(saved.city, 'Москва');
      assert.equal(saved.isFree, false);
      if (accepted) assert.equal(saved[field], false);
    });
  }

  test('строковое false не позволяет опубликовать платное с нулевой ценой', async () => {
    const fields = await formatFixture('stringfalse');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const control = await entries.create({ status: 'published', data: { ...fields, isOnline: false, city: 'Москва' } });
    assert.ok(control.publishedAt);
    let draft;
    try {
      draft = await entries.create({ data: { ...fields, isFree: 'false', isOnline: false, city: 'Москва', price: 0 } });
    } catch { return; /* Отказ неверного типа допустим. */ }
    try { await entries.publish({ documentId: draft.documentId }); } catch { /* Ожидаемый отказ. */ }
    assert.equal(await entries.findOne({ documentId: draft.documentId, status: 'published' }), null);
  });
  for (const action of ['read', 'create', 'update']) {
    test(`Editor может ${action} поле isOnline`, () => {
      const { EDITOR_PERMISSIONS } = loadCommonjs(path.join(cmsRoot, 'dist/src/lib/editor-role.js'));
      const permission = EDITOR_PERMISSIONS.find((row) => row.action === `plugin::content-manager.explorer.${action}` && row.subject === 'api::schedule-entry.schedule-entry');
      assert.ok(permission?.properties?.fields?.includes('isOnline'));
    });
  }

  test('пустой set с connect прежнего семинара не отвязывает проведение', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const seminar = await seminars.create({ data: { name: 'Противоречивый set' } });
    const entry = await entries.create({ data: { seminar: seminar.documentId } });
    try { await entries.update({ documentId: entry.documentId, data: { seminar: { set: [], connect: [seminar.documentId] } } }); } catch { /* Отказ допустим. */ }
    const saved = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
    assert.equal(saved.seminar?.documentId, seminar.documentId);
  });

  for (const [name, payload] of [['documentId', (entry) => entry.documentId], ['object id', (entry) => ({ id: entry.id })]]) {
    test(`обратная связь ${name} не отвязывает другое проведение`, async () => {
      const seminars = app.documents('api::seminar.seminar');
      const entries = app.documents('api::schedule-entry.schedule-entry');
      const seminar = await seminars.create({ data: { name: `Обратная связь ${name}` } });
      const first = await entries.create({ data: { seminar: seminar.documentId } });
      const second = await entries.create({ data: { seminar: seminar.documentId } });
      try { await seminars.update({ documentId: seminar.documentId, data: { schedule_entries: payload(first) } }); } catch { /* Отказ допустим. */ }
      for (const entry of [first, second]) {
        const saved = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
        assert.equal(saved.seminar?.documentId, seminar.documentId);
      }
    });
  }

  for (const [name, relation] of [['array', []], ['empty operations', { connect: [], disconnect: [] }]]) {
    test(`клон с teachers ${name} не сохраняет исторического преподавателя`, async () => {
      const teacher = await app.documents('api::teacher.teacher').create({ data: { name: `Исторический ${name}` } });
      const seminars = app.documents('api::seminar.seminar');
      const entries = app.documents('api::schedule-entry.schedule-entry');
      const seminar = await seminars.create({ data: { name: `Клон ${name}`, teachers: [teacher.documentId] } });
      const entry = await entries.create({ data: { seminar: seminar.documentId, teachers: [teacher.documentId] } });
      await seminars.update({ documentId: seminar.documentId, data: { teachers: [] } });
      const original = await entries.findOne({ documentId: entry.documentId, populate: ['teachers'] });
      assert.deepEqual(original.teachers.map((row) => row.documentId), [teacher.documentId]);
      let clone;
      try { clone = await entries.clone({ documentId: entry.documentId, data: { teachers: relation } }); }
      catch (error) { assert.match(error.message, /преподавател|teacher/i); return; }
      const saved = await entries.findOne({ documentId: clone.entries[0].documentId, populate: ['teachers'] });
      assert.equal(saved.teachers.some((row) => row.documentId === teacher.documentId), false);
    });
  }
  test('смешанный documentId и пустой connect не переносит проведение', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const source = await seminars.create({ data: { name: 'Исходный смешанный' } });
    const target = await seminars.create({ data: { name: 'Чужой смешанный' } });
    const entry = await entries.create({ data: { seminar: source.documentId } });
    try { await entries.update({ documentId: entry.documentId, data: { seminar: { documentId: target.documentId, connect: [] } } }); } catch { /* Отказ допустим. */ }
    const saved = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
    assert.equal(saved.seminar?.documentId, source.documentId);
  });

  test('смешанный documentId и пустой connect не назначает чужого преподавателя', async () => {
    const teachers = app.documents('api::teacher.teacher');
    const allowed = await teachers.create({ data: { name: 'Разрешённый смешанный' } });
    const foreign = await teachers.create({ data: { name: 'Чужой смешанный преподаватель' } });
    const seminar = await app.documents('api::seminar.seminar').create({ data: { name: 'Состав смешанный', teachers: [allowed.documentId] } });
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const entry = await entries.create({ data: { seminar: seminar.documentId, teachers: [allowed.documentId] } });
    try { await entries.update({ documentId: entry.documentId, data: { teachers: { documentId: foreign.documentId, connect: [] } } }); } catch { /* Отказ допустим. */ }
    const saved = await entries.findOne({ documentId: entry.documentId, populate: ['teachers'] });
    assert.equal(saved.teachers.some((teacher) => teacher.documentId === foreign.documentId), false);
  });
  for (const subject of ['seminar', 'teachers']) {
    test(`вложенный documentId с пустым connect не назначает чужой ${subject}`, async () => {
      const seminars = app.documents('api::seminar.seminar');
      const entries = app.documents('api::schedule-entry.schedule-entry');
      const teachers = app.documents('api::teacher.teacher');
      const allowed = await teachers.create({ data: { name: `Разрешённый вложенный ${subject}` } });
      const foreign = await teachers.create({ data: { name: `Чужой вложенный ${subject}` } });
      const source = await seminars.create({ data: { name: `Исходный вложенный ${subject}`, teachers: [allowed.documentId] } });
      const target = await seminars.create({ data: { name: `Чужой вложенный ${subject}` } });
      const entry = await entries.create({ data: { seminar: source.documentId, teachers: [allowed.documentId] } });
      const foreignId = subject === 'seminar' ? target.documentId : foreign.documentId;
      try { await entries.update({ documentId: entry.documentId, data: { [subject]: { connect: [{ documentId: foreignId, connect: [] }] } } }); } catch { /* Отказ допустим. */ }
      const saved = await entries.findOne({ documentId: entry.documentId, populate: ['seminar', 'teachers'] });
      if (subject === 'seminar') assert.equal(saved.seminar?.documentId, source.documentId);
      else assert.equal(saved.teachers.some((teacher) => teacher.documentId === foreignId), false);
    });
  }
  test('миграция штатных прав работает с реальной базой и повторно ничего не меняет', async () => {
    const role = await app.service('admin::role').findOne({ code: 'content-admin' });
    const permissions = app.db.query('admin::permission');
    const subjects = { 'api::seminar.seminar': 'duration', 'api::schedule-entry.schedule-entry': 'isOnline' };
    const rows = await permissions.findMany({ where: { role: { id: role.id } } });
    const selected = rows.filter((row) => subjects[row.subject] && /explorer\.(read|create|update)$/.test(row.action));
    assert.equal(selected.length, 6);
    for (const row of selected) {
      await permissions.update({ where: { id: row.id }, data: { properties: { ...row.properties, fields: row.properties.fields.filter((field) => field !== subjects[row.subject]) } } });
    }
    const { migrateContentAdminSchemaPermissions } = loadCommonjs(path.join(cmsRoot, 'dist/src/seminar-management/content-admin-role.js'));
    await migrateContentAdminSchemaPermissions(app);
    const migrated = await permissions.findMany({ where: { role: { id: role.id } } });
    for (const row of selected) {
      const current = migrated.find((item) => item.id === row.id);
      assert.ok(current.properties.fields.includes(subjects[row.subject]));
      assert.deepEqual(current.conditions, row.conditions);
    }
    await migrateContentAdminSchemaPermissions(app);
    const repeated = await permissions.findMany({ where: { role: { id: role.id } } });
    assert.deepEqual(repeated, migrated);
  });
  test('структурные сведения о документах и вложенный реестр сохраняются в опубликованной версии', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const seminar = await seminars.create({ status: 'published', data: {
      name: 'Проверка документа', ...validSeminarPublicationFields, course_group: publishedProgram.documentId,
      documents_state: 'issued', documents: [{ document: 'Удостоверение', issuer_unknown: true, prior_education: 'medical', completion_scope: 'full-cycle', completion_after_seminar_number: 4, registry: [{ name: 'ФИС ФРДО', subject: 'document', url: 'https://example.org/#register' }] }],
      nmo: { status: 'possible', url: 'https://example.org/#nmo' },
      training_registries: [{ name: 'IAHE', subject: 'training', url: 'https://example.org/#training' }],
    } });
    const saved = await seminars.findOne({ documentId: seminar.documentId, status: 'published', populate: { documents: { populate: ['registry'] }, nmo: true, training_registries: true } });
    assert.equal(saved.documents[0].issuer_unknown, true);
    assert.equal(saved.documents[0].completion_after_seminar_number, 4);
    assert.equal(saved.documents[0].registry[0].url, 'https://example.org/#register');
    assert.equal(saved.nmo.url, 'https://example.org/#nmo');
    assert.equal(saved.training_registries[0].url, 'https://example.org/#training');
  });
});
