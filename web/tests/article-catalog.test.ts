import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { dist, allPages, readPage } from './helpers/dist-pages';

// ─── Characterization-тесты: каталог статей ──────────────────────────────────
// Спецификация: openspec/changes/baseline-article-catalog/specs/article-catalog/spec.md
// Revision, с которого снят baseline: feat/demo-mode-and-hero-photo@542151b.
//
// Тесты ЗЕЛЁНЫЕ по замыслу: они фиксируют уже принятое поведение, а не требуют
// нового (AGENTS.md, «Baseline: фиксация уже существующего поведения»). Красный
// прогон здесь был бы искусственным; вместо него каждый гейт проходит
// негативную проверку — поведение временно нарушается и тест краснеет.
//
// Известные отклонения (весь каталог в <template>, отсутствие адресов у страниц
// списка 2..N) сюда НЕ попадают: они перечислены в спеке как known deviations и
// закрываются change `article-list-pagination`.

interface Article {
  slug: string;
  title: string;
  body_html: string;
  body_text: string;
  seo_title: string;
  seo_description: string;
  published_at: string | null;
  image: string | null;
}

const ENTITIES = join(import.meta.dirname, '..', '..', 'discovery', 'entities');
const articles: Article[] = JSON.parse(readFileSync(join(ENTITIES, 'articles.json'), 'utf-8'));

/** Размер страницы списка — паритет со старым сайтом (6 ссылок на /statyi). */
const PAGE_SIZE = 6;

const SITE = 'https://ikpk.su';
const listPage = () => readPage('/statyi/');
const articlePagePath = (slug: string) => `/statyi/${slug}/`;

/** Разметка страницы без содержимого <template>: то, что видит клиент без скрипта. */
const withoutTemplates = (html: string) => html.replace(/<template\b[\s\S]*?<\/template>/gi, '');

/** Пути всех страниц каталога: сам список и страницы статей. */
const catalogPages = (): string[] => ['/statyi/', ...articles.map((a) => articlePagePath(a.slug))];

/** Ссылки на статьи в основном контенте списка (вне <template>). */
const shownSlugs = (): string[] => [
  ...new Set([...withoutTemplates(listPage()).matchAll(/href="\/statyi\/([^"]+)"/g)].map((m) => m[1])),
];

// Данные — вход всех остальных проверок. Пустой каталог сделал бы их
// вакуумными: цикл по нулю элементов проходит всегда.
describe('каталог статей: источник данных', () => {
  it('каталог непуст — иначе проверки ниже ничего не проверяют', () => {
    expect(articles.length, 'discovery/entities/articles.json пуст').toBeGreaterThan(0);
  });

  it('обязательные поля заполнены у каждой записи', () => {
    const broken: string[] = [];
    for (const a of articles) {
      for (const field of ['slug', 'title', 'body_html', 'seo_title', 'seo_description'] as const) {
        if (!String(a[field] ?? '').trim()) broken.push(`${a.slug || '<без slug>'}: пустое ${field}`);
      }
    }
    expect(
      broken.slice(0, 8),
      `записи каталога с пустыми обязательными полями (${broken.length}):\n${broken.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });

  it('slug уникален и не требует кодирования в адресе', () => {
    const seen = new Map<string, number>();
    const problems: string[] = [];
    for (const a of articles) {
      seen.set(a.slug, (seen.get(a.slug) ?? 0) + 1);
      if (!/^[a-z0-9-]+$/.test(a.slug)) problems.push(`${a.slug}: недопустимые символы в slug`);
    }
    for (const [slug, count] of seen) {
      if (count > 1) problems.push(`${slug}: встречается ${count} раза`);
    }
    expect(problems.slice(0, 8), problems.slice(0, 8).join('\n')).toEqual([]);
  });
});

describe('каталог статей: адреса', () => {
  it('у каждой записи каталога есть собственная собранная страница', () => {
    const missing = articles.filter((a) => !existsSync(join(dist, 'statyi', a.slug, 'index.html')));
    expect(
      missing.map((a) => a.slug).slice(0, 8),
      `статей без собранной страницы: ${missing.length}`,
    ).toEqual([]);
  });

  it('страниц статей ровно столько, сколько записей', () => {
    const built = readdirSync(join(dist, 'statyi')).filter((name) =>
      statSync(join(dist, 'statyi', name)).isDirectory(),
    );
    expect(built.length, `собрано ${built.length} страниц при ${articles.length} записях`).toBe(
      articles.length,
    );
  });

  // Адрес статьи определяется её slug — и ничем больше. Проверяем по разметке
  // самой страницы: она объявляет собственный адрес каноническим, и он
  // совпадает с /statyi/<slug> независимо от места статьи в списке.
  it('адрес статьи определяется slug, а не позицией в списке', () => {
    const wrong: string[] = [];
    for (const a of articles) {
      const html = readPage(articlePagePath(a.slug));
      const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? '';
      if (canonical !== `${SITE}/statyi/${a.slug}`) wrong.push(`${a.slug}: canonical ${canonical}`);
    }
    expect(
      wrong.slice(0, 8),
      `${wrong.length} страниц с чужим адресом:\n${wrong.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });

  it('для каждого адреса каталога есть перенаправление со слэша на адрес без слэша', () => {
    const conf = join(dist, '..', '..', 'deploy', 'nginx-redirects.conf');
    if (!existsSync(conf)) {
      throw new Error('нет deploy/nginx-redirects.conf — запустите npm run redirects:gen');
    }
    const text = readFileSync(conf, 'utf-8');
    const rules = new Map<string, string>();
    for (const m of text.matchAll(/^location = (\S+) \{ return 301 (\S+); \}$/gm)) {
      rules.set(m[1], m[2]);
    }
    expect(rules.size, 'в конфиге нет ни одного правила — проверять нечего').toBeGreaterThan(0);

    const missing: string[] = [];
    for (const path of ['/statyi', ...articles.map((a) => `/statyi/${a.slug}`)]) {
      const target = rules.get(`${path}/`);
      if (target !== path) missing.push(`${path}/ → ${target ?? '<нет правила>'}`);
      else if (!existsSync(join(dist, path.replace(/^\//, ''), 'index.html'))) {
        missing.push(`${path}/ → ${path} (цель отсутствует в сборке)`);
      }
    }
    expect(
      missing.slice(0, 8),
      `адресов каталога без работающего перенаправления со слэша: ${missing.length}\n${missing.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });
});

describe('каталог статей: страница списка', () => {
  it('/statyi собрана и показывает статьи', () => {
    expect(shownSlugs().length, 'на /statyi нет ни одной ссылки на статью вне <template>').toBeGreaterThan(0);
  });

  it('в основном контенте — размер страницы списка, а не весь каталог', () => {
    const shown = shownSlugs();
    expect(shown.length, `на /statyi ${shown.length} ссылок на статьи вне <template>`).toBe(
      Math.min(PAGE_SIZE, articles.length),
    );
  });

  // «Самые новые» с учётом того, что даты в каталоге почти не различаются
  // (6 значений на 68 статей, KD-8): формулировка, не зависящая от разрешения
  // тай-брейков — ни одна показанная статья не старее любой непоказанной.
  it('показаны самые новые статьи каталога', () => {
    const shown = new Set(shownSlugs());
    const at = (slug: string) => Date.parse(articles.find((a) => a.slug === slug)?.published_at ?? '') || 0;
    const shownDates = [...shown].map(at);
    const hiddenDates = articles.filter((a) => !shown.has(a.slug)).map((a) => at(a.slug));
    expect(shownDates.length, 'нечего сравнивать').toBeGreaterThan(0);
    if (hiddenDates.length === 0) return; // весь каталог на одной странице — не дефект
    expect(
      Math.min(...shownDates) >= Math.max(...hiddenDates),
      'показана статья старее непоказанной — порядок по умолчанию не от новых к старым',
    ).toBe(true);
  });

  it('карточка ведёт на существующую статью и несёт заголовок с изображением', () => {
    const html = withoutTemplates(listPage());
    const found = [...html.matchAll(/<a[^>]*href="\/statyi\/([^"]+)"[^>]*class="[^"]*article-card[\s\S]*?<\/a>/g)];
    expect(found.length, 'на /statyi не найдено ни одного анонса статьи').toBe(
      Math.min(PAGE_SIZE, articles.length),
    );
    const problems: string[] = [];
    for (const [markup, slug] of found) {
      const article = articles.find((a) => a.slug === slug);
      if (!article) {
        problems.push(`${slug}: анонс ведёт на статью, которой нет в каталоге`);
        continue;
      }
      if (!existsSync(join(dist, 'statyi', slug, 'index.html'))) {
        problems.push(`${slug}: анонс ведёт на несобранную страницу`);
      }
      if (!markup.includes('article-card-title')) problems.push(`${slug}: в анонсе нет заголовка`);
      if (article.image && !/<img\b/.test(markup)) problems.push(`${slug}: в анонсе нет изображения`);
    }
    expect(problems.slice(0, 6), problems.slice(0, 6).join('\n')).toEqual([]);
  });

  // Ожидаемое число страниц вычисляется ИЗ ДАННЫХ. Пометки в разметке,
  // объявляющей отсутствие пагинации приемлемым, здесь нет и быть не может.
  it('постраничная навигация есть тогда и только тогда, когда страниц больше одной', () => {
    const html = listPage();
    const expectedPages = Math.max(1, Math.ceil(articles.length / PAGE_SIZE));
    const nav = html.match(/<nav[^>]*class="articles-pagination"[^>]*>/)?.[0];

    if (expectedPages <= 1) {
      expect(nav, 'страница одна — навигации быть не должно').toBeUndefined();
      return;
    }

    expect(nav, `ожидается ${expectedPages} страниц, но постраничной навигации на /statyi нет`).toBeDefined();
    const declared = Number(nav!.match(/data-total-pages="(\d+)"/)?.[1] ?? NaN);
    expect(declared, `разметка объявляет ${declared} страниц при ожидаемых ${expectedPages}`).toBe(
      expectedPages,
    );
    expect(html, 'нет перехода на предыдущую страницу').toContain('data-page-prev');
    expect(html, 'нет перехода на следующую страницу').toContain('data-page-next');
    const buttons = [...html.matchAll(/data-page-button="(\d+)"/g)].map((m) => Number(m[1]));
    expect(new Set(buttons).size, 'номеров страниц меньше двух').toBeGreaterThan(1);
    expect(Math.max(...buttons), 'последняя страница недостижима из навигации').toBe(expectedPages);
  });
});

describe('каталог статей: индексные инварианты', () => {
  it('canonical самоссылочный, без завершающего слэша, og:url совпадает', () => {
    const problems: string[] = [];
    for (const path of catalogPages()) {
      const html = readPage(path);
      const expected = `${SITE}${path.replace(/\/$/, '')}`;
      const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
      const og = html.match(/property="og:url" content="([^"]+)"/)?.[1];
      if (canonical !== expected) problems.push(`${path}: canonical ${canonical ?? '<нет>'} ≠ ${expected}`);
      if (og !== canonical) problems.push(`${path}: og:url ${og ?? '<нет>'} ≠ canonical ${canonical}`);
    }
    expect(problems.slice(0, 8), `${problems.length} нарушений:\n${problems.slice(0, 8).join('\n')}`).toEqual([]);
  });

  it('у каждой страницы каталога непустые title и description, title уникален по сайту', () => {
    const titles = new Map<string, string[]>();
    for (const p of allPages()) {
      const t = readPage(p).match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
      titles.set(t, [...(titles.get(t) ?? []), p]);
    }
    const problems: string[] = [];
    for (const path of catalogPages()) {
      const html = readPage(path);
      const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
      const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
      if (!title.trim()) problems.push(`${path}: пустой <title>`);
      else if ((titles.get(title) ?? []).length > 1) {
        problems.push(`${path}: <title> повторяется на ${(titles.get(title) ?? []).join(', ')}`);
      }
      if (!description.trim()) problems.push(`${path}: пустое описание`);
    }
    expect(problems.slice(0, 8), `${problems.length} нарушений:\n${problems.slice(0, 8).join('\n')}`).toEqual([]);
  });

  it('все страницы каталога есть в sitemap с lastmod', () => {
    const xml = readFileSync(join(dist, 'sitemap-0.xml'), 'utf-8');
    const entries = new Map<string, boolean>();
    for (const m of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)) {
      entries.set(m[1], m[2].includes('<lastmod>'));
    }
    expect(entries.size, 'sitemap пуст — проверять нечего').toBeGreaterThan(0);

    const problems: string[] = [];
    for (const path of catalogPages()) {
      const loc = `${SITE}${path.replace(/\/$/, '')}`;
      if (!entries.has(loc)) problems.push(`${loc}: нет в sitemap`);
      else if (!entries.get(loc)) problems.push(`${loc}: нет lastmod`);
    }
    expect(problems.slice(0, 8), `${problems.length} нарушений:\n${problems.slice(0, 8).join('\n')}`).toEqual([]);
  });

  // Признак — директива для робота в <meta name="robots">, а не строка
  // «nofollow» где угодно в документе: она законно стоит на внешних ссылках
  // (medshop, Яндекс.Диск), и проверка по подстроке краснела бы на исправной
  // странице.
  it('ни одна страница каталога не закрыта от индексации', () => {
    const closed = catalogPages().filter((p) => {
      const robots = readPage(p).match(/<meta name="robots" content="([^"]*)"/)?.[1] ?? '';
      return /\b(noindex|nofollow|none)\b/.test(robots);
    });
    expect(
      closed.slice(0, 8),
      `страниц каталога закрыто от индексации: ${closed.length}\n${closed.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });

  // Достижимость считается ЧЕСТНО: без разметки внутри `<template>` и без карты
  // сайта.
  //
  // Первая версия этой проверки считала рёбрами всё подряд и была почти
  // вакуумной. Замерено на собранном сайте: при учёте шаблонов недостижимых
  // статей 0 из 68; без шаблонов, но с `/sitemap` — тоже 0 (карта ссылается на
  // все 68, при этом сама закрыта `noindex,nofollow`); и только без того и
  // другого — 1. То есть проверка зеленела на рёбрах, которых для индексации и
  // для человека без JavaScript не существует: ревью сняло блок «Другие статьи»
  // со ВСЕХ 68 страниц статей — единственный реальный путь к 61 из них — и
  // прогон остался зелёным.
  //
  // Это ровно тот дефект, который KD-3 ставит в вину старому гейту
  // `seo-package.test.ts`. Поэтому здесь фиксируется не «сирот нет», а
  // фактическое состояние: недостижима ровно одна статья. Такая формулировка
  // краснеет в обе стороны — и если достижимость сломается, и если её починят
  // (тогда baseline перестал описывать текущее поведение и требует обновления).
  const KNOWN_UNREACHABLE = ['/statyi/kislotno-shelochnoj-balans-i-lechenie-pacienta/'];

  it('достижимость статей соответствует замеренной: недостижима ровно одна', () => {
    const inbound = new Set<string>();
    let templatesSeen = 0;
    let sitemapSkipped = 0;

    for (const p of allPages()) {
      // Карта сайта закрыта от индексации, поэтому ссылкой для поисковика не
      // является: считать её ребром — значит объявить достижимым что угодно.
      if (p.startsWith('/sitemap')) {
        sitemapSkipped++;
        continue;
      }
      const raw = readPage(p);
      templatesSeen += (raw.match(/<template\b/gi) ?? []).length;
      const html = withoutTemplates(raw);
      for (const m of html.matchAll(/<a\b[^>]*\bhref="(\/[^"#?]*)[#?]?[^"]*"/gi)) {
        let target = decodeURI(m[1]);
        if (!target.endsWith('/')) target += '/';
        if (target !== p) inbound.add(target);
      }
    }

    // Отсутствие материала — «не выполнено», а не «дефектов нет». Каждая из
    // трёх величин однажды была источником ложного зелёного: пустой набор
    // ссылок, невырезанные шаблоны, неисключённая карта сайта.
    expect(inbound.size, 'внутренних ссылок в сборке не найдено — проверять нечего').toBeGreaterThan(
      0,
    );
    expect(templatesSeen, 'ни одного <template> не найдено — вырезать нечего, проверка ослаблена').toBeGreaterThan(
      0,
    );
    expect(sitemapSkipped, 'карта сайта не найдена — исключать нечего').toBeGreaterThan(0);

    const unreachable = catalogPages().filter((p) => !inbound.has(p));
    expect(
      unreachable.sort(),
      `состав недостижимых страниц каталога изменился (${unreachable.length}):\n${unreachable.join('\n')}`,
    ).toEqual([...KNOWN_UNREACHABLE].sort());
  });
});

describe('каталог статей: разметка страницы статьи', () => {
  const ldBlocks = (html: string): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const parsed = JSON.parse(m[1]);
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) out.push(item);
    }
    return out;
  };

  it('на каждой странице статьи есть Article с обязательными полями и абсолютными URL', () => {
    const problems: string[] = [];
    for (const a of articles) {
      const blocks = ldBlocks(readPage(articlePagePath(a.slug)));
      const article = blocks.find((b) => b['@type'] === 'Article');
      if (!article) {
        problems.push(`${a.slug}: нет блока Article`);
        continue;
      }
      for (const field of ['headline', 'url', 'image', 'author', 'publisher']) {
        const v = article[field];
        if (v === undefined || v === null || v === '') problems.push(`${a.slug}: Article без ${field}`);
      }
      for (const field of ['url', 'image']) {
        const v = article[field];
        if (typeof v === 'string' && !/^https?:\/\//.test(v)) {
          problems.push(`${a.slug}: Article.${field} не абсолютный: ${v}`);
        }
      }
    }
    expect(problems.slice(0, 8), `${problems.length} нарушений:\n${problems.slice(0, 8).join('\n')}`).toEqual([]);
  });

  it('хлебные крошки статьи — Главная → Статьи → заголовок', () => {
    const problems: string[] = [];
    for (const a of articles) {
      const crumbs = ldBlocks(readPage(articlePagePath(a.slug))).find(
        (b) => b['@type'] === 'BreadcrumbList',
      );
      if (!crumbs) {
        problems.push(`${a.slug}: нет BreadcrumbList`);
        continue;
      }
      const items = (crumbs.itemListElement as Array<Record<string, unknown>>) ?? [];
      const names = items.map((i) => String(i.name ?? ''));
      if (names[0] !== 'Главная' || names[1] !== 'Статьи') {
        problems.push(`${a.slug}: крошки ${names.join(' → ')}`);
      }
      if (items[1]?.item !== `${SITE}/statyi`) {
        problems.push(`${a.slug}: «Статьи» ведёт на ${String(items[1]?.item)}`);
      }
      if (names.at(-1) !== a.title) problems.push(`${a.slug}: последняя крошка «${names.at(-1)}»`);
    }
    expect(problems.slice(0, 8), `${problems.length} нарушений:\n${problems.slice(0, 8).join('\n')}`).toEqual([]);
  });

  it('на странице списка есть BreadcrumbList', () => {
    const crumbs = ldBlocks(listPage()).find((b) => b['@type'] === 'BreadcrumbList');
    expect(crumbs, 'на /statyi нет BreadcrumbList').toBeDefined();
  });
});

describe('каталог статей: связь между статьями', () => {
  /** Ссылки блока «Другие статьи» в боковой колонке страницы статьи. */
  const relatedOf = (slug: string): string[] => {
    const html = readPage(articlePagePath(slug));
    const aside = html.match(/<aside[^>]*article-sidebar[\s\S]*?<\/aside>/)?.[0] ?? '';
    return [...new Set([...aside.matchAll(/href="\/statyi\/([^"]+)"/g)].map((m) => m[1]))];
  };

  it('до четырёх ссылок на существующие статьи, без самой статьи', () => {
    const known = new Set(articles.map((a) => a.slug));
    const problems: string[] = [];
    let withBlock = 0;
    for (const a of articles) {
      const related = relatedOf(a.slug);
      if (related.length > 0) withBlock += 1;
      if (related.length > 4) problems.push(`${a.slug}: ${related.length} ссылок`);
      if (related.includes(a.slug)) problems.push(`${a.slug}: ссылается на себя`);
      for (const slug of related) {
        if (!known.has(slug)) problems.push(`${a.slug} → ${slug}: статьи нет в каталоге`);
        else if (!existsSync(join(dist, 'statyi', slug, 'index.html'))) {
          problems.push(`${a.slug} → ${slug}: страница не собрана`);
        }
      }
    }
    // Каталога из одной статьи у нас нет; блок обязан быть у каждой.
    expect(withBlock, 'блок «Другие статьи» не найден ни на одной странице').toBe(articles.length);
    expect(problems.slice(0, 8), `${problems.length} нарушений:\n${problems.slice(0, 8).join('\n')}`).toEqual([]);
  });

  // Один общий набор на всех страницах — вырожденный случай, ради которого блок
  // не нужен. Порог сознательно не «ровно N»: контракт — различие наборов, а не
  // конкретный алгоритм подбора.
  it('наборы других статей различаются между статьями', () => {
    const sets = articles.map((a) => relatedOf(a.slug).slice().sort().join('|'));
    const distinct = new Set(sets).size;
    expect(
      distinct,
      `различных наборов ${distinct} на ${articles.length} статей — блок почти не различает страницы`,
    ).toBeGreaterThanOrEqual(Math.ceil(articles.length * 0.75));
  });
});
