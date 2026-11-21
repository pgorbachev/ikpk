// Run from cms: node --test tests/e2e/article-publication-defaults.test.js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const cmsRoot = path.join(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const uid = 'api::article.article';
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short' });
const afterMoscowMidnight = '2026-11-19T21:05:00Z';

function articleDay(entry) {
  assert.ok(entry?.published_date, 'опубликованная статья содержит календарную дату');
  return dayFormat.format(new Date(entry.published_date));
}

describe('дата и адрес статьи через Strapi', { timeout: 360000 }, () => {
  let app, work, articles, image, category;
  before(async () => {
    work = mkdtempSync(path.join(os.tmpdir(), 'ikpk-article-publication-'));
    const databaseClient = process.env.IKPK_TEST_DATABASE_CLIENT || 'sqlite';
    Object.assign(process.env, {
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '0', STRAPI_TELEMETRY_DISABLED: 'true',
      JWT_SECRET: 'articles-test-jwt', APP_KEYS: 'articles-one,articles-two', ADMIN_JWT_SECRET: 'articles-admin-jwt',
      API_TOKEN_SALT: 'articles-api-token', TRANSFER_TOKEN_SALT: 'articles-transfer-token', ENCRYPTION_KEY: 'articles-encryption',
      DATABASE_CLIENT: databaseClient,
      ...(databaseClient === 'sqlite' ? { DATABASE_FILENAME: path.join(work, 'db.sqlite') } : {}),
    });
    for (const key of ['CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN', 'IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP']) delete process.env[key];
    if (!process.env.E2E_REUSE_ADMIN_BUILD) {
      execFileSync(path.join(cmsRoot, 'node_modules/.bin/strapi'), ['build'], {
        cwd: cmsRoot, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
      });
    } else {
      execFileSync(path.join(cmsRoot, 'node_modules/.bin/tsc'), ['--pretty', 'false'], { cwd: cmsRoot, stdio: 'inherit' });
    }
    mkdirSync(path.join(cmsRoot, 'public/uploads'), { recursive: true });
    app = require('@strapi/strapi').createStrapi({ appDir: cmsRoot, distDir: path.join(cmsRoot, 'dist') });
    await app.load();
    articles = app.documents(uid);
    const institute = await app.documents('api::institute.institute').create({
      status: 'published',
      data: { name: 'Институт', slug: 'article-test-institute', order: 1, description: 'Описание', seo: { seo_title: 'Институт', seo_description: 'Описание' } },
    });
    category = await app.documents('api::course-group.course-group').create({
      status: 'published',
      data: {
        name: 'Категория', slug: 'article-test-category', description: 'Описание', institute: institute.documentId,
        seo: { seo_title: 'Категория', seo_description: 'Описание' }, is_article_category: true,
      },
    });
    image = await app.db.query('plugin::upload.file').create({
      data: {
        name: 'article.png', hash: 'article-test-fixture', ext: '.png', mime: 'image/png',
        size: 1, url: '/uploads/article.png', provider: 'local',
      },
    });
  });
  after(async () => {
    await app?.destroy();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  function payload(title, extra = {}) {
    return { title, body: 'Текст статьи', image: image.id, categories: [category.documentId], ...extra };
  }
  const published = (documentId) => articles.findOne({ documentId, status: 'published' });

  test('publish после полуночи в Москве проставляет дату даже в предыдущем дне UTC', async (t) => {
    const entry = await articles.create({ data: payload('Московская полночь') });
    t.mock.timers.enable({ apis: ['Date'], now: new Date(afterMoscowMidnight) });
    await articles.publish({ documentId: entry.documentId });
    assert.equal(articleDay(await published(entry.documentId)), '2026-11-20');
  });

  test('после неудачной первой публикации дата остаётся пустой до успешной попытки', async (t) => {
    const { documentId } = await articles.create({ data: payload('Повтор публикации', { body: null }) });
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-19T20:55:00Z') });
    await assert.rejects(articles.publish({ documentId }));
    assert.equal(await published(documentId), null);
    assert.equal((await articles.findOne({ documentId })).published_date, null);
    await articles.update({ documentId, data: { body: 'Статья дополнена' } });
    t.mock.timers.setTime(Date.parse(afterMoscowMidnight));
    await articles.publish({ documentId });
    assert.equal(articleDay(await published(documentId)), '2026-11-20');
  });

  test('create с опубликованным статусом заполняет дату', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(afterMoscowMidnight) });
    const { documentId } = await articles.create({ status: 'published', data: payload('Публикация через create') });
    assert.equal(articleDay(await published(documentId)), '2026-11-20');
  });

  test('update с опубликованным статусом заполняет дату', async (t) => {
    const { documentId } = await articles.create({ data: payload('Публикация через update') });
    t.mock.timers.enable({ apis: ['Date'], now: new Date(afterMoscowMidnight) });
    await articles.update({ documentId, status: 'published', data: { body: 'Обновленный текст' } });
    assert.equal(articleDay(await published(documentId)), '2026-11-20');
  });

  test('московский день, явно выбранный редактором, переживает сохранение и повторную публикацию', async (t) => {
    const title = 'Статья с выбранной датой';
    const { documentId } = await articles.create({
      data: payload(title, { published_date: '2026-11-12T21:00:00Z', slug: 'selected-date-probe' }),
    });
    const originalDate = (await articles.findOne({ documentId })).published_date;
    assert.equal(new Date(originalDate).toISOString(), '2026-11-12T21:00:00.000Z');
    t.mock.timers.enable({ apis: ['Date'], now: new Date(afterMoscowMidnight) });
    assert.equal(articleDay(await articles.findOne({ documentId })), '2026-11-13');
    await articles.update({ documentId, data: { published_date: null } });
    assert.equal((await articles.findOne({ documentId })).published_date, originalDate,
      'без выбора нового дня старое сохранённое datetime значение не переписывается');
    assert.equal(articleDay(await articles.findOne({ documentId })), '2026-11-13');
    await articles.publish({ documentId });
    assert.equal(articleDay(await published(documentId)), '2026-11-13');
    await articles.unpublish({ documentId });
    await articles.update({ documentId, data: { title: 'Правка статьи с выбранной датой', published_date: null } });
    await articles.publish({ documentId });
    assert.equal(articleDay(await published(documentId)), '2026-11-13');
    await articles.update({ documentId, status: 'published', data: { published_date: '2026-11-14T21:00:00Z' } });
    assert.equal(articleDay(await published(documentId)), '2026-11-15');
  });

  test('slug появляется при первом сохранении кириллического заголовка и сохраняется при переименовании черновика', async () => {
    const draft = await articles.create({ data: payload('') });
    assert.ok(!draft.slug, 'без заголовка адрес ещё не закреплён');
    const titled = await articles.update({ documentId: draft.documentId, data: { title: 'Кириллический заголовок' } });
    assert.match(titled.slug ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const renamed = await articles.update({ documentId: draft.documentId, data: { title: 'Другой заголовок' } });
    assert.equal(renamed.title, 'Другой заголовок');
    assert.equal(renamed.slug, titled.slug);
  });

  test('одинаковые заголовки имеют разные адреса при параллельной публикации', async () => {
    const data = () => payload('Одинаковый заголовок', { published_date: '2026-11-19T21:00:00Z' });
    const first = await articles.create({ data: data() });
    const second = await articles.create({ data: data() });
    await Promise.all([first, second].map(({ documentId }) => articles.publish({ documentId })));
    const [a, b] = await Promise.all([first, second].map(({ documentId }) => published(documentId)));
    assert.match(a.slug ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.match(b.slug ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.notEqual(a.slug, b.slug);
    assert.equal(a.slug, first.slug);
  });

  test('параллельное создание одинаковых черновиков сохраняет уникальные адреса', async () => {
    const title = 'Одновременное создание статей';
    const entries = await Promise.all([
      articles.create({ data: payload(title) }),
      articles.create({ data: payload(title) }),
    ]);
    assert.notEqual(entries[0].slug, entries[1].slug);
    assert.deepEqual(new Set(entries.map(({ slug }) => slug)).size, 2);
  });

  test('параллельные заголовки с пересекающимися основами получают разные адреса', async () => {
    await articles.create({ data: payload('Пересечение основы') });
    const entries = await Promise.all([
      articles.create({ data: payload('Пересечение основы') }),
      articles.create({ data: payload('Пересечение основы 2') }),
    ]);
    assert.equal(new Set(entries.map(({ slug }) => slug)).size, 2);
  });

  test('первое параллельное сохранение заголовка черновика закрепляет один адрес', async () => {
    const draft = await articles.create({ data: payload('') });
    const results = await Promise.all([
      articles.update({ documentId: draft.documentId, data: { title: 'Первый заголовок параллельно' } }),
      articles.update({ documentId: draft.documentId, data: { title: 'Второй заголовок параллельно' } }),
    ]);
    const stored = await articles.findOne({ documentId: draft.documentId });
    assert.match(stored.slug ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(results.every(({ slug }) => slug === stored.slug));
  });

  test('резервация slug живёт до commit внешней транзакции и разрешает вложенный publish', async () => {
    const baseTitle = 'Адрес во внешней транзакции';
    await articles.create({ data: payload(baseTitle) });
    let announceCreated;
    let releaseTransaction;
    const created = new Promise((resolve) => { announceCreated = resolve; });
    const hold = new Promise((resolve) => { releaseTransaction = resolve; });

    const firstTransaction = app.db.transaction(async () => {
      const first = await articles.create({ data: payload(baseTitle) });
      await articles.publish({ documentId: first.documentId });
      announceCreated(first);
      await hold;
      return first;
    });
    const first = await created;
    let secondFinished = false;
    const secondPromise = articles.create({ data: payload(`${baseTitle} 2`) }).then((entry) => {
      secondFinished = true;
      return entry;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondFinished, false, 'следующая выдача ждёт commit внешней транзакции');
    releaseTransaction();
    await firstTransaction;
    const second = await secondPromise;
    assert.notEqual(first.slug, second.slug);
  });

  test('rollback внешней транзакции освобождает очередь slug', async () => {
    await assert.rejects(app.db.transaction(async () => {
      await articles.create({ data: payload('Откат резервации slug') });
      throw new Error('test rollback');
    }), /test rollback/);
    const saved = await articles.create({ data: payload('Откат резервации slug') });
    assert.ok(saved.slug);
  });

  test('адрес переживает обычное переименование, снятие с публикации и повторную публикацию', async () => {
    const { documentId, slug } = await articles.create({
      status: 'published',
      data: payload('Статья с постоянной ссылкой', { published_date: '2026-11-19T21:00:00Z', slug: 'stable-address-probe' }),
    });
    assert.match(slug ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    await articles.update({ documentId, status: 'published', data: { title: 'Правка публикации' } });
    assert.equal((await published(documentId)).slug, slug);
    await articles.unpublish({ documentId });
    await articles.update({ documentId, data: { title: 'Правка после снятия' } });
    await articles.publish({ documentId });
    const again = await published(documentId);
    assert.equal(again.slug, slug);
    assert.equal(again.title, 'Правка после снятия');
  });

  test('clone получает новый slug и сохраняет дату оригинала', async () => {
    const original = await articles.create({
      status: 'published',
      data: payload('Оригинал для копирования', { published_date: '2026-11-19T21:00:00Z' }),
    });
    const clone = await articles.clone({ documentId: original.documentId });
    const cloned = await articles.findOne({ documentId: clone.documentId });
    assert.notEqual(cloned.documentId, original.documentId);
    assert.notEqual(cloned.slug, original.slug);
    assert.ok(cloned.slug);
    assert.equal(new Date(cloned.published_date).toISOString(), new Date(original.published_date).toISOString());
    assert.equal((await published(original.documentId)).slug, original.slug);
  });

  test('clone использует заданный заголовок и игнорирует подмену slug', async () => {
    const original = await articles.create({ data: payload('Исходный заголовок копии') });
    const clone = await articles.clone({
      documentId: original.documentId,
      data: { title: 'Новый заголовок копии', slug: 'forged-clone-address' },
    });
    const copied = await articles.findOne({ documentId: clone.documentId });
    assert.equal(copied.title, 'Новый заголовок копии');
    assert.notEqual(copied.slug, 'forged-clone-address');
    assert.equal(copied.slug, 'novyy-zagolovok-kopii');
    assert.equal((await articles.findOne({ documentId: original.documentId })).slug, original.slug);
  });

  test('clone с пустым новым заголовком не копирует ни старый, ни подставленный slug', async () => {
    const original = await articles.create({ data: payload('Заголовок пустой копии') });
    const clone = await articles.clone({
      documentId: original.documentId,
      data: { title: '', slug: 'forged-empty-clone-address' },
    });
    const copied = await articles.findOne({ documentId: clone.documentId });
    assert.equal(copied.title, '');
    assert.equal(copied.slug, null);
  });

  test('clone пустого источника игнорирует вручную переданный slug', async () => {
    const original = await articles.create({ data: payload('') });
    const clone = await articles.clone({
      documentId: original.documentId,
      data: { slug: 'forged-empty-source-address' },
    });
    const copied = await articles.findOne({ documentId: clone.documentId });
    assert.equal(copied.title, '');
    assert.equal(copied.slug, null);
  });

  test('публикация черновика со старыми null slug и датой восстанавливает значения опубликованной версии', async () => {
    const original = await articles.create({
      status: 'published',
      data: payload('Опубликованная версия с историей', { published_date: '2013-04-21T19:18:00.000Z' }),
    });
    await app.db.query(uid).update({
      where: { documentId: original.documentId, publishedAt: null },
      data: { slug: null, published_date: null },
    });
    await articles.publish({ documentId: original.documentId });
    const restored = await published(original.documentId);
    assert.equal(restored.slug, original.slug);
    assert.equal(new Date(restored.published_date).toISOString(), new Date(original.published_date).toISOString());
  });

  test('обычное обновление legacy draft с null сохраняет опубликованные slug и дату до повторной публикации', async () => {
    const original = await articles.create({
      status: 'published',
      data: payload('Исходный опубликованный адрес', {
        slug: 'legacy-draft-stable-address',
        published_date: '2013-04-21T19:18:00.000Z',
      }),
    });
    await app.db.query(uid).update({
      where: { documentId: original.documentId, publishedAt: null },
      data: { slug: null, published_date: null },
    });

    await articles.update({
      documentId: original.documentId,
      data: { title: 'Переименованный legacy черновик', published_date: null },
    });
    const updatedDraft = await articles.findOne({ documentId: original.documentId });
    assert.equal(updatedDraft.slug, original.slug);
    assert.equal(new Date(updatedDraft.published_date).toISOString(), '2013-04-21T19:18:00.000Z');

    await articles.publish({ documentId: original.documentId });
    const updatedPublished = await published(original.documentId);
    assert.equal(updatedPublished.slug, original.slug);
    assert.equal(new Date(updatedPublished.published_date).toISOString(), '2013-04-21T19:18:00.000Z');
    assert.equal(updatedPublished.title, 'Переименованный legacy черновик');
  });

  test('legacy unpublish переносит отсутствующие slug и дату в draft до удаления published версии', async () => {
    const original = await articles.create({
      status: 'published',
      data: payload('Legacy статья перед unpublish', { published_date: '2011-06-07T20:00:00.000Z' }),
    });
    await app.db.query(uid).update({
      where: { documentId: original.documentId, publishedAt: null },
      data: { slug: null, published_date: null },
    });

    await articles.unpublish({ documentId: original.documentId });
    const draftAfterUnpublish = await articles.findOne({ documentId: original.documentId });
    assert.equal(draftAfterUnpublish.slug, original.slug);
    assert.equal(new Date(draftAfterUnpublish.published_date).toISOString(), '2011-06-07T20:00:00.000Z');

    await articles.publish({ documentId: original.documentId });
    const republished = await published(original.documentId);
    assert.equal(republished.slug, original.slug);
    assert.equal(new Date(republished.published_date).toISOString(), '2011-06-07T20:00:00.000Z');
  });

  test('публикация проверяет актуальный черновик после конкурентного очищения обязательного текста', {
    skip: process.env.IKPK_TEST_DATABASE_CLIENT !== 'postgres',
  }, async () => {
    const draft = await articles.create({ data: payload('Гонка проверки публикации') });
    let releaseExternalLock;
    let signalLockAcquired;
    const lockAcquired = new Promise((resolve) => { signalLockAcquired = resolve; });
    const holdLock = new Promise((resolve) => { releaseExternalLock = resolve; });
    const externalTransaction = app.db.transaction(async ({ trx }) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['ikpk:article-slug-allocation']);
      signalLockAcquired();
      await holdLock;
    });
    await lockAcquired;

    const update = articles.update({ documentId: draft.documentId, data: { body: '' } });
    await new Promise((resolve) => setImmediate(resolve));
    const publish = articles.publish({ documentId: draft.documentId });
    await new Promise((resolve) => setImmediate(resolve));
    releaseExternalLock();

    await externalTransaction;
    await update;
    await assert.rejects(publish);
    assert.equal(await published(draft.documentId), null);
    assert.equal((await articles.findOne({ documentId: draft.documentId })).body, '');
  });

  test('обычный API не даёт подставить slug при обновлении черновика или опубликованной статьи', async () => {
    const { documentId, slug } = await articles.create({
      status: 'published',
      data: payload('Статья с защищённой ссылкой', { published_date: '2026-11-19T21:00:00Z', slug: 'protected-address-probe' }),
    });
    assert.ok(slug);
    for (const status of ['draft', 'published']) {
      try {
        await articles.update({ documentId, status, data: { slug: 'unauthorized-address' } });
      } catch (error) {
        assert.ok(['ApplicationError', 'ValidationError', 'ForbiddenError'].includes(error.name), String(error));
      }
      assert.equal((await articles.findOne({ documentId, status })).slug, slug);
    }
  });

  test('доверенный импорт и его повтор оставляют исходные slug и дату', async () => {
    const access = { state: { auth: { strategy: { name: 'content-api-token' }, credentials: { type: 'full-access' } } } };
    const slug = 'legacy-article-path';
    const published_date = '2013-04-21T19:18:00.000Z';
    const result = await app.requestContext.run(access, async () => {
      const { documentId } = await articles.create({
        status: 'published', data: payload('Импортированная статья', { slug, published_date, legacy_id: 'test-legacy-article' }),
      });
      await articles.update({ status: 'published', documentId, data: { title: 'Импортированная статья повторно', slug, published_date } });
      return published(documentId);
    });
    assert.equal(result.slug, slug);
    assert.equal(new Date(result.published_date).toISOString(), published_date);
  });

  test('legacy trusted import без slug и даты сохраняет значения опубликованной версии', async () => {
    const access = { state: { auth: { strategy: { name: 'content-api-token' }, credentials: { type: 'full-access' } } } };
    const slug = 'legacy-trusted-import-url';
    const published_date = '2012-02-03T20:00:00.000Z';
    const { documentId } = await app.requestContext.run(access, () => articles.create({
      status: 'published',
      data: payload('Legacy imported source', { slug, published_date }),
    }));
    await app.db.query(uid).update({
      where: { documentId, publishedAt: null },
      data: { slug: null, published_date: null },
    });
    await app.requestContext.run(access, () => articles.update({
      documentId,
      status: 'published',
      data: { title: 'Legacy imported rename' },
    }));
    const result = await published(documentId);
    assert.equal(result.title, 'Legacy imported rename');
    assert.equal(result.slug, slug);
    assert.equal(new Date(result.published_date).toISOString(), published_date);
  });

  test('доверенный импорт сохраняет исходный адрес и конфликтует вместо его перезаписи', async () => {
    const access = { state: { auth: { strategy: { name: 'content-api-token' }, credentials: { type: 'full-access' } } } };
    const slug = 'parallel-preserved-import-address';
    const imported = await app.requestContext.run(access, () => articles.create({
      data: payload('Исторический импорт', { slug, published_date: '2013-04-21T19:18:00.000Z' }),
    }));
    await assert.rejects(app.requestContext.run(access, () => articles.create({
      data: payload('Повторный конфликтующий импорт', { slug, published_date: '2014-05-22T19:18:00.000Z' }),
    })), /уже занят/);
    const preserved = await articles.findOne({ documentId: imported.documentId });
    assert.equal(preserved.slug, slug);
    assert.equal(new Date(preserved.published_date).toISOString(), '2013-04-21T19:18:00.000Z');
  });

  test('параллельные доверенный импорт и обычное создание сохраняют оба адреса', async () => {
    const access = { state: { auth: { strategy: { name: 'content-api-token' }, credentials: { type: 'full-access' } } } };
    const [imported, regular] = await Promise.all([
      app.requestContext.run(access, () => articles.create({
        data: payload('Другая историческая статья', { slug: 'historical-parallel-import-address' }),
      })),
      articles.create({ data: payload('Параллельное обычное создание') }),
    ]);
    const [importedRecord, regularRecord] = await Promise.all([
      articles.findOne({ documentId: imported.documentId }),
      articles.findOne({ documentId: regular.documentId }),
    ]);
    assert.equal(importedRecord.slug, 'historical-parallel-import-address');
    assert.equal(regularRecord.slug, 'parallelnoe-obychnoe-sozdanie');
  });

  test('штатный bulk publish сериализует выбор slug внутри общей transaction', async () => {
    const first = await articles.create({ data: payload('Статья для bulk publish') });
    const second = await articles.create({ data: payload('Статья для bulk publish') });
    await Promise.all([first, second].map(({ documentId }) => app.db.query(uid).update({
      where: { documentId, publishedAt: null },
      data: { slug: null },
    })));
    const documentManager = app.plugin('content-manager').service('document-manager');

    const count = await app.db.transaction(async () => Promise.race([
      documentManager.publishMany(uid, [first.documentId, second.documentId]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('bulk publish transaction timed out')), 1500)),
    ]));
    const publishedSlugs = [first.documentId, second.documentId]
      .map((documentId) => published(documentId))
      .map(async (record) => (await record)?.slug);
    const slugs = await Promise.all(publishedSlugs);
    assert.equal(count, 2);
    assert.equal(new Set(slugs).size, 2);
  });

  test('форма статьи показывает московский день и восстанавливает сохранённый день после очистки', async () => {
    app.config.set('admin.autoOpen', false);
    await app.listen();
    const base = `http://127.0.0.1:${app.server.httpServer.address().port}`;
    const email = 'article-date-editor@example.invalid';
    const password = 'Browser-test-password-2026';
    const role = await app.service('admin::role').findOne({ code: 'strapi-editor' });
    const superAdminRole = await app.service('admin::role').findOne({ code: 'strapi-super-admin' });
    await app.service('admin::user').create({
      email, password, firstname: 'Test', lastname: 'Editor',
      isActive: true, preferedLanguage: 'ru', roles: [role.id],
    });
    const superAdminEmail = 'article-date-admin@example.invalid';
    await app.service('admin::user').create({
      email: superAdminEmail, password, firstname: 'Test', lastname: 'Admin',
      isActive: true, preferedLanguage: 'ru', roles: [superAdminRole.id],
    });
    const requireWeb = createRequire(path.join(cmsRoot, '../web/package.json'));
    const { chromium } = requireWeb('playwright');
    const browser = await chromium.launch({ executablePath: process.env.IKPK_TEST_CHROMIUM_PATH || undefined });
    try {
      const page = await browser.newPage({ locale: 'ru-RU', timezoneId: 'America/Los_Angeles' });
      await page.clock.setFixedTime(new Date(afterMoscowMidnight));
      await page.goto(`${base}/admin/auth/login`);
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="password"]').fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/admin(?!\/auth)/);

      const collectionPath = `/content-manager/collection-types/${uid}`;
      await page.goto(`${base}/admin${collectionPath}/create`);
      await page.locator('input[name="title"]').waitFor({ timeout: 10000 });
      const date = page.locator('input[name="published_date"], input[id="published_date"], input[aria-label="Choose date"]');
      assert.equal(await date.count(), 1, 'у статьи одно доступное поле даты');
      assert.equal(await date.inputValue(), '2026-11-20', 'в новой статье сразу выбран московский день');
      assert.equal(await page.getByLabel('Choose time', { exact: true }).count(), 0, 'редактору не нужно выбирать время');
      const title = page.locator('input[name="title"]');
      const slug = page.locator('input[name="slug"]');
      assert.equal(await slug.isEditable(), false, 'адрес показывается только для чтения');
      await title.fill('Выбор дня в браузере');
      await date.fill('2026-11-11');

      async function saveDraft(method) {
        const pending = page.waitForResponse(r => r.request().method() === method &&
          new URL(r.url()).pathname.startsWith(collectionPath), { timeout: 10000 });
        await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
        const response = await pending;
        assert.ok(response.ok(), await response.text());
        return (await response.json()).data;
      }

      const { documentId } = await saveDraft('POST');
      assert.equal(articleDay(await articles.findOne({ documentId })), '2026-11-11');
      await page.clock.setFixedTime(new Date('2026-11-20T21:05:00Z'));
      await page.goto(`${base}/admin${collectionPath}/${documentId}`);
      assert.equal(await date.inputValue(), '2026-11-11');
      await date.fill('');
      await saveDraft('PUT');
      assert.equal(articleDay(await articles.findOne({ documentId })), '2026-11-11');
      await page.reload();
      assert.equal(await date.inputValue(), '2026-11-11');

      await page.goto(`${base}/admin${collectionPath}/create`);
      await page.locator('input[name="title"]').waitFor();
      const blankDate = page.locator('input[name="published_date"], input[id="published_date"], input[aria-label="Choose date"]');
      await blankDate.fill('');
      assert.equal(await blankDate.inputValue(), '', 'редактор может оставить новую статью без даты');
      const blankPending = page.waitForResponse(r => r.request().method() === 'POST' &&
        new URL(r.url()).pathname.startsWith(collectionPath));
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      const blankResponse = await blankPending;
      assert.ok(blankResponse.ok(), await blankResponse.text());
      const blankDocumentId = (await blankResponse.json()).data.documentId;
      assert.equal((await articles.findOne({ documentId: blankDocumentId })).published_date, null);

      const adminPage = await browser.newPage({ locale: 'ru-RU', timezoneId: 'America/Los_Angeles' });
      await adminPage.goto(`${base}/admin/auth/login`);
      await adminPage.locator('input[name="email"]').fill(superAdminEmail);
      await adminPage.locator('input[name="password"]').fill(password);
      await adminPage.locator('button[type="submit"]').click();
      await adminPage.waitForURL(/\/admin(?!\/auth)/);

      for (const [type, path] of [
        ['новость', '/content-manager/collection-types/api::news-item.news-item/create'],
        ['акция', '/content-manager/collection-types/api::promotion.promotion/create'],
      ]) {
        await adminPage.goto(`${base}/admin${path}`);
        const time = adminPage.getByRole('combobox', { name: 'Choose time', exact: true });
        await time.waitFor({ timeout: 10000 });
        assert.equal(await time.count(), 1, `штатный ввод времени сохранён для формы: ${type}`);
      }

    } finally {
      await browser.close();
    }
  });

});
