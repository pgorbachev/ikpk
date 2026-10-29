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
      if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        // Без типа Chromium не исполняет модульные скрипты Astro — страница была бы не та, что на стенде.
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        res.end(fs.readFileSync(file));
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

// Только содержимое <main>: название и описание есть ещё в <title> и JSON-LD, и проверка по всей
// странице прошла бы, даже если тело их больше не показывает.
const visible = (html) => {
  const main = html.match(/<main[\s>][\s\S]*<\/main>/);
  assert.ok(main, 'на странице нет <main>');
  return main[0].replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ');
};

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
  const eventTeacherNames = [
    teacherName,
    ...Array.from({ length: 10 }, (_, index) => `Браузерный преподаватель ${index + 2}`),
  ];
  const seminar = {
    name: 'Семинар сквозной проверки',
    slug: 'seminar-skvoznoj-proverki',
    description: '<p>Описание, набранное редактором в админке.</p>',
  };
  const seminarPath = `/${institute.slug}/${group.slug}/${seminar.slug}`;
  const uiSeminar = { name: 'Семинар из браузера' };
  // Своя группа: обложка группы — первая картинка её семинаров, и чужой семинар её бы занял.
  const uiGroup = { name: 'Курсы из браузера', slug: 'kursy-iz-brauzera' };
  let seminarDocumentId;
  const editor = { email: `e2e-${Date.now()}@example.invalid`, password: 'E2e-only-test-password-2026' };
  let uploadedName;

  before(async () => {
    // `strapi build` = компиляция сервера и сборка админки: браузерный сценарий не должен
    // кликать по устаревшему интерфейсу. E2E_REUSE_ADMIN_BUILD — только для отладки теста.
    if (!process.env.E2E_REUSE_ADMIN_BUILD) {
      execFileSync(path.join(cmsRoot, 'node_modules/.bin/strapi'), ['build'], {
        cwd: cmsRoot,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production', STRAPI_TELEMETRY_DISABLED: 'true' },
      });
    }
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
      IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP: '1',
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
    // XDG_RUNTIME_DIR и DBUS_SESSION_BUS_ADDRESS переводят кнопку на systemd-run с пределом памяти
    // (launchPlan), а он есть на раннере GitHub. Здесь — всегда простой запуск, как задумано.
    for (const key of ['CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN', 'CMS_URL',
      'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      delete process.env[key];
    }
    process.env.CMS_URL = `http://127.0.0.1:${process.env.PORT}`;

    // Каталог состояния кнопки создаёт bootstrap-vps.sh, а не CMS.
    fs.mkdirSync(path.dirname(process.env.IKPK_REFRESH_STATE), { recursive: true });
    fs.mkdirSync(path.join(cmsRoot, 'public/uploads'), { recursive: true });
    const { createStrapi } = loadCommonjs('@strapi/strapi');
    app = createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
    await app.load();
    // В development Strapi сам открывает админку в браузере разработчика при каждом запуске.
    app.config.set('admin.autoOpen', false);
    await app.listen();
    base = process.env.CMS_URL;
    assert.ok(process.env.CMS_TOKEN, 'bootstrap CMS не выдал токен съёма');

    const role = await app.service('admin::role').findOne({ code: 'content-admin' });
    const { email, password } = editor;
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
    const inst = await publish('api::institute.institute', {
      ...institute, legacy_id: institute.slug, description: 'Описание института для проверки.', order: 1,
      seo: { seo_title: institute.name, seo_description: 'Институт сквозной проверки.' },
    });
    const program = await publish('api::course-group.course-group', {
      ...group,
      legacy_id: `${institute.slug}/${group.slug}`,
      description: 'Описание программы для проверки.',
      seo: { seo_title: group.name, seo_description: 'Программа сквозной проверки.' },
      is_article_category: true,
      institute: inst.documentId,
    });
    await publish('api::course-group.course-group', {
      ...uiGroup,
      legacy_id: `${institute.slug}/${uiGroup.slug}`,
      description: 'Описание программы для браузерной проверки.',
      seo: { seo_title: uiGroup.name, seo_description: 'Программа браузерной проверки.' },
      institute: inst.documentId,
    });
    await publish('api::teacher.teacher', {
      name: teacherName,
      slug: 'proverkina-anna-petrovna',
      legacy_id: 'e2e-teacher',
      trait: 'teacher',
      institute: inst.documentId,
    });
    for (const [index, name] of eventTeacherNames.slice(1).entries()) {
      await publish('api::teacher.teacher', {
        name,
        slug: `browser-event-teacher-${index + 2}`,
        legacy_id: `browser-event-teacher-${index + 2}`,
        trait: 'teacher',
        institute: inst.documentId,
      });
    }
    await publish('api::article.article', {
      title: 'Статья сквозной проверки',
      slug: 'statya-skvoznoj-proverki',
      body: '<p>Текст.</p>',
      image: (await uploadImage('e2e-article.jpg', '#7a8f3c')).id,
      published_date: '2026-01-01T00:00:00.000Z',
      categories: [program.documentId],
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
      seo: { seo_title: seminar.name, seo_description: 'Описание семинара для поиска.' },
      documents_state: 'not-issued',
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
      teachers: { connect: [{ documentId: teachers.results[0].documentId }] },
    });
    await admin('POST', `/content-manager/collection-types/api::schedule-entry.schedule-entry/${entry.data.documentId}/actions/publish`, {});

    await refreshSite();

    const seminarPage = visible(await page(seminarPath));
    assert.ok(seminarPage.includes(seminar.name), 'нет названия семинара');
    assert.ok(seminarPage.includes('Описание, набранное редактором в админке.'), 'нет описания семинара');
    assert.ok(seminarPage.includes('Самара'), 'нет города проведения');
    assert.match(seminarPage, /41 500 ₽/, 'нет цены проведения');
    // У преподавателя семинара та же подпись, но связь проведения хранится отдельно.
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

  // Change seminar-management-ux, D5: перенос со старого сайта — запрос Content API с токеном
  // полного доступа, как его делает scripts/import.ts, — сохраняет адрес прежнего сайта.
  test('семинар из переноса открывается по адресу прежнего сайта', async () => {
    const { accessKey } = await app.service('admin::api-token').create({
      name: 'e2e-transfer-full-access',
      description: 'перенос',
      type: 'full-access',
      kind: 'content-api',
      lifespan: null,
    });
    const legacySlug = 'osoznanie-i-upravlenie-svoej-zhiznyu';
    const groupRow = await app.documents('api::course-group.course-group').findFirst({ filters: { slug: group.slug } });
    const response = await fetch(`${base}/api/seminars`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        data: {
          name: 'Авторский семинар-практикум «Осознание и управление своей жизнью»',
          slug: legacySlug,
          legacy_id: 'e2e-transfer-legacy-slug',
          description: '<p>Описание с прежнего сайта.</p>',
          seo: { seo_title: 'Семинар с прежнего сайта', seo_description: 'Описание перенесённого семинара.' },
          documents_state: 'not-issued',
          course_group: groupRow.documentId,
        },
      }),
    });
    assert.ok(response.ok, `перенос: ${response.status} ${await response.text()}`);

    await refreshSite();

    // Последний сегмент пути страницы семинара — адрес прежнего сайта, а не созданный из названия.
    await page(`/${institute.slug}/${group.slug}/${legacySlug}`);
  });

  // То же самое — руками в браузере: формы админки, выбор картинки из медиатеки флажком,
  // кнопка «Обновить сайт» на её странице, и результат глазами посетителя.
  test('в браузере: редактор заполняет формы, жмёт кнопку, посетитель видит семинар', async () => {
    const { chromium } = createRequire(path.join(repoRoot, 'web', 'package.json'))('playwright');
    const browser = await chromium.launch();
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 1000 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const pageUi = await context.newPage();
    const shot = async (name) => {
      fs.writeFileSync(path.join(work, `${name}.aria.txt`), await pageUi.locator('body').ariaSnapshot());
      await pageUi.screenshot({ path: path.join(work, `${name}.png`), fullPage: true });
    };
    const uiCoverStem = path.parse((await uploadImage('e2e-ui-cover.jpg', '#b5523b')).url).name;
    const day = 24 * 60 * 60 * 1000;
    const uiStart = new Date(Date.now() + 40 * day);
    try {
      await pageUi.goto(`${base}/admin/auth/login`);
      await pageUi.locator('input[name="email"]').fill(editor.email);
      await pageUi.locator('input[name="password"]').fill(editor.password);
      await pageUi.locator('button[type="submit"]').click();
      await pageUi.waitForURL(/\/admin(?!\/auth)/);
      await pageUi.goto(`${base}/admin/content-manager/collection-types/api::seminar.seminar/create`);
      await pageUi.locator('input[name="name"]').waitFor();
      // Метка «Опубликован» есть и у выбранных связей, поэтому ждём ответ самой публикации.
      const publishForm = async () => {
        const published = pageUi.waitForResponse(
          (response) => response.url().includes('/actions/publish') && response.request().method() === 'POST',
        );
        await pageUi.getByRole('button', { name: 'Опубликовать' }).click();
        assert.ok((await published).ok(), 'публикация из формы не прошла');
      };
      const pick = async (label, query, option) => {
        await pageUi.getByRole('combobox', { name: label }).click();
        await pageUi.keyboard.type(query);
        await pageUi.getByRole('option', { name: option }).click();
      };
      await pageUi.getByRole('textbox', { name: 'Название' }).fill(uiSeminar.name);
      await pick('Программа', 'браузера', uiGroup.name);
      for (const name of eventTeacherNames) await pick('Преподаватели', name, name);
      await pageUi.getByRole('combobox', { name: 'Выдаваемые документы' }).click();
      await pageUi.getByRole('option', { name: 'not-issued', exact: true }).click();
      const seoField = pageUi.getByText('SEO', { exact: true })
        .locator('xpath=ancestor::*[.//button[contains(normalize-space(.), "Ещё нет записей")]][1]');
      await seoField.getByRole('button', { name: 'Ещё нет записей. Нажмите кнопку ниже, чтобы добавить.', exact: true }).click();
      await pageUi.locator('input[name="seo.seo_title"]').fill(uiSeminar.name);
      await pageUi.locator('textarea[name="seo.seo_description"]').fill('Описание семинара для поиска.');
      await pageUi.getByRole('region', { name: 'Изображение' })
        .getByRole('button', { name: /Нажмите, чтобы добавить ресурс/ }).click();
      await pageUi.getByRole('dialog').waitFor();
      // Клик по карточке открывает её редактирование, выбор — только флажок в углу.
      // Именно на этом месте застряла приёмка 07.10.
      const dialog = pageUi.getByRole('dialog', { name: 'Добавить ресурсы' });
      await dialog.getByRole('checkbox', { name: 'e2e-ui-cover.jpg' }).check();
      await dialog.getByRole('button', { name: 'Готово' }).click();
      await dialog.waitFor({ state: 'detached' });
      // Набор кириллицы автоматом CodeMirror 5 не видит: keyboard.type шлёт её как insertText
      // (сохранялась одна точка), fill по contenteditable не доходит до состояния формы. Вставка
      // из буфера — обычное действие редактора, и её редактор обрабатывает как ввод.
      await pageUi.evaluate((text) => navigator.clipboard.writeText(text), 'Описание из браузера.');
      await pageUi.locator('.CodeMirror').first().click();
      await pageUi.keyboard.press('ControlOrMeta+V');
      await shot('ui-03-filled');
      await pageUi.getByRole('button', { name: 'Сохранить' }).click();
      await publishForm();
      const uiSeminarRecord = (await app.documents('api::seminar.seminar').findMany({
        filters: { name: uiSeminar.name }, status: 'published',
      }))[0];
      assert.ok(uiSeminarRecord, 'опубликованный семинар должен быть доступен для проверки формы');
      let seminarPageTwoRequests = 0;
      const seminarRelationsPage = (url) => {
        const parsed = new URL(url);
        return parsed.pathname.includes('/content-manager/relations/') && parsed.pathname.endsWith('/teachers');
      };
      pageUi.on('request', (request) => {
        const url = new URL(request.url());
        if (seminarRelationsPage(url.toString()) && url.searchParams.get('page') === '2') seminarPageTwoRequests += 1;
      });
      await pageUi.goto(`${base}/admin/content-manager/collection-types/api::seminar.seminar/${uiSeminarRecord.documentId}`);
      await pageUi.waitForResponse((response) => seminarRelationsPage(response.url()) &&
        new URL(response.url()).searchParams.get('page') === '1' && response.ok(), { timeout: 10_000 });
      await pageUi.waitForTimeout(500);
      assert.equal(seminarPageTwoRequests, 0, 'список преподавателей семинара не должен менять штатную постраничную загрузку');
      assert.equal(await pageUi.getByRole('button', { name: /Load More|Загрузить ещё/ }).count(), 1,
        'форма семинара должна сохранить штатную кнопку Load More');
      await pageUi.goto(`${base}/admin/content-manager/collection-types/api::schedule-entry.schedule-entry/create`);
      await pageUi.getByRole('textbox', { name: 'Город' }).or(pageUi.locator('input[name="city"]')).first().waitFor();
      await pick('Семинар', 'браузера', new RegExp(uiSeminar.name));
      const ruDate = (date) => date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
      const setMoment = async (label, date, time) => {
        const group = pageUi.getByRole('group', { name: label });
        const dateBox = group.getByRole('combobox', { name: 'Choose date' });
        await dateBox.fill(ruDate(date));
        await dateBox.press('Tab');
        await group.getByRole('combobox', { name: 'Choose time' }).click();
        await pageUi.getByRole('option', { name: time, exact: true }).click();
      };
      await setMoment('Начало', uiStart, '10:00');
      await setMoment('Окончание', new Date(uiStart.getTime() + day), '18:00');
      await pageUi.getByRole('textbox', { name: 'Город' }).fill('Казань');
      await pageUi.getByRole('textbox', { name: 'Цена', exact: true }).fill('36600');
      for (const name of eventTeacherNames) {
        await pick('Преподаватели проведения', name, name);
      }
      await pageUi.getByRole('button', { name: 'Сохранить' }).click();

      const uiDraftEntry = (await app.documents('api::schedule-entry.schedule-entry').findMany({
        status: 'draft', populate: ['seminar'],
      })).find((entry) => entry.seminar?.documentId === uiSeminarRecord.documentId);
      assert.ok(uiDraftEntry, 'черновик проведения должен сохраниться');

      let releasePageTwo;
      let pageTwoRequested;
      const pageTwoRequestStarted = new Promise((resolve) => { pageTwoRequested = resolve; });
      const pageTwoGate = new Promise((resolve) => { releasePageTwo = resolve; });
      const teacherRelationsPage = (url) => {
        const parsed = new URL(url);
        return parsed.pathname.includes('/content-manager/relations/') && parsed.pathname.endsWith('/teachers');
      };
      const pageTwoRoute = (url) => teacherRelationsPage(url) && new URL(url).searchParams.get('page') === '2';
      const pageThreeRoute = (url) => teacherRelationsPage(url) && new URL(url).searchParams.get('page') === '3';
      let pageThreeRequestCount = 0;
      await pageUi.route(pageTwoRoute, async (route) => {
        pageTwoRequested();
        await pageTwoGate;
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"injected page 2 failure"}' });
      });
      await pageUi.route(pageThreeRoute, async (route) => {
        pageThreeRequestCount += 1;
        await route.abort();
      });
      let publishAttempts = 0;
      const publishAbortRoute = (url) => new URL(url).pathname.includes('/actions/publish');
      await pageUi.route(publishAbortRoute, async (route) => {
        publishAttempts += 1;
        await route.abort();
      });
      await pageUi.goto(`${base}/admin/content-manager/collection-types/api::schedule-entry.schedule-entry/${uiDraftEntry.documentId}`);
      await pageTwoRequestStarted;
      const publishButton = pageUi.getByRole('button', { name: 'Опубликовать' });
      await publishButton.waitFor();
      const disabledWhilePageTwoPending = await publishButton.isDisabled();
      await publishButton.evaluate((button) => button.click());
      await pageUi.keyboard.press('ControlOrMeta+Shift+Enter');
      releasePageTwo();
      const pageTwoError = await pageUi.waitForResponse((response) =>
        pageTwoRoute(response.url()) && response.status() === 500, { timeout: 10_000 });
      assert.equal(pageTwoError.status(), 500);
      await pageUi.waitForTimeout(300);
      const disabledAfterPageTwoError = await publishButton.isDisabled();
      const publishAttemptsWhileIncomplete = publishAttempts;
      const pageThreeRequestsAfterError = pageThreeRequestCount;
      const listErrorVisible = await pageUi.getByText('Не удалось загрузить полный список преподавателей проведения.', { exact: true })
        .isVisible().catch(() => false);

      assert.equal(disabledWhilePageTwoPending, true, 'publish disabled while page 2 is pending');
      assert.equal(disabledAfterPageTwoError, true, 'publish remains disabled after page 2 fails');
      assert.equal(publishAttemptsWhileIncomplete, 0, 'publish action must not reach the server while list is incomplete');
      assert.equal(pageThreeRequestsAfterError, 0, 'failed page 2 must not be skipped in favor of page 3');
      assert.equal(listErrorVisible, true, 'list-loading failure must be visible in the form');

      await pageUi.unroute(pageTwoRoute);
      await pageUi.unroute(pageThreeRoute);
      await pageUi.unroute(publishAbortRoute);
      const requestedPages = new Set();
      pageUi.on('response', (response) => {
        const url = new URL(response.url());
        if (teacherRelationsPage(url.toString()) && url.searchParams.get('page')) requestedPages.add(url.searchParams.get('page'));
      });
      await pageUi.reload();
      await pageUi.waitForResponse((response) => pageTwoRoute(response.url()) && response.ok(), { timeout: 10_000 });
      await pageUi.waitForResponse((response) => teacherRelationsPage(response.url()) &&
        new URL(response.url()).searchParams.get('page') === '3' && response.ok(), { timeout: 10_000 });
      await pageUi.getByRole('combobox', { name: 'Преподаватели проведения (11)' }).waitFor();
      const bodyText = await pageUi.locator('body').innerText();
      let previousTeacherIndex = -1;
      for (const name of eventTeacherNames) {
        const index = bodyText.indexOf(name);
        assert.notEqual(index, -1, `полный список не показал «${name}»`);
        assert.ok(index > previousTeacherIndex, `в форме нарушен порядок преподавателей возле «${name}»`);
        previousTeacherIndex = index;
      }
      assert.deepEqual([...requestedPages].sort(), ['1', '2', '3']);
      assert.equal(await pageUi.getByRole('button', { name: /Load More|Загрузить ещё/ }).count(), 0,
        'список должен быть полностью загружен без дополнительного клика');
      const spaNavigate = async (pathname) => {
        await pageUi.evaluate((nextPath) => {
          globalThis.history.pushState({}, '', nextPath);
          globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate', { state: globalThis.history.state }));
        }, pathname);
        await pageUi.waitForURL(`${base}${pathname}`);
      };
      const scheduleEditPath = `/admin/content-manager/collection-types/api::schedule-entry.schedule-entry/${uiDraftEntry.documentId}`;
      const publishBeforeSpaReopen = pageUi.getByRole('button', { name: 'Опубликовать' });
      await publishBeforeSpaReopen.waitFor();
      assert.equal(await publishBeforeSpaReopen.isDisabled(), false,
        'полный список разблокирует publish до повторного открытия');
      await spaNavigate(`/admin/content-manager/collection-types/api::seminar.seminar/${uiSeminarRecord.documentId}`);
      let releaseFirstTeacherPage;
      let requestFirstTeacherPage;
      const firstTeacherPageRequested = new Promise((resolve) => { requestFirstTeacherPage = resolve; });
      const firstTeacherPageGate = new Promise((resolve) => { releaseFirstTeacherPage = resolve; });
      const firstTeacherPageRoute = (url) => {
        const parsed = new URL(url);
        return parsed.pathname === `/content-manager/relations/api::schedule-entry.schedule-entry/${uiDraftEntry.documentId}/teachers` &&
          parsed.searchParams.get('page') === '1';
      };
      await pageUi.route(firstTeacherPageRoute, async (route) => {
        requestFirstTeacherPage();
        await firstTeacherPageGate;
        await route.continue();
      });
      await spaNavigate(scheduleEditPath);
      await firstTeacherPageRequested;
      const pendingFirstPagePublish = pageUi.getByRole('button', { name: 'Опубликовать' });
      const disabledOnSpaReopen = await pendingFirstPagePublish.isDisabled();
      assert.equal(disabledOnSpaReopen, true,
        'новое SPA-открытие того же documentId блокирует publish до первой страницы списка');
      const publishAttemptsBeforePendingClick = publishAttempts;
      await pendingFirstPagePublish.evaluate((button) => button.click());
      assert.equal(publishAttempts, publishAttemptsBeforePendingClick,
        'публикация при новой загрузке первого списка преподавателей не достигает publish action');
      releaseFirstTeacherPage();
      await pageUi.waitForResponse((response) => firstTeacherPageRoute(response.url()) && response.ok(), { timeout: 10_000 });
      await pageUi.waitForFunction(() => [...globalThis.document.querySelectorAll('button')]
        .some((button) => button.textContent?.trim() === 'Опубликовать' && !button.disabled), null, { timeout: 10_000 });
      await pageUi.unroute(firstTeacherPageRoute);

      await publishForm();
      const publishedEntry = await app.documents('api::schedule-entry.schedule-entry').findOne({
        documentId: uiDraftEntry.documentId, status: 'published', populate: ['teachers'],
      });
      assert.deepEqual(publishedEntry.teachers.map(({ name }) => name), eventTeacherNames,
        'публикация штатной кнопкой должна подтвердить и сохранить весь текущий список по порядку');

      const bulkDraftCity = 'Черновик для проверки массовой публикации';
      const bulkDraftEntry = await app.documents('api::schedule-entry.schedule-entry').create({
        data: {
          seminar: uiSeminarRecord.documentId,
          teachers: publishedEntry.teachers.map(({ documentId }) => documentId),
          startAt: new Date(uiStart.getTime() + 2 * day).toISOString(),
          endAt: new Date(uiStart.getTime() + 3 * day).toISOString(),
          city: bulkDraftCity,
          entry_status: 'active',
        },
      });
      await pageUi.goto(`${base}/admin/content-manager/collection-types/api::schedule-entry.schedule-entry`);
      const bulkEntryRow = pageUi.getByRole('row').filter({ hasText: bulkDraftCity });
      await bulkEntryRow.waitFor();
      await bulkEntryRow.getByRole('checkbox').check();
      const scheduleBulkPublish = pageUi.getByRole('button', { name: 'Опубликовать' });
      await scheduleBulkPublish.waitFor();
      assert.equal(await scheduleBulkPublish.isDisabled(), true,
        'массовая публикация проведений отключена, потому что штатный action не подтверждает полный список');

      const bulkDraftSeminar = await app.documents('api::seminar.seminar').create({
        data: { name: 'Черновик семинара для массовой публикации', course_group: uiGroup.documentId },
      });
      await pageUi.goto(`${base}/admin/content-manager/collection-types/api::seminar.seminar`);
      const bulkSeminarRow = pageUi.getByRole('row').filter({ hasText: bulkDraftSeminar.name });
      await bulkSeminarRow.waitFor();
      await bulkSeminarRow.getByRole('checkbox').check();
      const seminarBulkPublish = pageUi.getByRole('button', { name: 'Опубликовать' });
      await seminarBulkPublish.waitFor();
      assert.equal(await seminarBulkPublish.isDisabled(), false,
        'массовая публикация семинаров остаётся штатной');

      // Сборка portable: имитируем runtime Postgres через существующий Strapi project-type
      // response. Эта browser session проверяет реальные компоненты/роуты, а не mocked UI.
      let nonSqliteProjectTypeCalls = 0;
      await pageUi.route('**/admin/project-type', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.data.flags.ikpkDatabaseClient = 'postgres';
        nonSqliteProjectTypeCalls += 1;
        await route.fulfill({ response, body: JSON.stringify(body) });
      });
      await pageUi.reload();
      await pageUi.waitForFunction(() => globalThis.window.strapi?.flags?.ikpkDatabaseClient === 'postgres');
      assert.ok(nonSqliteProjectTypeCalls > 0, 'admin использовал runtime database capability, а не значение сборки');
      const runtimeTeacherPageOne = (url) => {
        const parsed = new URL(url);
        return parsed.pathname === `/content-manager/relations/api::schedule-entry.schedule-entry/${bulkDraftEntry.documentId}/teachers` &&
          parsed.searchParams.get('page') === '1';
      };
      const runtimePageOneResponse = pageUi.waitForResponse((response) => runtimeTeacherPageOne(response.url()) && response.ok());
      const runtimePageTwoRequests = [];
      pageUi.on('request', (request) => {
        const parsed = new URL(request.url());
        if (parsed.pathname === `/content-manager/relations/api::schedule-entry.schedule-entry/${bulkDraftEntry.documentId}/teachers` &&
          parsed.searchParams.get('page') === '2') runtimePageTwoRequests.push(request.url());
      });
      await pageUi.goto(`${base}/admin/content-manager/collection-types/api::schedule-entry.schedule-entry/${bulkDraftEntry.documentId}`);
      await runtimePageOneResponse;
      assert.equal(await pageUi.getByRole('button', { name: /Load More|Загрузить ещё/ }).count(), 1,
        'runtime Postgres сохраняет штатную pagination связи');
      await pageUi.waitForTimeout(300);
      assert.deepEqual(runtimePageTwoRequests, [], 'runtime Postgres не запускает SQLite автозагрузку страниц');
      const runtimePublishButton = pageUi.getByRole('button', { name: 'Опубликовать' });
      await runtimePublishButton.waitFor();
      assert.equal(await runtimePublishButton.isDisabled(), false,
        'runtime Postgres не блокирует штатную публикацию формы');
      await publishForm();
      const runtimePublishedEntry = await app.documents('api::schedule-entry.schedule-entry').findOne({
        documentId: bulkDraftEntry.documentId, status: 'published', populate: ['teachers'],
      });
      assert.deepEqual(runtimePublishedEntry.teachers.map(({ name }) => name), eventTeacherNames,
        'штатная публикация сохраняет существующую связь при runtime non-SQLite');
      const runtimeBulkCity = 'Черновик для non-SQLite bulk action';
      await app.documents('api::schedule-entry.schedule-entry').create({
        data: {
          seminar: uiSeminarRecord.documentId,
          teachers: publishedEntry.teachers.map(({ documentId }) => documentId),
          startAt: new Date(uiStart.getTime() + 4 * day).toISOString(),
          endAt: new Date(uiStart.getTime() + 5 * day).toISOString(),
          city: runtimeBulkCity,
          entry_status: 'active',
        },
      });
      await pageUi.goto(`${base}/admin/content-manager/collection-types/api::schedule-entry.schedule-entry`);
      const runtimeBulkRow = pageUi.getByRole('row').filter({ hasText: runtimeBulkCity });
      await runtimeBulkRow.waitFor();
      await runtimeBulkRow.getByRole('checkbox').check();
      const runtimeBulkPublish = pageUi.getByRole('button', { name: 'Опубликовать' });
      await runtimeBulkPublish.waitFor();
      assert.equal(await runtimeBulkPublish.isDisabled(), false,
        'runtime non-SQLite сохраняет штатную массовую публикацию проведений');
      if (process.env.E2E_TEACHER_RELATIONS_ONLY === 'true') return;

      // Кнопка «Обновить сайт» — на её собственной странице админки.
      await pageUi.getByRole('link', { name: 'Обновить сайт' }).click();
      // На странице может висеть итог прошлого нажатия, поэтому ждём сначала «идёт» (кнопка
      // заблокирована), и только потом — её разблокировки.
      const refreshButton = pageUi.getByRole('button', { name: 'Обновить сайт' });
      await refreshButton.click();
      await pageUi.locator('button:disabled', { hasText: 'Обновить сайт' }).waitFor();
      await pageUi.locator('button:enabled', { hasText: 'Обновить сайт' }).waitFor({ timeout: 15 * 60_000 });
      await shot('ui-07-refreshed');
      assert.ok(await pageUi.getByText('Сайт обновлён.', { exact: false }).isVisible(), 'кнопка не обновила сайт');

      // Посетитель: опубликованный сайт в том же браузере, видимость — а не только наличие в HTML.
      const [created] = await app.documents('api::seminar.seminar').findMany({
        filters: { name: uiSeminar.name },
        status: 'published',
      });
      const visitor = await context.newPage();
      const open = async (url) => {
        const response = await visitor.goto(`${site}${url}`);
        assert.equal(response.status(), 200, `опубликованный сайт: ${url}`);
      };
      await open(`/${institute.slug}/${uiGroup.slug}/${created.slug}`);
      for (const text of [uiSeminar.name, 'Описание из браузера.', teacherName, 'Казань']) {
        await visitor.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 5000 })
          .catch(() => assert.fail(`на странице семинара не видно «${text}»`));
      }
      assert.match((await visitor.locator('main').innerText()).replace(/\s+/g, ' '), /36 600 ₽/, 'не видно цены');
      await visitor.screenshot({ path: path.join(work, 'site-seminar.png'), fullPage: true });

      await open(`/${institute.slug}`);
      const cover = visitor.locator(`img[src*="${uiCoverStem}"], img[srcset*="${uiCoverStem}"]`).first();
      await cover.scrollIntoViewIfNeeded().catch(() => assert.fail('картинки семинара нет на странице института'));
      assert.ok(await cover.isVisible(), 'картинка семинара не видна');
      assert.ok(
        // loading="lazy": ждём декодирования, а не читаем complete сразу после прокрутки.
        await cover.evaluate((img) => img.decode().then(() => img.naturalWidth > 0, () => false)),
        'картинка семинара не загрузилась',
      );
      await visitor.screenshot({ path: path.join(work, 'site-institute.png'), fullPage: true });
    } catch (error) {
      await shot('ui-failure').catch(() => {});
      throw error;
    } finally {
      await browser.close();
    }
  });
});
