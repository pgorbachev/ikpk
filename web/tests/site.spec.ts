import { test, expect } from '@playwright/test';

// ─── Homepage ────────────────────────────────────────────
test.describe('Homepage', () => {
  test('loads and has correct title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Институт клинической прикладной кинезиологии/);
  });

  test('has top navigation', async ({ page }) => {
    await page.goto('/');
    // Промоушен варианта D: навигация сайта — верхнее меню (topnav).
    // Пункты меню видны на десктопе, на мобиле — в бургер-drawer, поэтому
    // проверяем присутствие ссылок в DOM, а не их видимость.
    await expect(page.locator('header.topnav')).toBeVisible();
    await expect(page.locator('.topnav-logo')).toBeVisible();
    expect(
      await page.locator('.topnav a[href="/raspisanie-i-tseny"]').count(),
    ).toBeGreaterThan(0);
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

// ─── Search (FR-05, Pagefind) ────────────────────────────
test.describe('Search', () => {
  test('opens from header, finds seminars, tolerates typos', async ({ page }) => {
    await page.goto('/');
    await page.locator('#header-search-toggle').click();

    // Pagefind UI грузится лениво при первом открытии
    const input = page.locator('#header-search-pagefind input');
    await expect(input).toBeVisible({ timeout: 10_000 });

    // Сообщение Pagefind включает текст запроса — ждём его, чтобы не
    // сматчить устаревшие результаты предыдущего запроса (debounce)
    const message = page.locator('.pagefind-ui__message');
    const results = page.locator('.pagefind-ui__result-link');

    await input.fill('кинезиология');
    await expect(message).toContainText('кинезиология', { timeout: 10_000 });
    await expect(results.first()).toBeVisible();
    expect(await results.count()).toBeGreaterThan(0);

    // допуск опечатки в 1 символ (DoD плана 004, Этап 4)
    await input.fill('масаж');
    await expect(message).toContainText('масаж', { timeout: 10_000 });
    await expect(message).not.toContainText('Ничего не найдено');
    await expect(results.first()).toBeVisible();

    // Escape закрывает панель
    await page.keyboard.press('Escape');
    await expect(page.locator('#header-search')).toBeHidden();
  });
});

// ─── Video facade (FR-04, RUTUBE embed) ──────────────────
test.describe('Video', () => {
  test('playlist facade loads RUTUBE embed on click, accessibly', async ({ page }) => {
    await page.goto('/video/33/');

    // до клика — 0 iframe (ленивая загрузка, не бьёт по perf)
    await expect(page.locator('.video-facade iframe')).toHaveCount(0);

    await page.locator('.video-facade-btn').click();

    const iframe = page.locator('.video-facade iframe');
    await expect(iframe).toHaveCount(1);
    await expect(iframe).toHaveAttribute('src', /rutube\.ru\/play\/embed\//);
    // a11y: у плеера есть title и он получил фокус (кнопка уничтожена)
    await expect(iframe).toHaveAttribute('title', /Видео:/);
    await expect(iframe).toBeFocused();

    // ссылки на полный плейлист и VK-канал присутствуют
    await expect(page.getByRole('link', { name: /Весь плейлист на RUTUBE/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Канал на VK Видео/ })).toBeVisible();
  });
});

// ─── Contacts lazy map (FR-08) ───────────────────────────
test.describe('Contacts map', () => {
  test('Yandex map is injected by JS (not eager) with the right src', async ({ page }) => {
    await page.goto('/kontakty/');
    await page.locator('.contact-shell-map').scrollIntoViewIfNeeded();
    // карта подставляется скриптом (IntersectionObserver), а не статикой
    const iframe = page.locator('.contact-shell-map iframe');
    await expect(iframe).toHaveCount(1);
    await expect(iframe).toHaveAttribute('src', /yandex\.ru\/map-widget/);
  });
});
