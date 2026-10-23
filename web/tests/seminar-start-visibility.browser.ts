import { test, expect, type Page } from '@playwright/test';
import { AFTER, BEFORE, TITLES } from './helpers/seminar-start-fixture';
import { installThirdPartyGuard } from './helpers/third-party-guard';

// Real built pages and client scripts, controlled content and clock.
// This revision has no dated payment offers: payment-seminar-picker owns that coverage.
let fixture: { url: string; programPath: string; detailPaths: string[] };
test.beforeAll(() => {
  if (!process.env.IKPK_START_FIXTURE) throw new Error('Controlled fixture was not built');
  fixture = JSON.parse(process.env.IKPK_START_FIXTURE);
});
test.beforeEach(async ({ page }) => { await installThirdPartyGuard(page); });

async function open(page: Page, path: string, now: string) {
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now));
  expect((await page.goto(`${fixture.url}${path}`))?.status(), 'real fixture route must exist').toBe(200);
}
const month = (page: Page) => page.locator('[data-schedule-filter="month"]');
const shownCards = (page: Page) => page.locator('[data-schedule-item]:visible');
const seminarCard = (page: Page, title: string) => page.locator('[data-testid="course-group-seminar-card"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
async function expectNextHome(page: Page) {
  await expect(page.locator('.hero-d-next')).toContainText(TITLES[2]);
  await expect(page.locator('.upcoming-card:visible')).toHaveCount(3);
  // Outside the original top three: expired slots must refill.
  await expect(page.locator('.upcoming-card:visible').filter({ hasText: TITLES[3] })).toBeVisible();
  await expect(page.locator('.upcoming-card:visible').filter({ hasText: TITLES[1] })).toHaveCount(0);
}

test('control: dated sessions and last month are offered before Moscow midnight', async ({ page }) => {
  await open(page, '/', BEFORE);
  await expect(page.locator('.hero-d-next')).toContainText(TITLES[0]);
  await page.goto(`${fixture.url}/raspisanie-i-tseny`);
  await expect(month(page)).toBeEnabled();
  await month(page).selectOption('2026-10');
  await expect(shownCards(page)).toHaveCount(2);
});
test('unknown seminar price fits a 320px schedule card', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await open(page, '/raspisanie-i-tseny', BEFORE);
  const price = shownCards(page).first().locator('.schedule-card-price');
  await expect(price).toBeVisible();
  await price.evaluate((element) => { element.textContent = 'Стоимость уточняется'; });
  await expect(price).toHaveText('Стоимость уточняется');
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'unknown price must not widen the mobile page').toBeLessThanOrEqual(1);
});
test('home loaded after start advances hero and refills beyond original three', async ({ page }) => {
  await open(page, '/', AFTER); await expectNextHome(page);
});
test('open home removes offers at exact equality without reload', async ({ page }) => {
  await open(page, '/', BEFORE);
  await expect(page.locator('.hero-d-next')).toContainText(TITLES[0]);
  await page.clock.runFor(1_000); await expectNextHome(page);
});
test('focus and visibility resume reconcile home after a missed timer', async ({ page }) => {
  await open(page, '/', BEFORE);
  await expect(page.locator('.hero-d-next')).toContainText(TITLES[0]);
  // Move wall clock without firing the pending start timer.
  await page.clock.setSystemTime(new Date(AFTER));
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  await expectNextHome(page);
});
test('home hides the upcoming jump after the last session starts', async ({ page }) => {
  await open(page, '/', BEFORE);
  await expect(page.locator('[data-start-upcoming-action]')).toBeVisible();
  await page.clock.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('[data-start-upcoming-action]')).toBeHidden();
  await expect(page.locator('#upcoming')).toBeHidden();
});
test('schedule loaded after start removes expired offers and their final month', async ({ page }) => {
  await open(page, '/raspisanie-i-tseny', AFTER);
  await expect(month(page)).toBeEnabled();
  await expect(month(page).locator('option[value="2026-10"]')).toHaveCount(0);
  await expect(shownCards(page)).toHaveCount(25);
  await expect(shownCards(page).filter({ hasText: 'Сеанс 61001' })).toHaveCount(0);
  await expect(shownCards(page).filter({ hasText: 'Сеанс 61004' })).toBeVisible();
});
test('open schedule updates month, counts and pagination at the boundary', async ({ page }) => {
  await open(page, '/raspisanie-i-tseny', BEFORE);
  await expect(month(page)).toBeEnabled();
  await expect(shownCards(page)).toHaveCount(25);
  const secondPage = page.locator('[data-schedule-pagination]').getByRole('button', { name: 'Страница 2', exact: true });
  await expect(secondPage).toBeVisible(); await secondPage.click();
  await expect(shownCards(page)).toHaveCount(2);
  await page.clock.runFor(1_000);
  await expect(month(page).locator('option[value="2026-10"]')).toHaveCount(0);
  await expect(secondPage).toHaveCount(0);
  await expect(shownCards(page)).toHaveCount(25);
});
test('program retains course description but drops final started date and advances repeat session', async ({ page }) => {
  await open(page, fixture.programPath, AFTER);
  const finished = seminarCard(page, TITLES[1]);
  await expect(finished).toBeVisible();
  await expect(finished.locator('[data-testid="seminar-nearest-date"]:visible')).toHaveCount(0);
  await expect(finished.locator(`a[href="${fixture.detailPaths[1]}"]`).first()).toBeVisible();
  await expect(finished.locator('.course-group-seminar-cta')).toHaveAttribute('aria-label', `Подробнее о семинаре ${TITLES[1]}`);
  await expect(seminarCard(page, TITLES[0]).locator('[data-testid="seminar-nearest-date"]')).toContainText('4 ноя');
  await expect(seminarCard(page, TITLES[0]).locator('.course-group-seminar-cta')).toHaveAttribute('aria-label', `Записаться на семинар ${TITLES[0]}`);
});
test('seminar route retains description and only offers the future session', async ({ page }) => {
  await open(page, fixture.detailPaths[0], AFTER);
  await expect(page.getByRole('heading', { name: TITLES[0], exact: true })).toBeVisible();
  await expect(page.locator('.seminar-content')).toContainText('Описание сохраняется');
  await expect(page.locator('[data-seminar-schedule-card]:visible')).toHaveCount(1);
  await expect(page.locator('[data-seminar-schedule-card]:visible')).toContainText('Сеанс 61004');
  await expect(page.locator('a[href="/registration-fixture-61001"]:visible')).toHaveCount(0);
});
test('historical seminar remains reachable when its last registration expires', async ({ page }) => {
  await open(page, fixture.detailPaths[1], BEFORE);
  await expect(page.locator('[data-seminar-schedule-card]:visible')).toHaveCount(1);
  await page.clock.runFor(1_000);
  await expect(page.getByRole('heading', { name: TITLES[1], exact: true })).toBeVisible();
  await expect(page.locator('.seminar-content')).toContainText('Описание сохраняется');
  await expect(page.locator('.seminar-register-link:visible')).toHaveCount(0);
});

test('selected expired month resets while search still filters available offers', async ({ page }) => {
  await open(page, '/raspisanie-i-tseny', BEFORE);
  await expect(month(page)).toBeEnabled();
  await month(page).selectOption('2026-10');
  await expect(shownCards(page)).toHaveCount(2);
  await page.clock.runFor(1_000);
  await expect(month(page)).toHaveValue('');
  await expect(month(page).locator('option[value="2026-11"]')).toHaveText('Ноябрь 2026 (25)');
  await page.locator('[data-schedule-search]').fill('Сеанс 61004');
  await expect(shownCards(page)).toHaveCount(1);
  await expect(shownCards(page)).toContainText('Сеанс 61004');
  await expect(page.locator('[data-schedule-pagination]')).toBeHidden();
  await page.locator('[data-schedule-search]').fill('');
  await expect(shownCards(page)).toHaveCount(25);
});

test('all offers expire without removing course descriptions or detail routes', async ({ page }) => {
  await open(page, '/', '2026-12-01T00:00:00Z');
  await expect(page.locator('.hero-d-next:visible')).toHaveCount(0);
  await expect(page.locator('.upcoming-card:visible')).toHaveCount(0);
  await page.goto(`${fixture.url}/raspisanie-i-tseny`);
  await expect(month(page)).toBeDisabled();
  await expect(month(page).locator('option')).toHaveCount(1);
  await expect(shownCards(page)).toHaveCount(0);
  await expect(page.locator('[data-schedule-empty]')).toBeVisible();
  await page.goto(`${fixture.url}${fixture.detailPaths[0]}`);
  await expect(page.locator('.seminar-content')).toContainText('Описание сохраняется');
  await expect(page.locator('[data-testid="seminar-schedule-empty"]')).toBeVisible();
  await expect(page.locator('.seminar-register-link:visible')).toHaveCount(0);
});

test('open program advances the nearest date on resume', async ({ page }) => {
  await open(page, fixture.programPath, BEFORE);
  await expect(seminarCard(page, TITLES[1]).locator('[data-testid="seminar-nearest-date"]')).toBeVisible();
  await page.clock.setSystemTime(new Date(AFTER));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(seminarCard(page, TITLES[1]).locator('[data-testid="seminar-nearest-date"]')).toBeHidden();
  await expect(seminarCard(page, TITLES[0]).locator('[data-testid="seminar-nearest-date"]')).toContainText('4 ноя');
});
