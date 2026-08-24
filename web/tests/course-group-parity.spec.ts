import { expect, test } from '@playwright/test';
import { gotoAttachedPath } from './helpers/navigation';
import { installThirdPartyGuard } from './helpers/third-party-guard';

test.beforeEach(async ({ page }) => {
  await installThirdPartyGuard(page);
});

const TARGET_GROUPS = [
  '/programmy/kraniosakralnaya-terapiya',
  '/programmy/avtorskie-seminary-zharovoj-ls',
];

test.describe('Course Group Landing Parity', () => {
  for (const path of TARGET_GROUPS) {
    test(`${path} has structured hero and seminar hierarchy`, async ({ page }) => {
      await gotoAttachedPath(page, path);

      await expect(page.locator('[data-testid="course-group-head"]')).toBeVisible();
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('.cg-intro')).toHaveCount(0);
      await expect(page.locator('.course-group-kicker')).toHaveCount(0);
      await expect(page.locator('.course-group-hero-media')).toHaveCount(0);
      await expect(page.getByRole('link', { name: /Записаться на обучение/i })).toHaveCount(0);
      await expect(page.getByRole('link', { name: /Смотреть семинары/i })).toHaveCount(0);

      const leadText = (await page.locator('.course-group-lead').textContent())?.replace(/\s+/g, ' ').trim() || '';
      expect(leadText.length).toBeGreaterThan(40);
      expect(leadText).not.toMatch(/cst-\d|ser-\d|часть\s*№|записаться\s*cst/i);
      expect(leadText).not.toMatch(/^Пройдите обучение в ИКПК по программе/i);

      await expect(page.locator('[data-testid="course-group-seminars"]')).toBeVisible();
      await expect(page.getByRole('heading', { name: /Семинары и курсы/i })).toHaveCount(0);
      const cards = page.locator('[data-testid="course-group-seminar-card"]');
      expect(await cards.count()).toBeGreaterThan(1);

      const firstCard = cards.first();
      await expect(firstCard).toContainText('Записаться на семинар');
      await expect(firstCard).not.toContainText('Подробнее');
      const firstCardStyle = await firstCard.evaluate((node) => {
        const cs = getComputedStyle(node as HTMLElement);
        return {
          borderRadius: Number.parseFloat(cs.borderTopLeftRadius),
          boxShadow: cs.boxShadow,
        };
      });
      expect(firstCardStyle.borderRadius).toBeLessThanOrEqual(8);
      expect(firstCardStyle.boxShadow).not.toBe('none');
    });
  }

  test('course-group page renders additional informational content when available', async ({ page }) => {
    await gotoAttachedPath(page, '/programmy/kraniosakralnaya-terapiya');

    const extra = page.locator('[data-testid="course-group-extra-content"]');
    await expect(extra).toBeVisible();
    const extraText = (await extra.textContent())?.replace(/\s+/g, ' ').trim() || '';
    expect(extraText.length).toBeGreaterThan(180);

    const extraHtml = await extra.innerHTML();
    expect(extraHtml).not.toMatch(/__[A-Za-z0-9_-]+/);
  });
});
