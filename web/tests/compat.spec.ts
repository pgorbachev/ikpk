import { test, expect } from '@playwright/test';

const PAGES: Array<{ path: string; check: string }> = [
  { path: '/', check: 'Институт клинической прикладной кинезиологии' },
  { path: '/raspisanie-i-tseny', check: 'Расписание' },
  { path: '/statyi', check: 'Статьи' },
  { path: '/kontakty', check: 'Контакты' },
];

test.describe('Compatibility smoke', () => {
  for (const pageDef of PAGES) {
    test(`${pageDef.path} loads with core content`, async ({ page }) => {
      const jsErrors: string[] = [];
      page.on('pageerror', (error) => jsErrors.push(error.message));

      const response = await page.goto(pageDef.path, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), `${pageDef.path} should return HTTP 200`).toBe(200);

      const body = page.locator('body');
      await expect(body).toContainText(pageDef.check);
      await expect(page.locator('h1').first()).toBeVisible();
      expect(jsErrors, `${pageDef.path} should not raise runtime JS errors`).toHaveLength(0);
    });
  }

  test('homepage keeps SEO and analytics base markers', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /ikpk\.su/);

    const html = await page.content();
    expect(html).toContain('39506315');
    expect(html).toContain('mc.yandex.ru/metrika');
  });

  test('content pages render <details> blocks', async ({ page }) => {
    await page.goto('/svedeniya-ob-obrazovatelnoy-organizatsii');
    const details = page.locator('details');
    expect(await details.count()).toBeGreaterThan(0);
  });
});
