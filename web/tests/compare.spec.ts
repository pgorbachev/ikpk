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
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

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

test.setTimeout(20000);

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
    const rows = page.locator('[data-testid="schedule-card"]');
    const count = await rows.count();
    expect(count, 'Schedule page should have events').toBeGreaterThan(3);
  });

  test('institute page has course groups', async ({ page }) => {
    await page.goto(NEW_SITE + '/institut-klinicheskoy-prikladnoy-kineziologii');
    const cards = page.locator('[data-testid="institute-program-card"]');
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

// ─── Homepage mandatory sections ───────────────────────────

test.describe('Homepage mandatory sections', () => {
  test('has "Наши преимущества" section with 6 advantage cards', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const heading = page.locator('h2:has-text("Наши преимущества")');
    await expect(heading).toBeVisible();
    const cards = page.locator('.feature-card');
    expect(await cards.count(), 'Should have 6 advantage cards').toBe(6);
  });

  test('has "Наш подход к обучению" section with statistics', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const heading = page.locator('h2:has-text("Наш подход к обучению")');
    await expect(heading).toBeVisible();
    const text = await page.locator('body').textContent() ?? '';
    expect(text).toContain('14000');
    expect(text).toContain('20 лет');
    expect(text).toContain('1500');
  });

  test('has "Наши программы" section with 3 institute program cards', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const heading = page.locator('h2:has-text("Наши программы")');
    await expect(heading).toBeVisible();
    const cards = page.locator('.prog-card');
    expect(await cards.count(), 'Should have 3 program cards').toBe(3);
  });

  test('has newsletter section', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const section = page.locator('[data-newsletter-variant="band"]');
    await expect(section).toBeVisible();
  });

  test('hero contains full text about exclusive representation', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    const heroText = await page.locator('.hero').textContent() ?? '';
    expect(heroText).toContain('Эксклюзивное представительство');
    expect(heroText).toContain('международным стандартам');
  });

  test('hero has visual illustration', async ({ page }) => {
    await page.goto(NEW_SITE + '/');
    await expect(page.locator('.hero-visual')).toBeVisible();
  });
});

// ─── No legacy CSS hash classes ────────────────────────────

test.describe('No legacy CSS hash classes in rendered output', () => {
  const LEGACY_PATTERNS = [
    'typography_',
    'articles-form_',
    'collapsible_',
    'schedule-prices_',
    'teachers-form_',
  ];
  const CSS_HASH_RE = /_\w+__[A-Za-z0-9]{5}/;

  const PAGES_TO_CHECK = [
    ['/', 'homepage'],
    ['/statyi', 'articles list'],
    ['/kontakty', 'contacts'],
    ['/oplata', 'payment'],
    ['/svedeniya-ob-obrazovatelnoy-organizatsii', 'svedeniya'],
    ['/sotrudnichestvo-s-nami', 'cooperation'],
  ];

  for (const [path, label] of PAGES_TO_CHECK) {
    test(`${label} (${path}) has no legacy CSS module classes`, async ({ page }) => {
      await page.goto(NEW_SITE + path);
      const allClasses = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[class]'))
          .map(el => el.className)
          .join(' ');
      });
      for (const pat of LEGACY_PATTERNS) {
        expect(allClasses, `Should not contain legacy class prefix "${pat}"`).not.toContain(pat);
      }
      expect(
        CSS_HASH_RE.test(allClasses),
        `Should not contain CSS module hash classes on ${path}`
      ).toBe(false);
    });
  }

  test('article detail page has no legacy CSS module classes', async ({ page }) => {
    await page.goto(NEW_SITE + '/statyi');
    const firstLink = await page.locator('a[href^="/statyi/"]').first().getAttribute('href');
    expect(firstLink).toBeTruthy();
    await page.goto(NEW_SITE + firstLink!);
    const allClasses = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[class]')).map(el => el.className).join(' ')
    );
    for (const pat of LEGACY_PATTERNS) {
      expect(allClasses).not.toContain(pat);
    }
    expect(CSS_HASH_RE.test(allClasses)).toBe(false);
  });

  test('seminar detail page has no legacy CSS module classes', async ({ page }) => {
    const url = NEW_SITE + '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/osnovy-manualnogo-myshechnogo-testirovaniya';
    await page.goto(url);
    const allClasses = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[class]')).map(el => el.className).join(' ')
    );
    for (const pat of LEGACY_PATTERNS) {
      expect(allClasses).not.toContain(pat);
    }
    expect(CSS_HASH_RE.test(allClasses)).toBe(false);
  });
});

// ─── Content pages: clean structured HTML ──────────────────

test.describe('Content pages have clean structured HTML', () => {
  test('article detail has non-empty body content', async ({ page }) => {
    await page.goto(NEW_SITE + '/statyi');
    const firstLink = await page.locator('a[href^="/statyi/"]').first().getAttribute('href');
    expect(firstLink).toBeTruthy();
    await page.goto(NEW_SITE + firstLink!);
    const richContent = page.locator('.rich-content');
    const html = await richContent.innerHTML();
    expect(html.trim().length, 'Article body should not be empty').toBeGreaterThan(50);
  });

  test('article detail has no legacy articles-form_ wrappers', async ({ page }) => {
    await page.goto(NEW_SITE + '/statyi');
    const firstLink = await page.locator('a[href^="/statyi/"]').first().getAttribute('href');
    await page.goto(NEW_SITE + firstLink!);
    const legacyWrappers = page.locator('[class*="articles-form_"]');
    expect(await legacyWrappers.count(), 'No articles-form_ wrappers should remain').toBe(0);
  });

  test('seminar detail has non-empty body content', async ({ page }) => {
    const url = NEW_SITE + '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/osnovy-manualnogo-myshechnogo-testirovaniya';
    await page.goto(url);
    const body = await page.locator('main, article, .seminar-content, .content').first().textContent() ?? '';
    expect(body.trim().length, 'Seminar body should not be empty').toBeGreaterThan(50);
  });

  test('seminar detail has <details> collapsible elements', async ({ page }) => {
    const url = NEW_SITE + '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/osnovy-manualnogo-myshechnogo-testirovaniya';
    await page.goto(url);
    const details = page.locator('details');
    expect(await details.count(), 'Seminar should have collapsible <details> elements').toBeGreaterThan(0);
  });
});

// ─── Article page structure ────────────────────────────────

test.describe('Article page structure', () => {
  test('has 2-column layout with sidebar', async ({ page }) => {
    await page.goto(NEW_SITE + '/statyi');
    const firstLink = await page.locator('a[href^="/statyi/"]').first().getAttribute('href');
    await page.goto(NEW_SITE + firstLink!);
    const sidebar = page.locator('aside.article-sidebar');
    await expect(sidebar).toBeVisible();
  });

  test('has "Другие статьи" related articles in sidebar', async ({ page }) => {
    await page.goto(NEW_SITE + '/statyi');
    const firstLink = await page.locator('a[href^="/statyi/"]').first().getAttribute('href');
    await page.goto(NEW_SITE + firstLink!);
    const sidebarTitle = page.locator('aside.article-sidebar h3:has-text("Другие статьи")');
    await expect(sidebarTitle).toBeVisible();
  });

  test('related articles in sidebar contain links', async ({ page }) => {
    await page.goto(NEW_SITE + '/statyi');
    const firstLink = await page.locator('a[href^="/statyi/"]').first().getAttribute('href');
    await page.goto(NEW_SITE + firstLink!);
    const relatedLinks = page.locator('aside.article-sidebar .sidebar-articles a');
    expect(await relatedLinks.count(), 'Sidebar should have related article links').toBeGreaterThan(0);
  });
});

// ─── Seminar page structure ────────────────────────────────

test.describe('Seminar page structure', () => {
  const SEMINAR_URL = '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/osnovy-manualnogo-myshechnogo-testirovaniya';

  test('does not use rebuild sidebar layout', async ({ page }) => {
    await page.goto(NEW_SITE + SEMINAR_URL);
    const sidebar = page.locator('aside.seminar-sidebar');
    await expect(sidebar).toHaveCount(0);
    await expect(page.locator('.page-header')).toHaveCount(0);
  });

  test('has inline schedule section', async ({ page }) => {
    await page.goto(NEW_SITE + SEMINAR_URL);
    const schedule = page.locator('[data-testid="seminar-schedule"]');
    await expect(schedule).toBeVisible();
    await expect(schedule.getByRole('heading', { name: 'Расписание' })).toBeVisible();
    await expect(schedule.getByRole('link', { name: 'Показать все' })).toBeVisible();
  });

  test('keeps rich content with collapsible sections', async ({ page }) => {
    await page.goto(NEW_SITE + SEMINAR_URL);
    await expect(page.locator('.seminar-content')).toBeVisible();
    expect(await page.locator('details').count()).toBeGreaterThan(0);
  });

  test('has seminar registration links in schedule rows', async ({ page }) => {
    await page.goto(NEW_SITE + SEMINAR_URL);
    const registerLinks = page.locator('.seminar-register-link');
    expect(await registerLinks.count()).toBeGreaterThan(0);
  });
});

// ─── Static pages structure ────────────────────────────────

test.describe('Static pages structure', () => {
  test('kontakty has phone contact block', async ({ page }) => {
    await page.goto(NEW_SITE + '/kontakty');
    const text = await page.locator('body').textContent() ?? '';
    expect(text).toMatch(/\+7|8\s*\(495\)/);
  });

  test('kontakty has email contact block', async ({ page }) => {
    await page.goto(NEW_SITE + '/kontakty');
    const emailLink = page.locator('a[href*="mailto:"]');
    expect(await emailLink.count(), 'Should have email link').toBeGreaterThan(0);
  });

  test('svedeniya has collapsible <details> sections', async ({ page }) => {
    await page.goto(NEW_SITE + '/svedeniya-ob-obrazovatelnoy-organizatsii');
    const details = page.locator('details');
    const count = await details.count();
    expect(count, 'Svedeniya page should have multiple collapsible sections').toBeGreaterThan(3);
  });

  test('sotrudnichestvo has CTA section', async ({ page }) => {
    await page.goto(NEW_SITE + '/sotrudnichestvo-s-nami');
    const ctaBtn = page.locator('.cta-btn, a.btn:has-text("Связаться"), a.btn:has-text("Написать")');
    expect(await ctaBtn.count(), 'Should have a CTA button').toBeGreaterThan(0);
  });
});
