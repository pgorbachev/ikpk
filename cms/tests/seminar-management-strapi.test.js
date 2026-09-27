import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  });

  after(async () => {
    if (app) await app.destroy();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      fs.rmSync(dbFile + suffix, { force: true });
    }
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
      data: { name: 'Опубликованный' },
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
});
