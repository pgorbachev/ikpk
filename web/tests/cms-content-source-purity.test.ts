import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
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
 * Сам файл проверки обязан содержать оба сегмента, чтобы их искать. Отдельно ниже
 * классифицируется standalone reader переноса, если он недостижим из пути публикации.
 */
const SELF = join('web', 'tests', 'cms-content-source-purity.test.ts');
const MIGRATION_ENTRY = join('scripts', 'import.ts');

const SCAN_ROOTS = [
  join(WEB_ROOT, 'src'),
  join(WEB_ROOT, 'scripts'),
  join(WEB_ROOT, 'tests'),
  join(REPO_ROOT, 'scripts'),
];
const SCAN_FILES = [join(WEB_ROOT, 'astro.config.mjs')];
const CODE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|astro|json)$/;

function namesLegacyContent(text: string): boolean {
  return text.includes(SEGMENT_A) && text.includes(SEGMENT_B);
}

function referencesMigrationEntry(source: string, text: string): boolean {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  let publicationCode = code;
  let publishStage = '';
  if (source === join('deploy', 'trial', 'deploy.sh')) {
    publishStage = code.match(/^stage_publish\s*\(\)\s*\{([\s\S]*?)^\}/m)?.[1] ?? '';
    // The orchestrator's explicit CMS import stage is a migration, not a web source. Keep
    // scanning every other deploy command and reject an import call from the publish stage.
    publicationCode = code
      .replace(/^stage_import\s*\(\)\s*\{[\s\S]*?^\}\s*$/m, '')
      .replace(/^\s*import\)\s*stage_import\s*;;\s*$/gm, '');
  }
  const targetsMigration = (specifier: string): boolean =>
    normalize(join(dirname(source), specifier)).replace(/\.(?:[cm]?[jt]sx?)$/, '') ===
    MIGRATION_ENTRY.replace(/\.ts$/, '');
  const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.[^'"\n]+)['"]/g;
  if (/\bstage_import\b/.test(publishStage)) return true;
  for (const match of publicationCode.matchAll(imports)) if (targetsMigration(match[1])) return true;

  const packageScript = source === join('scripts', 'package.json');
  let commandText = publicationCode;
  if (packageScript) {
    try {
      const scripts = JSON.parse(code).scripts as Record<string, string>;
      commandText = Object.entries(scripts)
        .filter(([name]) => !['import', 'import:dry'].includes(name))
        .map(([, value]) => value).join('\n');
    } catch { /* malformed package data is not an import edge */ }
  }
  const commandPathTargetsMigration = (path: string): boolean =>
    normalize(join(dirname(source), path)).replace(/\.(?:[cm]?[jt]sx?)$/, '') ===
    MIGRATION_ENTRY.replace(/\.ts$/, '');
  const relativeCommands = /\b(?:npx\s+)?(?:tsx|node)\s+((?:\.\.\/|\.\/)[^\s"'`]+import\.ts)\b/g;
  for (const match of commandText.matchAll(relativeCommands)) {
    if (commandPathTargetsMigration(match[1])) return true;
  }
  const relativePrefixes = /\b(?:npm|pnpm)\s+--prefix\s+([^\s]+)\s+run\s+import(?::dry)?\b/g;
  for (const match of commandText.matchAll(relativePrefixes)) {
    if (normalize(join(dirname(source), match[1])) === dirname(MIGRATION_ENTRY)) return true;
  }
  const scriptCwd = packageScript || /(?:\bcd\s+[^;\n]*\bscripts\b|--prefix\s+scripts\b)/.test(commandText);
  return (
    /\b(?:npx\s+)?(?:tsx|node)\s+\.?\/?scripts\/import\.ts\b/.test(commandText) ||
    /\b(?:npm|pnpm)\s+--prefix\s+scripts\s+run\s+import(?::dry)?\b/.test(commandText) ||
    (scriptCwd && /\b(?:npm|pnpm)\s+run\s+import(?::dry)?\b/.test(commandText)) ||
    (scriptCwd && /\btsx\s+\.?\/?import\.ts\b/.test(commandText))
  );
}

function isStandaloneMigrationReader(
  rel: string,
  text: string,
  publicationSources: Array<{ path: string; text: string }>,
): boolean {
  // Legacy data is allowed only in the explicit CMS importer, while disconnected from site output.
  return rel === MIGRATION_ENTRY && /legacyTransferDir\s*\(/.test(text) &&
    /async function loadJSON/.test(text) && /STRAPI_API_TOKEN/.test(text) &&
    /api(?:<[^>]+>)?\(\s*["'](?:POST|PUT)["']/.test(text) &&
    !publicationSources.some(({ path, text: source }) => referencesMigrationEntry(path, source));
}

function isBypassReader(
  rel: string,
  text: string,
  migrationReaderIsStandalone: boolean,
): boolean {
  return namesLegacyContent(text) && !(rel === MIGRATION_ENTRY && migrationReaderIsStandalone);
}

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

function publicationSources(overrides = new Map<string, string>()): Array<{ path: string; text: string }> {
  const webSource = [
    ...walk(join(WEB_ROOT, 'src')),
    ...walk(join(WEB_ROOT, 'scripts')),
    ...[join(WEB_ROOT, 'astro.config.mjs'), join(WEB_ROOT, 'package.json')].filter(existsSync),
    ...[join(REPO_ROOT, '.github', 'workflows', 'test.yml')].filter(existsSync),
  ];
  const scriptRuntime = [
    join(REPO_ROOT, 'scripts', 'publication-launcher.mjs'),
    join(REPO_ROOT, 'scripts', 'publication-transport.mjs'),
    join(REPO_ROOT, 'scripts', 'deploy-web.sh'),
    join(REPO_ROOT, 'scripts', 'package.json'),
    ...walk(join(REPO_ROOT, 'scripts', 'lib')).filter((file) => !/\.test\./.test(file)),
    join(REPO_ROOT, 'deploy', 'trial', 'deploy.sh'),
    join(REPO_ROOT, 'deploy', 'trial', 'refresh-site.sh'),
  ].filter((file) => existsSync(file));
  const paths = [...new Set([...webSource, ...scriptRuntime])].map((file) =>
    relative(REPO_ROOT, file).split(sep).join('/'),
  );
  for (const path of overrides.keys()) if (!paths.includes(path)) paths.push(path);
  return paths.map((path) => ({
    path,
    text: overrides.get(path) ?? readFileSync(join(REPO_ROOT, path), 'utf-8'),
  }));
}

function bypassReaders(): string[] {
  const publicationCode = publicationSources();
  const migrationReaderIsStandalone = isStandaloneMigrationReader(
    MIGRATION_ENTRY,
    readFileSync(join(REPO_ROOT, MIGRATION_ENTRY), 'utf-8'),
    publicationCode,
  );
  return scanned()
    .filter((file) => {
      const text = readFileSync(file, 'utf-8');
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      return isBypassReader(rel, text, migrationReaderIsStandalone);
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

  it('standalone CMS migration reader is permitted only while outside the publication path', () => {
    const migrationSource = readFileSync(join(REPO_ROOT, MIGRATION_ENTRY), 'utf-8');
    const sources = publicationSources();
    const paths = new Set(sources.map(({ path }) => path));
    expect([...paths]).toEqual(expect.arrayContaining([
      'scripts/publication-launcher.mjs', 'scripts/publication-transport.mjs',
      'scripts/deploy-web.sh', 'scripts/package.json', 'deploy/trial/deploy.sh',
      'deploy/trial/refresh-site.sh',
    ]));
    expect(isStandaloneMigrationReader(MIGRATION_ENTRY, migrationSource, sources)).toBe(true);

    // Mutate actual production-entry inventory locations, not an out-of-band source list.
    const incomingEdges = [
      ['scripts/publication-launcher.mjs', `import './import.js';`],
      ['scripts/deploy-web.sh', `cd "$ROOT/scripts"\nexec tsx import.ts\nnpm run import`],
      ['scripts/package.json', JSON.stringify({ scripts: { import: 'tsx import.ts', publish: 'npm --prefix scripts run import' } })],
      ['web/package.json', JSON.stringify({ scripts: { publish: 'tsx ../scripts/import.ts' } })],
      ['web/package.json', JSON.stringify({ scripts: { publish: 'npm --prefix ../scripts run import' } })],
      ['deploy/trial/deploy.sh', `stage_publish() {\n  npm --prefix scripts run import\n}`],
      ['deploy/trial/deploy.sh', `stage_publish() {\n  stage_import\n}`],
      ['deploy/trial/refresh-site.sh', `import '../../scripts/import.js';`],
    ] as const;
    for (const [path, source] of incomingEdges) {
      const withIncomingEdge = publicationSources(new Map([[path, source]]));
      expect(
        isStandaloneMigrationReader(MIGRATION_ENTRY, migrationSource, withIncomingEdge),
        `${path} can reach the migration importer`,
      ).toBe(false);
    }
  });

  it('a discovery/entities fallback in site code remains a bypass', () => {
    expect(
      isBypassReader(
        'web/src/lib/data.ts',
        `readFileSync(join('discovery', 'entities', 'articles.json'), 'utf-8')`,
        false,
      ),
    ).toBe(true);
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
    const dir = fixtureDir();
    expect(existsSync(dir)).toBe(true);
    // Каталог без snapshot.json — вакуум: «фикстура есть» при отсутствии предмета.
    expect(
      existsSync(join(dir, 'snapshot.json')),
      `в ${dir} нет snapshot.json — закреплённый снимок как предмет отсутствует`,
    ).toBe(true);
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
