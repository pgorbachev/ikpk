/**
 * КРАСНЫЕ тесты по change `cms-content-authoring-and-migration`,
 * capability `cms-media-pipeline`: разделение оригиналов, неизменность оригинала и
 * ограничения загрузки.
 *
 * Предметы, существующие в репозитории: конвейер производных
 * (`web/scripts/make-derivatives.ts`), каталог оригиналов `media-originals/` и
 * конфигурация загрузки Strapi (`cms/config/plugins.ts`). Всё, что требует ЗАГРУЗКИ
 * через развёрнутую админку, перечислено в конце файла с названной причиной.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const ORIGINALS = join(ROOT, 'media-originals');

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Реестр разделения оригиналов. Спека требует, чтобы разделение было НАЗВАНО ЯВНО;
 * файла для него сегодня нет ни одного, поэтому проверка красная по существу, а не по
 * имени: принимается любое из кандидатных мест.
 */
const SPLIT_CANDIDATES = [
  join(ROOT, 'media-originals', 'ownership.json'),
  join(ROOT, 'discovery', 'media-ownership.json'),
  join(ROOT, 'web', 'src', 'lib', 'media-ownership.json'),
];

describe('cms-media-pipeline: оригиналы разделены на перенесённые и материал сборки', () => {
  it('предмет проверки существует: каталог оригиналов непуст', () => {
    expect(existsSync(ORIGINALS), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${ORIGINALS}`).toBe(true);
    expect(allFiles(ORIGINALS).length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: оригиналов нет вовсе').toBeGreaterThan(0);
  });

  // Scenario: дизайнерский материал остаётся в репозитории.
  // Требование: разделение SHALL быть названо явно — иначе часть контента ссылается на
  // медиатеку, часть на файлы репозитория, и «источник истины — база» верно наполовину.
  it('реестр разделения оригиналов существует', () => {
    const found = SPLIT_CANDIDATES.filter((f) => existsSync(f));
    expect(
      found.map((f) => relative(ROOT, f)),
      `разделение оригиналов не названо ни в одном из мест: ${SPLIT_CANDIDATES.map((f) => relative(ROOT, f)).join(', ')}`,
    ).not.toEqual([]);
  });

  it('реестр покрывает каждый оригинал: непокрытых нет', () => {
    const registry = SPLIT_CANDIDATES.find((f) => existsSync(f));
    expect(registry, 'реестра разделения нет — покрытие считать не от чего').toBeDefined();
    const json = JSON.parse(readFileSync(registry!, 'utf-8')) as Record<string, unknown>;
    const declared = new Set(Object.keys(json));
    const files = allFiles(ORIGINALS).map((f) => relative(ORIGINALS, f));
    const uncovered = files.filter((f) => !declared.has(f));
    expect(uncovered.length, `оригиналов без объявленной принадлежности: ${uncovered.length}`).toBe(0);
  });

  it('реестр различает контент и материал сборки, а не помечает всё одним', () => {
    const registry = SPLIT_CANDIDATES.find((f) => existsSync(f));
    expect(registry).toBeDefined();
    const json = JSON.parse(readFileSync(registry!, 'utf-8')) as Record<string, string>;
    const values = new Set(Object.values(json));
    expect(values.size, 'все оригиналы отнесены к одной группе — разделения нет').toBeGreaterThan(1);
  });
});

describe('cms-media-pipeline: оригинал загруженного изображения сохраняется неизменным', () => {
  // Scenario: оригинал не изменяется сборкой.
  // Проверяется по ИСХОДНИКУ конвейера: сборка не пишет в каталог оригиналов вовсе.
  // Побайтовое сравнение до и после сборки дало бы тот же ответ дороже, а на CMS-медиа
  // (которого сегодня нет) — вакуумно.
  it('конвейер производных не пишет в каталог оригиналов', () => {
    const file = join(ROOT, 'web', 'scripts', 'make-derivatives.ts');
    expect(existsSync(file), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${file}`).toBe(true);
    const code = readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');

    const originalsSymbol = /const\s+(\w+)\s*=\s*join\([^)]*['"]media-originals['"]/.exec(code);
    expect(
      originalsSymbol,
      'ПРОВЕРИТЬ НЕ УДАЛОСЬ: в конвейере не найдено объявление каталога оригиналов',
    ).not.toBeNull();
    const name = originalsSymbol![1];

    const writes = code
      .split('\n')
      .filter((line) => /\b(writeFileSync|writeFile|rmSync|unlinkSync|copyFileSync|renameSync)\b/.test(line))
      .filter((line) => new RegExp(`\\b${name}\\b`).test(line));
    expect(writes, 'сборка пишет в каталог оригиналов — оригинал перестаёт быть оригиналом').toEqual([]);
  });
});

describe('cms-media-pipeline: недопустимая загрузка отклоняется при загрузке', () => {
  function uploadConfig(): string {
    const file = join(ROOT, 'cms', 'config', 'plugins.ts');
    expect(existsSync(file), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${file}`).toBe(true);
    return readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');
  }

  it('конфигурация загрузки существует и настраивает upload', () => {
    expect(
      /upload/i.test(uploadConfig()),
      'плагин загрузки не настроен вовсе: ограничений на загружаемый файл нет',
    ).toBe(true);
  });

  // Scenario: превышение предела размера не принимается
  it('предел размера файла задан', () => {
    expect(
      /sizeLimit|fileSize|maxFileSize/i.test(uploadConfig()),
      'предел размера загружаемого файла не задан',
    ).toBe(true);
  });

  // Scenario: векторная графика с разметкой не принимается
  it('перечень принимаемых форматов задан и векторной графики в нём нет', () => {
    const config = uploadConfig();
    expect(
      /allowedTypes|mime|allowedFormats/i.test(config),
      'перечень принимаемых форматов не задан: принимается что угодно',
    ).toBe(true);
    expect(/svg/i.test(config), 'векторная графика в перечне принимаемых форматов').toBe(false);
  });

  // Scenario: допустимое изображение принимается
  it('растровые форматы в перечне присутствуют', () => {
    const config = uploadConfig();
    const raster = ['jpeg', 'jpg', 'png', 'webp'].filter((f) => new RegExp(f, 'i').test(config));
    expect(raster, 'ни одного растрового формата не разрешено — загружать нечего').not.toEqual([]);
  });
});

/*
 * СЦЕНАРИИ cms-media-pipeline БЕЗ АВТОМАТИЧЕСКОЙ ПРОВЕРКИ ЗДЕСЬ
 *
 * 1. Требуют ЗАГРУЗКИ через развёрнутую админку, которой нет ни в репозитории, ни в CI.
 *    Мок медиатеки проверял бы собственную заглушку. Проверка — после развёртывания, со
 *    свидетельством (файл, ответ админки, адреса в разметке):
 *      - «страница с загруженным изображением не ссылается на систему управления»;
 *      - «новое изображение получает производные и размеры»;
 *      - «перенесённая запись ссылается на медиатеку».
 *    Дополнительно: до переключения источника сборки (change `cms-content-publication`)
 *    эти проверки ВАКУУМНЫ даже при развёрнутом Strapi — на страницах нет ни одного
 *    изображения из медиатеки, и «ни один адрес не указывает на хост CMS» верно на
 *    пустом множестве. Вакуумность названа здесь, а не выдана за зелёный цвет.
 *
 * 2. Уже покрыты существующими гейтами, и дублировать их нельзя — два гейта над одним
 *    предметом расходятся в ответах молча:
 *      - «внешние ссылки в содержимом сохраняются» — `tests/rich-content-contract.test.ts`
 *        («mailto, tel, http, https и root-relative якоря сохраняются»);
 *      - «адаптивный набор не ссылается на отсутствующие файлы» и «изображение без
 *        известных размеров останавливает сборку» — там же (`broken-local srcset валит
 *        сборку`, `descriptor не совпадающий с width в URL валит сборку`) и
 *        `tests/media-manifest.test.ts`.
 *    Оба на текущем коде ЗЕЛЁНЫЕ: требование уже выполняется для медиа репозитория.
 *
 * 3. «Повторный перенос не дублирует медиатеку» — проверено чисто в
 *    `scripts/lib/cms-migration.test.ts` (ключ по содержимому файла).
 */
