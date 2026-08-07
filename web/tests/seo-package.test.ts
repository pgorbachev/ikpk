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
  it('404.html is lighter than 26KB (демо-баннер учитывается отдельно)', () => {
    // Признак демо-сборки берётся из СОСТАВА сборки, а не из самой проверяемой
    // страницы: правило `.demo-banner{…}` попадает в инлайновый CSS и боевой
    // сборки тоже (стили эмитятся независимо от условного рендера), поэтому
    // прежняя проверка по подстроке выдавала боевой сборке демо-допуск и
    // маскировала перерасход. Замерено: боевая 404 — 27228 Б при лимите 26624,
    // то есть на 604 Б больше, и гейт при этом был зелёным. Страница-заглушка
    // `/demo-zayavka` существует только в демо-сборке — она и служит признаком.
    const isDemoBuild = existsSync(join(dist, 'demo-zayavka', 'index.html'));
    const limit = isDemoBuild ? 28 * 1024 : 27 * 1024;

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

// ─── Прототипы каркаса: обязательные блоки главной ──────────────────────────
// План 005 §4.4 фиксирует состав главной, без которого выбор варианта
// невозможен: позиционирование, ближайшее событие, доказательства доверия, три
// института, маршруты аудиторий, семинары, преподаватели, видео, новости, CTA.
// Гейт проверяет ИМЕННО состав, а не оформление: направления различаются
// архитектурой подачи, но ни одно не имеет права терять обязательный блок.
describe('прототипы каркаса', () => {
  const DIRECTIONS = ['editorial', 'faculty', 'modular'];
  const REQUIRED = [
    { name: 'позиционирование (h1)', match: /<h1[^>]*>/ },
    { name: 'ближайшие семинары', match: /Ближайшие семинары|upcoming/i },
    { name: 'три института', match: /Институт Апледжера/ },
    { name: 'преподаватели', match: /teacher-card|Преподаватели/i },
    { name: 'итоговый CTA', match: /cta-band|Записаться/i },
    { name: 'футер с контактами', match: /646-54-50/ },
  ];

  for (const id of DIRECTIONS) {
    it(`/preview/${id}: обязательные блоки на месте`, () => {
      const path = `/preview/${id}/`;
      if (!allPages().includes(path)) {
        // в боевой сборке черновиков нет — это проверяет отдельный гейт
        expect(readPage('/')).not.toContain('data-demo-banner');
        return;
      }
      const html = readPage(path);
      const missing = REQUIRED.filter(({ match }) => !match.test(html)).map((r) => r.name);
      expect(missing, `в прототипе ${id} нет блоков: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

// ─── Прототипы честно помечают происхождение изображений ────────────────────
// Проверено просмотром файлов: подлинный фотоактив ИКПК — только портреты
// преподавателей. Изображения институтов, событий и статей — сток и CGI
// (глянцевое спа-фото, силуэт на закате с разорванной цепью, 3D-рендеры).
//
// Без пометки владелец оценит стоковую картинку как собственную съёмку и выберет
// вариант, которого потом не получит. Пометка нужна ТОЛЬКО в прототипах: в
// боевой сборке это служебная разметка, ей там не место.
describe('прототипы: происхождение изображений', () => {
  it('на страницах прототипов есть пометки происхождения', () => {
    const previews = allPages().filter((p) => p.startsWith('/preview/'));
    if (previews.length === 0) {
      expect(readPage('/')).not.toContain('data-demo-banner');
      return;
    }

    const missing = previews.filter((p) => !readPage(p).includes('data-provenance-legend'));
    expect(missing, `в прототипах нет пометок происхождения:\n${missing.join('\n')}`).toEqual([]);
  });

  it('служебная пометка не попадает в боевые страницы', () => {
    const leaked = allPages()
      .filter((p) => !p.startsWith('/preview/'))
      .filter((p) => readPage(p).includes('data-provenance-legend'));
    expect(leaked.slice(0, 5), `пометка прототипа на боевой странице:\n${leaked.slice(0, 5).join('\n')}`).toEqual([]);
  });
});

// ─── Редакционное направление: событие строкой, а не карточкой ──────────────
// Направления должны различаться АРХИТЕКТУРОЙ подачи, а не только порядком
// секций. Первый различающий элемент: в Institutional Editorial ближайшее
// событие подаётся строкой-анонсом между линейками (дата · город · семинар ·
// объём · цена · «Записаться»), а не карточкой с картинкой — карточка тянет за
// собой изображение, а изображения событий у нас стоковые.
describe('прототипы: своя подача первого экрана', () => {
  it('editorial подаёт ближайшее событие строкой-анонсом', () => {
    if (!allPages().includes('/preview/editorial/')) {
      expect(readPage('/')).not.toContain('data-demo-banner');
      return;
    }
    const html = readPage('/preview/editorial/');
    expect(html, 'нет строки-анонса события').toContain('data-event-line');
    expect(html, 'нет editorial hero').toContain('data-hero="editorial"');

    const at = html.indexOf('data-event-line');
    const line = html.slice(at, at + 900);
    expect(line, 'в анонсе нет города').toMatch(/Санкт-Петербург|Москва|Онлайн|Уточняется|Челны|Новосибирск|Новгород/);
    expect(line, 'в анонсе нет цены или пометки «бесплатно»').toMatch(/₽|Бесплатно/);
  });

  it('faculty подаёт событие карточкой с преподавателем', () => {
    if (!allPages().includes('/preview/faculty/')) {
      expect(readPage('/')).not.toContain('data-demo-banner');
      return;
    }
    const html = readPage('/preview/faculty/');
    expect(html, 'нет faculty hero').toContain('data-hero="faculty"');
    expect(html, 'нет карточки события с преподавателем').toContain('data-event-teacher');
    expect(html, 'faculty не должен повторять строку editorial').not.toContain('data-event-line');
  });

  it('modular подаёт каталог: picker + сетка дат без строки editorial', () => {
    if (!allPages().includes('/preview/modular/')) {
      expect(readPage('/')).not.toContain('data-demo-banner');
      return;
    }
    const html = readPage('/preview/modular/');
    expect(html, 'нет modular hero').toContain('data-hero="modular"');
    expect(html, 'нет модуля подбора').toContain('data-modular-picker');
    expect(html, 'нет сетки дат').toContain('data-upcoming="modular"');
    expect(html, 'нет траектории ступеней').toContain('data-tracks="modular"');
    expect(html, 'modular не должен повторять строку editorial').not.toContain('data-event-line');
  });

  it('в остальных направлениях строки-анонса нет — подача отличается', () => {
    for (const id of ['faculty', 'modular']) {
      const path = `/preview/${id}/`;
      if (!allPages().includes(path)) continue;
      expect(readPage(path), `${id} повторяет подачу editorial`).not.toContain('data-event-line');
    }
  });

  it('у каждого каркаса есть прототип страницы семинара', () => {
    if (!allPages().includes('/preview/editorial/')) {
      expect(readPage('/')).not.toContain('data-demo-banner');
      return;
    }
    for (const id of ['editorial', 'faculty', 'modular']) {
      const path = `/preview/${id}/seminar/`;
      expect(allPages(), `нет ${path}`).toContain(path);
      const html = readPage(path);
      expect(html).toContain(`data-seminar-architecture="${id}"`);
    }
  });
});
