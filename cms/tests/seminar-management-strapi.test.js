import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
const loadCommonjs = createRequire(import.meta.url);
const cmsRoot = path.join(import.meta.dirname, '..');
const dbFile = path.join(os.tmpdir(), `ikpk-seminar-management-${process.pid}.db`);

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
    delete process.env.CONTENT_ADMIN_EMAIL;
    delete process.env.CONTENT_ADMIN_PASSWORD;

    fs.mkdirSync(path.join(cmsRoot, 'public/uploads'), { recursive: true });
    const { createStrapi } = loadCommonjs('@strapi/strapi');
    app = createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
    await app.load();
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
      data: { name: 'Институт для теста', slug: 'institut-dlya-testa', legacy_id: 'institut-dlya-testa' },
    });
    publishedProgram = await app.documents('api::course-group.course-group').create({
      status: 'published',
      data: {
        name: 'Программа для теста',
        slug: 'programma-dlya-testa',
        legacy_id: 'programma-dlya-testa',
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

  test('форма создания семинара видит поля, а не только код роли', async () => {
    const contentTypes = app.plugin('content-manager').service('content-types');
    const configuration = await contentTypes.findConfiguration(app.contentType('api::seminar.seminar'));
    assert.match(configuration.metadatas.course_group.edit.description, /Для публикации выберите опубликованную программу/);
    const response = await fetch(`${base}/admin/users/me/permissions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const rows = body.data;
    const fieldsOf = (action, subject) => {
      const matches = rows.filter((row) => row.action === action && row.subject === subject);
      assert.equal(matches.length, 1, `${action} ${subject}`);
      return matches[0].properties?.fields ?? [];
    };
    const createFields = fieldsOf(
      'plugin::content-manager.explorer.create',
      'api::seminar.seminar',
    );
    for (const field of ['name', 'slug', 'description', 'course_group', 'teachers', 'seo.seo_title']) {
      assert.ok(createFields.includes(field), `create seminar missing ${field}`);
    }
    assert.deepEqual(
      fieldsOf('plugin::content-manager.explorer.read', 'api::seminar.seminar'),
      createFields,
    );
    assert.deepEqual(
      fieldsOf('plugin::content-manager.explorer.update', 'api::seminar.seminar'),
      createFields,
    );
    assert.equal(
      rows.some(
        (row) =>
          row.action === 'plugin::content-manager.explorer.publish' &&
          row.subject === 'api::seminar.seminar',
      ),
      true,
    );
    const entryFields = fieldsOf(
      'plugin::content-manager.explorer.create',
      'api::schedule-entry.schedule-entry',
    );
    for (const field of ['seminar', 'startAt', 'endAt', 'city']) {
      assert.ok(entryFields.includes(field), `create entry missing ${field}`);
    }
    assert.equal(
      rows.some(
        (row) =>
          row.action === 'plugin::content-manager.explorer.create' &&
          row.subject === 'api::course-group.course-group',
      ),
      false,
    );
    assert.ok(
      fieldsOf('plugin::content-manager.explorer.read', 'api::teacher.teacher').includes('name'),
    );
  });

  test('черновик без программы сохраняется, публикация сообщает о недостающей связи', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const draft = await seminars.create({ data: { name: 'Пока без программы' } });
    assert.equal(draft.publishedAt ?? null, null);

    await assert.rejects(
      () => seminars.publish({ documentId: draft.documentId }),
      /Выберите опубликованную программу перед публикацией семинара/,
    );
    await assert.rejects(
      () => seminars.create({ status: 'published', data: { name: 'Без программы сразу' } }),
      /Выберите опубликованную программу перед публикацией семинара/,
    );
    await assert.rejects(
      () => seminars.create({
        status: 'published',
        data: {
          name: 'Подмена пустой связью',
          course_group: { set: [], connect: [publishedProgram.documentId] },
        },
      }),
      /Выберите опубликованную программу перед публикацией семинара/,
    );
    const stillDraft = await seminars.findOne({ documentId: draft.documentId, status: 'published' });
    assert.equal(stillDraft, null);
  });

  test('семинар публикуется только со связанной опубликованной программой сайта', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const programs = app.documents('api::course-group.course-group');
    const program = await programs.create({
      data: {
        name: 'Программа-черновик',
        slug: 'programma-chernovik',
        legacy_id: 'programma-chernovik',
        institute: publishedInstitute.documentId,
      },
    });
    const seminar = await seminars.create({
      data: { name: 'Ждёт программу', course_group: program.documentId },
    });
    await assert.rejects(
      () => seminars.publish({ documentId: seminar.documentId }),
      /Выберите опубликованную программу перед публикацией семинара/,
    );
    await programs.publish({ documentId: program.documentId });
    await seminars.publish({ documentId: seminar.documentId });
    const published = await seminars.findOne({
      documentId: seminar.documentId,
      status: 'published',
      populate: ['course_group'],
    });
    assert.equal(published.course_group.documentId, program.documentId);
    await seminars.update({
      documentId: seminar.documentId,
      status: 'published',
      data: { duration: '3 дня', course_group: { connect: [], disconnect: [] } },
    });
    await assert.rejects(
      () => seminars.update({
        documentId: seminar.documentId,
        status: 'published',
        data: { course_group: { set: [] } },
      }),
      /Выберите опубликованную программу перед публикацией семинара/,
    );

    const noSiteId = await programs.create({
      status: 'published',
      data: { name: 'Без идентификатора сайта', slug: 'bez-identifikatora-sayta' },
    });
    await assert.rejects(
      () => seminars.create({
        status: 'published',
        data: { name: 'Не попадёт на сайт', course_group: noSiteId.documentId },
      }),
      /нет идентификатора для сайта/,
    );

    const noInstitute = await programs.create({
      status: 'published',
      data: { name: 'Без института', slug: 'bez-instituta', legacy_id: 'bez-instituta' },
    });
    await assert.rejects(
      () => seminars.create({
        status: 'published',
        data: { name: 'Неизвестный институт', course_group: noInstitute.documentId },
      }),
      /нет опубликованного института для сайта/,
    );
  });

  test('список выбора по HTTP содержит свободное проведение и не содержит чужое', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const seminarA = await seminars.create({ data: { name: 'Семинар A' } });
    const seminarB = await seminars.create({ data: { name: 'Семинар B' } });
    const foreign = await entries.create({
      data: { seminar: seminarB.documentId, startAt: '2026-04-01T00:00:00.000Z', city: 'Казань' },
    });
    const free = await entries.create({
      data: { startAt: '2026-03-12T00:00:00.000Z', city: 'Москва' },
    });

    const response = await fetch(
      `${base}/content-manager/relations/api::seminar.seminar/schedule_entries?id=${seminarA.documentId}&page=1&pageSize=100`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const ids = body.results.map((row) => row.documentId);
    assert.ok(ids.includes(free.documentId));
    assert.equal(ids.includes(foreign.documentId), false);
    const freeRow = body.results.find((row) => row.documentId === free.documentId);
    assert.equal(freeRow.admin_label, '12 марта 2026 · Москва');
  });

  test('массив и числовой id не переносят чужое проведение', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const seminarA = await seminars.create({ data: { name: 'Источник' } });
    const seminarB = await seminars.create({ data: { name: 'Получатель' } });
    const entry = await entries.create({ data: { seminar: seminarA.documentId } });

    await assert.rejects(
      () => seminars.update({ documentId: seminarB.documentId, data: { schedule_entries: [entry.documentId] } }),
      /другому семинару/,
    );
    await assert.rejects(
      () =>
        seminars.update({
          documentId: seminarB.documentId,
          data: { schedule_entries: { connect: [{ id: entry.id }] } },
        }),
      /другому семинару/,
    );
    await assert.rejects(
      () =>
        seminars.update({
          documentId: seminarB.documentId,
          data: { schedule_entries: { connect: [String(entry.id)] } },
        }),
      /другому семинару/,
    );
    const kept = await entries.findOne({ documentId: entry.documentId, populate: ['seminar'] });
    assert.equal(kept.seminar.documentId, seminarA.documentId);

    const free = await entries.create({ data: { city: 'Тула' } });
    await seminars.update({
      documentId: seminarA.documentId,
      data: { schedule_entries: [entry.documentId, free.documentId] },
    });
    const attached = await entries.findOne({ documentId: free.documentId, populate: ['seminar'] });
    assert.equal(attached.seminar.documentId, seminarA.documentId);
  });

  test('публикация через create и клонирование не обходят правила', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const seminar = await seminars.create({ data: { name: 'Для клона' } });
    const entry = await entries.create({ data: { seminar: seminar.documentId, city: 'Омск' } });

    await assert.rejects(
      () =>
        entries.create({
          status: 'published',
          data: { startAt: '2026-05-10T00:00:00.000Z', endAt: '2026-05-09T00:00:00.000Z' },
        }),
      (error) => {
        assert.match(error.message, /Укажите семинар/);
        assert.match(error.message, /Окончание проведения не может быть раньше начала/);
        return true;
      },
    );
    const leaked = await app.db.query('api::schedule-entry.schedule-entry').findMany({
      where: { endAt: '2026-05-09T00:00:00.000Z', publishedAt: { $notNull: true } },
    });
    assert.equal(leaked.length, 0);

    const draft = await entries.create({ data: { startAt: '2026-06-01T00:00:00.000Z' } });
    assert.equal(draft.publishedAt ?? null, null);

    const cloned = await entries.clone({ documentId: entry.documentId, data: { name: 'Arbitrary forged name' } });
    assert.equal(cloned.entries[0].name, 'Для клона');

    const role = await app.service('admin::role').findOne({ code: 'content-admin' });
    const user = await app.db.query('admin::user').findOne({
      where: { preferedLanguage: 'ru' },
      populate: ['roles'],
    });
    const ability = await app.service('admin::permission').engine.generateUserAbility(user);
    const ctx = {
      state: { userAbility: ability, user },
      params: { model: 'api::schedule-entry.schedule-entry', sourceId: entry.documentId },
      request: { body: { name: 'Forged via content-admin clone' } },
      query: {},
      forbidden() {
        throw new Error('forbidden');
      },
      notFound() {
        throw new Error('notFound');
      },
    };
    await app.plugin('content-manager').controller('collection-types').clone(ctx);
    assert.notEqual(ctx.body.data.name, 'Forged via content-admin clone');
    assert.equal(ctx.body.data.name, 'Для клона');
    assert.equal(role.code, 'content-admin');

    const publishedSeminar = await seminars.create({
      status: 'published',
      data: { name: 'Опубликованный', course_group: publishedProgram.documentId },
    });
    const published = await entries.create({
      status: 'published',
      data: {
        seminar: publishedSeminar.documentId,
        startAt: '2026-07-01T00:00:00.000Z',
        endAt: '2026-07-02T00:00:00.000Z',
      },
    });
    const beforeRemoval = await entries.findOne({
      documentId: published.documentId,
      status: 'published',
      populate: ['seminar'],
    });
    assert.equal(beforeRemoval.seminar.documentId, publishedSeminar.documentId);
    for (const seminarPayload of [
      { set: [] },
      [],
      { disconnect: [publishedSeminar.documentId], connect: [] },
    ]) {
      await assert.rejects(
        () =>
          entries.update({
            documentId: published.documentId,
            status: 'published',
            data: { seminar: seminarPayload },
          }),
        /Укажите семинар/,
      );
    }
    const stillPublished = await entries.findOne({
      documentId: published.documentId,
      status: 'published',
      populate: ['seminar'],
    });
    assert.equal(stillPublished.seminar.documentId, publishedSeminar.documentId);
    assert.ok(stillPublished.publishedAt);

    const source = await seminars.create({
      status: 'published',
      data: { name: 'Семинар А', course_group: publishedProgram.documentId },
    });
    const target = await seminars.create({
      status: 'published',
      data: { name: 'Семинар Б', course_group: publishedProgram.documentId },
    });
    const reassignment = [
      ['numericString', () => String(target.id)],
      ['numericObject', () => ({ connect: [{ id: target.id }] })],
      ['numericArray', () => [target.id]],
      ['numericSet', () => ({ set: [{ id: target.id }] })],
      ['numericConnectString', () => ({ connect: [String(target.id)] })],
      ['numericPositional', () => ({ id: target.id })],
    ];
    for (const [, payload] of reassignment) {
      const row = await entries.create({
        status: 'published',
        data: {
          seminar: source.documentId,
          startAt: '2026-08-01T00:00:00.000Z',
          endAt: '2026-08-02T00:00:00.000Z',
        },
      });
      assert.equal(row.name, 'Семинар А');
      await entries.update({
        documentId: row.documentId,
        status: 'published',
        data: { seminar: payload() },
      });
      const moved = await entries.findOne({
        documentId: row.documentId,
        status: 'published',
        populate: ['seminar'],
      });
      assert.equal(moved.seminar.documentId, target.documentId);
      assert.equal(moved.name, 'Семинар Б');
    }
    const unnamed = await seminars.create({ data: { name: '' } });
    const stays = await entries.create({
      status: 'published',
      data: {
        seminar: source.documentId,
        startAt: '2026-08-03T00:00:00.000Z',
        endAt: '2026-08-04T00:00:00.000Z',
      },
    });
    await assert.rejects(
      () =>
        entries.update({
          documentId: stays.documentId,
          status: 'published',
          data: { seminar: String(unnamed.id) },
        }),
      /название семинара/,
    );
    const kept = await entries.findOne({
      documentId: stays.documentId,
      status: 'published',
      populate: ['seminar'],
    });
    assert.equal(kept.seminar.documentId, source.documentId);
    assert.equal(kept.name, 'Семинар А');

    const other = await seminars.create({ data: { name: 'Чужой' } });
    const foreign = await entries.create({ data: { seminar: other.documentId } });
    await assert.rejects(
      () =>
        seminars.clone({
          documentId: seminar.documentId,
          data: {
            name: 'Клон',
            slug: `klon-${Date.now()}`,
            schedule_entries: { connect: [foreign.documentId] },
          },
        }),
      /другому семинару/,
    );
    const foreignAfter = await entries.findOne({ documentId: foreign.documentId, populate: ['seminar'] });
    assert.equal(foreignAfter.seminar.documentId, other.documentId);
  });

  test('пустая подпись прежней строки заполняется без смены имени', async () => {
    const created = await app.db.query('api::schedule-entry.schedule-entry').create({
      data: {
        documentId: `legacy-${Date.now()}`,
        name: 'Н-ПК-1',
        startAt: '2026-03-12T00:00:00.000Z',
        city: 'Москва',
        admin_label: null,
        publishedAt: null,
      },
    });
    const { backfillAdminLabels } = loadCommonjs(path.join(cmsRoot, 'dist/src/seminar-management/documents.js'));
    await backfillAdminLabels(app);
    const stored = await app.db.query('api::schedule-entry.schedule-entry').findOne({ where: { id: created.id } });
    assert.equal(stored.name, 'Н-ПК-1');
    assert.equal(stored.admin_label, '12 марта 2026 · Москва');
  });

  test('подпись проведения берёт день редактора и не сдвигает его в Москву', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const seminar = await seminars.create({ data: { name: `Зоны ${Date.now()}` } });
    const created = await entries.create({
      data: {
        seminar: seminar.documentId,
        startAt: '2026-11-01T23:30:00+02:00',
        endAt: '2026-11-02T01:00:00+02:00',
        city: 'Никосия',
      },
    });
    assert.equal(created.admin_label, '1 ноября 2026 · Никосия');
    const kept = await entries.update({
      documentId: created.documentId,
      data: { city: 'Ларнака', startAt: '2026-11-01T21:30:00.000Z' },
    });
    assert.equal(kept.admin_label, '1 ноября 2026 · Ларнака');
    const midnight = await entries.create({
      data: {
        seminar: seminar.documentId,
        startAt: '2026-10-01T00:00:00+03:00',
        endAt: '2026-10-01T10:00:00+03:00',
        city: 'Москва',
      },
    });
    assert.equal(midnight.admin_label, '1 октября 2026 · Москва');
  });

  test('съём читает тип, закрытый для публичной роли', async () => {
    const action = 'api::institute.institute.find';
    const permissions = app.db.query('plugin::users-permissions.permission');
    const rows = await permissions.findMany({ where: { action } });
    for (const row of rows) {
      await permissions.delete({ where: { id: row.id } });
    }
    const anon = await fetch(`${base}/api/institutes?status=published&pagination[pageSize]=1`);
    assert.equal(anon.status, 403);
    assert.equal(typeof process.env.CMS_TOKEN, 'string');
    assert.ok(process.env.CMS_TOKEN.length > 20);
    const authed = await fetch(`${base}/api/institutes?status=published&pagination[pageSize]=1`, {
      headers: { Authorization: `Bearer ${process.env.CMS_TOKEN}` },
    });
    assert.equal(authed.status, 200);
    const body = await authed.json();
    assert.ok(Array.isArray(body.data));
    const kept = createHash('sha256').update(process.env.CMS_TOKEN).digest('hex');
    const { ensureCaptureToken } = loadCommonjs(path.join(cmsRoot, 'dist/src/seminar-management/capture-token.js'));
    await ensureCaptureToken(app);
    assert.equal(createHash('sha256').update(process.env.CMS_TOKEN).digest('hex'), kept);
  });
});
