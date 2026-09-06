// Тесты по утверждённой спеке `cms-media-pipeline`
// (`openspec/changes/cms-content-authoring-and-migration/specs/cms-media-pipeline/spec.md`).
//
// Предмет — путь файла от снимка до адреса отдачи: переписывание каталога загрузок системы
// управления в статический адрес сайта и раскладка байтов хранилища на диск сборки.
//
// КРАСНЫЕ ПО ЗАМЫСЛУ:
//   * `web/src/lib/media.ts`, `localizeAssetUrls` знает только легаси-бакет
//     (`replaceAll(BUCKET_PREFIX, '')`) — адрес `/uploads/<файл>` из системы управления она
//     оставляет как есть, и страница просит у сайта путь, которого на нём нет (наблюдено:
//     `/uploads/1_1732538413910_61932bccdb.webp` отдаёт 404 на стенде);
//   * `web/scripts/lib/content-media-store.ts` умеет читать файл по идентификатору
//     содержимого, но не умеет раскладывать медиа снимка на диск сборки — генератору
//     производных нечего увидеть.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUCKET_PREFIX, localizeAssetUrls } from '../src/lib/media';
import {
  CMS_UPLOADS_PREFIX,
  SITE_MEDIA_PREFIX,
  mediaStoreModule,
  requireExport,
} from './helpers/cms-media-pipeline-contract';

// ══════════ Требование: изображения отдаются с сайта, а не из системы управления ══════════

describe('адрес каталога загрузок переписывается в статический адрес сайта', () => {
  // Сценарий: страница с загруженным изображением не ссылается на систему управления
  it('одиночный адрес загрузки становится адресом сайта', () => {
    expect(localizeAssetUrls(`${CMS_UPLOADS_PREFIX}img-1.webp`)).toBe(
      `${SITE_MEDIA_PREFIX}img-1.webp`,
    );
  });

  it('адрес внутри разметки переписывается там же, где встретился', () => {
    const html = `<p><img src="${CMS_UPLOADS_PREFIX}a.webp"><img src="${CMS_UPLOADS_PREFIX}b.webp"></p>`;
    const out = localizeAssetUrls(html);
    expect(out).toContain(`src="${SITE_MEDIA_PREFIX}a.webp"`);
    expect(out).toContain(`src="${SITE_MEDIA_PREFIX}b.webp"`);
    expect(out, 'остался адрес каталога загрузок').not.toContain(`"${CMS_UPLOADS_PREFIX}`);
  });

  it('абсолютный адрес системы управления тоже не доживает до страницы', () => {
    const out = localizeAssetUrls(
      `https://cms.example.invalid${CMS_UPLOADS_PREFIX}c.webp`,
      'https://cms.example.invalid',
    );
    expect(out, `в выводе остался хост системы управления: ${out}`).not.toContain(
      'cms.example.invalid',
    );
    expect(out).toBe(`${SITE_MEDIA_PREFIX}c.webp`);
  });

  // Сценарий: внешние ссылки в содержимом сохраняются.
  // ЗЕЛЁНАЯ сегодня — охрана к рерайту выше: он не должен трогать ничего, кроме каталога
  // загрузок системы управления.
  it('сторонние ссылки и уже локальные адреса не трогаются', () => {
    const external = 'https://example.invalid/article?id=1#top';
    expect(localizeAssetUrls(external)).toBe(external);
    expect(localizeAssetUrls('https://www.youtube.com/embed/abc')).toBe(
      'https://www.youtube.com/embed/abc',
    );
    expect(localizeAssetUrls('/media/legacy/logo-v2.png')).toBe('/media/legacy/logo-v2.png');
    // Легаси-бакет продолжает локализоваться прежним способом.
    expect(localizeAssetUrls(`${BUCKET_PREFIX}/media/users/1/images/x.webp`)).toBe(
      '/media/users/1/images/x.webp',
    );
    expect(localizeAssetUrls('https://third.example/uploads/report.pdf')).toBe(
      'https://third.example/uploads/report.pdf',
    );
    expect(localizeAssetUrls('https://third.example/?next=/uploads/report.pdf')).toBe(
      'https://third.example/?next=/uploads/report.pdf',
    );
  });
});

// ═════ Требование: у каждого отдаваемого изображения есть производные и известные размеры ═════
//
// Часть «файл вообще доехал до генератора производных». Сами производные и записи манифеста
// проверяются на собранном дереве (`web/tests/cms-media-derivatives.build.test.ts`).

describe('медиа снимка раскладывается на диск сборки', () => {
  const bytesOf = (s: string): Buffer => Buffer.from(s, 'utf-8');

  async function storeWith(entries: Record<string, string>): Promise<{
    storeDir: string;
    destDir: string;
    media: { ref: string; contentId: string }[];
  }> {
    const store = await mediaStoreModule();
    const storeDir = mkdtempSync(join(tmpdir(), 'ikpk-media-store-'));
    const destDir = join(mkdtempSync(join(tmpdir(), 'ikpk-media-dest-')), 'media-originals');
    mkdirSync(destDir, { recursive: true });
    const media = Object.entries(entries).map(([name, content]) => {
      const contentId = store.contentIdOf(bytesOf(content));
      writeFileSync(join(storeDir, contentId), bytesOf(content));
      return { ref: `${SITE_MEDIA_PREFIX}${name}`, contentId };
    });
    return { storeDir, destDir, media };
  }

  it('файл ложится по пути, соответствующему адресу отдачи, байт в байт', async () => {
    const materializeInto = await requireExport(mediaStoreModule(), 'materializeInto');
    const { storeDir, destDir, media } = await storeWith({
      'img-1.webp': 'first file',
      'img-2.webp': 'second file',
    });

    const result = materializeInto({ storeDir, destDir, media });
    expect(result.ok, result.ok ? '' : `${result.reason}: ${result.ref}`).toBe(true);

    // `/media/uploads/img-1.webp` → `<корень оригиналов>/uploads/img-1.webp`: генератор
    // производных обходит корень и склеивает ключ манифеста как `/media/<относительный путь>`
    // (`web/scripts/make-derivatives.ts`).
    expect(readFileSync(join(destDir, 'uploads', 'img-1.webp'), 'utf-8')).toBe('first file');
    expect(readFileSync(join(destDir, 'uploads', 'img-2.webp'), 'utf-8')).toBe('second file');
  });

  it('подмена байтов в хранилище — отказ с указанием ссылки, а не разложенный чужой файл', async () => {
    const materializeInto = await requireExport(mediaStoreModule(), 'materializeInto');
    const { storeDir, destDir, media } = await storeWith({ 'img-1.webp': 'genuine content' });

    writeFileSync(join(storeDir, media[0]!.contentId), bytesOf('substituted content'));

    const result = materializeInto({ storeDir, destDir, media });
    expect(result.ok, 'подмена попала бы на диск сборки').toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('content-id-mismatch');
      expect(result.ref).toBe(media[0]!.ref);
    }
    expect(
      existsSync(join(destDir, 'uploads', 'img-1.webp')),
      'подменённый файл всё-таки разложен',
    ).toBe(false);
  });

  it('отсутствующий в хранилище файл отличается от подменённого', async () => {
    const materializeInto = await requireExport(mediaStoreModule(), 'materializeInto');
    const { storeDir, destDir, media } = await storeWith({ 'img-1.webp': 'genuine content' });

    const store = await mediaStoreModule();
    const orphan = { ref: `${SITE_MEDIA_PREFIX}img-9.webp`, contentId: store.contentIdOf(bytesOf('gone')) };

    const result = materializeInto({ storeDir, destDir, media: [...media, orphan] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing');
      expect(result.ref).toBe(orphan.ref);
    }
  });

  it('пустой список медиа не выдаёт себя за выполненную раскладку', async () => {
    const materializeInto = await requireExport(mediaStoreModule(), 'materializeInto');
    const { storeDir, destDir } = await storeWith({});

    const result = materializeInto({ storeDir, destDir, media: [] });
    // Раскладывать нечего — законный исход, но и следов остаться не должно: пустой список,
    // выдавший непустое дерево, означал бы чужие файлы на входе генератора производных.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.written).toEqual([]);
    expect(readdirSync(destDir)).toEqual([]);
  });
});

// ═════════════════ Покрытие спеки `cms-media-pipeline`: чем закрыт каждый сценарий ════════
//
// Требование «Изображения отдаются с сайта, а не из системы управления»
//   * страница с загруженным изображением не ссылается на систему управления — ЕСТЬ:
//     `cms-media-capture.test.ts` (медиа попадает в снимок содержимым), этот файл (рерайт
//     адреса), `cms-media-derivatives.build.test.ts` (в собранном дереве нет `/uploads/`);
//   * внешние ссылки в содержимом сохраняются — ЕСТЬ: этот файл и `cms-media-capture.test.ts`.
//
// Требование «У каждого отдаваемого изображения есть производные и известные размеры»
//   * новое изображение получает производные и размеры — ЕСТЬ: раскладка на диск сборки в
//     этом файле, размеры и файлы — `cms-media-derivatives.build.test.ts`;
//   * адаптивный набор не ссылается на отсутствующие файлы — ЕСТЬ:
//     `cms-media-derivatives.build.test.ts` и существующий гейт `media-migration.test.ts`
//     («every image reference resolves locally» разбирает и `srcset`);
//   * изображение без известных размеров останавливает сборку — ЕСТЬ ПО СЛЕДСТВИЮ:
//     `cms-media-derivatives.build.test.ts` требует размеры у каждого `<img src="/media/…">`
//     собранных страниц. Проверять сам факт ненулевого кода выхода сборки здесь нечем: у
//     `web/scripts/make-derivatives.ts` нет входа, которым можно задать «изображение
//     используется, но записи о нём нет», — такой вход появится вместе с реализацией (задача
//     5.2), и проверка кода выхода принадлежит ей.
//
// Требование «Существующие оригиналы разделены на перенесённые и остающиеся материалом
// сборки» (три сценария) — ПРОВЕРКИ НЕТ. Предмет — перенос контента в медиатеку
// (`scripts/import.ts`, задачи 8.1 и 8.1b), а не конвейер отдачи: исполнителя у требования в
// коде пока нет вовсе, и тест здесь проверял бы собственную выдумку о будущем импортёре.
//
// Требование «Оригинал загруженного изображения сохраняется неизменным» — ПРОВЕРКА ЧАСТИЧНАЯ.
// Для медиа системы управления «оригинал» — это байты в хранилище снимка, и их неизменность
// стережёт сверка по идентификатору содержимого (`readFromStore` в
// `cms-snapshot-media.test.ts`, `materializeInto` выше: подмена — отказ). Побайтовая
// неизменность каталога `media-originals/` после сборки (задача 5.5) не проверяется: для неё
// нужен прогон генератора производных по 445 файлам, а он занимает минуты и переписывает
// отслеживаемый `web/src/lib/media-manifest.json` — цена несоразмерна, и проверка принадлежит
// той задаче, где генератор всё равно запускается.
//
// Требование «Недопустимая загрузка отклоняется при загрузке» (три сценария) — ПРОВЕРКИ НЕТ.
// Предмет — конфигурация загрузчика Strapi (`cms/`, задача 5.4): отказ обязан происходить в
// админке при загрузке, а не позже в сборке, поэтому из набора `web/tests` его наблюдать
// нечем. Проверка принадлежит набору `cms/`.
