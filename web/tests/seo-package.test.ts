import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { dist, walkHtml, allPages, readPage } from './helpers/dist-pages';

// ─── Этап 3 (план 004): SEO-пакет как вечные CI-гейты ───────────────────────

// ── 3.2: 0 страниц-сирот — обход dist по внутренним ссылкам ────────────────
describe('orphan pages (обход по внутренним ссылкам)', () => {
  it('every built page is reachable from / via internal <a href>', () => {
    const pages = new Set(allPages());
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
  it('404.html is lighter than 20KB', () => {
    expect(statSync(join(dist, '404.html')).size).toBeLessThan(20 * 1024);
  });

  it('sitemap has lastmod on every url and includes /statyi/*', () => {
    const xml = readFileSync(join(dist, 'sitemap-0.xml'), 'utf-8');
    const urls = xml.match(/<url>/g)?.length ?? 0;
    const lastmods = xml.match(/<lastmod>/g)?.length ?? 0;
    expect(urls).toBeGreaterThan(200);
    expect(lastmods).toBe(urls);
    expect((xml.match(/ikpk\.su\/statyi\//g)?.length ?? 0)).toBeGreaterThan(60);
  });

  it('robots.txt: Sitemap + Clean-param, no CSS/JS blocking', () => {
    const robots = readFileSync(join(dist, 'robots.txt'), 'utf-8');
    expect(robots).toContain('Sitemap: https://ikpk.su/sitemap-index.xml');
    expect(robots).toContain('Clean-param:');
    expect(robots).not.toContain('Disallow: /_astro/');
  });
});
