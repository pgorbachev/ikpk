import { expect, test } from '@playwright/test';
import { gotoAttachedPath } from './helpers/navigation';

const INSTITUTES = [
  '/institut-klinicheskoy-prikladnoy-kineziologii',
  '/institut-apledzhera',
  '/institut-barralya',
];

test.describe('Institute Landing Parity', () => {
  for (const path of INSTITUTES) {
    test(`${path} has structured institute landing sections`, async ({ page }) => {
      await gotoAttachedPath(page, path);

      await expect(page.locator('[data-testid="institute-hero"]')).toBeVisible();
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('.institute-intro')).toHaveCount(0);
      await expect(page.getByRole('link', { name: /Записаться на обучение/i })).toBeVisible();
      await expect(page.locator('[data-testid="institute-hero-logo"]')).toBeVisible();
      const heroImage = page.locator('[data-testid="institute-hero-logo"] img');
      await expect(heroImage).toHaveCount(1);
      const heroSource = await heroImage.getAttribute('src');
      expect(heroSource).not.toMatch(/_next\/static/);
      await expect(page.getByRole('heading', { name: /Программы обучения/i })).toBeVisible();
      await expect(page.locator('[data-testid="institute-program-card"]').first()).toBeVisible();
      await expect(page.getByRole('heading', { name: /Преподаватели/i })).toBeVisible();
      await expect(page.locator('[data-testid="institute-teacher-card"]').first()).toBeVisible();

      const leadText = (await page.locator('.institute-lead').textContent())?.replace(/\s+/g, ' ').trim() || '';
      expect(leadText.length).toBeGreaterThan(50);
      expect(leadText).not.toMatch(/записаться|показать ещё/i);
    });
  }

  test('institutes expose additional content shell instead of stopping after cards', async ({ page }) => {
    await gotoAttachedPath(page, '/institut-klinicheskoy-prikladnoy-kineziologii');

    const extra = page.locator('[data-testid="institute-extra-content"]');
    await expect(extra).toBeVisible();

    const extraText = (await extra.textContent())?.replace(/\s+/g, ' ').trim() || '';
    expect(extraText.length).toBeGreaterThan(200);
    await expect(extra.getByRole('button', { name: /Показать еще|Показать ещё/i })).toHaveCount(0);
  });
});
