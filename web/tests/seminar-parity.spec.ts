import { expect, test } from '@playwright/test';
import { gotoAttachedPath } from './helpers/navigation';

const pages = [
  '/institut-apledzhera/kraniosakralnaya-terapiya/kraniosakralnaya-terapiya-1',
  '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/osnovy-manualnogo-myshechnogo-testirovaniya',
];

for (const path of pages) {
  test.describe(`Seminar parity ${path}`, () => {
    test('uses production-like content flow', async ({ page }) => {
      await gotoAttachedPath(page, path);

      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('aside.seminar-sidebar')).toHaveCount(0);
      await expect(page.locator('.page-header')).toHaveCount(0);
      await expect(page.locator('.seminar-content')).toBeVisible();
      expect(await page.locator('details').count()).toBeGreaterThan(0);
    });

    test('shows inline schedule section with registration links', async ({ page }) => {
      await gotoAttachedPath(page, path);

      const schedule = page.locator('[data-testid="seminar-schedule"]');
      await expect(schedule).toBeVisible();
      await expect(schedule.getByRole('heading', { name: 'Расписание' })).toBeVisible();
      await expect(schedule.getByRole('link', { name: 'Показать все' })).toBeVisible();
      expect(await schedule.locator('.seminar-register-link').count()).toBeGreaterThan(0);
    });
  });
}
