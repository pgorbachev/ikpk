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
    for (const field of ['seminar', 'startAt', 'endAt', 'city', 'teachers']) {
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
    assert.equal(rows.some((row) =>
      row.action === 'plugin::content-manager.explorer.update' && row.subject === 'api::teacher.teacher'), false);
  });

  // Найдено при приёмке 07.10.2026: «мой семинар» не находил «Мой семинар Новый». Поиск админки
  // на SQLite — `поле LIKE ? ESCAPE '\\'`, а встроенный LIKE не различает регистр только у латиницы.
  test('поиск в админке не зависит от регистра кириллицы', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const cyrillic = await seminars.create({ data: { name: 'Мой семинар Поиска' } });
    const latin = await seminars.create({ data: { name: 'Latin Search Probe' } });
    const found = async (query) => {
      const response = await fetch(
        `${base}/content-manager/collection-types/api::seminar.seminar?_q=${encodeURIComponent(query)}&page=1&pageSize=100`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body.results.map((row) => row.documentId);
    };
    assert.ok((await found('мой семинар поиска')).includes(cyrillic.documentId), 'строчные');
    assert.ok((await found('МОЙ СЕМИНАР ПОИСКА')).includes(cyrillic.documentId), 'прописные');
    assert.ok((await found('latin search')).includes(latin.documentId), 'латиница');
    assert.equal((await found('latin search')).includes(cyrillic.documentId), false, 'LIKE совпал со всем подряд');
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
    const unpublished = await app.documents('api::course-group.course-group').create({
      data: { name: 'Неопубликованная программа', slug: 'neopublikovannaya-programma' },
    });
    await assert.rejects(
      () => seminars.create({
        status: 'published',
        data: {
          name: 'Противоречивые идентификаторы',
          course_group: { id: publishedProgram.id, documentId: unpublished.documentId },
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
        ...validCourseGroupPublicationFields,
        institute: publishedInstitute.documentId,
      },
    });
    const seminar = await seminars.create({
      data: {
        name: 'Ждёт программу',
        ...validSeminarPublicationFields,
        course_group: program.documentId,
      },
    });
    await assert.rejects(
      () => seminars.publish({ documentId: seminar.documentId }),
      /Выберите опубликованную программу перед публикацией семинара/,
    );
    await programs.publish({ documentId: program.documentId });
    const publishedProgramRecord = await programs.findOne({
      documentId: program.documentId,
      status: 'published',
    });
    assert.ok(publishedProgramRecord?.publishedAt, 'программа должна быть опубликована до семинара');
    await seminars.publish({ documentId: seminar.documentId });
    const published = await seminars.findOne({
      documentId: seminar.documentId,
      status: 'published',
      populate: ['course_group'],
    });
    assert.ok(published?.publishedAt, 'семинар должен быть опубликован');
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
      data: {
        name: 'Без идентификатора сайта',
        slug: 'bez-identifikatora-sayta',
        institute: publishedInstitute.documentId,
        ...validCourseGroupPublicationFields,
      },
    });
    await assert.rejects(
      () => seminars.create({
        status: 'published',
        data: {
          name: 'Не попадёт на сайт',
          ...validSeminarPublicationFields,
          course_group: noSiteId.documentId,
        },
      }),
      /нет идентификатора для сайта/,
    );

    await assert.rejects(
      () => programs.create({
        status: 'published',
        data: {
          name: 'Без института',
          slug: 'bez-instituta',
          legacy_id: 'bez-instituta',
          ...validCourseGroupPublicationFields,
        },
      }),
      /не заполнены обязательные поля: institute/,
    );
    const matchingIds = await seminars.create({
      status: 'published',
      data: {
        name: 'Совпадающие идентификаторы',
        ...validSeminarPublicationFields,
        course_group: { id: publishedProgram.id, documentId: publishedProgram.documentId },
      },
    });
    assert.ok(matchingIds.publishedAt);
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
      data: { name: 'Опубликованный', ...validSeminarPublicationFields, course_group: publishedProgram.documentId },
    });
    const published = await entries.create({
      status: 'published',
      data: {
        seminar: publishedSeminar.documentId,
        startAt: '2026-07-01T00:00:00.000Z',
        endAt: '2026-07-02T00:00:00.000Z',
        city: 'Москва',
        entry_status: 'active',
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
      data: { name: 'Семинар А', ...validSeminarPublicationFields, course_group: publishedProgram.documentId },
    });
    const target = await seminars.create({
      status: 'published',
      data: { name: 'Семинар Б', ...validSeminarPublicationFields, course_group: publishedProgram.documentId },
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
          city: 'Москва',
          entry_status: 'active',
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
        city: 'Москва',
        entry_status: 'active',
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
        entry_status: 'active',
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
        entry_status: 'active',
      },
    });
    assert.equal(midnight.admin_label, '1 октября 2026 · Москва');
  });

  test('черновик проведения может ссылаться на неопубликованного преподавателя, но его публикация отклоняется', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const teachers = app.documents('api::teacher.teacher');
    const seminar = await seminars.create({
      status: 'published',
      data: { name: 'Семинар для неопубликованного преподавателя', ...validSeminarPublicationFields,
        course_group: publishedProgram.documentId },
    });
    const teacher = await teachers.create({ data: {
      name: 'Черновой преподаватель', slug: 'draft-event-teacher', trait: 'teacher', legacy_id: 'draft-event-101',
    } });
    const entry = await entries.create({ data: {
      seminar: seminar.documentId, teachers: [teacher.documentId], city: 'Москва',
      startAt: '2027-03-17T00:00:00.000Z', endAt: '2027-03-21T00:00:00.000Z',
    } });
    assert.equal(entry.publishedAt ?? null, null, 'черновик должен сохраняться');
    await assert.rejects(() => entries.publish({ documentId: entry.documentId }), /преподавател/i);
    assert.equal(await entries.findOne({ documentId: entry.documentId, status: 'published' }), null);
  });

  test('при публикации проведения нужны имя и legacy_id опубликованной версии преподавателя', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const teachers = app.documents('api::teacher.teacher');
    const seminar = await seminars.create({
      status: 'published',
      data: { name: 'Семинар для опубликованного преподавателя', ...validSeminarPublicationFields,
        course_group: publishedProgram.documentId },
    });
    const teacher = await teachers.create({ status: 'published', data: {
      name: 'Преподаватель без идентификатора', slug: 'event-teacher-without-legacy', trait: 'teacher',
    } });
    await teachers.update({ documentId: teacher.documentId, data: { legacy_id: 'draft-only-identifier' } });
    const entry = await entries.create({ data: {
      seminar: seminar.documentId, teachers: [teacher.documentId], city: 'Москва',
      startAt: '2027-03-17T00:00:00.000Z', endAt: '2027-03-21T00:00:00.000Z',
    } });
    await assert.rejects(() => entries.publish({ documentId: entry.documentId }), /преподавател/i);
    assert.equal(await entries.findOne({ documentId: entry.documentId, status: 'published' }), null);
  });

  test('числовой startAt не обходит требование преподавателя при create и update status=published', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const seminar = await seminars.create({
      status: 'published',
      data: { name: 'Семинар для числового startAt', ...validSeminarPublicationFields,
        course_group: publishedProgram.documentId },
    });
    const startAt = 1_893_456_000_000;
    const endAt = 1_893_542_400_000;
    const entryData = {
      seminar: seminar.documentId, city: 'Москва', entry_status: 'active', startAt, endAt, teachers: [],
    };

    await assert.rejects(
      () => entries.create({ status: 'published', data: entryData }),
      /преподавател/i,
      'create со status=published должен пройти ту же teacher-проверку, что прямой publish',
    );

    const draft = await entries.create({ data: entryData });
    await assert.rejects(
      () => entries.update({ documentId: draft.documentId, status: 'published', data: {} }),
      /преподавател/i,
      'update со status=published не должен обходить проверку',
    );
    assert.equal(await entries.findOne({ documentId: draft.documentId, status: 'published' }), null);
  });

  test('назначение преподавателя одному проведению не меняет другое проведение и общий семинар', async () => {
    const seminars = app.documents('api::seminar.seminar');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const teachers = app.documents('api::teacher.teacher');
    const one = await teachers.create({ status: 'published', data: {
      name: 'Первый преподаватель', slug: 'event-teacher-one', trait: 'teacher', legacy_id: 'event-teacher-201',
    } });
    const two = await teachers.create({ status: 'published', data: {
      name: 'Второй преподаватель', slug: 'event-teacher-two', trait: 'teacher', legacy_id: 'event-teacher-202',
    } });
    const seminar = await seminars.create({ status: 'published', data: {
      name: 'Семинар с разными преподавателями', ...validSeminarPublicationFields,
      course_group: publishedProgram.documentId, teachers: [one.documentId],
    } });
    const data = { seminar: seminar.documentId, city: 'Москва', entry_status: 'active',
      startAt: '2027-03-17T00:00:00.000Z', endAt: '2027-03-21T00:00:00.000Z' };
    const event = await entries.create({ status: 'published', data: { ...data, teachers: [two.documentId] } });
    const other = await entries.create({ status: 'published', data: { ...data, teachers: [one.documentId] } });
    const get = (api, documentId) => api.findOne({ documentId, status: 'published', populate: ['teachers'] });
    assert.deepEqual((await get(entries, event.documentId)).teachers.map((t) => t.documentId), [two.documentId]);
    assert.deepEqual((await get(entries, other.documentId)).teachers.map((t) => t.documentId), [one.documentId]);
    assert.deepEqual((await get(seminars, seminar.documentId)).teachers.map((t) => t.documentId), [one.documentId]);
    await entries.update({ documentId: event.documentId, data: { teachers: [one.documentId] } });
    assert.deepEqual((await get(entries, event.documentId)).teachers.map((t) => t.documentId), [two.documentId],
      'неопубликованная правка проведения не меняет опубликованную связь');
    await entries.publish({ documentId: event.documentId });
    assert.deepEqual((await get(entries, event.documentId)).teachers.map((t) => t.documentId), [one.documentId]);
    assert.deepEqual((await get(entries, other.documentId)).teachers.map((t) => t.documentId), [one.documentId]);
  });

  async function protectionFixture(suffix, { startAt, endAt, entryStatus = 'active', additionalText } = {}) {
    const teachers = app.documents('api::teacher.teacher');
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const seminars = app.documents('api::seminar.seminar');
    const teacher = await teachers.create({ status: 'published', data: {
      name: `Преподаватель ${suffix}`, slug: `event-protection-${suffix}`,
      trait: 'teacher', legacy_id: `event-protection-${suffix}`,
    } });
    const seminar = await seminars.create({ status: 'published', data: {
      name: `Семинар защиты ${suffix}`, ...validSeminarPublicationFields, course_group: publishedProgram.documentId,
    } });
    const event = await entries.create({ status: 'published', data: {
      seminar: seminar.documentId, teachers: [teacher.documentId], city: 'Москва', entry_status: entryStatus,
      startAt, endAt: endAt ?? startAt, ...(additionalText ? { additionalText } : {}),
    } });
    return { teachers, entries, seminar, teacher, event };
  }

  for (const action of ['unpublish', 'delete']) {
    test(`защита преподавателя: будущее опубликованное активное проведение блокирует ${action}`, async () => {
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const { teachers, entries, teacher, event } = await protectionFixture(`future-${action}`, { startAt: future });
      await assert.rejects(() => teachers[action]({ documentId: teacher.documentId }), /проведен|семинар/i);
      assert.ok(await teachers.findOne({ documentId: teacher.documentId, status: 'published' }),
        `${action} не должен удалять опубликованного преподавателя`);
      const saved = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
      assert.deepEqual(saved.teachers.map(t => t.documentId), [teacher.documentId], 'связь проведения сохранена');
    });
  }

  test('защита преподавателя: прошедшие и отменённые проведения не запрещают unpublish и delete', async () => {
    const past = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    for (const [kind, startAt, entryStatus] of [
      ['past', past, 'active'], ['cancelled', future, 'cancelled'], ['completed', future, 'completed'],
    ]) {
      for (const action of ['unpublish', 'delete']) {
        const current = await protectionFixture(`${kind}-${action}`, { startAt, entryStatus });
        await current.teachers[action]({ documentId: current.teacher.documentId });
        assert.equal(await current.teachers.findOne({ documentId: current.teacher.documentId, status: 'published' }), null,
          `${kind}: ${action} не должен быть заблокирован`);
      }
    }
  });

  test('защита преподавателя: правка черновика не меняет опубликованные данные и допустима', async () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { teachers, teacher } = await protectionFixture('draft-edit', { startAt: future });
    await teachers.update({ documentId: teacher.documentId, data: { name: 'Имя в черновике' } });
    const draft = await teachers.findOne({ documentId: teacher.documentId, status: 'draft' });
    const published = await teachers.findOne({ documentId: teacher.documentId, status: 'published' });
    assert.equal(draft.name, 'Имя в черновике');
    assert.equal(published.name, teacher.name);
  });

  test('защита преподавателя: черновая отмена не снимает защиту опубликованного проведения', async () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { teachers, entries, teacher, event } = await protectionFixture('draft-cancellation', { startAt: future });
    await entries.update({ documentId: event.documentId, data: { entry_status: 'cancelled' } });
    const published = await entries.findOne({ documentId: event.documentId, status: 'published' });
    assert.equal(published.entry_status, 'active', 'отмена пока существует только в черновике');
    await assert.rejects(() => teachers.unpublish({ documentId: teacher.documentId }), /проведен|семинар/i);
    assert.ok(await teachers.findOne({ documentId: teacher.documentId, status: 'published' }));
  });

  test('защита преподавателя: проведение с отсутствующей датой не считается будущим', async () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { teachers, teacher, event } = await protectionFixture('missing-date', { startAt: future });
    // Симулируем историческую опубликованную запись без даты: обычная публикация сейчас её не допускает.
    await app.db.query('api::schedule-entry.schedule-entry').update({ where: { id: event.id }, data: { startAt: null } });
    await teachers.unpublish({ documentId: teacher.documentId });
    assert.equal(await teachers.findOne({ documentId: teacher.documentId, status: 'published' }), null);
  });

  test('защита преподавателя: граница начала при отсутствии времени — полночь Москвы', async (t) => {
    const { teachers, teacher } = await protectionFixture('midnight', { startAt: '2026-10-28T21:00:00.000Z' });
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-28T20:59:00.000Z') });
    await assert.rejects(() => teachers.unpublish({ documentId: teacher.documentId }), /проведен|семинар/i);
    t.mock.timers.setTime(Date.parse('2026-10-28T21:01:00.000Z'));
    await teachers.unpublish({ documentId: teacher.documentId });
    assert.equal(await teachers.findOne({ documentId: teacher.documentId, status: 'published' }), null);
  });

  test('защита преподавателя: одно явное время начала задаёт московскую границу', async (t) => {
    const { teachers, teacher } = await protectionFixture('explicit-time', {
      startAt: '2026-10-28T21:00:00.000Z', additionalText: 'Начало в 10:30',
    });
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-29T07:29:00.000Z') });
    await assert.rejects(() => teachers.unpublish({ documentId: teacher.documentId }), /проведен|семинар/i);
    t.mock.timers.setTime(Date.parse('2026-10-29T07:31:00.000Z'));
    await teachers.unpublish({ documentId: teacher.documentId });
    assert.equal(await teachers.findOne({ documentId: teacher.documentId, status: 'published' }), null);
  });

  test('защита преподавателя: неоднозначное время не продлевает границу после полуночи Москвы', async (t) => {
    const { teachers, teacher } = await protectionFixture('ambiguous-time', {
      startAt: '2026-10-28T21:00:00.000Z', additionalText: 'Начало в 10:30 или начало в 11:30',
    });
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-29T07:29:00.000Z') });
    await teachers.unpublish({ documentId: teacher.documentId });
    assert.equal(await teachers.findOne({ documentId: teacher.documentId, status: 'published' }), null);
  });

  for (const action of ['create', 'update']) {
    test(`защита преподавателя: прямой published ${action} не обходит проверку связи`, async () => {
      const { teachers, entries, seminar, teacher, event } = await protectionFixture(`direct-${action}`, {
        startAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const draftTeacher = await teachers.create({ data: { name: 'Неопубликованный прямой',
        slug: `event-protection-draft-${action}`, trait: 'teacher', legacy_id: `direct-draft-${action}` } });
      const data = { seminar: seminar.documentId, teachers: [draftTeacher.documentId], city: 'Москва', entry_status: 'active',
        startAt: '2030-03-17T00:00:00.000Z', endAt: '2030-03-21T00:00:00.000Z' };
      if (action === 'create') {
        await assert.rejects(() => entries.create({ status: 'published', data }), /преподавател/i);
      } else {
        await assert.rejects(() => entries.update({ documentId: event.documentId, status: 'published',
          data: { teachers: [draftTeacher.documentId] } }), /преподавател/i);
        const saved = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
        assert.deepEqual(saved.teachers.map(t => t.documentId), [teacher.documentId]);
      }
    });
  }

  test('защита преподавателя: одновременная публикация проведения и снятие преподавателя сохраняют инвариант', async () => {
    for (let n = 0; n < 3; n++) {
      const { teachers, entries, teacher, event } = await protectionFixture(`concurrent-${n}`, {
        startAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
      await entries.unpublish({ documentId: event.documentId });
      const results = await Promise.allSettled([
        entries.publish({ documentId: event.documentId }),
        teachers.unpublish({ documentId: teacher.documentId }),
      ]);
      assert.ok(results.some(result => result.status === 'fulfilled'), 'хотя бы одна операция должна завершиться');
      const publishedEvent = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
      const publishedTeacher = await teachers.findOne({ documentId: teacher.documentId, status: 'published' });
      if (publishedEvent) {
        assert.ok(publishedTeacher, 'опубликованное будущее проведение не может потерять преподавателя');
        assert.deepEqual(publishedEvent.teachers.map(t => t.documentId), [teacher.documentId]);
      }
    }
  });

  async function reactivationFixture(suffix, initial) {
    const entries = app.documents('api::schedule-entry.schedule-entry');
    const teachers = app.documents('api::teacher.teacher');
    const seminars = app.documents('api::seminar.seminar');
    const teacher = await teachers.create({ status: 'published', data: {
      name: `Преподаватель возврата ${suffix}`, slug: `reactivation-${suffix}`,
      trait: 'teacher', legacy_id: `reactivation-${suffix}`,
    } });
    const seminar = await seminars.create({ status: 'published', data: {
      name: `Семинар возврата ${suffix}`, ...validSeminarPublicationFields,
      course_group: publishedProgram.documentId, teachers: [teacher.documentId],
    } });
    const event = await entries.create({ status: 'published', data: {
      seminar: seminar.documentId, city: 'Москва', teachers: [], ...initial,
      entry_status: initial.entry_status === 'active' && initial.startAt.startsWith('2099') ? 'cancelled' : initial.entry_status,
    } });
    // Историческая запись уже опубликована до введения обязательного выбора.
    if (initial.entry_status === 'active' && initial.startAt.startsWith('2099')) {
      await app.db.query('api::schedule-entry.schedule-entry').updateMany({
        where: { documentId: event.documentId }, data: { entry_status: 'active' },
      });
    }
    return { entries, teacher, event };
  }

  const futureActive = {
    entry_status: 'active', startAt: '2099-03-17T00:00:00.000Z', endAt: '2099-03-21T00:00:00.000Z',
  };
  for (const [kind, initial] of [
    ['отменённого', { ...futureActive, entry_status: 'cancelled' }],
    ['прошедшего', { entry_status: 'active', startAt: '2000-03-17T00:00:00.000Z', endAt: '2000-03-21T00:00:00.000Z' }],
    ['архивного', { ...futureActive, entry_status: 'completed' }],
  ]) {
    for (const method of ['publish', 'update']) {
      for (const hasTeacher of [false, true]) {
        test(`возврат проведения: ${method} ${kind} в будущее ${hasTeacher ? 'с преподавателем' : 'без преподавателя'}`, async () => {
          const suffix = `${kind === 'отменённого' ? 'cancelled' : kind === 'прошедшего' ? 'past' : 'completed'}-${method}-${hasTeacher}`;
          const { entries, teacher, event } = await reactivationFixture(suffix, initial);
          const data = { ...futureActive, teachers: hasTeacher ? [teacher.documentId] : [] };
          let publish;
          if (method === 'publish') {
            await entries.update({ documentId: event.documentId, data });
            const draft = await entries.findOne({ documentId: event.documentId, status: 'draft', populate: ['teachers'] });
            assert.equal(draft.entry_status, 'active', 'черновой перенос разрешён без преподавателя');
            assert.deepEqual(draft.teachers.map(t => t.documentId), hasTeacher ? [teacher.documentId] : []);
            publish = () => entries.publish({ documentId: event.documentId });
          } else {
            publish = () => entries.update({ documentId: event.documentId, status: 'published', data });
          }
          if (!hasTeacher) {
            await assert.rejects(publish, /преподавател/i);
            const saved = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
            assert.equal(saved.entry_status, initial.entry_status);
            assert.equal(saved.startAt, initial.startAt);
            assert.deepEqual(saved.teachers, []);
          } else {
            await publish();
            const saved = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
            assert.equal(saved.entry_status, 'active');
            assert.equal(saved.startAt, futureActive.startAt);
            assert.deepEqual(saved.teachers.map(t => t.documentId), [teacher.documentId]);
          }
        });
      }
    }
  }

  for (const method of ['publish', 'update']) {
    test(`подтверждение преподавателя: ${method} будущего legacy без преподавателя отклоняется и старый fallback сохраняется`, async () => {
      const { entries, event } = await reactivationFixture(`legacy-${method}`, futureActive);
      let publish;
      if (method === 'publish') {
        await entries.update({ documentId: event.documentId, data: { city: 'Санкт-Петербург' } });
        publish = () => entries.publish({ documentId: event.documentId });
      } else {
        publish = () => entries.update({ documentId: event.documentId, status: 'published', data: { city: 'Санкт-Петербург' } });
      }
      await assert.rejects(publish, /преподавател/i);
      const saved = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
      assert.equal(saved.city, 'Москва');
      assert.deepEqual(saved.teachers, []);
    });
  }

  for (const status of ['draft', 'published']) {
    test(`подтверждение преподавателя: новое ${status} проведение без преподавателя`, async () => {
      const { entries, event } = await reactivationFixture(`new-${status}`, futureActive);
      const data = {
        seminar: (await entries.findOne({ documentId: event.documentId, populate: ['seminar'] })).seminar.documentId,
        city: 'Москва', ...futureActive, teachers: [],
      };
      if (status === 'published') {
        await assert.rejects(() => entries.create({ status, data }), /преподавател/i);
        return;
      }
      const created = await entries.create({ status, data });
      const saved = await entries.findOne({ documentId: created.documentId, status, populate: ['teachers'] });
      assert.ok(saved);
      assert.deepEqual(saved.teachers, []);
    });
  }

  test('возврат проведения: черновой перенос без преподавателя допустим и не меняет опубликованную запись', async () => {
    const initial = { ...futureActive, entry_status: 'cancelled' };
    const { entries, event } = await reactivationFixture('draft-only', initial);
    await entries.update({ documentId: event.documentId, data: { ...futureActive, teachers: [] } });
    const draft = await entries.findOne({ documentId: event.documentId, status: 'draft', populate: ['teachers'] });
    const published = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
    assert.equal(draft.entry_status, 'active');
    assert.deepEqual(draft.teachers, []);
    assert.equal(published.entry_status, 'cancelled');
    assert.deepEqual(published.teachers, []);
  });

  test('подтверждение преподавателя: штатная публикация сохраняет весь выбранный список по порядку', async () => {
    const { entries, teacher, event } = await reactivationFixture('ordered-list', futureActive);
    const teachers = app.documents('api::teacher.teacher');
    const second = await teachers.create({ status: 'published', data: {
      name: 'Второй выбранный преподаватель', slug: 'reactivation-ordered-second',
      trait: 'teacher', legacy_id: 'reactivation-ordered-second',
    } });
    const selected = [second.documentId, teacher.documentId];
    await entries.update({ documentId: event.documentId, data: { teachers: selected } });
    const old = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
    assert.deepEqual(old.teachers, [], 'черновой выбор не меняет опубликованный fallback');
    await entries.publish({ documentId: event.documentId });
    const saved = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
    assert.deepEqual(saved.teachers.map(t => t.documentId), selected);
  });

  for (const method of ['publish', 'update']) {
    test(`подтверждение преподавателя: ${method} отклоняет частично неопубликованный список целиком`, async () => {
      const { entries, teacher, event } = await reactivationFixture(`partial-${method}`, futureActive);
      const teachers = app.documents('api::teacher.teacher');
      const draftTeacher = await teachers.create({ data: {
        name: 'Неопубликованный второй преподаватель', slug: `reactivation-partial-draft-${method}`,
        trait: 'teacher', legacy_id: `reactivation-partial-draft-${method}`,
      } });
      const selected = [teacher.documentId, draftTeacher.documentId];
      let publish;
      if (method === 'publish') {
        await entries.update({ documentId: event.documentId, data: { teachers: selected } });
        publish = () => entries.publish({ documentId: event.documentId });
      } else {
        publish = () => entries.update({ documentId: event.documentId, status: 'published', data: { teachers: selected } });
      }
      await assert.rejects(publish, /преподавател/i);
      const saved = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
      assert.deepEqual(saved.teachers, [], 'не должен публиковаться только первый преподаватель');
    });
  }

  for (const [kind, data] of [
    ['cancelled', { ...futureActive, entry_status: 'cancelled' }],
    ['completed', { ...futureActive, entry_status: 'completed' }],
    ['past', { entry_status: 'active', startAt: '2000-03-17T00:00:00.000Z', endAt: '2000-03-21T00:00:00.000Z' }],
  ]) {
    test(`подтверждение преподавателя: ${kind} публикация не требует преподавателя`, async () => {
      const { entries, event } = await reactivationFixture(`exempt-${kind}`, data);
      await entries.update({ documentId: event.documentId, data: { city: 'Санкт-Петербург' } });
      await entries.publish({ documentId: event.documentId });
      const saved = await entries.findOne({ documentId: event.documentId, status: 'published', populate: ['teachers'] });
      assert.equal(saved.city, 'Санкт-Петербург');
      assert.deepEqual(saved.teachers, []);
    });
  }

  test('съём читает тип, закрытый для публичной роли', async () => {
    process.env.IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP = '1';
    const { bootstrapCaptureTokenForRehearsal } = loadCommonjs(
      path.join(cmsRoot, 'dist/src/seminar-management/capture-token.js'),
    );
    await bootstrapCaptureTokenForRehearsal(app);
    delete process.env.IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP;

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
    process.env.IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP = '1';
    await bootstrapCaptureTokenForRehearsal(app);
    delete process.env.IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP;
    assert.equal(createHash('sha256').update(process.env.CMS_TOKEN).digest('hex'), kept);
  });
});
