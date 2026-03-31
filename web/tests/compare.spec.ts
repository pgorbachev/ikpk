/**
 * Site comparison test: original ikpk.su vs new build (localhost:4322)
 *
 * Crawls key pages on both sites and compares:
 * - Page existence (HTTP status)
 * - <title>, <h1>, meta description
 * - Navigation links
 * - Footer content
 * - Contact info (phone, email)
 * - Key content blocks presence
 * - SEO elements (canonical, OG, JSON-LD)
 */
import { test, expect, Page } from '@playwright/test';

const ORIGINAL = 'https://ikpk.su';
const NEW_SITE = 'http://localhost:4322';

// Key pages to compare (from url_map.csv top-level)
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
];

// Helper: extract page data from a URL
async function extractPageData(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const status = response?.status() ?? 0;

  if (status >= 400) {
    return { status, title: '', h1: '', metaDesc: '', canonical: '', hasJsonLd: false, phone: false, links: [] as string[] };
  }

  const title = await page.title();

  const h1 = await page.locator('h1').first().textContent().catch(() => '') ?? '';

  const metaDesc = await page.locator('meta[name="description"]')
    .getAttribute('content').catch(() => '') ?? '';

  const canonical = await page.locator('link[rel="canonical"]')
    .getAttribute('href').catch(() => '') ?? '';

  const hasJsonLd = (await page.locator('script[type="application/ld+json"]').count()) > 0;

  const bodyText = await page.locator('body').textContent() ?? '';
  const phone = bodyText.includes('646-54-50');

  // Get all internal nav links
  const links = await page.locator('a[href^="/"]').evaluateAll(
    (els) => [...new Set(els.map(e => e.getAttribute('href') || '').filter(h => h.length > 1))]
  );

  return { status, title, h1: h1.trim(), metaDesc, canonical, hasJsonLd, phone, links };
}

// ─── Page-by-page comparison ───────────────────────────────

test.describe('Content parity: page-by-page', () => {
  for (const path of KEY_PAGES) {
    test(`${path} — exists on both sites`, async ({ browser }) => {
      const ctx = await browser.newContext();
      const origPage = await ctx.newPage();
      const newPage = await ctx.newPage();

      const [orig, rebuilt] = await Promise.all([
        extractPageData(origPage, ORIGINAL + path),
        extractPageData(newPage, NEW_SITE + path),
      ]);

      // Both should return 200
      expect(orig.status, `Original ${path} status`).toBeLessThan(400);
      expect(rebuilt.status, `New ${path} status`).toBeLessThan(400);

      await ctx.close();
    });

    test(`${path} — title present on new site`, async ({ browser }) => {
      const ctx = await browser.newContext();
      const newPage = await ctx.newPage();
      const rebuilt = await extractPageData(newPage, NEW_SITE + path);

      expect(rebuilt.title.length, `New ${path} should have a title`).toBeGreaterThan(0);
      await ctx.close();
    });

    test(`${path} — h1 present on new site`, async ({ browser }) => {
      const ctx = await browser.newContext();
      const newPage = await ctx.newPage();
      const rebuilt = await extractPageData(newPage, NEW_SITE + path);

      expect(rebuilt.h1.length, `New ${path} should have h1`).toBeGreaterThan(0);
      await ctx.close();
    });

    test(`${path} — meta description present`, async ({ browser }) => {
      const ctx = await browser.newContext();
      const newPage = await ctx.newPage();
      const rebuilt = await extractPageData(newPage, NEW_SITE + path);

      expect(rebuilt.metaDesc.length, `New ${path} should have meta description`).toBeGreaterThan(0);
      await ctx.close();
    });
  }
});

// ─── Navigation structure ──────────────────────────────────

test.describe('Navigation parity', () => {
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

  test('new site has all original navigation links', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const allLinks = await page.locator('a[href^="/"]').evaluateAll(
      (els) => [...new Set(els.map(e => (e.getAttribute('href') || '').replace(/\/$/, '') || '/'))]
    );

    const missing: string[] = [];
    for (const target of EXPECTED_NAV_TARGETS) {
      if (!allLinks.includes(target)) {
        missing.push(target);
      }
    }

    expect(missing, `Missing navigation links on new homepage: ${missing.join(', ')}`).toHaveLength(0);
  });
});

// ─── Footer parity ─────────────────────────────────────────

test.describe('Footer parity', () => {
  test('footer has phone number', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const footerText = await page.locator('footer').textContent() ?? '';
    expect(footerText).toContain('646-54-50');
  });

  test('footer has email', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const footerText = await page.locator('footer').textContent() ?? '';
    expect(footerText).toContain('info@ikpk.su');
  });

  test('footer has copyright', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const footerText = await page.locator('footer').textContent() ?? '';
    expect(footerText).toContain('ikpk.su');
  });

  test('footer has institute links', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const footerLinks = await page.locator('footer a[href^="/"]').evaluateAll(
      (els) => els.map(e => e.getAttribute('href') || '')
    );
    expect(footerLinks).toContain('/raspisanie-i-tseny');
    expect(footerLinks).toContain('/kontakty');
    expect(footerLinks).toContain('/sotrudnichestvo-s-nami');
  });

  test('footer has social links (VK, YouTube, Telegram)', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const footerHtml = await page.locator('footer').innerHTML();
    // At least some social links should be present
    const hasSocial = /vk\.com|youtube\.com|t\.me|telegram/i.test(footerHtml);
    expect(hasSocial, 'Footer should have social media links').toBe(true);
  });
});

// ─── Contact info ──────────────────────────────────────────

test.describe('Contact info parity', () => {
  test('kontakty page has correct phone', async ({ page }) => {
    await page.goto(NEW_SITE + '/kontakty');
    const text = await page.locator('body').textContent() ?? '';
    expect(text).toContain('646-54-50');
  });

  test('kontakty page has email', async ({ page }) => {
    await page.goto(NEW_SITE + '/kontakty');
    const text = await page.locator('body').textContent() ?? '';
    expect(text).toContain('info@ikpk.su');
  });

  test('phone in header or visible on homepage', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const text = await page.locator('body').textContent() ?? '';
    expect(text).toContain('646-54-50');
  });
});

// ─── SEO elements ──────────────────────────────────────────

test.describe('SEO parity', () => {
  test('homepage has canonical URL', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toContain('ikpk.su');
  });

  test('homepage has OG tags', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content');
    expect(ogTitle?.length).toBeGreaterThan(0);
  });

  test('homepage has JSON-LD EducationalOrganization', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const ldScripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const hasEdu = ldScripts.some(s => s.includes('EducationalOrganization'));
    expect(hasEdu).toBe(true);
  });

  test('JSON-LD has correct phone', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const ldScripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const hasCorrectPhone = ldScripts.some(s => s.includes('6465450'));
    expect(hasCorrectPhone, 'JSON-LD should have phone 646-54-50').toBe(true);
  });

  test('article pages have Article JSON-LD', async ({ page }) => {
    await page.goto(NEW_SITE + '/statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii');
    const ldScripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const hasArticle = ldScripts.some(s => s.includes('"Article"'));
    expect(hasArticle).toBe(true);
  });

  test('robots.txt exists and is valid', async ({ page }) => {
    const resp = await page.goto(NEW_SITE + '/robots.txt');
    expect(resp?.status()).toBe(200);
    const text = await page.locator('body').textContent() ?? '';
    expect(text).toContain('Sitemap');
  });

  test('Yandex.Metrika counter present', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const html = await page.content();
    expect(html).toContain('39506315');
  });

  test('Mail.ru Top counter present', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const html = await page.content();
    expect(html).toContain('3752684');
  });
});

// ─── Homepage content blocks ───────────────────────────────

test.describe('Homepage content parity', () => {
  // Original has: Hero, Наши преимущества, Наш подход к обучению, Наши программы, Новости, Newsletter
  test('has hero section with institute name', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const text = await page.locator('body').textContent() ?? '';
    expect(text).toContain('Институт клинической прикладной кинезиологии');
  });

  test('has institute program cards', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    // Should have links to all 3 institutes
    const links = await page.locator('a').evaluateAll(
      (els) => els.map(e => e.getAttribute('href') || '')
    );
    expect(links.some(l => l.includes('institut-klinicheskoy'))).toBe(true);
    expect(links.some(l => l.includes('institut-apledzhera'))).toBe(true);
    expect(links.some(l => l.includes('institut-barralya'))).toBe(true);
  });

  test('has news section', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const text = await page.locator('body').textContent() ?? '';
    // Should have news items or news heading
    const hasNews = text.includes('Новости') || text.includes('новост');
    expect(hasNews, 'Homepage should have a news section').toBe(true);
  });

  test('has newsletter subscription form', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const emailInput = page.locator('input[type="email"]');
    expect(await emailInput.count()).toBeGreaterThan(0);
  });

  test('has promotions/discounts link', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const links = await page.locator('a').evaluateAll(
      (els) => els.map(e => e.getAttribute('href') || '')
    );
    expect(links.some(l => l.includes('aktsii'))).toBe(true);
  });
});

// ─── Key content pages: article count ──────────────────────

test.describe('Content volume parity', () => {
  test('articles listing has multiple items', async ({ page }) => {
    await page.goto(NEW_SITE + '/statyi');
    const cards = page.locator('.card, article, [class*="article"]');
    const count = await cards.count();
    expect(count, 'Articles page should list multiple articles').toBeGreaterThan(5);
  });

  test('schedule page has events', async ({ page }) => {
    await page.goto(NEW_SITE + '/raspisanie-i-tseny');
    const rows = page.locator('table tbody tr, .schedule-entry, .card');
    const count = await rows.count();
    expect(count, 'Schedule page should have events').toBeGreaterThan(3);
  });

  test('institute page has course groups', async ({ page }) => {
    await page.goto(NEW_SITE + '/institut-klinicheskoy-prikladnoy-kineziologii');
    const cards = page.locator('.card');
    const count = await cards.count();
    expect(count, 'Institute page should have course group cards').toBeGreaterThan(0);
  });
});

// ─── Deep content: detail pages ────────────────────────────

test.describe('Detail page content', () => {
  test('article detail has rich HTML content', async ({ page }) => {
    await page.goto(NEW_SITE + '/statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii');
    const richContent = page.locator('.rich-content');
    await expect(richContent).toBeVisible();
    const html = await richContent.innerHTML();
    // Rich content should have structural tags, not just plain text
    const hasTags = /<(h[2-6]|ul|ol|strong|em|a )/.test(html);
    expect(hasTags, 'Article detail should have rich HTML structure').toBe(true);
  });

  test('seminar detail page loads', async ({ page }) => {
    // Pick first seminar from first institute/course group
    await page.goto(NEW_SITE + '/institut-klinicheskoy-prikladnoy-kineziologii');
    const firstLink = page.locator('.card a').first();
    if (await firstLink.count() > 0) {
      const href = await firstLink.getAttribute('href');
      if (href) {
        await page.goto(NEW_SITE + href);
        await expect(page.locator('h1').first()).toBeVisible();
      }
    }
  });
});

// ─── Comprehensive link crawl ──────────────────────────────

test.describe('No broken internal links', () => {
  test('all internal links from homepage return 200', async ({ page, request }) => {
    await page.goto(NEW_SITE + '/');
    const links = await page.locator('a[href^="/"]').evaluateAll(
      (els) => [...new Set(els.map(e => e.getAttribute('href') || '').filter(h => h.length > 1))]
    );

    const broken: string[] = [];
    // Test first 30 unique links to keep test fast
    for (const link of links.slice(0, 30)) {
      try {
        const resp = await request.get(NEW_SITE + link);
        if (resp.status() >= 400) {
          broken.push(`${link} → ${resp.status()}`);
        }
      } catch {
        broken.push(`${link} → error`);
      }
    }

    expect(broken, `Broken links: ${broken.join(', ')}`).toHaveLength(0);
  });
});
