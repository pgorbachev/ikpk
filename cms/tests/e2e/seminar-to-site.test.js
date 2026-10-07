// Сквозная проверка «редактор в админке → кнопка «Обновить сайт» → опубликованный сайт».
//
// Каждый участок цепочки покрыт своими тестами, но стык между ними — нет: тесты CMS кончаются
// на базе, тесты сайта начинаются со снимка, написанного руками. Приёмка 07.10.2026 нашла дефект
// ровно на стыке: преподаватель семинара сохранялся в CMS и не доходил до сайта.
//
// Поэтому здесь нет заглушек ни на одном шаге: настоящий Strapi, вход ролью content-admin,
// запросы той же админки, тот же обработчик кнопки и тот же worker, что на стенде (съём →
// производные медиа → `npm run build` → переключение релиза → сверка объявления релиза).
// Отличие от стенда одно: worker стартует без systemd-run — на машине разработчика его нет.
//
// Долгий (несколько минут: сборка Strapi и две сборки сайта), поэтому вне `npm test` и вне
// проверок PR. Запуск: `npm run test:e2e` из cms/ — нужны `npm ci` в cms/ и web/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const loadCommonjs = createRequire(import.meta.url);
const cmsRoot = path.join(import.meta.dirname, '..', '..');
const repoRoot = path.join(cmsRoot, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ikpk-e2e-seminar-'));
const workspace = path.join(work, 'workspace');
const webRoot = path.join(work, 'www');

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

// Дерево сборки — тот же состав, что кладёт на стенд `scripts/lib/site-build-archive.sh`, но из
// рабочего каталога, а не из HEAD: так негативная проверка видит незакоммиченную мутацию.
function prepareWorkspace() {
  const listed = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z', '--', 'web', 'cms/src',
      'fixtures/content-snapshot/collapsible_panels.json', 'fixtures/content-snapshot/url_map.csv'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  for (const file of listed.split('\0').filter(Boolean)) {
    const from = path.join(repoRoot, file);
    if (!fs.existsSync(from)) continue; // удалён в рабочем каталоге, но ещё в индексе
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.copyFileSync(from, path.join(workspace, file));
  }
  // Только читаются: копировать 170 МБ оригиналов и node_modules незачем.
  fs.symlinkSync(path.join(repoRoot, 'media-originals'), path.join(workspace, 'media-originals'));
  fs.symlinkSync(path.join(repoRoot, 'web', 'node_modules'), path.join(workspace, 'web', 'node_modules'));
}

// Раздача опубликованного релиза — вместо nginx стенда. Формат адресов Astro: `trailingSlash: 'never'`.
function serveCurrent(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const root = path.join(webRoot, 'current');
    for (const candidate of [urlPath, `${urlPath}.html`, path.join(urlPath, 'index.html')]) {
      const file = path.join(root, candidate);
      if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200);
        res.end(fs.readFileSync(file));
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const visible = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ');

describe('семинар из админки доходит до опубликованного сайта', { timeout: 40 * 60_000 }, () => {
  /** @type {import('@strapi/strapi').Core.Strapi} */
  let app;
  let base;
  let site;
  let siteServer;
  let token;
  const dbFile = path.join(work, 'data.db');

  const admin = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      },
      body: body instanceof FormData ? body : body && JSON.stringify(body),
    });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${url}: ${response.status} ${text}`);
    return JSON.parse(text);
  };
  // Загрузка картинки тем же запросом, что делает медиатека админки.
  const uploadImage = async (name, background) => {
    const sharp = createRequire(path.join(repoRoot, 'web', 'package.json'))('sharp');
    const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: 'image/jpeg' }), name);
    const [uploaded] = await admin('POST', '/upload', form);
    return uploaded;
  };
  const page = async (url) => {
    const response = await fetch(`${site}${url}`, { redirect: 'manual' });
    assert.equal(response.status, 200, `опубликованный сайт: ${url}`);
    return response.text();
  };
  // Кнопка «Обновить сайт»: тот же адрес админки и тот же опрос состояния, что у страницы кнопки.
  const refreshSite = async () => {
    const started = await admin('POST', '/admin/site-refresh', {});
    assert.equal(started.status, 'running', JSON.stringify(started));
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const state = await admin('GET', '/admin/site-refresh');
      if (state.status === 'running') continue;
      assert.equal(state.status, 'succeeded', JSON.stringify(state));
      return state;
    }
  };

  const institute = { name: 'Институт Сквозной Проверки', slug: 'institut-skvoznoj-proverki' };
  const group = { name: 'Курсы сквозной проверки', slug: 'kursy-skvoznoj-proverki' };
  const teacherName = 'Проверкина Анна Петровна';
  const seminar = {
    name: 'Семинар сквозной проверки',
    slug: 'seminar-skvoznoj-proverki',
    description: '<p>Описание, набранное редактором в админке.</p>',
  };
  const seminarPath = `/${institute.slug}/${group.slug}/${seminar.slug}`;
  let seminarDocumentId;
  let uploadedName;

  before(async () => {
    execFileSync(path.join(cmsRoot, 'node_modules/.bin/tsc'), ['--pretty', 'false'], {
      cwd: cmsRoot,
      stdio: 'inherit',
    });
    prepareWorkspace();
    const sitePort = await freePort();
    site = `http://127.0.0.1:${sitePort}`;
    siteServer = await serveCurrent(sitePort);

    Object.assign(process.env, {
      NODE_ENV: 'development',
      JWT_SECRET: 'e2e-only-users-permissions-jwt',
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
      APP_KEYS: 'e2e-one,e2e-two',
      ADMIN_JWT_SECRET: 'e2e-only-admin-jwt',
      API_TOKEN_SALT: 'e2e-only-api-token',
      TRANSFER_TOKEN_SALT: 'e2e-only-transfer-token',
      ENCRYPTION_KEY: 'e2e-only-encryption',
      DATABASE_CLIENT: 'sqlite',
      DATABASE_FILENAME: dbFile,
      STRAPI_TELEMETRY_DISABLED: 'true',
      // Окружение кнопки — те же ключи, что объявляет bootstrap-vps.sh для стенда.
      IKPK_BUILD_WORKSPACE: workspace,
      IKPK_WEB_ROOT: webRoot,
      IKPK_REFRESH_STATE: path.join(webRoot, 'shared', 'site-refresh', 'state.json'),
      IKPK_VERIFY_URL: `${site}/release.json`,
      IKPK_INSTALLED_COMMIT: 'e2e0000000000000000000000000000000000000',
      PAYMENT_ROLE: 'stand',
      DEMO_FORMS: 'stub',
      CHAT_LOADER_SRC: 'none',
    });
    // Готовые производные медиа берутся из локальной сборки, если она есть: без них первый
    // прогон пересчитывает все оригиналы. На результат не влияет — сборка досчитает недостающее.
    const derivatives = path.join(repoRoot, 'web', 'public', 'media');
    if (fs.existsSync(derivatives)) process.env.IKPK_MEDIA_CACHE = derivatives;
    for (const key of ['CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN', 'CMS_URL']) {
      delete process.env[key];
    }
    process.env.CMS_URL = `http://127.0.0.1:${process.env.PORT}`;

    // Каталог состояния кнопки создаёт bootstrap-vps.sh, а не CMS.
    fs.mkdirSync(path.dirname(process.env.IKPK_REFRESH_STATE), { recursive: true });
    fs.mkdirSync(path.join(cmsRoot, 'public/uploads'), { recursive: true });
    const { createStrapi } = loadCommonjs('@strapi/strapi');
    app = createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
    await app.load();
    await app.listen();
    base = process.env.CMS_URL;
    assert.ok(process.env.CMS_TOKEN, 'bootstrap CMS не выдал токен съёма');

    const role = await app.service('admin::role').findOne({ code: 'content-admin' });
    const email = `e2e-${Date.now()}@example.invalid`;
    const password = 'E2e-only-test-password-2026';
    await app.service('admin::user').create({
      email,
      firstname: 'E2E',
      lastname: 'Editor',
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

    // Каркас, который на проде уже есть и который content-admin создавать не может: институт,
    // группа курсов, преподаватель. Статья — потому что съём отказывает на пустых каркасных типах.
    const publish = (uid, data) => app.documents(uid).create({ status: 'published', data });
    const inst = await publish('api::institute.institute', { ...institute, legacy_id: institute.slug });
    await publish('api::course-group.course-group', {
      ...group,
      legacy_id: `${institute.slug}/${group.slug}`,
      institute: inst.documentId,
    });
    await publish('api::teacher.teacher', {
      name: teacherName,
      slug: 'proverkina-anna-petrovna',
      legacy_id: 'e2e-teacher',
      institute: inst.documentId,
    });
    await publish('api::article.article', {
      title: 'Статья сквозной проверки',
      slug: 'statya-skvoznoj-proverki',
      body: '<p>Текст.</p>',
      image: (await uploadImage('e2e-article.jpg', '#7a8f3c')).id,
      seo: { seo_title: 'Статья сквозной проверки', seo_description: 'Описание статьи сквозной проверки.' },
    });
  });

  after(async () => {
    if (app) await app.destroy();
    if (siteServer) siteServer.close();
    if (!process.env.E2E_KEEP) fs.rmSync(work, { recursive: true, force: true });
    else console.log(`E2E_KEEP: рабочий каталог оставлен в ${work}`);
  });

  test('редактор создаёт семинар и проведение — после кнопки они на сайте', async () => {
    const uploaded = await uploadImage('e2e-seminar-cover.jpg', '#2a6f97');
    uploadedName = path.parse(uploaded.url).name;

    const groups = await admin('GET', `/content-manager/collection-types/api::course-group.course-group?_q=${encodeURIComponent(group.name)}`);
    const teachers = await admin('GET', `/content-manager/collection-types/api::teacher.teacher?_q=${encodeURIComponent('проверкина')}`);
    assert.equal(teachers.results.length, 1, 'поиск админки не нашёл преподавателя');

    const created = await admin('POST', '/content-manager/collection-types/api::seminar.seminar', {
      ...seminar,
      price: 45_000,
      duration: '3 дня',
      image: uploaded.id,
      course_group: { connect: [{ documentId: groups.results[0].documentId }] },
      teachers: { connect: [{ documentId: teachers.results[0].documentId }] },
    });
    seminarDocumentId = created.data.documentId;
    await admin('POST', `/content-manager/collection-types/api::seminar.seminar/${seminarDocumentId}/actions/publish`, {});

    const day = 24 * 60 * 60 * 1000;
    const start = new Date(Math.ceil((Date.now() + 30 * day) / day) * day + 6 * 60 * 60 * 1000);
    const entry = await admin('POST', '/content-manager/collection-types/api::schedule-entry.schedule-entry', {
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 2 * day).toISOString(),
      city: 'Самара',
      price: 41_500,
      oldPrice: 48_000,
      isFree: false,
      registrationFormLink: 'https://example.invalid/zapis',
      description: '<p>Подробности проведения.</p>',
      additionalText: '<p>Взять удобную одежду.</p>',
      duration: '3 дня',
      seminar: { connect: [{ documentId: seminarDocumentId }] },
    });
    await admin('POST', `/content-manager/collection-types/api::schedule-entry.schedule-entry/${entry.data.documentId}/actions/publish`, {});

    await refreshSite();

    const seminarPage = visible(await page(seminarPath));
    assert.ok(seminarPage.includes(seminar.name), 'нет названия семинара');
    assert.ok(seminarPage.includes('Описание, набранное редактором в админке.'), 'нет описания семинара');
    assert.ok(seminarPage.includes('Самара'), 'нет города проведения');
    assert.match(seminarPage, /41 500 ₽/, 'нет цены проведения');
    // Преподаватель указан только у семинара: поле преподавателей проведения в админке скрыто.
    assert.ok(seminarPage.includes(teacherName), 'преподаватель семинара не дошёл до страницы');
    assert.ok(!seminarPage.includes('уточняется'), 'на странице «Преподаватель уточняется»');

    const schedule = visible(await page('/raspisanie-i-tseny'));
    assert.ok(schedule.includes(seminar.name), 'семинара нет в расписании');
    assert.ok(schedule.includes(teacherName), 'преподавателя нет в расписании');

    // Картинка семинара на сайте видна только карточкой группы курсов, у которой нет своей.
    const institutePage = await page(`/${institute.slug}`);
    const cover = institutePage.match(new RegExp(`["'(](/media/uploads/${uploadedName}[^"') ,]*)`));
    assert.ok(cover, 'картинка семинара не стала обложкой карточки группы');
    await page(cover[1]);
  });

  test('правка семинара после публикации и кнопки видна на сайте', async () => {
    assert.ok(seminarDocumentId, 'первый сценарий не создал семинар');
    const renamed = 'Семинар сквозной проверки, исправленный';
    await admin('PUT', `/content-manager/collection-types/api::seminar.seminar/${seminarDocumentId}`, {
      name: renamed,
      description: '<p>Исправленное описание.</p>',
    });
    await admin('POST', `/content-manager/collection-types/api::seminar.seminar/${seminarDocumentId}/actions/publish`, {});

    await refreshSite();

    const seminarPage = visible(await page(seminarPath));
    assert.ok(seminarPage.includes(renamed), 'новое название не дошло');
    assert.ok(seminarPage.includes('Исправленное описание.'), 'новое описание не дошло');
    assert.ok(!seminarPage.includes('Описание, набранное редактором в админке.'), 'старое описание осталось');
  });
});
