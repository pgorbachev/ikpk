import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dist, allPages } from './helpers/dist-pages';
import { REPO_ROOT, WEB_ROOT, type Snapshot } from './helpers/cms-content-publication-contract';

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
  // Сценарий: значения, зависящие от контента, соответствуют снимку
  it('lastmod карты сайта соответствует данным снимка, а не файлам материала переноса', () => {
    requireDist();
    const sitemap = join(dist, 'sitemap-0.xml');
    expect(existsSync(sitemap), `нет карты сайта ${sitemap}`).toBe(true);
    const xml = readFileSync(sitemap, 'utf-8');

    const articles = snapshotOfBuild().content.types.articles as Record<string, unknown>[];
    const dated = articles.filter((a) => typeof a.published_at === 'string' && a.published_at !== '');
    expect(dated.length, 'в снимке нет ни одной даты — сверять нечего').toBeGreaterThan(0);

    const mismatched: string[] = [];
    for (const article of dated) {
      const slug = String(article.slug);
      const expected = String(article.published_at).slice(0, 10);
      const entry = new RegExp(
        `<loc>[^<]*/statyi/${slug}</loc>\\s*<lastmod>([^<]+)</lastmod>`,
      ).exec(xml);
      if (!entry) {
        mismatched.push(`${slug}: нет записи в карте сайта`);
        continue;
      }
      if (!entry[1].startsWith(expected)) mismatched.push(`${slug}: ${entry[1]} вместо ${expected}`);
    }

    expect(mismatched, `lastmod разошёлся со снимком:\n${mismatched.join('\n')}`).toEqual([]);
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
    const token = process.env.CMS_TOKEN ?? process.env.STRAPI_TOKEN ?? '';
    if (token === '')
      throw new Error(
        'ПРОВЕРИТЬ НЕ УДАЛОСЬ: токен доступа не задан в окружении, искать нечего. ' +
          'Проверка обязана выполняться в прогоне, где токен есть.',
      );

    const leaking = allPages().filter((page) =>
      readFileSync(join(dist, page, 'index.html'), 'utf-8').includes(token),
    );
    expect(leaking).toEqual([]);
    expect(JSON.stringify(snapshotOfBuild()).includes(token)).toBe(false);
  });
});
