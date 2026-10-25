import { expect, test } from '@playwright/test';
import { installThirdPartyGuard } from './helpers/third-party-guard';

test('desktop schedule pagination reveals the new results and moves keyboard focus', async ({ page }) => {
  await installThirdPartyGuard(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const response = await page.goto('/raspisanie-i-tseny');
  expect(response?.status()).toBe(200);

  const scrollport = page.locator('[data-page-scrollport]');
  const hasScrollport = (await scrollport.count()) === 1;
  const cards = page.locator('[data-schedule-item]:not([hidden])');
  const pagination = page.locator('[data-schedule-pagination]');
  if (hasScrollport) await expect(scrollport).toBeVisible();
  await expect(cards).toHaveCount(25);

  const pageTwo = pagination.getByRole('button', { name: 'Страница 2', exact: true });
  await expect(pageTwo).toBeVisible();
  const firstPageFirstResult = await cards.first().textContent();
  if (hasScrollport) {
    await scrollport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => scrollport.evaluate((element) =>
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
  } else {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() =>
      window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1)).toBe(true);
  }

  await pageTwo.focus();
  await page.keyboard.press('Enter');

  await expect(cards).not.toHaveCount(0);
  expect(await cards.first().textContent()).not.toBe(firstPageFirstResult);
  const firstResult = cards.first();
  await expect.poll(async () => firstResult.evaluate((element) => {
    const port = element.closest('[data-page-scrollport]');
    const cardRect = element.getBoundingClientRect();
    if (port instanceof HTMLElement) {
      const portRect = port.getBoundingClientRect();
      const topInset = Number.parseFloat(getComputedStyle(port).scrollPaddingTop) || 0;
      return cardRect.top >= portRect.top + topInset - 1 && cardRect.top < portRect.bottom;
    }
    const headerBottom = document.querySelector('.topnav')?.getBoundingClientRect().bottom ?? 0;
    return cardRect.top >= headerBottom && cardRect.top < window.innerHeight;
  })).toBe(true);

  await expect(firstResult).toBeFocused();
});
