import { test, expect } from '@playwright/test';
import { gotoAttachedPath } from './helpers/navigation';

function normalizeTextList(values: string[]): string[] {
  return values.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

test.describe('Parity Audit Acceptance', () => {
  test('homepage header keeps required controls', async ({ page }) => {
    await gotoAttachedPath(page, '/');

    const header = page.locator('header').first();
    await expect(header).toBeVisible();
    await expect(header.locator('a[href^="tel:"]')).toBeVisible();
    await expect(header.getByRole('button', { name: /Открыть поиск/i })).toBeVisible();
    await expect(header.getByRole('button', { name: /слабовидящ/i })).toBeVisible();
    await expect(header.locator('[role="switch"][aria-label*="тем"]')).toBeVisible();

    const headerControlMetrics = await header.locator('.header-controls').evaluate((node) => {
      const search = node.querySelector('[data-header-tool="search"]') as HTMLElement | null;
      const vision = node.querySelector('[data-header-tool="vision"]') as HTMLElement | null;
      const theme = node.querySelector('[data-header-tool="theme"]') as HTMLElement | null;
      const themeThumb = node.querySelector('[data-theme-thumb]') as HTMLElement | null;

      if (!search || !vision || !theme) {
        return null;
      }

      const searchRect = search.getBoundingClientRect();
      const visionRect = vision.getBoundingClientRect();
      const themeRect = theme.getBoundingClientRect();
      const searchRadius = Number.parseFloat(getComputedStyle(search).borderTopLeftRadius);
      const themeRadius = Number.parseFloat(getComputedStyle(theme).borderTopLeftRadius);

      return {
        searchWidth: searchRect.width,
        visionWidth: visionRect.width,
        themeWidth: themeRect.width,
        searchRadius,
        themeRadius,
        hasThemeThumb: Boolean(themeThumb),
      };
    });

    expect(headerControlMetrics).not.toBeNull();
    expect(headerControlMetrics?.hasThemeThumb).toBeTruthy();
    expect(headerControlMetrics!.themeWidth).toBeGreaterThan(headerControlMetrics!.searchWidth + 12);
    expect(headerControlMetrics!.themeRadius).toBeGreaterThan(headerControlMetrics!.searchRadius + 8);
    expect(headerControlMetrics!.visionWidth).toBeGreaterThanOrEqual(headerControlMetrics!.searchWidth);
  });

  test('homepage search control opens and focuses a real input', async ({ page }) => {
    await gotoAttachedPath(page, '/');

    const header = page.locator('header').first();
    const searchButton = header.getByRole('button', { name: /Открыть поиск/i });
    await expect(searchButton).toBeVisible();
    await searchButton.click();

    // Pagefind UI создаёт input лениво при первом открытии панели
    const searchInput = page.locator('#header-search-pagefind input');
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await expect(searchInput).toBeFocused();
    await searchInput.fill('апледжер');
    await expect(searchInput).toHaveValue('апледжер');
  });

  test('homepage theme toggle changes root theme state', async ({ page }) => {
    await gotoAttachedPath(page, '/');

    const root = page.locator('html');
    const toggle = page.locator('#theme-toggle');
    await expect(toggle).toBeVisible();

    const initialTheme = (await root.getAttribute('data-theme')) ?? 'light';
    await toggle.click();
    const nextTheme = (await root.getAttribute('data-theme')) ?? '';
    expect(nextTheme).not.toBe(initialTheme);

    await toggle.click();
    const revertedTheme = (await root.getAttribute('data-theme')) ?? '';
    expect(revertedTheme).toBe(initialTheme);
  });

  test('favicon uses organization emblem asset', async ({ page }) => {
    await gotoAttachedPath(page, '/');

    const faviconHref = await page.locator('head link[rel="icon"]').first().getAttribute('href');
    expect(faviconHref).toBe('/favicon.svg');

    const faviconResponse = await page.request.get('/favicon.svg');
    expect(faviconResponse.ok()).toBeTruthy();
    const faviconBody = await faviconResponse.text();
    expect(faviconBody).toContain('fill="#02AEC4"');
    expect(faviconBody).toContain('viewBox="0 0 33 34"');
    expect(faviconBody).not.toContain('prefers-color-scheme');
  });

  test('homepage news section has behavior controls, not static-only grid', async ({ page }) => {
    await gotoAttachedPath(page, '/');

    const newsHeading = page.getByRole('heading', { name: /^Новости$/i }).first();
    await expect(newsHeading).toBeVisible();

    const newsSection = newsHeading.locator('xpath=ancestor::section[1]');
    const newsCards = newsSection.locator('.news-card');
    const sliderControls = newsSection.locator('[aria-label*="slide" i], [aria-label*="слайд" i]');

    expect(await newsCards.count()).toBeGreaterThanOrEqual(4);
    expect(await sliderControls.count()).toBeGreaterThanOrEqual(2);

    const track = newsSection.locator('[data-news-track]');
    await expect(newsSection.locator('.news-card.is-visible')).toHaveCount(4);
    await expect(track).toHaveAttribute('data-visible-count', '4');

    const initialLayout = await newsSection.evaluate((section) => {
      const viewport = section.querySelector('[data-news-viewport]')?.getBoundingClientRect();
      const cards = Array.from(section.querySelectorAll('.news-card.is-visible')).map((card) => {
        const rect = (card as HTMLElement).getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      });
      return {
        viewport: viewport ? { left: viewport.left, right: viewport.right, width: viewport.width } : null,
        cards,
      };
    });

    expect(initialLayout.viewport).not.toBeNull();
    expect(initialLayout.cards).toHaveLength(4);
    for (const card of initialLayout.cards) {
      expect(card.width).toBeGreaterThan(110);
      expect(card.left).toBeGreaterThanOrEqual((initialLayout.viewport?.left ?? 0) - 1);
      expect(card.right).toBeLessThanOrEqual((initialLayout.viewport?.right ?? Number.POSITIVE_INFINITY) + 1);
    }

    const initialStartIndex = await track.getAttribute('data-start-index');
    await newsSection.getByRole('button', { name: /Следующий слайд/i }).click();
    await expect(newsSection.locator('.news-card.is-visible')).toHaveCount(4);
    await expect(track).toHaveAttribute('data-visible-count', '4');
    const afterOneStepIndex = await track.getAttribute('data-start-index');
    expect(afterOneStepIndex).not.toBe(initialStartIndex);

    const totalCards = await newsCards.count();
    for (let i = 0; i < totalCards - 1; i += 1) {
      await newsSection.getByRole('button', { name: /Следующий слайд/i }).click();
    }
    const afterFullLoopIndex = await track.getAttribute('data-start-index');
    expect(afterFullLoopIndex).toBe(initialStartIndex);
  });

  test('homepage keeps section order after news in parity mode', async ({ page }) => {
    await gotoAttachedPath(page, '/');

    const headings = normalizeTextList(
      await page.locator('h2, h3, h4').allTextContents(),
    );
    const newsIndex = headings.findIndex((heading) => heading === 'Новости');
    const newsletterIndex = headings.findIndex((heading) => /Подпишитесь на наши новости/i.test(heading));

    expect(newsIndex, 'Expected heading "Новости"').toBeGreaterThan(-1);
    expect(newsletterIndex, 'Expected heading "Подпишитесь на наши новости"').toBeGreaterThan(newsIndex);
    expect(headings).not.toContain('Наши институты');
    expect(headings).not.toContain('Акции и скидки');
  });

  test('homepage institute emblem cards do not use destructive cover-fit', async ({ page }) => {
    await gotoAttachedPath(page, '/');

    const programLogos = page.locator('.program-logo-media img');
    const programLogoCount = await programLogos.count();
    if (programLogoCount > 0) {
      for (let i = 0; i < programLogoCount; i += 1) {
        const fit = await programLogos.nth(i).evaluate((node) => getComputedStyle(node).objectFit);
        expect(fit).toBe('contain');
      }
      return;
    }

    const instituteHeading = page.getByRole('heading', { name: /^Наши институты$/i }).first();
    if (await instituteHeading.count() === 0) {
      return;
    }

    const cards = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h2, h3, h4'));
      const heading = headings.find((item) => item.textContent?.trim() === 'Наши институты');
      const section = heading?.closest('section');
      if (!section) return [] as Array<{ objectFit: string; title: string }>;

      return Array.from(section.querySelectorAll('a, .media-card, .card'))
        .filter((card) => card.querySelector('img'))
        .map((card) => {
          const image = card.querySelector('img');
          const title = card.querySelector('h2, h3, h4')?.textContent?.trim() ?? '';
          const objectFit = image ? getComputedStyle(image).objectFit : '';
          return { objectFit, title };
        });
    });

    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.objectFit, `Institute emblem must use contain-fit (${card.title || 'unknown card'})`).toBe('contain');
    }
  });

  test('/statyi keeps pagination behavior or explicit accepted alternative', async ({ page }) => {
    await gotoAttachedPath(page, '/statyi');
    await expect(page.getByRole('heading', { name: /^Статьи$/i })).toBeVisible();
    await expect(page.locator('.articles-intro, .articles-lead, .articles-meta')).toHaveCount(0);
    await expect(page.locator('[data-articles-search]')).toBeVisible();
    await expect(page.locator('[data-articles-sort]')).toBeVisible();
    await expect(page.locator('[data-newsletter-variant="card"]')).toBeVisible();

    const acceptedAlternative = page.locator('[data-parity-statyi-mode="accepted-no-pagination"]');
    if (await acceptedAlternative.count()) {
      const altCards = page.locator('a[href^="/statyi/"]:has(h2), a[href^="/statyi/"]:has(h3)');
      expect(await altCards.count()).toBeLessThanOrEqual(6);
      return;
    }

    const pagination = page.locator('[data-testid="articles-pagination"], nav[aria-label="Пагинация статей"], .pagination');
    await expect(pagination).toBeVisible();
    await expect(pagination.locator('[data-page-prev]')).toBeVisible();
    await expect(pagination.locator('[data-page-next]')).toBeVisible();

    const pageButtons = pagination.locator('[data-page-button]');
    expect(await pageButtons.count()).toBeGreaterThan(1);

    const totalPagesAttr = await pagination.getAttribute('data-total-pages');
    const totalPages = totalPagesAttr ? Number.parseInt(totalPagesAttr, 10) : Number.NaN;
    if (Number.isFinite(totalPages) && totalPages > 7) {
      expect(await pageButtons.count()).toBeLessThan(totalPages);
      expect(await pagination.locator('[data-page-ellipsis]').count()).toBeGreaterThan(0);
    }

    const articleCards = page.locator('a[href^="/statyi/"]:has(h2), a[href^="/statyi/"]:has(h3)');
    expect(await articleCards.count()).toBeLessThanOrEqual(6);

    const firstCard = page.locator('[data-articles-grid] .article-card').first();
    await expect(firstCard).toBeVisible();
    const firstCardStyle = await firstCard.evaluate((node) => {
      const cs = getComputedStyle(node as HTMLElement);
      return {
        borderRadius: Number.parseFloat(cs.borderTopLeftRadius),
        boxShadow: cs.boxShadow,
      };
    });
    expect(firstCardStyle.borderRadius).toBeGreaterThanOrEqual(18);
    expect(firstCardStyle.boxShadow).not.toBe('none');
  });

  test('/kontakty uses dominant contact shell with real map surface', async ({ page }) => {
    await gotoAttachedPath(page, '/kontakty');
    await expect(page.getByRole('heading', { name: /^Контакты$/i })).toBeVisible();

    const shell = page.locator('.contact-shell');
    await expect(shell).toBeVisible();
    await expect(shell.locator('.contact-shell-info')).toBeVisible();

    const mapIframe = shell.locator('.contact-shell-map iframe');
    await expect(mapIframe).toBeVisible();

    const mapSrc = await mapIframe.getAttribute('src');
    expect(mapSrc ?? '').toContain('yandex');

    expect(await shell.locator('.contact-shell-title').count()).toBe(0);
    expect(await shell.locator('.contact-shell-lead').count()).toBe(0);
    const shellColumns = await shell.evaluate((node) => {
      const info = node.querySelector('.contact-shell-info') as HTMLElement | null;
      const map = node.querySelector('.contact-shell-map') as HTMLElement | null;
      if (!info || !map) return null;
      const infoRect = info.getBoundingClientRect();
      const mapRect = map.getBoundingClientRect();
      return { infoWidth: infoRect.width, mapWidth: mapRect.width };
    });
    expect(shellColumns).not.toBeNull();
    expect(shellColumns!.mapWidth).toBeGreaterThan(shellColumns!.infoWidth);

    const legacyContactBlocks = page.locator('.contact-block');
    expect(await legacyContactBlocks.count()).toBe(0);
  });

  test('typography and tone smoke', async ({ page }) => {
    await gotoAttachedPath(page, '/');
    const homeChrome = await page.evaluate(() => {
      const header = document.querySelector('header');
      const sidebar = document.getElementById('sidebar');
      return {
        headerBg: header ? getComputedStyle(header).backgroundColor : '',
        sidebarBg: sidebar ? getComputedStyle(sidebar).backgroundColor : '',
      };
    });

    expect(homeChrome.headerBg).toBe('rgb(250, 250, 250)');
    expect(homeChrome.sidebarBg).toBe('rgb(250, 250, 250)');
    const homepageCtaTone = await page.locator('.adv-cta-shell').evaluate((node) => {
      const cs = getComputedStyle(node);
      return {
        backgroundImage: cs.backgroundImage,
        radius: Number.parseFloat(cs.borderTopLeftRadius),
      };
    });
    expect(homepageCtaTone.backgroundImage).toContain('linear-gradient');
    expect(homepageCtaTone.radius).toBeGreaterThanOrEqual(18);

    await gotoAttachedPath(page, '/kontakty');
    const contactsH1 = await page.locator('h1').first().evaluate((node) => {
      const cs = getComputedStyle(node);
      return {
        fontSize: Number.parseFloat(cs.fontSize),
        fontWeight: Number.parseInt(cs.fontWeight, 10),
      };
    });

    expect(contactsH1.fontSize).toBeGreaterThanOrEqual(46);
    expect(contactsH1.fontSize).toBeLessThanOrEqual(50);
    expect(contactsH1.fontWeight).toBeLessThanOrEqual(550);
    await expect(page.locator('[data-newsletter-variant="card"]')).toBeVisible();

    await gotoAttachedPath(page, '/statyi');
    const articlesH1 = await page.locator('h1').first().evaluate((node) => {
      const cs = getComputedStyle(node);
      return {
        fontSize: Number.parseFloat(cs.fontSize),
        fontWeight: Number.parseInt(cs.fontWeight, 10),
      };
    });

    expect(articlesH1.fontSize).toBeGreaterThanOrEqual(46);
    expect(articlesH1.fontSize).toBeLessThanOrEqual(50);
    expect(articlesH1.fontWeight).toBeLessThanOrEqual(550);

    const footerHeadings = await page.locator('.footer-heading').evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).textTransform),
    );
    for (const value of footerHeadings) {
      expect(value).not.toBe('uppercase');
    }
  });
});
