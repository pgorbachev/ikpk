import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { dist, walkHtml, allPages, readPage } from './helpers/dist-pages';

// ─── Этап 3 (план 004): SEO-пакет как вечные CI-гейты ───────────────────────

// ── 3.2: 0 страниц-сирот — обход dist по внутренним ссылкам ────────────────
describe('orphan pages (обход по внутренним ссылкам)', () => {
  it('every built page is reachable from / via internal <a href>', () => {
    // /preview/* — noindex-черновики вариантов, намеренно не слинкованы
    const pages = new Set(allPages().filter((p) => !p.startsWith('/preview/')));
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
  it('404.html is lighter than 26KB', () => {
    expect(statSync(join(dist, '404.html')).size).toBeLessThan(26 * 1024);
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

  it('preview variant pages are noindex and excluded from sitemap', () => {
    const previews = allPages().filter((p) => p.startsWith('/preview/'));
    expect(previews.length, 'no preview variants built').toBeGreaterThan(0);
    const xml = readFileSync(join(dist, 'sitemap-0.xml'), 'utf-8');
    for (const p of previews) {
      expect(readPage(p), `${p} must be noindex`).toContain('noindex');
      expect(xml.includes(p), `${p} must NOT be in sitemap`).toBe(false);
    }
  });

  it('variant D is content-complete (parity-блоки в нужном порядке)', () => {
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
      'Новости',
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
});
