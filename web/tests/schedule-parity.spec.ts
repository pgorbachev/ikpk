import { expect, test } from '@playwright/test';
import { gotoAttachedPath } from './helpers/navigation';

test.describe('Schedule Listing Parity', () => {
  test('/raspisanie-i-tseny renders production-like filters, cards and pagination', async ({ page }) => {
    await gotoAttachedPath(page, '/raspisanie-i-tseny');

    await expect(page.getByRole('heading', { name: /^Расписание и цены$/i })).toBeVisible();
    await expect(page.getByText(/в расписании возможны изменения/i)).toBeVisible();

    const search = page.locator('[data-testid="schedule-search"]');
    const institute = page.locator('[data-testid="schedule-filter-institute"]');
    const program = page.locator('[data-testid="schedule-filter-program"]');
    const city = page.locator('[data-testid="schedule-filter-city"]');

    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('placeholder', 'Поиск...');
    await expect(institute).toBeVisible();
    await expect(program).toBeDisabled();
    await expect(city).toBeVisible();

    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Хлебные крошки' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Подпишитесь на наши новости/i })).toHaveCount(0);
    const cards = page.locator('[data-schedule-item]:not([hidden]) [data-testid="schedule-card"]');
    expect(await cards.count()).toBeGreaterThan(20);
    await expect(cards.first().locator('[data-testid="schedule-card-image"]')).toBeVisible();
    await expect(cards.first().getByRole('link', { name: /Подробнее/i })).toBeVisible();
    await expect(cards.first().getByRole('link', { name: /Зарегистрироваться|Записаться/i })).toBeVisible();

    const pagination = page.locator('[data-testid="schedule-pagination"]');
    await expect(pagination).toBeVisible();
    expect(await pagination.locator('button').count()).toBeLessThanOrEqual(4);
  });

  test('schedule filters enable dependent program selector and narrow visible cards', async ({ page }) => {
    await gotoAttachedPath(page, '/raspisanie-i-tseny');

    const institute = page.locator('[data-testid="schedule-filter-institute"]');
    const program = page.locator('[data-testid="schedule-filter-program"]');
    const city = page.locator('[data-testid="schedule-filter-city"]');
    const cards = page.locator('[data-schedule-item]:not([hidden])');

    const initialVisibleCards = await cards.count();
    expect(initialVisibleCards).toBeGreaterThan(8);

    await institute.selectOption({ label: 'Институт Апледжера' });
    await expect(program).toBeEnabled();
    await program.selectOption({ label: 'Краниосакральная терапия' });
    await city.selectOption({ label: 'Санкт-Петербург' });

    const filteredCardCount = await cards.count();
    expect(filteredCardCount).toBeLessThan(initialVisibleCards);

    const visibleCardData = await cards.evaluateAll((nodes) => nodes.map((node) => ({
      title: (node.querySelector('[data-testid="schedule-card-title"]')?.textContent || '').trim(),
      program: (node.querySelector('[data-testid="schedule-card-program"]')?.textContent || '').trim(),
      city: (node.querySelector('[data-testid="schedule-card-city"]')?.textContent || '').trim(),
    })));

    const visibleCardTitles = visibleCardData.map((card) => card.title);
    expect(visibleCardTitles.length).toBeGreaterThan(0);
    for (const title of visibleCardTitles) {
      expect(title.trim().length).toBeGreaterThan(10);
    }

    expect(new Set(visibleCardData.map((card) => card.program)).size).toBe(1);
    expect(new Set(visibleCardData.map((card) => card.city)).size).toBe(1);
  });

  test('schedule search filters cards by seminar title', async ({ page }) => {
    await gotoAttachedPath(page, '/raspisanie-i-tseny');

    const search = page.locator('[data-testid="schedule-search"]');
    await search.fill('миофасциальный');

    const cards = page.locator('[data-schedule-item]:not([hidden])');
    const titles = (await cards.evaluateAll((nodes) => nodes.map((node) => (
      (node.querySelector('[data-testid="schedule-card-title"]')?.textContent || '').trim()
    )))).map((value) => value.trim());
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(title.toLowerCase()).toContain('миофасциаль');
    }
  });
});
