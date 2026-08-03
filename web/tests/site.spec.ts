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

  // Подписка — ссылка на форму Bitrix24, как на старом сайте, а не форма на
  // странице: наша прежняя форма-заглушка собирала имя, телефон и почту и
  // никуда их не отправляла.
  test('newsletter block links to a working subscription form', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.newsletter-signup')).toBeVisible();

    const cta = page.locator('.newsletter-signup a.newsletter-signup-button');
    await expect(cta).toBeVisible();

    const href = await cta.getAttribute('href');
    // в demo-режиме ссылка ведёт на заглушку — в прод-CRM заказчика с демо-стенда
    // подписки уходить не должны
    expect(href).toMatch(/bitrix24site\.ru|\/demo-zayavka/);

    await expect(page.locator('.newsletter-signup form')).toHaveCount(0);
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
    await page.goto('/video/33');

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
    await page.goto('/kontakty');
    await page.locator('.contact-shell-map').scrollIntoViewIfNeeded();
    // карта подставляется скриптом (IntersectionObserver), а не статикой
    const iframe = page.locator('.contact-shell-map iframe');
    await expect(iframe).toHaveCount(1);
    await expect(iframe).toHaveAttribute('src', /yandex\.ru\/map-widget/);
  });
});

// ─── Верхнее меню: подсказка о подменю ───────────────────────────────────────
// Регресс-тест к багу: шеврон (▾) был в разметке, но SVG без intrinsic-ширины
// внутри flex-контейнера сжимался до width:0 — пользователь не видел, у каких
// пунктов есть подменю, и поведение выглядело случайным. Ловится только реальным
// браузером: build-гейты layout не считают.
test.describe('Top navigation affordance', () => {
  test('items with a dropdown show a visible chevron', async ({ page }) => {
    await page.goto('/');

    const menu = page.locator('.topnav-menu');
    // на мобильной раскладке меню скрыто (там drawer) — проверять нечего
    if (!(await menu.isVisible())) test.skip();

    const withDropdown = page.locator('.topnav-menu > ul > li.has-dropdown');
    const count = await withDropdown.count();
    expect(count, 'в меню должны быть пункты с подменю').toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const item = withDropdown.nth(i);
      const label = (await item.locator('> a').innerText()).trim();
      const chev = item.locator('.chev');
      await expect(chev, `у «${label}» нет шеврона в разметке`).toHaveCount(1);
      const box = await chev.boundingBox();
      expect(box, `шеврон «${label}» не отрисован`).not.toBeNull();
      expect(box!.width, `шеврон «${label}» имеет нулевую ширину`).toBeGreaterThan(4);
      expect(box!.height, `шеврон «${label}» имеет нулевую высоту`).toBeGreaterThan(4);
    }
  });

  test('hovering an item with a dropdown reveals its links', async ({ page }) => {
    await page.goto('/');
    const menu = page.locator('.topnav-menu');
    if (!(await menu.isVisible())) test.skip();

    const item = page.locator('.topnav-menu > ul > li.has-dropdown').first();
    const dropdown = item.locator('.dropdown');
    await expect(dropdown).not.toBeVisible();
    await item.hover();
    await expect(dropdown).toBeVisible();
    expect(await dropdown.locator('a').count()).toBeGreaterThan(1);
  });
});

// Кнопка, которую нельзя прочитать, хуже отсутствия кнопки. Здесь это выходило
// из конфликта специфичности: `.rich-content a` (0,1,1) перебивает `.btn-primary`
// (0,1,0), поэтому CTA внутри легаси-контента получал синий текст на зелёном
// фоне — контраст ~1.08:1. Build-гейты такое не видят: разметка корректна,
// классы на месте, дефект возникает только в вычисленных стилях.
test.describe('Contrast of CTA inside rich content', () => {
  const parse = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  test('CTA text is readable on its own background', async ({ page }) => {
    await page.goto('/oplata');

    const cta = page.locator('.rich-content a.btn').first();
    await expect(cta).toBeVisible();

    const { color, background } = await cta.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });

    const [l1, l2] = [lum(parse(color)), lum(parse(background))].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    expect(ratio, `контраст текста CTA ${color} на фоне ${background} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

// В тёмной теме фон страницы и фон карточки брались из одного токена
// (--color-light-100), поэтому поверхности не различались: карточка держалась
// только на рамке. Это видно глазом, но не ловится ни разметочными гейтами,
// ни axe (контраст текста при этом в норме).
test.describe('Dark theme surfaces', () => {
  test('card surface differs from page surface', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    const { pageBg, cardBg } = await page.evaluate(() => {
      const card = document.querySelector('.card, .institute-card, .segment-card')!;
      return {
        pageBg: getComputedStyle(document.body).backgroundColor,
        cardBg: getComputedStyle(card).backgroundColor,
      };
    });

    expect(cardBg, `фон карточки ${cardBg} совпадает с фоном страницы ${pageBg}`).not.toBe(pageBg);
  });
});
