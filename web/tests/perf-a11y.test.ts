import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const dist = join(import.meta.dirname, '..', 'dist');

function readPage(path: string): string {
  const file = path === '/'
    ? join(dist, 'index.html')
    : join(dist, path.replace(/^\//, ''), 'index.html');
  return readFileSync(file, 'utf-8');
}

let homepage: string;
let subpage: string;

beforeAll(() => {
  if (!existsSync(dist)) {
    throw new Error(
      'dist/ not found — run "npm run build" first, or use "npm run test:build" which builds automatically.'
    );
  }
  homepage = readPage('/');
  subpage = readPage('/kontakty');
});

// ─── Self-hosted fonts ──────────────────────────────────────────────────────
describe('Self-hosted Inter font', () => {
  it('does not reference Google Fonts', () => {
    expect(homepage).not.toContain('fonts.googleapis.com');
    expect(subpage).not.toContain('fonts.googleapis.com');
  });

  it('preloads latin and cyrillic woff2 files', () => {
    expect(homepage).toContain('<link rel="preload" href="/fonts/inter-latin.woff2"');
    expect(homepage).toContain('<link rel="preload" href="/fonts/inter-cyrillic.woff2"');
  });

  it('has font files in the build output', () => {
    expect(existsSync(join(dist, 'fonts', 'inter-latin.woff2'))).toBe(true);
    expect(existsSync(join(dist, 'fonts', 'inter-cyrillic.woff2'))).toBe(true);
  });

  it('declares @font-face with font-display: swap in CSS', () => {
    // Find the built CSS file
    const cssDir = join(dist, '_astro');
    if (existsSync(cssDir)) {
      const cssFiles = readdirSync(cssDir).filter((f: string) => f.endsWith('.css'));
      const allCss = cssFiles.map((f: string) => readFileSync(join(cssDir, f), 'utf-8')).join('');
      expect(allCss).toContain('font-display:swap');
      expect(allCss).toContain('inter-latin.woff2');
      expect(allCss).toContain('inter-cyrillic.woff2');
    }
  });
});

// ─── Hero image optimization ────────────────────────────────────────────────
describe('Hero image', () => {
  it('homepage has hero preload with fetchpriority', () => {
    expect(homepage).toMatch(/rel="preload"[^>]*href="\/hero-main\.svg"/);
    expect(homepage).toMatch(/fetchpriority="high"/);
  });

  it('subpages do not preload hero', () => {
    expect(subpage).not.toContain('preload" href="/hero-main.svg"');
  });

  it('hero SVG is under 100KB', () => {
    const heroPath = join(dist, 'hero-main.svg');
    const stat = statSync(heroPath);
    expect(stat.size).toBeLessThan(100 * 1024);
  });
});

// ─── Deferred analytics ─────────────────────────────────────────────────────
describe('Analytics', () => {
  it('initializes Yandex.Metrika stub synchronously (before deferred block)', () => {
    // The sync stub must appear before the deferred loader
    const ymStubIndex = homepage.indexOf('window.ym=window.ym||function');
    const deferIndex = homepage.indexOf('_loadAnalyticsScripts');
    expect(ymStubIndex).toBeGreaterThan(-1);
    expect(deferIndex).toBeGreaterThan(-1);
    expect(ymStubIndex).toBeLessThan(deferIndex);
  });

  it('queues Mail.ru pageview synchronously', () => {
    const tmrIndex = homepage.indexOf('_tmr.push({id:"3752684"');
    const deferIndex = homepage.indexOf('_loadAnalyticsScripts');
    expect(tmrIndex).toBeGreaterThan(-1);
    expect(tmrIndex).toBeLessThan(deferIndex);
  });

  it('defers script downloads via requestIdleCallback', () => {
    expect(homepage).toContain('requestIdleCallback(_loadAnalyticsScripts');
  });

  it('has noscript pixel fallbacks', () => {
    expect(homepage).toContain('mc.yandex.ru/watch/39506315');
    expect(homepage).toContain('top-fwz1.mail.ru/counter');
  });

  it('analytics are not in <head>', () => {
    const head = homepage.slice(0, homepage.indexOf('</head>'));
    expect(head).not.toContain('mc.yandex.ru/metrika/tag.js');
    expect(head).not.toContain('top-fwz1.mail.ru/js/code.js');
  });
});

// ─── Button contrast (WCAG AA) ─────────────────────────────────────────────
describe('Button contrast', () => {
  it('accent-500 is the darkened value for AA compliance', () => {
    const cssDir = join(dist, '_astro');
    if (existsSync(cssDir)) {
      const cssFiles = readdirSync(cssDir).filter((f: string) => f.endsWith('.css'));
      const allCss = cssFiles.map((f: string) => readFileSync(join(cssDir, f), 'utf-8')).join('');
      expect(allCss).toMatch(/--color-accent-500:\s*#357a38/);
      expect(allCss).not.toMatch(/--color-accent-500:\s*#41a143/);
    }
  });
});

// ─── Accessibility ──────────────────────────────────────────────────────────
describe('Accessibility', () => {
  it('phone link has aria-label', () => {
    expect(homepage).toMatch(/href="tel:\+78126465450"[^>]*aria-label/);
  });

  it('footer logo link has aria-label', () => {
    expect(homepage).toMatch(/class="footer-logo-link"[^>]*aria-label="ИКПК/);
  });
});
