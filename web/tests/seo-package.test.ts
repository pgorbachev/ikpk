import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { dist, walkHtml, allPages, readPage } from './helpers/dist-pages';

// ─── Этап 3 (план 004): SEO-пакет как вечные CI-гейты ───────────────────────

// ── 3.2: 0 страниц-сирот — обход dist по внутренним ссылкам ────────────────
describe('orphan pages (обход по внутренним ссылкам)', () => {
  it('every built page is reachable from / via internal <a href>', () => {
    // Из проверки исключаем noindex-страницы: это служебные (черновики
    // вариантов /preview/*, заглушка форм демо-стенда), они намеренно не
    // слинкованы и в индекс не идут. Правило по метатегу, а не по списку
    // префиксов — само подхватывает новые служебные страницы.
    const pages = new Set(
      allPages().filter((p) => !/<meta name="robots" content="noindex/.test(readPage(p)))
    );
    const visited = new Set<string>();
    const queue = ['/'];
    while (queue.length) {
      const page = queue.pop()!;
      if (visited.has(page)) continue;
      visited.add(page);
      const html = readPage(page);
      // Осознанное допущение: Astro эмитит внутренние ссылки как
      // root-relative href в двойных кавычках; абсолютные/одинарные формы
      // не считаются внутренними навигационными рёбрами.
      for (const m of html.matchAll(/<a\b[^>]*\bhref="(\/[^"#?]*)[#?]?[^"]*"/gi)) {
        let target = decodeURI(m[1]);
        if (!target.endsWith('/')) target += '/';
        if (pages.has(target) && !visited.has(target)) queue.push(target);
      }
    }
    const orphans = [...pages].filter((p) => !visited.has(p));
    expect(orphans, `orphan pages (no internal inbound path from /):\n${orphans.join('\n')}`).toEqual(
      []
    );
  });
});

// ── 3.4: политика внешних ссылок ────────────────────────────────────────────
describe('external link policy (domain_strategy.md)', () => {
  it('0 links to staging domains anywhere in dist', () => {
    const offenders: string[] = [];
    for (const f of walkHtml()) {
      if (readFileSync(f, 'utf-8').includes('staging.ikpk.su')) offenders.push(f.replace(dist, ''));
    }
    expect(offenders).toEqual([]);
  });

  it('every medshop link carries rel with nofollow (дубль kinezio.shop, будет закрыт)', () => {
    const offenders: string[] = [];
    for (const f of walkHtml()) {
      const html = readFileSync(f, 'utf-8');
      for (const m of html.matchAll(/<a\b[^>]*medshop\.ikpk\.su[^>]*>/gi)) {
        if (!/rel="[^"]*nofollow[^"]*"/i.test(m[0])) offenders.push(`${f.replace(dist, '')}: ${m[0].slice(0, 120)}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('Яндекс.Диск («Фото») links carry rel nofollow', () => {
    const html = readPage('/');
    const links = [...html.matchAll(/<a\b[^>]*disk\.yandex\.ru[^>]*>/gi)];
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l[0]).toMatch(/rel="[^"]*nofollow[^"]*"/i);
  });
});

// ── 3.5: JSON-LD 5 типов валидны на всех страницах ──────────────────────────
describe('JSON-LD validation', () => {
  const REQUIRED_FIELDS: Record<string, string[]> = {
    Organization: ['name', 'url'],
    Article: ['headline', 'url', 'image', 'author', 'publisher'],
    Course: ['name', 'description', 'provider'],
    Event: ['name', 'startDate', 'location'],
    BreadcrumbList: ['itemListElement'],
  };

  it('every ld+json block parses and known types carry required fields', () => {
    const problems: string[] = [];
    const seenTypes = new Set<string>();
    for (const f of walkHtml()) {
      const html = readFileSync(f, 'utf-8');
      for (const m of html.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi
      )) {
        let data: unknown;
        try {
          data = JSON.parse(m[1]);
        } catch {
          problems.push(`${f.replace(dist, '')}: unparseable JSON-LD`);
          continue;
        }
        for (const item of Array.isArray(data) ? data : [data]) {
          const obj = item as Record<string, unknown>;
          const type = String(obj['@type'] ?? '');
          seenTypes.add(type);
          for (const field of REQUIRED_FIELDS[type] ?? []) {
            if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
              problems.push(`${f.replace(dist, '')}: ${type} missing ${field}`);
            }
          }
          // абсолютность URL-полей (Google Rich Results требует абсолютные)
          for (const field of ['url', 'image']) {
            const v = obj[field];
            if (typeof v === 'string' && v.startsWith('/')) {
              problems.push(`${f.replace(dist, '')}: ${type}.${field} is relative: ${v}`);
            }
          }
        }
      }
    }
    expect(problems.slice(0, 20), problems.slice(0, 20).join('\n')).toEqual([]);
    // Базовые типы присутствуют всегда. Event НЕ требуем: он эмитится только
    // семинарами с будущими датами (build-time) — без предстоящих семинаров
    // Event легитимно отсутствует (страницы переходят на Course), и это не
    // должно красить CI. Структура Event валидируется выше, когда он есть.
    for (const t of ['Organization', 'Article', 'Course', 'BreadcrumbList']) {
      expect([...seenTypes]).toContain(t);
    }
  });

  // Находка B9 (docs/security-audit-2026-08-08.md). Проводка между компонентами и
  // serializeJsonLd не сторожилась ничем: юнит `json-ld.test.ts` проверяет саму
  // функцию, поэтому возврат любого места вставки к голому `JSON.stringify` оставил
  // бы весь набор зелёным, и фикс #40 откатился бы молча.
  //
  // Проверяется ВЫВОД, а не место вызова: гейт не знает и не должен знать, сколько
  // компонентов эмитят JSON-LD, — новый компонент попадает под него сам.
  //
  // Гейт зелёный с момента написания: продукт уже корректен. Красное состояние
  // предъявляется негативной верификацией (возврат вызова к `JSON.stringify`),
  // а не падением на текущем коде.
  it('ни один блок JSON-LD не содержит литерального "<"', () => {
    const offenders: string[] = [];
    let blocks = 0;
    for (const f of walkHtml()) {
      const html = readFileSync(f, 'utf-8');
      // Тег ищется по общему признаку: произвольные атрибуты и любые кавычки.
      // Точная строка `<script type="application/ld+json">` пропустила бы блок с
      // `id`/`data-*` или одинарными кавычками — гейт остался бы зелёным за счёт
      // остальных блоков, а страж непустоты этого не заметил бы. Соседний гейт по
      // исходникам (json-ld.test.ts) описывает предмет именно так, и два гейта над
      // одним предметом обязаны описывать его одинаково.
      for (const m of html.matchAll(
        /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
      )) {
        blocks++;
        // Любой `<` внутри значения обязан быть экранирован в <: именно из него
        // собирается закрывающий тег, и его отсутствие закрывает весь класс — включая
        // разный регистр и сборку последовательности по частям.
        if (m[1].includes('<')) {
          offenders.push(`${f.replace(dist, '')}: литеральный '<' — ${m[1].slice(0, 120)}`);
        }
        // Одной проверки на `<` НЕДОСТАТОЧНО, и это не рассуждение: на payload вида
        // `{"headline":"x</script><img …>"}` захват обрывается на внедрённом
        // закрывающем теге, поэтому сам опасный символ в группу не попадает —
        // измерено, гейт давал blocks=1, offenders=0. Обрыв виден по другому
        // признаку: остаток перестаёт быть разбираемым JSON.
        try {
          JSON.parse(m[1]);
        } catch {
          offenders.push(
            `${f.replace(dist, '')}: блок не разбирается как JSON (вероятен внедрённый ` +
              `закрывающий тег) — ${m[1].slice(0, 120)}`,
          );
        }
      }
    }
    // «Проверять нечего» — это провал проверки, а не её успех.
    expect(blocks, 'в dist не найдено ни одного блока JSON-LD — гейт вакуумен').toBeGreaterThan(0);
    expect(offenders.slice(0, 20), offenders.slice(0, 20).join('\n')).toEqual([]);
  });

  it('BreadcrumbList present on depth-1 hub pages', () => {
    for (const p of [
      '/statyi/',
      '/raspisanie-i-tseny/',
      '/kontakty/',
      '/video/',
      '/institut-klinicheskoy-prikladnoy-kineziologii/',
      '/institut-apledzhera/',
      '/institut-barralya/',
    ]) {
      expect(readPage(p), `no BreadcrumbList on ${p}`).toContain('BreadcrumbList');
    }
  });
});

// ── 3.5: иерархия заголовков и уникальность title ───────────────────────────
describe('headings and titles', () => {
  it('H1→H2→H3 hierarchy is not broken on key templates', () => {
    for (const p of [
      '/',
      '/statyi/90percent-narushenij-v-skeletno-myshechnoj-sisteme/',
      '/raspisanie-i-tseny/',
      '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/',
    ]) {
      const html = readPage(p);
      const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
      expect(levels.filter((l) => l === 1).length, `${p}: exactly one H1`).toBe(1);
      expect(levels[0], `${p}: first heading must be H1`).toBe(1);
      let prev = 0;
      for (const l of levels) {
        // вниз по дереву — только на один уровень за шаг (h2→h4 запрещён)
        if (l > prev) expect(l - prev, `${p}: skipped level before h${l}`).toBeLessThanOrEqual(1);
        prev = l;
      }
    }
  });

  it('no duplicate <title> across the site', () => {
    const titles = new Map<string, string[]>();
    for (const p of allPages()) {
      const m = readPage(p).match(/<title>([^<]+)<\/title>/);
      if (!m) continue;
      titles.set(m[1], [...(titles.get(m[1]) ?? []), p]);
    }
    const dups = [...titles.entries()].filter(([, ps]) => ps.length > 1);
    expect(
      dups.map(([t, ps]) => `${t} → ${ps.join(', ')}`),
      dups.map(([t, ps]) => `${t} → ${ps.join(', ')}`).join('\n')
    ).toEqual([]);
  });
});

// ── 3.5: лёгкая 404 и sitemap lastmod ───────────────────────────────────────
describe('404 and sitemap', () => {
  it('kontakty map is lazy — no eager iframe in static HTML (FR-08)', () => {
    const html = readPage('/kontakty/');
    // единственный <iframe> в статике — внутри <noscript> (fallback);
    // рабочая карта подставляется JS по IntersectionObserver
    const iframes = [...html.matchAll(/<iframe\b/gi)];
    expect(iframes.length, 'eager map iframe in static HTML').toBe(1);
    const noscriptIframe = /<noscript>[\s\S]*<iframe[\s\S]*<\/noscript>/i.test(html);
    expect(noscriptIframe, 'the only iframe must be the <noscript> fallback').toBe(true);
  });

  // После промоушена верхнего меню 404 несёт полноценную навигацию (выпадашки +
  // поиск + тумблер темы) — это осознанный UX-выбор (со страницы ошибки удобно
  // уйти куда угодно). Бюджет поднят с 20KB; ~22KB сырого HTML → ~6KB в gzip.
  // Бюджет знает про режим сборки. Демо-сборка для превью-стенда добавляет
  // баннер «это демонстрационный стенд», и он честно перевешивал лимит на
  // ~20 байт: гейт краснел на сборке стенда, хотя настоящим посетителям
  // баннер не показывается. Поднимать лимит для всех из-за этого нельзя —
  // тогда потеряем защиту прода, ради которой гейт и заводили.
  // Поднято ещё раз, 2026-08-22: второй номер телефона в шапке и подвале (D12
  // списка после демо) прибавляет ~204 Б каждой странице, и боевая 404 стала
  // 27852 Б при лимите 27648. Подъём назван и измерен, а не сделан ради зелёного:
  // запас над фактом остаётся тем же порядком, что был (820 Б против 420 Б).
  it('404.html is lighter than 28KB (демо-баннер учитывается отдельно)', () => {
    // Признак демо-сборки берётся из СОСТАВА сборки, а не из самой проверяемой
    // страницы: правило `.demo-banner{…}` попадает в инлайновый CSS и боевой
    // сборки тоже (стили эмитятся независимо от условного рендера), поэтому
    // прежняя проверка по подстроке выдавала боевой сборке демо-допуск и
    // маскировала перерасход. Замерено: боевая 404 — 27228 Б при лимите 26624,
    // то есть на 604 Б больше, и гейт при этом был зелёным. Страница-заглушка
    // `/demo-zayavka` существует только в демо-сборке — она и служит признаком.
    const isDemoBuild = existsSync(join(dist, 'demo-zayavka', 'index.html'));
    const limit = isDemoBuild ? 29 * 1024 : 28 * 1024;

    expect(
      statSync(join(dist, '404.html')).size,
      isDemoBuild ? 'демо-сборка: лимит с запасом на баннер стенда' : 'прод-сборка',
    ).toBeLessThan(limit);
  });

  it('sitemap has lastmod on every url and includes /statyi/*', () => {
    const xml = readFileSync(join(dist, 'sitemap-0.xml'), 'utf-8');
    const urls = xml.match(/<url>/g)?.length ?? 0;
    const lastmods = xml.match(/<lastmod>/g)?.length ?? 0;
    expect(urls).toBeGreaterThan(200);
    expect(lastmods).toBe(urls);
    expect((xml.match(/ikpk\.su\/statyi\//g)?.length ?? 0)).toBeGreaterThan(60);
  });

  it('pagefind search index is built (FR-05)', () => {
    // артефакты Pagefind в dist: ленивый UI + индекс
    for (const f of ['pagefind/pagefind.js', 'pagefind/pagefind-ui.js', 'pagefind/pagefind-ui.css']) {
      expect(statSync(join(dist, f)).size, `${f} is empty`).toBeGreaterThan(1000);
    }
    // индекс нетривиален (256 страниц → фрагменты + словари)
    const entry = JSON.parse(readFileSync(join(dist, 'pagefind', 'pagefind-entry.json'), 'utf-8'));
    expect(Object.keys(entry.languages ?? {}).length).toBeGreaterThan(0);
  });

  // Черновики вариантов собираются только в демо-режиме (они не должны уезжать
  // в прод), поэтому в боевой сборке проверять нечего — и это не повод краснеть.
  it('preview variant pages are noindex and excluded from sitemap', () => {
    const previews = allPages().filter((p) => p.startsWith('/preview/'));
    if (previews.length === 0) {
      expect(readPage('/'), 'черновиков нет — это допустимо только в боевой сборке').not.toContain(
        'data-demo-banner',
      );
      return;
    }
    const xml = readFileSync(join(dist, 'sitemap-0.xml'), 'utf-8');
    for (const p of previews) {
      expect(readPage(p), `${p} must be noindex`).toContain('noindex');
      expect(xml.includes(p), `${p} must NOT be in sitemap`).toBe(false);
    }
  });

  it('rich-content canary is noindex and excluded from sitemap', () => {
    const xml = readFileSync(join(dist, 'sitemap-0.xml'), 'utf-8');
    expect(xml.includes('rich-content-canary'), 'canary must NOT be in sitemap').toBe(false);
    const html = readPage('/rich-content-canary');
    expect(html).toContain('noindex');
    expect(html).toContain('rc-fixture-control-9f3c2e1a');
  });

  it('variant D is content-complete (parity-блоки в нужном порядке)', () => {
    // то же: в боевой сборке черновика нет
    if (!allPages().includes('/preview/d/')) {
      expect(readPage('/')).not.toContain('data-demo-banner');
      return;
    }
    const html = readPage('/preview/d/');
    // обязательные секции content-complete главной, по порядку
    const expectedOrder = [
      'для врачей и специалистов', // hero-hybrid H1
      'Наши преимущества',
      'Наш подход к обучению',
      'Наши программы',
      'Для кого обучение',
      'Ближайшие семинары',
      'Преподаватели',
      // Заголовок секции переименован по просьбе заказчика (D21).
      'Предложения',
    ];
    let cursor = 0;
    for (const marker of expectedOrder) {
      const idx = html.indexOf(marker, cursor);
      expect(idx, `секция «${marker}» отсутствует или не по порядку в /preview/d/`).toBeGreaterThan(-1);
      cursor = idx;
    }
    // ключевые счётчики контента (защита от случайного удаления)
    expect((html.match(/feature-card-title/g) ?? []).length, '6 преимуществ').toBeGreaterThanOrEqual(6);
    expect((html.match(/prog-card/g) ?? []).length, '3 института').toBeGreaterThanOrEqual(3);
    expect(html, 'статистика 14000+').toContain('14000+');
  });

  it('preview variant internal links all resolve to built pages', () => {
    // Ссылки секций (в т.ч. href семинаров из home.ts, собранный join двух
    // датасетов) должны вести на реальные страницы — не в 404/фолбэк.
    const built = new Set(allPages());
    const broken: string[] = [];
    for (const p of allPages().filter((x) => x.startsWith('/preview/'))) {
      const html = readPage(p);
      for (const m of html.matchAll(/<a\b[^>]*\bhref="(\/[^"#?]*)"/gi)) {
        let target = decodeURI(m[1]);
        // ссылка на файл (PDF документа, картинка) — это не страница, ей
        // неоткуда взяться в списке собранных маршрутов
        if (/\.[a-z0-9]{2,5}$/i.test(target)) continue;
        if (!target.endsWith('/')) target += '/';
        // якоря (#upcoming) и внешние уже отфильтрованы паттерном
        if (!built.has(target)) broken.push(`${p} → ${m[1]}`);
      }
    }
    expect(broken, `preview links to non-existent pages:\n${broken.join('\n')}`).toEqual([]);
  });

  it('preview draft content is NOT in the Pagefind index (утечка в поиск)', () => {
    const fragDir = join(dist, 'pagefind', 'fragment');
    // фрагменты Pagefind сжаты; проверяем, что ни один не ссылается на /preview/
    let leaked = false;
    for (const f of readdirSync(fragDir)) {
      const buf = readFileSync(join(fragDir, f));
      // grep по gunzip-контенту
      try {
        const text = gunzipSync(buf).toString('utf-8');
        if (text.includes('/preview/')) leaked = true;
      } catch {
        // не gzip — ищем как есть
        if (buf.toString('utf-8').includes('/preview/')) leaked = true;
      }
    }
    expect(leaked, 'preview draft leaked into Pagefind search index').toBe(false);
  });

  it('robots.txt: Sitemap + Clean-param, no CSS/JS blocking', () => {
    const robots = readFileSync(join(dist, 'robots.txt'), 'utf-8');
    expect(robots).toContain('Sitemap: https://ikpk.su/sitemap-index.xml');
    expect(robots).toContain('Clean-param:');
    expect(robots).not.toContain('Disallow: /_astro/');
  });

  // Симметрия к запрету обхода на стенде: `robots.txt` теперь генерируется маршрутом по
  // режиму сборки, поэтому ошибка в условии закрыла бы от индексации БОЕВОЙ сайт целиком —
  // отказ, который снаружи выглядит как «сайт просто пропал из выдачи». Проверка отвечает
  // на обратный вопрос к демо-гейту: здесь обход обязан быть разрешён.
  it('robots.txt боевой сборки не запрещает обход', () => {
    const robots = readFileSync(join(dist, 'robots.txt'), 'utf-8');
    expect(
      robots,
      `боевой robots.txt запрещает обход целиком — сайт закрыт от поисковиков:\n${robots}`,
    ).not.toMatch(/^\s*Disallow:\s*\/\s*$/m);
    expect(robots, 'боевой robots.txt не разрешает обход явно').toMatch(/^\s*Allow:\s*\/\s*$/m);
  });
});

// ─── Заголовок и описание есть у КАЖДОЙ страницы ────────────────────────────
// Гейт выше проверял title только у списка ключевых страниц — и пропустил
// момент, когда обновление каталога с живого API привело 138 страниц к пустому
// <title>: API отдаёт seo-поля пустыми (живой сайт собирает заголовок шаблоном),
// а наши шаблоны подставляли значение напрямую. Пустой title — это и серьёзное
// нарушение доступности (axe: document-title), и потеря сниппета в поиске.
describe('title and description on every page', () => {
  it('every built page has a non-empty <title>', () => {
    const offenders: string[] = [];
    for (const p of allPages()) {
      const m = readPage(p).match(/<title>([^<]*)<\/title>/);
      if (!m || !m[1].trim()) offenders.push(p);
    }
    expect(
      offenders.slice(0, 8),
      `страниц без заголовка: ${offenders.length}\n${offenders.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });

  it('every built page has a non-empty meta description', () => {
    const offenders: string[] = [];
    for (const p of allPages()) {
      const m = readPage(p).match(/<meta name="description" content="([^"]*)"/);
      if (!m || !m[1].trim()) offenders.push(p);
    }
    expect(
      offenders.slice(0, 8),
      `страниц без описания: ${offenders.length}\n${offenders.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });
});

// ─── Служебные страницы не уезжают в прод ───────────────────────────────────
// Черновики вариантов (/preview/*) и заглушка форм демо-стенда (/demo-zayavka)
// нужны на превью-стенде, но в боевой сборке им делать нечего: они публично
// доступны по прямому адресу, а на старом сайте таких URL нет. noindex защищает
// от индексации, но не от того, что страницу увидят по ссылке.
describe('служебные страницы вне прод-сборки', () => {
  // Признак — САМ ЭЛЕМЕНТ баннера (data-demo-banner), а не имя класса:
  // класс .demo-banner лежит в общем CSS независимо от режима, и проверка по
  // нему делала этот гейт пустым — он уходил в демо-ветку на боевой сборке.
  const isDemoBuild = readPage('/').includes('data-demo-banner');

  it('в прод-сборке нет черновиков вариантов и демо-заглушки', () => {
    if (isDemoBuild) {
      // на демо-стенде они и должны быть — это его назначение
      expect(allPages().some((p) => p.startsWith('/preview/'))).toBe(true);
      return;
    }

    const leaked = allPages().filter(
      (p) => p.startsWith('/preview/') || p.startsWith('/demo-zayavka'),
    );
    expect(
      leaked,
      `служебные страницы попали в боевую сборку:\n${leaked.join('\n')}`,
    ).toEqual([]);
  });
});

// ─── Редиректы ведут на существующие страницы ───────────────────────────────
// Перенаправление на несуществующий адрес хуже отсутствия перенаправления:
// поисковик видит 404 по цепочке и выбрасывает страницу из индекса, а
// посетитель попадает в тупик. Гейт сверяет сгенерированный конфиг nginx
// (deploy/nginx-redirects.conf) с тем, что реально собрано.
describe('редиректы легаси-адресов', () => {
  const CONF = join(dist, '..', '..', 'deploy', 'nginx-redirects.conf');

  // nginx сопоставляет location с путём БЕЗ строки запроса, поэтому правило с
  // «?» не выберется никогда: оно выглядит рабочим и ничего не делает.
  it('в конфиге нет правил с query-параметром', () => {
    const conf = readFileSync(CONF, 'utf-8');
    const bad = conf
      .split('\n')
      .filter((l) => /^\s*location\b/.test(l) && l.includes('?'));
    expect(
      bad,
      `правило с query-параметром не сработает в nginx:\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('каждая цель редиректа существует в сборке', () => {
    if (!existsSync(CONF)) {
      throw new Error('нет deploy/nginx-redirects.conf — запустите npm run redirects:gen');
    }
    const conf = readFileSync(CONF, 'utf-8');
    const built = new Set(allPages());
    const broken: string[] = [];

    for (const m of conf.matchAll(/location = (\S+) \{ return 301 (\S+); \}/g)) {
      const [, from, to] = m;
      // файлы (карта сайта, PDF) — не страницы, проверяем наличие файла
      if (/\.[a-z0-9]{2,5}$/i.test(to)) {
        if (!existsSync(join(dist, to.replace(/^\//, '')))) broken.push(`${from} → ${to} (нет файла)`);
        continue;
      }
      const normalized = to.endsWith('/') ? to : `${to}/`;
      if (!built.has(normalized)) broken.push(`${from} → ${to}`);
    }

    expect(
      broken.slice(0, 10),
      `редиректов в никуда: ${broken.length}\n${broken.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  });
});
