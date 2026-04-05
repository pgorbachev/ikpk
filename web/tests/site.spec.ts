import { test, expect } from '@playwright/test';

// ─── Homepage ────────────────────────────────────────────
test.describe('Homepage', () => {
  test('loads and has correct title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Институт клинической прикладной кинезиологии/);
  });

  test('has header with navigation', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('header')).toBeVisible();
    // Navigation is now in sidebar, check sidebar exists
    await expect(page.locator('#sidebar')).toHaveCount(1);
  });

  test('has newsletter subscription form', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.newsletter-signup')).toBeVisible();
    await expect(page.locator('.newsletter-signup input[type="email"]')).toBeVisible();
  });

  test('has footer with correct phone', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('footer')).toContainText('646-54-50');
  });

  test('has Yandex.Metrika counter', async ({ page }) => {
    await page.goto('/');
    const html = await page.content();
    expect(html).toContain('39506315');
    expect(html).toContain('mc.yandex.ru/metrika');
  });

  test('has institutes section', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.institute-card').first()).toBeVisible();
  });
});

// ─── SEO & Meta ──────────────────────────────────────────
test.describe('SEO', () => {
  test('homepage has canonical URL', async ({ page }) => {
    await page.goto('/');
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute('href', /ikpk\.su/);
  });

  test('homepage has OG tags', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /.+/);
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'ru_RU');
  });

  test('homepage has JSON-LD schema', async ({ page }) => {
    await page.goto('/');
    const ld = page.locator('script[type="application/ld+json"]');
    const content = await ld.first().textContent();
    expect(content).toContain('EducationalOrganization');
  });

  test('article page has Article schema', async ({ page }) => {
    await page.goto('/statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii');
    const ld = page.locator('script[type="application/ld+json"]');
    const texts = await ld.allTextContents();
    const hasArticle = texts.some(t => t.includes('"Article"'));
    expect(hasArticle).toBe(true);
  });
});

// ─── Key Pages ───────────────────────────────────────────
test.describe('Key pages load', () => {
  const pages = [
    '/',
    '/institut-klinicheskoy-prikladnoy-kineziologii',
    '/raspisanie-i-tseny',
    '/statyi',
    '/kontakty',
    '/aktsii-i-skidki',
    '/oplata',
    '/sotrudnichestvo-s-nami',
    '/svedeniya-ob-obrazovatelnoy-organizatsii',
    '/video',
    '/sitemap',
  ];

  for (const path of pages) {
    test(`${path} returns 200 and has content`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator('h1').first()).toBeVisible();
    });
  }
});

// ─── Navigation ──────────────────────────────────────────
test.describe('Navigation', () => {
  test('institute page has course groups', async ({ page }) => {
    await page.goto('/institut-klinicheskoy-prikladnoy-kineziologii');
    const cards = page.locator('.program-card');
    expect(await cards.count()).toBeGreaterThan(0);
  });

  test('breadcrumbs present on nested pages', async ({ page }) => {
    await page.goto('/statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii');
    await expect(page.locator('nav[aria-label="breadcrumb"], .breadcrumbs')).toBeVisible();
  });

  test('footer links to correct sotrudnichestvo URL', async ({ page }) => {
    await page.goto('/');
    const link = page.locator('footer a[href="/sotrudnichestvo-s-nami"]');
    await expect(link).toBeVisible();
  });
});

// ─── Content Quality ─────────────────────────────────────
test.describe('Content quality', () => {
  test('article detail renders rich HTML (not flat text)', async ({ page }) => {
    await page.goto('/statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii');
    // Rich content should have at least some structural tags
    const richContent = page.locator('.rich-content');
    await expect(richContent).toBeVisible();
    const innerHtml = await richContent.innerHTML();
    // Should have more than just a single <p> tag
    const hasTags = /<(h[1-6]|ul|ol|strong|em|a )/.test(innerHtml);
    expect(hasTags).toBe(true);
  });

  test('kontakty page shows correct phone', async ({ page }) => {
    await page.goto('/kontakty');
    await expect(page.locator('.contact-shell-link').first()).toContainText('646-54-50');
  });

  test('schedule page has events table', async ({ page }) => {
    await page.goto('/raspisanie-i-tseny');
    const rows = page.locator('.schedule-card');
    expect(await rows.count()).toBeGreaterThan(0);
  });
});
