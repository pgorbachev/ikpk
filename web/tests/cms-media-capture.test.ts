// Тесты по утверждённой спеке `cms-media-pipeline`
// (`openspec/changes/cms-content-authoring-and-migration/specs/cms-media-pipeline/spec.md`),
// требование «Изображения отдаются с сайта, а не из системы управления» — та его часть,
// которая решается при СНЯТИИ снимка: с сайта нельзя отдать то, чего в снимке нет.
//
// Написаны красными до реализации; сейчас зелёные. Наблюдено на стенде `http://193.124.115.99`:
//   * `web/scripts/capture-content-snapshot.ts` кладёт `const content: SnapshotContent =
//     { types, media: [] }` — медиа не скачиваются вовсе, поэтому все 131 файл живого
//     снимка на сайте отдают 404;
//   * `web/scripts/lib/content-field-map.ts` объявляет
//     `{ type: 'teachers', field: 'photo', source: 'photo', transform: 'mediaRef' }`, то есть
//     кладёт в поле ОБЪЕКТ `{url, id}`, тогда как сайт читает его строкой
//     (`web/src/lib/data.ts`, `photo: string`; `web/src/components/home/sections/Teachers.astro`,
//     `src={t.photo}`) — в разметку уходит `src="[object Object]"`.
//
// Соответствие «сценарий спеки → проверка» — в отчёте сессии и в комментариях ниже.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localizeAssetUrls } from '../src/lib/media';
import {
  type CmsStub,
  type StubCollection,
  type StubUpload,
  runCapture,
  startCmsStub,
} from './helpers/cms-live-snapshot-capture-contract';
import {
  CMS_UPLOADS_PREFIX,
  SNAPSHOT_MEDIA_DIRNAME,
  mediaStoreModule,
  uploadRefsIn,
} from './helpers/cms-media-pipeline-contract';
import {
  EXTERNAL_LINK_IN_BODY,
  MEDIA_FILE_COUNT,
  mediaDataset,
  stubUploadBytes,
  stubUploads,
} from './helpers/cms-media-stub-data';

// ───────────────────────────────────────────────────────────────── оснастка

let stubs: CmsStub[] = [];

afterEach(async () => {
  await Promise.all(stubs.map((s) => s.close().catch(() => undefined)));
  stubs = [];
});

async function stub(
  over: Record<string, StubCollection> = {},
  uploads: Record<string, StubUpload> = {},
): Promise<CmsStub> {
  const started = await startCmsStub(mediaDataset(over), stubUploads(uploads));
  stubs.push(started);
  return started;
}

const outDir = (): string => mkdtempSync(join(tmpdir(), 'ikpk-media-capture-'));

interface CapturedSnapshot {
  content: {
    types: Record<string, Record<string, unknown>[]>;
    media: { ref: string; contentId: string }[];
  };
}

const readSnapshot = (dir: string): CapturedSnapshot =>
  JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf-8')) as CapturedSnapshot;

/**
 * Хвост ссылки — имя файла. Сравнение по нему, а не по строке целиком: спека не решает, в
 * какой момент `/uploads/x.webp` становится `/media/uploads/x.webp` (при снятии или при
 * загрузке), и тест не вправе это предписывать.
 */
const fileNameOf = (ref: string): string => ref.split('/').pop() ?? ref;

// ══════════ Требование: изображения отдаются с сайта, а не из системы управления ══════════

describe('снятие снимка забирает медиа содержимым', () => {
  // Сценарий: страница с загруженным изображением не ссылается на систему управления.
  // Проверяется у ИСТОЧНИКА: пока байтов нет в снимке, отдать их со статического адреса
  // нечем — именно это и наблюдалось на стенде (404 на всех 131 файле).
  it('каждое медиа записей снимка попало в content.media с идентификатором содержимого', async () => {
    const store = await mediaStoreModule();
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, `захват не прошёл:\n${run.output}`).toBe(0);

    const snap = readSnapshot(dir);
    const refsInRecords = uploadRefsIn(snap.content.types).map(fileNameOf);
    expect(
      new Set(refsInRecords).size,
      'заглушка отдала меньше файлов, чем задумано, — проверка стала бы вакуумной',
    ).toBe(MEDIA_FILE_COUNT);

    const listed = new Set(snap.content.media.map((m) => fileNameOf(m.ref)));
    const notListed = [...new Set(refsInRecords)].filter((name) => !listed.has(name));
    expect(
      notListed,
      `ссылки записей без содержимого в снимке:\n${notListed.join('\n')}`,
    ).toEqual([]);

    // Идентификатор обязан быть идентификатором СОДЕРЖИМОГО, а не именем файла: иначе
    // подмена байтов в хранилище остаётся незамеченной.
    for (const item of snap.content.media) {
      const n = Number(/img-(\d+)\.webp$/.exec(fileNameOf(item.ref))?.[1]);
      expect(Number.isFinite(n), `неожиданная ссылка ${item.ref}`).toBe(true);
      expect(item.contentId, `идентификатор ${item.ref} не соответствует байтам заглушки`).toBe(
        store.contentIdOf(stubUploadBytes(n)),
      );
    }
  });

  it('байты лежат в хранилище снимка и читаются по идентификатору содержимого', async () => {
    const store = await mediaStoreModule();
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, `захват не прошёл:\n${run.output}`).toBe(0);

    // Скачивание — наблюдаемое событие, а не догадка по содержимому снимка: без обращений к
    // каталогу загрузок «медиа в снимке» могло бы означать переписанную ссылку.
    expect(
      cms.uploadRequests.length,
      'к каталогу загрузок системы управления не было ни одного обращения',
    ).toBeGreaterThan(0);

    const storeDir = join(dir, SNAPSHOT_MEDIA_DIRNAME);
    const snap = readSnapshot(dir);
    expect(snap.content.media.length, 'в снимке нет медиа').toBeGreaterThan(0);

    for (const item of snap.content.media) {
      const read = store.readFromStore({ storeDir, contentId: item.contentId });
      expect(read.ok, `${item.ref}: ${read.ok ? '' : read.reason}`).toBe(true);
    }
  });

  it('одно содержимое под двумя ссылками даёт одну запись хранилища, а не две', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, `захват не прошёл:\n${run.output}`).toBe(0);

    // Новость и акция ссылаются на один и тот же файл (`cms-media-stub-data.ts`).
    const snap = readSnapshot(dir);
    const ids = snap.content.media.map((m) => m.contentId);
    expect(ids.length, 'в снимке нет медиа').toBeGreaterThan(0);
    expect(new Set(ids).size, `повторы в хранилище: ${ids.join(', ')}`).toBe(ids.length);
  });

  it('недокачанный файл — отказ съёма с указанием файла, а не тихий пропуск', async () => {
    const cms = await stub({}, { [`${CMS_UPLOADS_PREFIX}img-3.webp`]: { status: 500 } });
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    expect(run.status, `съём завершился успехом при недокачанном файле:\n${run.output}`).not.toBe(0);
    expect(run.output, 'отказ не называет файл').toContain('img-3.webp');
    // Снимок, не прошедший проверку, не должен оставаться на диске: следующая сборка возьмёт
    // именно его (`web/scripts/lib/snapshot-paths.ts`, порядок разрешения каталога снимка).
    expect(
      existsSync(join(dir, 'snapshot.json')),
      'неудачный съём оставил снимок на диске',
    ).toBe(false);
  });

  it('пустой ответ файла — отказ съёма с указанием файла', async () => {
    const cms = await stub({}, { [`${CMS_UPLOADS_PREFIX}img-3.webp`]: { bytes: Buffer.alloc(0) } });
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    expect(run.status, `пустой файл принят как медиа: ${run.output}`).not.toBe(0);
    expect(run.output).toContain('img-3.webp');
    expect(existsSync(join(dir, 'snapshot.json'))).toBe(false);
  });

  it('сторонняя ссылка с сегментом /uploads/ сохраняется и не скачивается из CMS', async () => {
    const baseDataset = mediaDataset();
    const current = baseDataset.articles.records[0]!;
    const external = 'https://third.example/uploads/report.pdf';
    const externalQuery = 'https://third.example/?next=/uploads/query-report.pdf';
    const cms = await stub({
      articles: {
        records: [{
          ...current,
          body: `<p><a href="${external}">report</a><a href="${externalQuery}">query</a></p>`,
        }],
      },
    });
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    expect(run.status, `захват внешней ссылки ошибочно не прошёл: ${run.output}`).toBe(0);
    const article = readSnapshot(dir).content.types.articles?.[0];
    expect(article?.body_html).toContain(external);
    expect(article?.body_html).toContain(externalQuery);
    expect(cms.uploadRequests).not.toContain('/uploads/report.pdf');
    expect(cms.uploadRequests).not.toContain('/uploads/query-report.pdf');
  });
});

// ════════════ Требование: форма поля снимка совпадает с формой, которую читает сайт ═══════
//
// Отдельного требования спеки под это нет — это наблюдённый дефект, и он относится к тому же
// требованию «изображения отдаются с сайта»: `src="[object Object]"` не является адресом
// сайта ни в каком прочтении.

describe('поля-адреса приходят строкой, а не объектом', () => {
  // `web/src/lib/data.ts`: `Teacher.photo: string`, `Article.image: string | null`.
  // Прочие типы (`NewsItem`, `Promotion`, `ScheduleEntry`) объявляют `image: {url, id}` — их
  // объектная форма законна, и тест её не трогает.
  const stringFields: { type: string; field: string }[] = [
    { type: 'teachers', field: 'photo' },
    { type: 'articles', field: 'image' },
  ];

  for (const { type, field } of stringFields) {
    it(`${type}.${field} — строка адреса, а не объект`, async () => {
      const cms = await stub();
      const dir = outDir();

      const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
      expect(run.status, `захват не прошёл:\n${run.output}`).toBe(0);

      const records = readSnapshot(dir).content.types[type];
      expect(records?.length, `в снимке нет типа ${type}`).toBeGreaterThan(0);

      for (const record of records!) {
        const value = record[field];
        expect(
          typeof value,
          `${type}.${field} = ${JSON.stringify(value)}; в разметку уйдёт "${String(value)}"`,
        ).toBe('string');
        expect(String(value), 'значение вырождается в [object Object]').not.toBe('[object Object]');
      }
    });
  }
});

// ═════════════════ Сценарии, проверяемые здесь как охрана, а не как красное ════════════════

describe('содержимое снимка не зависит от системы управления и не теряет внешних ссылок', () => {
  // Сценарий: страница с загруженным изображением не ссылается на систему управления.
  // ЗЕЛЁНАЯ сегодня: REST отдаёт медиа относительным путём, хоста в значениях нет. Проверка
  // стережёт, чтобы скачивание медиа не начало класть в снимок абсолютный адрес админки.
  it('ни одно значение снимка не содержит хост системы управления', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, `захват не прошёл:\n${run.output}`).toBe(0);

    const raw = readFileSync(join(dir, 'snapshot.json'), 'utf-8');
    const host = new URL(cms.url).host;
    const hit = raw.split('\n').filter((line) => line.includes(host) && !line.includes('"url"'));
    // Поле `origin.url` несёт адрес системы управления по замыслу (change
    // `cms-live-snapshot-capture`) — это отметка происхождения, а не ссылка на ресурс.
    expect(hit, `хост админки в значениях снимка:\n${hit.slice(0, 5).join('\n')}`).toEqual([]);
  });

  // Сценарий: внешние ссылки в содержимом сохраняются.
  // ЗЕЛЁНАЯ сегодня по построению: рерайта ещё нет. Проверка нужна как охрана к рерайту
  // `/uploads/` → `/media/uploads/`, который вводит реализация: он не должен трогать ничего,
  // кроме собственного каталога загрузок.
  it('внешняя ссылка в теле статьи уцелела дословно', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, `захват не прошёл:\n${run.output}`).toBe(0);

    const article = readSnapshot(dir).content.types.articles?.[0];
    expect(String(article?.body_html), 'внешняя ссылка исчезла из тела статьи').toContain(
      EXTERNAL_LINK_IN_BODY,
    );
    // И после локализации адресов — тем же путём, каким тело читает сайт.
    expect(localizeAssetUrls(String(article?.body_html))).toContain(EXTERNAL_LINK_IN_BODY);
  });

  // Регресс: прерванный съём заклинивал хранилище навсегда. Имя файла в хранилище — это хеш
  // его содержимого, поэтому обрыв посреди записи оставлял под верным именем обрезанные
  // байты; следующий прогон видел расхождение и ОТКАЗЫВАЛ, никто повреждённый файл не
  // перезаписывал, и каждый последующий съём падал, пока человек не сотрёт его руками.
  it('повреждённый файл в хранилище лечится записью, а не заклинивает съём', async () => {
    const store = await mediaStoreModule();
    const cms = await stub();
    const dir = outDir();

    const first = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(first.status, `первый съём не прошёл:\n${first.output}`).toBe(0);

    const snap = readSnapshot(dir);
    const victim = snap.content.media[0];
    expect(victim, 'заглушка не отдала ни одного медиа — проверка стала бы вакуумной').toBeTruthy();
    const stored = join(dir, 'media', victim.contentId);
    const original = readFileSync(stored);
    writeFileSync(stored, original.subarray(0, Math.max(1, original.length - 3)));
    expect(
      store.readFromStore({ storeDir: join(dir, 'media'), contentId: victim.contentId }).ok,
      'подготовка: файл должен был стать повреждённым',
    ).toBe(false);

    const second = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(second.status, `повторный съём после повреждения:\n${second.output}`).toBe(0);
    expect(
      store.readFromStore({ storeDir: join(dir, 'media'), contentId: victim.contentId }).ok,
      'повреждённый файл не восстановлен',
    ).toBe(true);
  });
});

describe('do not publish non-document upload types', () => {
  it('reports a skipped upload reference and does not copy it', async () => {
    const store = await mediaStoreModule();
    const baseDataset = mediaDataset();
    const current = baseDataset.articles.records[0]!;
    const rejected = ['page.HTML?cache=1', 'mark.Svg', 'client.JS'];
    const kept = ['cover.JPG', 'cover.JPEG', 'cover.PNG', 'cover.WEBP', 'brief.PDF?download=1'];
    const hrefs = [...rejected, ...kept]
      .map((name) => `<a href="${CMS_UPLOADS_PREFIX}${name}">${name}</a>`)
      .join('');
    const uploads: Record<string, StubUpload> = {};
    for (const name of [...rejected, ...kept]) {
      const path = `${CMS_UPLOADS_PREFIX}${name.split('?')[0]}`;
      uploads[path] = { bytes: Buffer.from(`bytes-for-${path}`) };
    }
    const cms = await stub({
      articles: { records: [{ ...current, body: `${current.body}${hrefs}` }] },
    }, uploads);
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, `capture failed:\n${run.output}`).toBe(0);

    const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf-8')) as CapturedSnapshot & {
      skippedUploads?: { ref: string }[];
    };
    const publishedNames = snap.content.media.map((item) => fileNameOf(item.ref));
    const report = JSON.stringify(snap.skippedUploads ?? []);
    const problems: string[] = [];
    if (!Array.isArray(snap.skippedUploads) || snap.skippedUploads.length === 0) {
      problems.push('rejection report is missing');
    }
    for (const name of ['page.HTML', 'mark.Svg', 'client.JS']) {
      if (!report.includes(name)) problems.push(`rejection report does not name ${name}`);
      if (publishedNames.includes(name)) problems.push(`published media includes ${name}`);
      const storedId = store.contentIdOf(Buffer.from(`bytes-for-${CMS_UPLOADS_PREFIX}${name}`));
      if (existsSync(join(dir, SNAPSHOT_MEDIA_DIRNAME, storedId))) {
        problems.push(`snapshot media store contains ${name}`);
      }
    }
    for (const name of ['cover.JPG', 'cover.JPEG', 'cover.PNG', 'cover.WEBP', 'brief.PDF']) {
      if (!publishedNames.includes(name)) problems.push(`published media is missing ${name}`);
    }

    const materialized = join(mkdtempSync(join(tmpdir(), 'ikpk-published-media-')), 'media');
    mkdirSync(materialized, { recursive: true });
    const laidOut = store.materializeInto({
      storeDir: join(dir, SNAPSHOT_MEDIA_DIRNAME),
      destDir: materialized,
      media: snap.content.media,
    });
    if (!laidOut.ok) problems.push(`materialize failed: ${laidOut.reason} ${laidOut.ref}`);
    const copiedNames = laidOut.ok
      ? readdirSync(materialized, { recursive: true }).map((entry) => fileNameOf(String(entry)))
      : [];
    for (const name of ['page.HTML', 'mark.Svg', 'client.JS']) {
      if (copiedNames.includes(name)) problems.push(`copied output includes ${name}`);
    }
    for (const name of ['cover.JPG', 'cover.JPEG', 'cover.PNG', 'cover.WEBP', 'brief.PDF']) {
      if (!copiedNames.includes(name)) problems.push(`copied output is missing ${name}`);
    }

    const siteDir = mkdtempSync(join(tmpdir(), 'ikpk-site-media-'));
    let copyIfPublishable: ((src: string, dest: string) => 'copied' | 'skipped') | undefined;
    try {
      ({ copyIfPublishable } = await import('../scripts/lib/publishable-media.ts'));
    } catch {
      copyIfPublishable = undefined;
    }
    if (typeof copyIfPublishable !== 'function') {
      problems.push('copy step allowlist is missing');
    } else {
      const originals = mkdtempSync(join(tmpdir(), 'ikpk-originals-'));
      for (const name of ['page.HTML', 'mark.Svg', 'client.JS', 'cover.JPG', 'cover.JPEG', 'cover.PNG', 'cover.WEBP', 'brief.PDF']) {
        const src = join(originals, name);
        writeFileSync(src, `disk-${name}`);
        copyIfPublishable(src, join(siteDir, name));
      }
      const siteNames = readdirSync(siteDir);
      for (const name of ['page.HTML', 'mark.Svg', 'client.JS']) {
        if (siteNames.includes(name)) problems.push(`site copy includes ${name}`);
      }
      for (const name of ['cover.JPG', 'cover.JPEG', 'cover.PNG', 'cover.WEBP', 'brief.PDF']) {
        if (!siteNames.includes(name)) problems.push(`site copy is missing ${name}`);
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });
});
