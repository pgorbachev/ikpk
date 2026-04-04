import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ORIGINAL = 'https://ikpk.su';
const DIST = join(import.meta.dirname, '..', 'dist');
const REMOTE_PARITY_ENABLED = process.env.PARITY_REMOTE === '1' || process.env.PARITY_REMOTE_STRICT === '1';
const STRICT_REMOTE_PARITY = process.env.PARITY_REMOTE_STRICT === '1';

const KEY_PAGES = [
  '/',
  '/institut-klinicheskoy-prikladnoy-kineziologii',
  '/institut-apledzhera',
  '/institut-barralya',
  '/raspisanie-i-tseny',
  '/statyi',
  '/video',
  '/kontakty',
  '/oplata',
  '/sotrudnichestvo-s-nami',
  '/svedeniya-ob-obrazovatelnoy-organizatsii',
  '/aktsii-i-skidki',
] as const;

const EXPECTED_NAV_TARGETS = [
  '/',
  '/aktsii-i-skidki',
  '/institut-klinicheskoy-prikladnoy-kineziologii',
  '/institut-apledzhera',
  '/institut-barralya',
  '/raspisanie-i-tseny',
  '/oplata',
  '/statyi',
  '/video',
  '/svedeniya-ob-obrazovatelnoy-organizatsii',
  '/sotrudnichestvo-s-nami',
  '/kontakty',
];

const ARTICLE_PATH = '/statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii';
const SEMINAR_PATH = '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/osnovy-manualnogo-myshechnogo-testirovaniya';

type PageSnapshot = {
  status: number;
  html: string;
};

const remoteCache = new Map<string, Promise<PageSnapshot>>();
const localCache = new Map<string, PageSnapshot>();
let remoteOriginReachable = false;

function localFileForPath(path: string): string {
  if (path === '/') return join(DIST, 'index.html');
  return join(DIST, path.replace(/^\//, ''), 'index.html');
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(html: string, tag: string): string {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? stripTags(match[1]) : '';
}

function extractMeta(html: string, attr: 'name' | 'property', value: string): string {
  const regex = new RegExp(
    `<meta[^>]*${attr}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    'i',
  );
  const match = html.match(regex);
  return match?.[1] ?? '';
}

function extractCanonical(html: string): string {
  const match = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  return match?.[1] ?? '';
}

function extractInternalLinks(html: string): string[] {
  const matches = [...html.matchAll(/href=["'](\/[^"'#?]*)["']/g)];
  return [...new Set(matches.map((match) => match[1].replace(/\/$/, '') || '/'))];
}

function hasLegacyHashClass(html: string): boolean {
  return /class=["'][^"']*__[A-Za-z0-9_-]+/i.test(html);
}

async function fetchRemote(path: string): Promise<PageSnapshot> {
  let snapshot = remoteCache.get(path);
  if (!snapshot) {
    snapshot = fetch(ORIGINAL + path).then(async (response) => ({
      status: response.status,
      html: response.ok ? await response.text() : '',
    }));
    remoteCache.set(path, snapshot);
  }
  return snapshot;
}

function readLocal(path: string): PageSnapshot {
  const existing = localCache.get(path);
  if (existing) return existing;

  const file = localFileForPath(path);
  const snapshot = existsSync(file)
    ? { status: 200, html: readFileSync(file, 'utf-8') }
    : { status: 404, html: '' };

  localCache.set(path, snapshot);
  return snapshot;
}

beforeAll(() => {
  if (!existsSync(DIST)) {
    throw new Error('dist/ not found — run "npm run build" first, or use "npm run test:build".');
  }
});

beforeAll(async () => {
  if (!REMOTE_PARITY_ENABLED) {
    return;
  }

  try {
    const remote = await fetchRemote('/');
    remoteOriginReachable = remote.status < 400;
  } catch {
    remoteOriginReachable = false;
    if (STRICT_REMOTE_PARITY) {
      throw new Error(`Remote parity source ${ORIGINAL} is not reachable.`);
    }
  }
});

describe('Parity audit against original site', () => {
  it('all key pages exist locally', () => {
    for (const path of KEY_PAGES) {
      expect(readLocal(path).status, `Local ${path} status`).toBe(200);
    }
  });

  it('all key pages exist on original when remote parity is available', async () => {
    if (!REMOTE_PARITY_ENABLED || !remoteOriginReachable) {
      return;
    }

    const checks = await Promise.all(KEY_PAGES.map(async (path) => ({
      path,
      remote: await fetchRemote(path),
    })));

    for (const check of checks) {
      expect(check.remote.status, `Original ${check.path} status`).toBeLessThan(400);
    }
  });

  it('key pages keep title, h1 and meta description', () => {
    for (const path of KEY_PAGES) {
      const html = readLocal(path).html;
      expect(extractTag(html, 'title').length, `${path} title`).toBeGreaterThan(0);
      expect(extractTag(html, 'h1').length, `${path} h1`).toBeGreaterThan(0);
      expect(extractMeta(html, 'name', 'description').length, `${path} meta description`).toBeGreaterThan(0);
    }
  });

  it('homepage keeps expected navigation targets', () => {
    const links = extractInternalLinks(readLocal('/').html);
    for (const target of EXPECTED_NAV_TARGETS) {
      expect(links, `Missing nav target ${target}`).toContain(target);
    }
  });

  it('homepage footer keeps contacts and social links', () => {
    const html = readLocal('/').html;
    expect(html).toContain('646-54-50');
    expect(html).toContain('info@ikpk.su');
    expect(/vk\.com|youtube\.com|rutube\.ru|t\.me/i.test(html)).toBe(true);
  });

  it('homepage keeps canonical, OG, JSON-LD and analytics markers', () => {
    const html = readLocal('/').html;
    expect(extractCanonical(html)).toContain('ikpk.su');
    expect(extractMeta(html, 'property', 'og:title').length).toBeGreaterThan(0);
    expect(html).toContain('application/ld+json');
    expect(html).toContain('EducationalOrganization');
    expect(html).toContain('39506315');
    expect(html).toContain('mc.yandex.ru/metrika');
  });

  it('homepage keeps mandatory content sections', () => {
    const text = stripTags(readLocal('/').html);
    expect(text).toContain('Наши преимущества');
    expect(text).toContain('Наш подход к обучению');
    expect(text).toContain('Наши программы');
    expect(text).toContain('Подпишитесь на наши новости');
    expect(text).toContain('единственный официальный представитель институтов Апледжера и Барраля');
  });

  it('article page keeps rich content and Article JSON-LD', () => {
    const html = readLocal(ARTICLE_PATH).html;
    expect(/class="[^"]*\brich-content\b/i.test(html)).toBe(true);
    expect(/<(h2|h3|ul|ol|strong|em|a )/i.test(html)).toBe(true);
    expect(html).toContain('"@type":"Article"');
  });

  it('seminar page keeps sidebar structure and schedule data', () => {
    const html = readLocal(SEMINAR_PATH).html;
    expect(html).toContain('seminar-sidebar');
    expect(html).toContain('Записаться');
    expect(html).toContain('sidebar-price');
    expect(html).toContain('sidebar-next-date');
    expect(html).toContain('Преподаватель');
  });

  it('static pages keep contact blocks and details sections', () => {
    const contacts = readLocal('/kontakty').html;
    const svedeniya = readLocal('/svedeniya-ob-obrazovatelnoy-organizatsii').html;
    const cooperation = readLocal('/sotrudnichestvo-s-nami').html;

    expect(contacts).toContain('contact-value');
    expect(contacts).toContain('info@ikpk.su');
    expect(svedeniya).toContain('<details');
    expect(cooperation).toContain('cta');
  });

  it('key local pages do not render legacy CSS hash classes', () => {
    for (const path of ['/', '/statyi', '/kontakty', '/oplata', '/svedeniya-ob-obrazovatelnoy-organizatsii', '/sotrudnichestvo-s-nami']) {
      expect(hasLegacyHashClass(readLocal(path).html), `Legacy hash classes on ${path}`).toBe(false);
    }
    expect(hasLegacyHashClass(readLocal(ARTICLE_PATH).html), 'Legacy hash classes on article').toBe(false);
    expect(hasLegacyHashClass(readLocal(SEMINAR_PATH).html), 'Legacy hash classes on seminar').toBe(false);
  });

  it('original and local homepage keep same main institute heading', async () => {
    if (!REMOTE_PARITY_ENABLED || !remoteOriginReachable) {
      return;
    }

    const remote = await fetchRemote('/');
    const local = readLocal('/');
    expect(extractTag(local.html, 'h1')).toBe(extractTag(remote.html, 'h1'));
  });

  it('original and local contacts page keep the same primary heading', async () => {
    if (!REMOTE_PARITY_ENABLED || !remoteOriginReachable) {
      return;
    }

    const remote = await fetchRemote('/kontakty');
    const local = readLocal('/kontakty');
    expect(extractTag(local.html, 'h1')).toBe(extractTag(remote.html, 'h1'));
  });
});
