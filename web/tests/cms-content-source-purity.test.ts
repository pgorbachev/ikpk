import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT, WEB_ROOT } from './helpers/cms-content-publication-contract';

// Спека `cms-content-source`: требования «Контент читается только через снимок, без обходных
// путей» и «Проверки предложений изменений идут по закреплённому снимку».
//
// Этот файл КРАСЕН НЕ ИЗ-ЗА ОТСУТСТВУЮЩЕГО МОДУЛЯ, а против текущего дерева: обходные чтения
// материала переноса существуют прямо сейчас, и их число — предмет требования. Тест зеленеет,
// когда реализация переведёт всё на снимок (tasks.md 1a, 3, 5.4, 5.5, 5.5b, 6.1).
//
// ПРИЗНАК ВЫБРАН ПО ПРЕДМЕТУ, А НЕ ПО УДОБСТВУ GREP. Поиск строкового литерала
// `discovery/entities` не видит путей, собранных из сегментов
// (`join('discovery', 'entities', …)` в `web/tests/teacher-lead.test.ts`), и по нему выходит
// 5–6 файлов вместо двенадцати (design.md, Migration Plan, пункт 3). Поэтому признак —
// СОВМЕСТНОЕ присутствие обоих сегментов в файле. Слово `discovery` в одиночку не годится в
// другую сторону: `web/tests/repo-hygiene.test.ts` читает `discovery/url_map.csv` — артефакт
// миграции URL, а не контент, — и по одному слову предикат давал бы 13.

const SEGMENT_A = 'discovery';
const SEGMENT_B = 'entities';

/**
 * Единственное поимённое исключение — сам этот файл: он обязан содержать оба сегмента, чтобы
 * их искать. Исключение названо здесь, а не спрятано в предикате.
 */
const SELF = join('web', 'tests', 'cms-content-source-purity.test.ts');

const SCAN_ROOTS = [
  join(WEB_ROOT, 'src'),
  join(WEB_ROOT, 'scripts'),
  join(WEB_ROOT, 'tests'),
  join(REPO_ROOT, 'scripts'),
];
const SCAN_FILES = [join(WEB_ROOT, 'astro.config.mjs')];
const CODE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|astro|json)$/;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : CODE_EXT.test(name) ? [full] : [];
  });
}

function scanned(): string[] {
  const files = [...SCAN_ROOTS.flatMap(walk), ...SCAN_FILES.filter(existsSync)];
  if (files.length === 0) throw new Error('нечего сканировать: список файлов пуст');
  return files;
}

function bypassReaders(): string[] {
  return scanned()
    .filter((file) => {
      const text = readFileSync(file, 'utf-8');
      return text.includes(SEGMENT_A) && text.includes(SEGMENT_B);
    })
    .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
    .filter((rel) => rel !== SELF.split(sep).join('/'))
    .sort();
}

describe('контент читается только через снимок', () => {
  it('предикат вообще что-то видит — иначе «обходов нет» означало бы «я не проверила»', () => {
    // Контроль вакуумности: сканируемых файлов много, и признак на них исполняется.
    expect(scanned().length).toBeGreaterThan(50);
  });

  // Сценарий: обходных чтений не осталось
  it('ни один файл сборки, скриптов и проверок не читает материал переноса напрямую', () => {
    const found = bypassReaders();
    expect(found, `обходные чтения материала переноса (${found.length}):\n${found.join('\n')}`).toEqual([]);
  });

  // Сценарий: записи-заплатки расписания перестают участвовать в сборке вместе с переключением
  it('модуль записей-заплаток расписания в сборке не участвует', () => {
    const importers = scanned()
      .filter((file) => /schedule-supplements/.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .filter((rel) => rel !== SELF.split(sep).join('/'))
      .sort();

    expect(
      importers,
      'страница расписания подмешивает записи из модуля репозитория — это тот же обход, что и чтение файла',
    ).toEqual([]);
  });

  it('data.ts читает снимок, а не каталог материала переноса', () => {
    const dataTs = join(WEB_ROOT, 'src', 'lib', 'data.ts');
    expect(existsSync(dataTs), 'web/src/lib/data.ts не найден').toBe(true);
    const text = readFileSync(dataTs, 'utf-8');

    expect(text.includes(SEGMENT_A) && text.includes(SEGMENT_B)).toBe(false);
    expect(text, 'источник данных не назван снимком').toMatch(/snapshot/i);
    // Форма чтения остаётся синхронной: 31 файл `web/src` не переписывается (design.md, D1),
    // и сборка не обращается к системе управления во время генерации.
    expect(text).toMatch(/readFileSync/);
    expect(text, 'генерация обращается к системе управления — снимок перестал быть снимком').not.toMatch(
      /\bfetch\s*\(/,
    );
  });
});

describe('проверки предложений изменений идут по закреплённому снимку', () => {
  /** Закреплённый снимок-фикстура: лежит в репозитории и потому не зависит ни от сети,
   *  ни от текущего состояния системы управления. */
  const FIXTURE_CANDIDATES = [
    join(WEB_ROOT, 'tests', 'fixtures', 'content-snapshot'),
    join(REPO_ROOT, 'fixtures', 'content-snapshot'),
  ];

  const fixtureDir = (): string => {
    const found = FIXTURE_CANDIDATES.find(existsSync);
    if (!found)
      throw new Error(
        `закреплённого снимка нет ни по одному из путей: ${FIXTURE_CANDIDATES.join(', ')}`,
      );
    return found;
  };

  // Сценарии: проверка предложения не зависит от текущего контента; проверка предложения
  // выполняется без сети
  it('закреплённый снимок лежит в репозитории', () => {
    expect(existsSync(fixtureDir())).toBe(true);
  });

  // Сценарий: закреплённый снимок в другой календарный день
  it('у закреплённого снимка своя опорная дата, зафиксированная в нём самом', () => {
    const dir = fixtureDir();
    const manifest = readdirSync(dir).find((name) => /snapshot\.json$|manifest\.json$/.test(name));
    expect(manifest, `в ${dir} нет манифеста снимка`).toBeDefined();

    const parsed = JSON.parse(readFileSync(join(dir, manifest as string), 'utf-8')) as {
      referenceDate?: unknown;
      pinned?: unknown;
    };
    expect(parsed.referenceDate, 'опорная дата не зафиксирована — эталоны разойдутся от хода времени').toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(parsed.pinned).toBe(true);
  });

  /**
   * Признак — АДРЕС системы управления в окружении проверки, а не любое упоминание букв
   * `CMS`. Первая редакция ловила `CMS_(URL|TOKEN|API|BASE)` и давала два ложных
   * расхождения на `tests/helpers/rich-content-safety/paths.ts`, где `CMS_API_DIR` — путь к
   * каталогу `cms/src/api` в этом же репозитории, то есть ровно противоположное сети.
   * Токен сам по себе тоже не признак: `cms-article-catalog-snapshot.build.test.ts` читает
   * его, чтобы проверить ОТСУТСТВИЕ токена в выводе.
   *
   * Этот тест зелёный и сегодня, и это его назначение: он охраняет инвариант от реализации,
   * которая переведёт проверки на снимок и может увести их в сеть. Красным он станет ровно
   * тогда, когда обязательная проверка начнёт спрашивать живую систему управления.
   */
  it('ни одна проверка не обращается к системе управления', () => {
    const files = walk(join(WEB_ROOT, 'tests'));
    expect(files.length, 'файлов проверок не найдено — вакуумная проверка').toBeGreaterThan(50);

    const networked = files
      .filter((file) => /process\.env\.(CMS|STRAPI)_(URL|API|BASE)/.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .sort();

    expect(networked, 'обязательная проверка зависит от сети и от текущего контента').toEqual([]);
  });

  // Сценарий: визуальные эталоны сравниваются на закреплённом контенте
  it('сравнение с визуальными эталонами идёт на закреплённом снимке', () => {
    const baseline = join(WEB_ROOT, 'tests', 'visual-baseline.spec.ts');
    expect(existsSync(baseline), 'файл визуальных эталонов не найден — проверять нечего').toBe(true);
    expect(
      readFileSync(baseline, 'utf-8'),
      'эталоны снимаются с контента, который может измениться между прогонами',
    ).toMatch(/snapshot|фикстур|pinned/i);
  });
});
