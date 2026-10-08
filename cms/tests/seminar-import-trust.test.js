// Доверенный перенос со старого сайта (change seminar-management-ux, D5, задачи 1.6–1.8).
//
// Доверенным считается запрос Content API с токеном полного доступа — так ходит
// `scripts/import.ts`. Панель (JWT администратора), токен настраиваемого типа, запрос без токена
// и пользователь сайта доверенными не бывают. Проверки идут настоящими HTTP-запросами к
// поднятому Strapi: признак доверия определяется по учётным данным запроса, и вызов document
// service в обход HTTP его не показал бы.
//
// Повторный перенос (1.8) проверяется прогоном самого `scripts/import.ts` против этого же
// Strapi: файл собирается esbuild из node_modules CMS (своего tsx в CMS нет, а джоб `cms checks`
// ставит только cms/), каталог материала переноса подменяется через
// `migration/legacy-transfer-dir.json` рядом с собранным файлом — так же, как скрипт ищет его в
// репозитории. Производственный код не меняется.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';

const loadCommonjs = createRequire(import.meta.url);
const cmsRoot = path.join(import.meta.dirname, '..');
const repoRoot = path.join(cmsRoot, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ikpk-import-trust-'));
const dbFile = path.join(work, 'data.db');
const SEMINAR = 'api::seminar.seminar';
const ENTRY = 'api::schedule-entry.schedule-entry';

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

describe('доверенный перенос в собранном Strapi', { timeout: 600000 }, () => {
  /** @type {import('@strapi/strapi').Core.Strapi} */
  let app;
  let base;
  let adminJwt;
  let fullToken;
  let customToken;
  let readOnlyToken;
  let siteUserJwt;
  let seminar;
  let publishedProgram;

  const createPublishedSeminar = (data) => app.documents(SEMINAR).create({
    status: 'published',
    data: { ...data, course_group: publishedProgram.documentId },
  });

  // Заголовок авторизации по виду запрашивающего; null — без заголовка.
  const call = async (method, url, auth, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body && JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };
  const ok = (result, what) => {
    assert.ok(result.status >= 200 && result.status < 300, `${what}: ${result.status} ${result.text}`);
    return result.body;
  };
  const slugFromName = (name) =>
    app.plugin('content-manager').service('uid').generateUIDField({
      contentTypeUID: SEMINAR,
      field: 'slug',
      data: { name },
    });
  const draftOf = (uid, documentId) => app.documents(uid).findOne({ documentId, status: 'draft' });
  const allSlugs = async () =>
    (await app.db.query(SEMINAR).findMany({ select: ['id', 'slug'] }))
      .map((row) => `${row.id}:${row.slug}`)
      .sort();
  const grant = async (roleType, action) => {
    const role = await app.db.query('plugin::users-permissions.role').findOne({ where: { type: roleType } });
    assert.ok(role, `нет роли ${roleType}`);
    await app.db.query('plugin::users-permissions.permission').create({ data: { action, role: role.id } });
    return role;
  };

  before(async () => {
    const [major] = process.versions.node.split('.').map(Number);
    assert.ok(major >= 20 && major <= 24, `Node из engines (>=20 <=24), сейчас ${process.version}`);
    execFileSync(path.join(cmsRoot, 'node_modules/.bin/tsc'), ['--pretty', 'false'], {
      cwd: cmsRoot,
      stdio: 'inherit',
    });

    Object.assign(process.env, {
      NODE_ENV: 'development',
      JWT_SECRET: 'trust-only-users-permissions-jwt',
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
      APP_KEYS: 'trust-test-one,trust-test-two',
      ADMIN_JWT_SECRET: 'trust-only-admin-jwt',
      API_TOKEN_SALT: 'trust-only-api-token',
      TRANSFER_TOKEN_SALT: 'trust-only-transfer-token',
      ENCRYPTION_KEY: 'trust-only-encryption',
      DATABASE_CLIENT: 'sqlite',
      DATABASE_FILENAME: dbFile,
      STRAPI_TELEMETRY_DISABLED: 'true',
    });
    delete process.env.CONTENT_ADMIN_EMAIL;
    delete process.env.CONTENT_ADMIN_PASSWORD;

    fs.mkdirSync(path.join(cmsRoot, 'public/uploads'), { recursive: true });
    const { createStrapi } = loadCommonjs('@strapi/strapi');
    app = createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
    await app.load();
    // В development Strapi сам открывает админку в браузере разработчика при каждом запуске.
    app.config.set('admin.autoOpen', false);
    await app.listen();
    base = `http://127.0.0.1:${process.env.PORT}`;

    // Панель: администратор контента — именно та роль, которой доверия быть не должно.
    const role = await app.service('admin::role').findOne({ code: 'content-admin' });
    assert.equal(role.code, 'content-admin');
    const email = `trust-${Date.now()}@example.invalid`;
    const password = 'Trust-only-test-password-2026';
    await app.service('admin::user').create({
      email,
      firstname: 'Trust',
      lastname: 'Probe',
      password,
      isActive: true,
      preferedLanguage: 'ru',
      roles: [role.id],
    });
    adminJwt = ok(await call('POST', '/admin/login', null, { email, password }), 'вход в панель').data.accessToken;

    const tokens = app.service('admin::api-token');
    const full = await tokens.create({
      name: 'trust-full-access',
      description: 'перенос',
      type: 'full-access',
      kind: 'content-api',
      lifespan: null,
    });
    fullToken = full.accessKey;
    assert.equal(full.type, 'full-access');
    const custom = await tokens.create({
      name: 'trust-custom',
      description: 'настраиваемый',
      type: 'custom',
      kind: 'content-api',
      lifespan: null,
      permissions: [`${SEMINAR}.find`, `${SEMINAR}.create`, `${SEMINAR}.update`, `${ENTRY}.create`],
    });
    customToken = custom.accessKey;
    assert.equal(custom.type, 'custom');
    const readOnly = await tokens.create({
      name: 'trust-read-only',
      description: 'только чтение',
      type: 'read-only',
      kind: 'content-api',
      lifespan: null,
    });
    readOnlyToken = readOnly.accessKey;
    assert.equal(readOnly.type, 'read-only');

    // Запрос без токена и пользователь сайта получают право создания проведения, иначе их отказ
    // 403 был бы «не доверенным» по совпадению, а не по правилу имени. Чтение семинаров нужно,
    // чтобы Content API принял связь (без него — 400 «Invalid key seminar»).
    await grant('public', `${ENTRY}.create`);
    await grant('public', `${SEMINAR}.find`);
    const authenticated = await grant('authenticated', `${ENTRY}.create`);
    await grant('authenticated', `${SEMINAR}.find`);
    const siteUser = await app.plugin('users-permissions').service('user').add({
      username: `site-${Date.now()}`,
      email: `site-${Date.now()}@example.invalid`,
      password: 'Site-user-password-2026',
      provider: 'local',
      confirmed: true,
      blocked: false,
      role: authenticated.id,
    });
    siteUserJwt = app.plugin('users-permissions').service('jwt').issue({ id: siteUser.id });

    const institute = await app.documents('api::institute.institute').create({
      status: 'published',
      data: { name: 'Институт переноса', slug: 'institut-perenosa', legacy_id: 'trust-institute' },
    });
    publishedProgram = await app.documents('api::course-group.course-group').create({
      status: 'published',
      data: {
        name: 'Программа переноса', slug: 'programma-perenosa', legacy_id: 'trust-program',
        institute: institute.documentId,
      },
    });
    seminar = await createPublishedSeminar({ name: 'НПК-1' });
  });

  after(async () => {
    if (app) await app.destroy();
    fs.rmSync(work, { recursive: true, force: true });
  });

  // ── Имя проведения ─────────────────────────────────────────────────────────

  const entryBody = (name) => ({
    data: {
      name,
      seminar: seminar.documentId,
      startAt: '2026-11-10T07:00:00.000Z',
      endAt: '2026-11-11T15:00:00.000Z',
      city: 'Москва',
    },
  });

  test('перенос по токену полного доступа сохраняет исходное имя проведения', async () => {
    const created = ok(await call('POST', '/api/schedule-entries', fullToken, entryBody('Н-ПК-1')), 'создание');
    const stored = await draftOf(ENTRY, created.data.documentId);
    // В теле нет поля trustedImport: доверие определяется токеном, а не телом.
    assert.equal(stored.name, 'Н-ПК-1');
  });

  test('панель с trustedImport: true в теле исходное имя не сохраняет', async () => {
    const created = ok(
      await call('POST', `/content-manager/collection-types/${ENTRY}`, adminJwt, {
        ...entryBody('Н-ПК-1').data,
        name: 'Н-ПК-1 из панели',
        trustedImport: true,
      }),
      'создание из панели',
    );
    const stored = await draftOf(ENTRY, created.data.documentId);
    assert.equal(stored.name, 'НПК-1');
  });

  for (const [who, auth] of [
    ['токен настраиваемого типа', () => customToken],
    ['запрос Content API без токена', () => null],
    ['пользователь сайта', () => siteUserJwt],
  ]) {
    test(`${who} не доверенный: имя проведения задано по правилам редактора`, async () => {
      const created = ok(
        await call('POST', '/api/schedule-entries', auth(), entryBody(`Н-ПК-1 ${who}`)),
        `создание: ${who}`,
      );
      const stored = await draftOf(ENTRY, created.data.documentId);
      assert.equal(stored.name, 'НПК-1');
    });
  }

  test('токен только для чтения не может создать проведение: отказ 403 по правам', async () => {
    const result = await call('POST', '/api/schedule-entries', readOnlyToken, entryBody('Н-ПК-1 read-only'));
    assert.equal(result.status, 403, `создание read-only токеном: ожидался отказ по правам 403: ${result.status} ${result.text}`);
  });

  test('токен только для чтения не может обновить семинар: отказ 403 по правам', async () => {
    const result = await call('PUT', `/api/seminars/${seminar.documentId}`, readOnlyToken, {
      data: { name: 'Подмена read-only' },
    });
    assert.equal(result.status, 403, `обновление read-only токеном: ожидался отказ по правам 403: ${result.status} ${result.text}`);
    assert.notEqual((await draftOf(SEMINAR, seminar.documentId)).name, 'Подмена read-only');
  });

  // ── Адрес семинара ─────────────────────────────────────────────────────────

  test('перенос сохраняет адрес прежнего сайта', async () => {
    const name = 'Авторский семинар-практикум «Осознание и управление своей жизнью»';
    const slug = 'osoznanie-i-upravlenie-svoej-zhiznyu';
    assert.notEqual(await slugFromName(name), slug, 'пример не различает адрес и название');
    const created = ok(await call('POST', '/api/seminars', fullToken, {
      data: { name, slug, course_group: publishedProgram.documentId },
    }), 'создание');
    assert.equal((await draftOf(SEMINAR, created.data.documentId)).slug, slug);
  });

  test('перенос без адреса: slug создан из названия', async () => {
    const name = 'Перенос без адреса';
    const expected = await slugFromName(name);
    const created = ok(await call('POST', '/api/seminars', fullToken, {
      data: { name, slug: '', course_group: publishedProgram.documentId },
    }), 'создание');
    assert.equal((await draftOf(SEMINAR, created.data.documentId)).slug, expected);
  });

  test('перенос без названия: slug пуст, переданный не сохранён', async () => {
    const created = ok(
      await call('POST', '/api/seminars?status=draft', fullToken, { data: { slug: 'bez-nazvaniya-perenos' } }),
      'создание черновика',
    );
    const stored = await draftOf(SEMINAR, created.data.documentId);
    assert.equal(stored.slug ?? '', '');
  });

  test('занятый адрес из переноса — отказ с адресом, ни один slug не изменился', async () => {
    const draftTaken = await app.documents(SEMINAR).create({ data: { name: 'Занятый черновиком' } });
    const publishedTaken = await createPublishedSeminar({ name: 'Занятый опубликованным' });
    for (const taken of [draftTaken.slug, publishedTaken.slug]) {
      assert.ok(taken);
      const name = `Другой семинар на ${taken}`;
      const before = await allSlugs();
      const result = await call('POST', '/api/seminars', fullToken, {
        data: { name, slug: taken, course_group: publishedProgram.documentId },
      });
      assert.ok(result.status >= 400 && result.status < 500, `занятый ${taken} принят: ${result.status} ${result.text}`);
      assert.ok(result.body?.error?.message?.includes(taken), `в ошибке не назван адрес ${taken}: ${result.text}`);
      assert.deepEqual(await allSlugs(), before);
    }
  });

  for (const bad of ['Osoznanie-Zhizn', 'bad slug', 'bad--slug', '-bad-slug', 'bad-slug-']) {
    test(`негодный адрес из переноса «${bad}» — отказ с адресом`, async () => {
      const before = await allSlugs();
      const result = await call('POST', '/api/seminars', fullToken, {
        data: { name: `Негодный адрес ${bad}`, slug: bad, course_group: publishedProgram.documentId },
      });
      assert.ok(result.status >= 400 && result.status < 500, `негодный «${bad}» принят: ${result.status} ${result.text}`);
      assert.ok(result.body?.error?.message?.includes(bad), `в ошибке не назван адрес «${bad}»: ${result.text}`);
      assert.deepEqual(await allSlugs(), before);
    });
  }

  test('повторный перенос не меняет адрес', async () => {
    const existing = await createPublishedSeminar({ name: 'Повторный перенос адреса', legacy_id: 'trust-repeat-slug' });
    ok(
      await call('PUT', `/api/seminars/${existing.documentId}`, fullToken, {
        data: { name: 'Повторный перенос адреса', slug: 'drugoj-adres-perenosa' },
      }),
      'обновление',
    );
    assert.equal((await draftOf(SEMINAR, existing.documentId)).slug, existing.slug);
  });

  test('редактор не задаёт адрес', async () => {
    const name = 'Семинар из панели с адресом';
    const expected = await slugFromName(name);
    const created = ok(
      await call('POST', `/content-manager/collection-types/${SEMINAR}`, adminJwt, {
        name,
        slug: 'proizvolnyj-adres-paneli',
      }),
      'создание из панели',
    );
    assert.equal((await draftOf(SEMINAR, created.data.documentId)).slug, expected);
  });

  test('редактор не меняет адрес', async () => {
    const existing = await app.documents(SEMINAR).create({ data: { name: 'Правка адреса в панели' } });
    ok(
      await call('PUT', `/content-manager/collection-types/${SEMINAR}/${existing.documentId}`, adminJwt, {
        name: 'Правка адреса в панели',
        slug: 'drugoj-adres-paneli',
      }),
      'правка из панели',
    );
    assert.equal((await draftOf(SEMINAR, existing.documentId)).slug, existing.slug);
  });

  test('токен с настраиваемыми правами не задаёт адрес', async () => {
    const name = 'Семинар настраиваемого токена';
    const expected = await slugFromName(name);
    const created = ok(
      await call('POST', '/api/seminars?status=draft', customToken, {
        data: { name, slug: 'adres-nastraivaemogo-tokena' },
      }),
      'создание',
    );
    assert.equal((await draftOf(SEMINAR, created.data.documentId)).slug, expected);
  });

  // ── Повторный перенос scripts/import.ts ───────────────────────────────────

  const ids = {
    neverPublished: 'trust-reimport-never-published',
    unpublished: 'trust-reimport-unpublished',
    unpublishedEntry: 'trust-reimport-entry-unpublished',
    entryOfUnpublished: 'trust-reimport-entry-of-unpublished',
    published: 'trust-reimport-published',
    publishedEntry: 'trust-reimport-entry-published',
    createdSeminar: 'trust-reimport-created-seminar',
    entryOfCreatedSeminar: 'trust-reimport-entry-of-created-seminar',
  };
  let importRun;
  let fixtures;

  async function prepareReimport() {
    const seminars = app.documents(SEMINAR);
    const entries = app.documents(ENTRY);
    const dates = { startAt: '2026-12-01T07:00:00.000Z', endAt: '2026-12-02T15:00:00.000Z' };

    // Семинар без опубликованной версии: ни разу не опубликованный и снятый с публикации.
    await seminars.create({
      data: { name: 'Ни разу не опубликован', legacy_id: ids.neverPublished, description: 'прежнее' },
    });
    const unpublished = await createPublishedSeminar({
      name: 'Снят с публикации', legacy_id: ids.unpublished, description: 'прежнее',
    });
    await seminars.unpublish({ documentId: unpublished.documentId });

    // Снятое с публикации проведение опубликованного семинара.
    const host = await createPublishedSeminar({ name: 'Семинар снятого проведения' });
    const unpublishedEntry = await entries.create({
      status: 'published',
      data: { seminar: host.documentId, city: 'Прежний город', legacy_id: ids.unpublishedEntry, ...dates },
    });
    await entries.unpublish({ documentId: unpublishedEntry.documentId });

    // Опубликованное проведение семинара, который редактор снял с публикации.
    const hidden = await createPublishedSeminar({ name: 'Снятый семинар проведения' });
    const entryOfUnpublished = await entries.create({
      status: 'published',
      data: { seminar: hidden.documentId, city: 'Прежний город', legacy_id: ids.entryOfUnpublished, ...dates },
    });
    await seminars.unpublish({ documentId: hidden.documentId });

    // Семинар, остающийся опубликованным (основное правило 1.8, не исключение).
    const published = await createPublishedSeminar({
      name: 'Остаётся опубликованным', legacy_id: ids.published, description: 'прежнее',
    });
    // Опубликованное проведение опубликованного семинара.
    const publishedEntry = await entries.create({
      status: 'published',
      data: { seminar: published.documentId, city: 'Прежний город', legacy_id: ids.publishedEntry, ...dates },
    });

    // Опубликованное проведение семинара, которого в CMS ещё нет: этот прогон его СОЗДАСТ
    // (POST без query публикует по умолчанию). Placeholder-семинар даёт проведению связь
    // до переноса — перенос переставит её на созданный.
    const placeholderHost = await createPublishedSeminar({ name: 'Заглушка до переноса' });
    const entryOfCreatedSeminar = await entries.create({
      status: 'published',
      data: { seminar: placeholderHost.documentId, city: 'Прежний город', legacy_id: ids.entryOfCreatedSeminar, ...dates },
    });

    fixtures = { host, hidden, entryOfUnpublished, published, publishedEntry, entryOfCreatedSeminar };

    const createdSeminarSlug = 'sozdan-v-etom-zapuske-perenosa';

    // Материал переноса: только эти записи; прочие типы пусты.
    const transfer = path.join(work, 'transfer');
    fs.mkdirSync(transfer, { recursive: true });
    for (const file of [
      'institutes.json', 'teachers.json', 'articles.json', 'video_playlists.json',
      'static_pages.json', 'news.json', 'promotions.json', 'course_groups.json',
    ]) {
      fs.writeFileSync(path.join(transfer, file), '[]');
    }
    fs.writeFileSync(
      path.join(transfer, 'seminars.json'),
      JSON.stringify([
        { legacy_id: ids.neverPublished, name: 'Ни разу не опубликован', slug: 'ni-razu-ne-opublikovan', description_html: 'из повторного переноса' },
        { legacy_id: ids.unpublished, name: 'Снят с публикации', slug: unpublished.slug, description_html: 'из повторного переноса' },
        { legacy_id: ids.published, name: 'Остаётся опубликованным', slug: published.slug, description_html: 'из повторного переноса' },
        { legacy_id: ids.createdSeminar, name: 'Создан в этом прогоне переноса', slug: createdSeminarSlug, description_html: 'из повторного переноса' },
      ].map((row) => ({ ...row, course_group_legacy_id: 'trust-program' }))),
    );
    // Семинаров проведений нет в seminars.json: связь ищется запросом по slug (поиск с черновиками).
    fs.writeFileSync(
      path.join(transfer, 'schedule_entries.json'),
      JSON.stringify([
        { id: ids.unpublishedEntry, name: host.name, city: { name: 'Новый город' }, seminar: { slug: host.slug }, ...dates },
        { id: ids.entryOfUnpublished, name: hidden.name, city: { name: 'Новый город' }, seminar: { slug: hidden.slug }, ...dates },
        { id: ids.publishedEntry, name: published.name, city: { name: 'Новый город' }, seminar: { slug: published.slug }, ...dates },
        { id: ids.entryOfCreatedSeminar, name: 'Проведение созданного семинара', city: { name: 'Новый город' }, seminar: { slug: createdSeminarSlug }, ...dates },
      ]),
    );

    // import.ts ищет каталог материала по `<корень>/migration/legacy-transfer-dir.json`, где
    // корень — родитель каталога скрипта. Собранный файл кладётся в `<work>/scripts/`.
    fs.mkdirSync(path.join(work, 'migration'), { recursive: true });
    fs.writeFileSync(path.join(work, 'migration', 'legacy-transfer-dir.json'), JSON.stringify({ relativeDir: 'transfer' }));
    const bundle = path.join(work, 'scripts', 'import.mjs');
    execFileSync(path.join(cmsRoot, 'node_modules/.bin/esbuild'), [
      path.join(repoRoot, 'scripts', 'import.ts'),
      '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${bundle}`,
    ]);
    // Внешние пакеты (form-data) — из node_modules CMS.
    fs.symlinkSync(path.join(cmsRoot, 'node_modules'), path.join(work, 'node_modules'));

    // Асинхронно: синхронный запуск остановил бы цикл событий, на котором отвечает этот же Strapi.
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [bundle, '--skip-media'], {
      env: { ...process.env, STRAPI_URL: base, STRAPI_API_TOKEN: fullToken },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout + stderr;
  }
  const reimport = () => (importRun ??= prepareReimport());
  const versions = async (uid, legacyId) => ({
    drafts: await app.documents(uid).findMany({ filters: { legacy_id: legacyId }, status: 'draft' }),
    published: await app.documents(uid).findMany({ filters: { legacy_id: legacyId }, status: 'published' }),
  });

  for (const [label, key] of [
    ['ни разу не опубликованного', 'neverPublished'],
    ['снятого с публикации', 'unpublished'],
  ]) {
    test(`повторный перенос ${label} семинара обновляет черновик и не публикует`, async () => {
      const output = await reimport();
      assert.equal(output.includes(`❌ seminars [${ids[key]}]`), false, `ошибка переноса:\n${output}`);
      const { drafts, published } = await versions(SEMINAR, ids[key]);
      assert.equal(drafts.length, 1, 'семинар с этим legacy_id не один');
      assert.equal(drafts[0].description, 'из повторного переноса');
      assert.equal(published.length, 0, 'перенос опубликовал семинар');
    });
  }

  test('повторный перенос снятого с публикации проведения', async () => {
    const output = await reimport();
    assert.equal(output.includes(`❌ schedule-entries [${ids.unpublishedEntry}]`), false, `ошибка переноса:\n${output}`);
    const { drafts, published } = await versions(ENTRY, ids.unpublishedEntry);
    assert.equal(drafts.length, 1, 'проведение с этим legacy_id не одно');
    assert.equal(drafts[0].city, 'Новый город');
    assert.equal(published.length, 0, 'перенос опубликовал проведение');
  });

  test('повторный перенос опубликованной записи (семинар) обновляет опубликованную версию', async () => {
    const output = await reimport();
    assert.equal(output.includes(`❌ seminars [${ids.published}]`), false, `ошибка переноса:\n${output}`);
    const { drafts, published } = await versions(SEMINAR, ids.published);
    assert.equal(published.length, 1, `опубликованная версия пропала:\n${output}`);
    assert.equal(published[0].description, 'из повторного переноса');
    assert.equal(drafts.length, 1);
  });

  test('повторный перенос опубликованного проведения опубликованного семинара обновляет опубликованную версию', async () => {
    const output = await reimport();
    assert.equal(output.includes(`❌ schedule-entries [${ids.publishedEntry}]`), false, `ошибка переноса:\n${output}`);
    const { published } = await versions(ENTRY, ids.publishedEntry);
    assert.equal(published.length, 1, `опубликованная версия пропала:\n${output}`);
    assert.equal(published[0].city, 'Новый город');
  });

  test('повторный перенос опубликованного проведения семинара, созданного в этом же прогоне, обновляет опубликованную версию', async () => {
    const output = await reimport();
    assert.equal(output.includes(`❌ schedule-entries [${ids.entryOfCreatedSeminar}]`), false, `ошибка переноса:\n${output}`);
    const { published } = await versions(ENTRY, ids.entryOfCreatedSeminar);
    assert.equal(published.length, 1, `опубликованная версия пропала:\n${output}`);
    assert.equal(
      published[0].city,
      'Новый город',
      'опубликованная версия не обновилась: созданный в этом прогоне семинар кеширован как неопубликованный, и перенос форсирует черновик',
    );
  });

  test('опубликованное проведение неопубликованного семинара: опубликованная версия нетронута', async () => {
    const output = await reimport();
    const { drafts, published } = await versions(ENTRY, ids.entryOfUnpublished);
    assert.equal(published.length, 1, `опубликованная версия пропала:\n${output}`);
    assert.equal(published[0].city, 'Прежний город');
    assert.equal(published[0].documentId, fixtures.entryOfUnpublished.documentId);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].city, 'Новый город');
  });

  test('поиск семинара для связи проведения учитывает черновики (задача 1.8)', async () => {
    const output = await reimport();
    const id = ids.entryOfUnpublished;
    assert.equal(output.includes(`[${id}] seminar →`), false, `семинар проведения ${id} не найден:\n${output}`);
    const draft = await app.documents(ENTRY).findOne({
      documentId: fixtures.entryOfUnpublished.documentId,
      status: 'draft',
      populate: ['seminar'],
    });
    assert.equal(draft.seminar?.documentId, fixtures.hidden.documentId);
  });
});
