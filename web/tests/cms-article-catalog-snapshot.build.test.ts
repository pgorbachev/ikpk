import { afterAll, describe, it, expect } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { dist, allPages } from './helpers/dist-pages';
import { REPO_ROOT, WEB_ROOT, type Snapshot } from './helpers/cms-content-publication-contract';
import { readSitemapTree } from './helpers/sitemap-xml';

const PINNED_SNAPSHOT_DIR = join(REPO_ROOT, 'fixtures', 'content-snapshot');
const SITEMAP_TEST_CONFIG = join('tests', 'fixtures', 'sitemap-lastmod', 'astro.config.mjs');
const ASTRO_BIN = join(WEB_ROOT, 'node_modules', '.bin', 'astro');
let sitemapScratch: string | undefined;

afterAll(() => {
  if (sitemapScratch) rmSync(sitemapScratch, { recursive: true, force: true });
});

function scratchDir(): string {
  sitemapScratch ??= mkdtempSync(join(tmpdir(), 'ikpk-sitemap-lastmod-'));
  return sitemapScratch;
}

function hasProductionSerializer(source: string): boolean {
  const file = ts.createSourceFile('astro.config.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'sitemap') {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const prop = options.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(file) === 'serialize');
        if (prop && ts.isPropertyAssignment(prop) && ts.isArrowFunction(prop.initializer)) {
          const fn = prop.initializer;
          found = fn.parameters.length === 1 && ts.isIdentifier(fn.parameters[0].name)
            && ts.isCallExpression(fn.body) && ts.isIdentifier(fn.body.expression)
            && fn.body.expression.text === 'serializeSitemapEntry' && fn.body.arguments.length === 1
            && ts.isIdentifier(fn.body.arguments[0]) && fn.body.arguments[0].text === fn.parameters[0].name.text;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function copySnapshot(name: string): { dir: string; snapshot: BuiltSnapshot } {
  const dir = join(scratchDir(), name);
  cpSync(PINNED_SNAPSHOT_DIR, dir, { recursive: true });
  const file = join(dir, 'snapshot.json');
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as BuiltSnapshot;
  return { dir, snapshot };
}

function saveSnapshot(dir: string, snapshot: BuiltSnapshot): void {
  writeFileSync(join(dir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
}

function buildSnapshot(snapshotDir: string, name: string): string {
  const outDir = join(scratchDir(), name);
  const env: NodeJS.ProcessEnv = { ...process.env, CONTENT_SNAPSHOT_DIR: snapshotDir, PAYMENT_ROLE: 'ci' };
  delete env.DEMO_PROFILE;
  delete env.DEMO_OUTPUT;
  delete env.DEMO_FORMS;
  delete env.PAYMENT_ENDPOINT_PROD;
  delete env.PAYMENT_ENDPOINT_STAND;
  execFileSync(ASTRO_BIN, ['--config', 'astro.config.mjs', 'build', '--outDir', outDir], {
    cwd: WEB_ROOT,
    env,
    stdio: 'pipe',
    maxBuffer: 8 * 1024 * 1024,
  });
  return outDir;
}

// Спека `article-catalog` (MODIFIED) и часть `cms-content-source` про вывод сборки.
//
// Предмет — СОБРАННОЕ ДЕРЕВО, поэтому файл живёт в наборе `vitest.build.config.ts`, который
// запускается после сборки. Проверять здесь нечего без dist: отсутствие каталога — «не
// выполнено», а не успех.
//
// КРАСНЫЕ ПО ЗАМЫСЛУ: снимка, которым выполнена сборка, ещё нет — сборка идёт из файлов
// материала переноса (tasks.md 3.1, 5.5b, 6.1).

/**
 * Снимок, которым выполнена сборка. Реализация обязана положить его рядом с выводом: без
 * этого нельзя ни сказать, что опубликовано, ни повторить сборку.
 */
const SNAPSHOT_CANDIDATES = [
  join(WEB_ROOT, 'dist-snapshot', 'snapshot.json'),
  join(WEB_ROOT, '.snapshot', 'snapshot.json'),
  join(REPO_ROOT, 'build-snapshot', 'snapshot.json'),
];

interface BuiltSnapshot extends Snapshot {
  fingerprint: string;
  snapshotId: string;
}

function snapshotOfBuild(): BuiltSnapshot {
  const found = SNAPSHOT_CANDIDATES.find(existsSync);
  if (!found)
    throw new Error(
      `снимка сборки нет ни по одному из путей: ${SNAPSHOT_CANDIDATES.join(', ')}. ` +
        'Сборка выполнена не из снимка — проверять соответствие нечему.',
    );
  return JSON.parse(readFileSync(found, 'utf-8')) as BuiltSnapshot;
}

function articlesOfSnapshot(): { slug: string }[] {
  const records = snapshotOfBuild().content.types.articles;
  if (!Array.isArray(records) || records.length === 0)
    throw new Error('в снимке нет статей — вакуумная проверка');
  return records as { slug: string }[];
}

function requireDist(): void {
  if (!existsSync(dist) || readdirSync(dist).length === 0)
    throw new Error(`ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет собранного дерева ${dist}`);
}

describe('каталог статей собран из снимка', () => {
  // Сценарий: у каждой статьи каталога есть своя страница
  it('у каждой статьи снимка есть страница с непустым содержимым', () => {
    requireDist();
    const missing: string[] = [];
    const empty: string[] = [];

    for (const { slug } of articlesOfSnapshot()) {
      const file = join(dist, 'statyi', slug, 'index.html');
      if (!existsSync(file)) {
        missing.push(slug);
        continue;
      }
      if (readFileSync(file, 'utf-8').trim().length === 0) empty.push(slug);
    }

    expect(missing, `нет страниц статей: ${missing.join(', ')}`).toEqual([]);
    expect(empty, `пустые страницы статей: ${empty.join(', ')}`).toEqual([]);
  });

  it('страниц статей ровно столько, сколько статей в снимке', () => {
    requireDist();
    const built = allPages().filter((p) => /^\/statyi\/[^/]+\/$/.test(p) && !/^\/statyi\/page\//.test(p));
    expect(built.length).toBe(articlesOfSnapshot().length);
  });

  // Сценарий: адрес не зависит от места в списке
  it('адрес статьи определяется только её slug', () => {
    requireDist();
    const bySlug = articlesOfSnapshot().map(({ slug }) => `/statyi/${slug}/`).sort();
    const built = allPages()
      .filter((p) => /^\/statyi\/[^/]+\/$/.test(p) && !/^\/statyi\/page\//.test(p))
      .sort();
    expect(built).toEqual(bySlug);
  });

  // Сценарий: вариант со слэшем не создаёт второго адреса
  it('для каждого адреса каталога есть постоянное перенаправление со слэша, и цель существует', () => {
    requireDist();
    const redirects = join(REPO_ROOT, 'deploy', 'nginx-redirects.conf');
    expect(existsSync(redirects), `нет файла перенаправлений ${redirects}`).toBe(true);
    const conf = readFileSync(redirects, 'utf-8');

    const listPages = allPages().filter((p) => /^\/statyi\/page\/\d+\/$/.test(p));
    const addresses = [
      '/statyi',
      ...listPages.map((p) => p.replace(/\/$/, '')),
      ...articlesOfSnapshot().map(({ slug }) => `/statyi/${slug}`),
    ];
    expect(addresses.length, 'адресов каталога не найдено — вакуумная проверка').toBeGreaterThan(1);

    const withoutRule: string[] = [];
    const withoutTarget: string[] = [];
    for (const address of addresses) {
      // Правило постоянного перенаправления с варианта со слэшем на адрес без слэша.
      const hasRule =
        conf.includes(`${address}/`) && /return\s+30[18]/.test(conf);
      if (!hasRule) withoutRule.push(address);
      if (!existsSync(join(dist, address.replace(/^\//, ''), 'index.html'))) withoutTarget.push(address);
    }

    expect(withoutRule, `адреса каталога без правила перенаправления: ${withoutRule.length}`).toEqual([]);
    expect(withoutTarget, `цели перенаправления нет в сборке: ${withoutTarget.join(', ')}`).toEqual([]);
  });
});

describe('вывод сборки соответствует снимку', () => {
  it('XML-проверка отказывает на пустом индексе, отсутствующей карте, пустой карте и повторном URL', () => {
    const root = join(scratchDir(), 'malformed-xml');
    const index = (children: string) =>
      `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`;
    const sitemap = (urls: string) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
    const child = (loc: string) => `<sitemap><loc>https://example.test/${loc}</loc></sitemap>`;
    const url = (loc: string) => `<url><loc>https://example.test/${loc}</loc></url>`;
    const writeTree = (name: string, indexXml: string, childXml?: string) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'sitemap-index.xml'), indexXml);
      if (childXml !== undefined) writeFileSync(join(dir, 'sitemap-0.xml'), childXml);
      return dir;
    };

    expect(() => readSitemapTree(writeTree('empty-index', index('')))).toThrow(/не перечисляет/);
    expect(() => readSitemapTree(writeTree('missing-child', index(child('sitemap-0.xml'))))).toThrow(/нет перечисленной/);
    expect(() => readSitemapTree(writeTree('truncated', index(child('sitemap-0.xml')).replace('</sitemapindex>', '')))).toThrow();
    expect(() => readSitemapTree(writeTree('duplicate-loc', index(child('sitemap-0.xml')), sitemap('<url><loc>https://example.test/a</loc><loc>https://example.test/b</loc></url>')))).toThrow(/повторный loc/);
    expect(() => readSitemapTree(writeTree('duplicate-lastmod', index(child('sitemap-0.xml')), sitemap('<url><loc>https://example.test/a</loc><lastmod>2025</lastmod><lastmod>2026</lastmod></url>')))).toThrow(/повторный lastmod/);
    expect(() => readSitemapTree(writeTree('empty-child', index(child('sitemap-0.xml')), sitemap('')))).toThrow(/пустая дочерняя/);
    expect(() => readSitemapTree(writeTree(
      'duplicate-url',
      index(child('sitemap-0.xml')),
      sitemap(url('same') + url('same')),
    ))).toThrow(/повторный URL/);
  });

  // Сценарий: значения, зависящие от контента, соответствуют снимку
  it('в фактическом XML карты и все её дочерние URL сохранены без неподтверждённых дат', () => {
    requireDist();
    const sitemap = readSitemapTree(dist);
    expect(sitemap.urls.size, 'sitemap пуст — проверять нечего').toBeGreaterThan(0);
    const datedPages = [...sitemap.urls.values()].filter((entry) => entry.lastmod !== undefined);
    expect.soft(
      datedPages.length,
      `фикстура не подтверждает дату изменения этих страниц:\n${datedPages.slice(0, 8).map((entry) => `${entry.loc}: ${entry.lastmod}`).join('\n')}`,
    ).toBe(0);
    expect.soft(
      sitemap.index.every((entry) => entry.lastmod === undefined),
      'история изменения дочерних карт отсутствует, поэтому index не должен датироваться',
    ).toBe(true);
  });

  it('даты статьи не меняют URL sitemap, расписание или даты неизменённых страниц', { timeout: 180_000 }, () => {
    requireDist();
    const first = copySnapshot('snapshot-a');
    const datedArticles = first.snapshot.content.types.articles as Record<string, unknown>[];
    const selected = datedArticles.find((article) => typeof article.published_at === 'string' && article.published_at !== '');
    expect(selected, 'в контрольном снимке нет статьи для сценария').toBeTruthy();
    const slug = String(selected!.slug);
    const originalDate = String(selected!.published_at);
    const unchangedArticle = datedArticles.find((article) => article.slug !== slug);
    expect(unchangedArticle, 'в контрольном снимке нет второй статьи для проверки неизменённой страницы').toBeTruthy();
    const baseline = JSON.parse(readFileSync(join(WEB_ROOT, 'tests/fixtures/sitemap-lastmod/baseline-urls.json'), 'utf8')) as { snapshotSha256: string; urls: string[] };
    const snapshotHash = createHash('sha256').update(readFileSync(join(first.dir, 'snapshot.json'))).digest('hex');
    expect(snapshotHash, 'эталон URL относится к другому контрольному снимку').toBe(baseline.snapshotSha256);
    const firstBuild = buildSnapshot(first.dir, 'build-a');
    const repeatedBuild = buildSnapshot(first.dir, 'build-a-repeat');

    const second = copySnapshot('snapshot-b');
    const secondArticles = second.snapshot.content.types.articles as Record<string, unknown>[];
    const changed = secondArticles.find((article) => article.slug === slug);
    expect(changed, `статья ${slug} исчезла при копировании контрольного снимка`).toBeTruthy();
    const changedDate = originalDate.startsWith('2001-') ? '2002-03-04' : '2001-03-04';
    changed!.published_at = changedDate;
    saveSnapshot(second.dir, second.snapshot);
    const secondBuild = buildSnapshot(second.dir, 'build-b');

    const firstTree = readSitemapTree(firstBuild);
    const secondTree = readSitemapTree(secondBuild);
    const baseTree = readSitemapTree(dist);
    const urls = (tree: ReturnType<typeof readSitemapTree>) => [...tree.urls.keys()].sort();
    expect.soft(urls(firstTree)).toEqual(baseline.urls);
    const repeatedTree = readSitemapTree(repeatedBuild);
    expect.soft([...repeatedTree.urls.values()]).toEqual([...firstTree.urls.values()]);
    expect.soft(repeatedTree.index).toEqual(firstTree.index);
    expect.soft(urls(firstTree)).toEqual(urls(baseTree));
    expect.soft(urls(secondTree)).toEqual(urls(baseTree));

    const selectedLoc = `https://ikpk.su/statyi/${slug}`;
    const unchangedLocs = [
      'https://ikpk.su/raspisanie-i-tseny',
      'https://ikpk.su/statyi',
      'https://ikpk.su/kontakty',
      `https://ikpk.su/statyi/${String(unchangedArticle!.slug)}`,
    ];
    for (const loc of [selectedLoc, ...unchangedLocs]) {
      expect.soft(firstTree.urls.has(loc), `${loc} отсутствует в первом XML`).toBe(true);
      expect.soft(secondTree.urls.has(loc), `${loc} отсутствует во втором XML`).toBe(true);
      expect.soft(firstTree.urls.get(loc)?.lastmod, `${loc} не должен получать дату из чужой публикации`).toBeUndefined();
      expect.soft(secondTree.urls.get(loc)?.lastmod, `${loc} не должен получать дату из чужой публикации`).toBeUndefined();
    }
    expect.soft(
      [...firstTree.urls.values()].every((entry) => entry.lastmod === undefined),
      'первый контрольный снимок не содержит подтверждённых дат изменения страниц',
    ).toBe(true);
    expect.soft(
      [...secondTree.urls.values()].every((entry) => entry.lastmod === undefined),
      'изменение published_at не должно датировать страницы в XML',
    ).toBe(true);

    const noDates = copySnapshot('snapshot-no-dates');
    const noDateArticles = noDates.snapshot.content.types.articles as Record<string, unknown>[];
    for (const article of noDateArticles) article.published_at = null;
    saveSnapshot(noDates.dir, noDates.snapshot);
    const noDatesBuild = buildSnapshot(noDates.dir, 'build-no-dates');
    const noDatesTree = readSitemapTree(noDatesBuild);
    expect.soft(urls(noDatesTree)).toEqual(urls(baseTree));
    const noDateFallbacks = [...noDatesTree.urls.values()].filter((entry) => entry.lastmod !== undefined);
    expect.soft(
      noDateFallbacks.length,
      `отсутствие дат не должно создавать эпоху или fallback lastmod: ${noDateFallbacks.slice(0, 5).map((entry) => `${entry.loc}: ${entry.lastmod}`).join('\n')}`,
    ).toBe(0);
    expect.soft(noDatesTree.index.every((entry) => entry.lastmod === undefined)).toBe(true);
  });

  it('положительный XML использует общий сериализатор только в изолированной тестовой сборке', { timeout: 120_000 }, () => {
    const outDir = join(scratchDir(), 'positive-build');
    const cacheDir = join(scratchDir(), 'positive-cache');
    execFileSync(ASTRO_BIN, ['--config', SITEMAP_TEST_CONFIG, 'build'], {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        SITEMAP_LASTMOD_TEST_BUILD: '1',
        SITEMAP_LASTMOD_TEST_OUT_DIR: outDir,
        SITEMAP_LASTMOD_TEST_CACHE_DIR: cacheDir,
      },
      stdio: 'pipe',
      maxBuffer: 8 * 1024 * 1024,
    });

    const testTree = readSitemapTree(outDir);
    const datedLoc = 'https://sitemap-lastmod.test/with-date';
    const undatedLoc = 'https://sitemap-lastmod.test/without-date';
    expect(testTree.urls.get(datedLoc)?.lastmod).toBe('2026-11-25T12:34:56.000Z');
    expect(testTree.urls.get(undatedLoc)?.lastmod).toBeUndefined();
    expect(testTree.urls.has('https://sitemap-lastmod.test/invalid-date')).toBe(true);
    expect(testTree.urls.get('https://sitemap-lastmod.test/invalid-date')?.lastmod).toBeUndefined();
    expect(testTree.index.every((entry) => entry.lastmod === undefined)).toBe(true);

    const productionConfig = readFileSync(join(WEB_ROOT, 'astro.config.mjs'), 'utf8');
    expect(productionConfig).toContain('sitemap-lastmod-serializer.mjs');
    const serializerWiring = /serialize:\s*\(item\)\s*=>\s*serializeSitemapEntry\(item\)/;
    expect(hasProductionSerializer(productionConfig)).toBe(true);
    const disconnected = productionConfig.replace(serializerWiring, 'serialize: (item) => item');
    expect(disconnected).not.toBe(productionConfig);
    expect(hasProductionSerializer(disconnected)).toBe(false);
    expect(productionConfig).not.toContain('SITEMAP_LASTMOD_TEST');
    expect(productionConfig).not.toContain('tests/fixtures/sitemap-lastmod');
  });

  // Сценарий: идентификатор снимка объявлен вне разметки страниц
  it('идентификатора снимка в разметке страниц нет', () => {
    requireDist();
    const { snapshotId } = snapshotOfBuild();
    expect(snapshotId, 'у сборки нет идентификатора снимка').toBeTruthy();

    const leaking = allPages().filter((page) =>
      readFileSync(join(dist, page, 'index.html'), 'utf-8').includes(snapshotId),
    );
    expect(
      leaking,
      'идентификатор снимка попал в разметку — он двигал бы визуальные эталоны при неизменной раскладке',
    ).toEqual([]);
  });

  // Сценарий: вывод сборки не содержит токена
  it('токена доступа нет ни в выводе сборки, ни в снимке', () => {
    requireDist();
    // В джобе Tests CMS_TOKEN намеренно отсутствует: к CMS обращается только шаг
    // capture (чистота пайплайна). Тогда игла — CONTENT_ACCESS_LEAK_NEEDLE из
    // vitest.build.config; при живом доступе предпочитается настоящий токен.
    const token =
      process.env.CMS_TOKEN?.trim() ||
      process.env.STRAPI_TOKEN?.trim() ||
      process.env.CONTENT_ACCESS_LEAK_NEEDLE?.trim() ||
      '';
    if (token === '')
      throw new Error(
        'ПРОВЕРИТЬ НЕ УДАЛОСЬ: ни CMS_TOKEN/STRAPI_TOKEN, ни CONTENT_ACCESS_LEAK_NEEDLE ' +
          'не заданы — искать нечего. Проверка обязана иметь иглу.',
      );

    const leaking = allPages().filter((page) =>
      readFileSync(join(dist, page, 'index.html'), 'utf-8').includes(token),
    );
    expect(leaking).toEqual([]);
    expect(JSON.stringify(snapshotOfBuild()).includes(token)).toBe(false);
  });
});

