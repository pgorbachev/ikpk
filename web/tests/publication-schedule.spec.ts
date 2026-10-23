import { test, expect, candidate } from './helpers/publication-candidate';
import { calendarDay, isBeforeStart, type ScheduleWindowEntry } from '../src/lib/schedule-window';
import { monthKeys, monthOptions } from '../src/lib/schedule-months';

type Entry = ScheduleWindowEntry & { status: string; seminar: { slug: string }; city?: { name: string }; name?: string };
const slug = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-+|-+$/g, '');
const cityName = (entry: Entry) => typeof entry.city === 'string' ? entry.city : entry.city?.name ?? '';
function entries() {
  const { snapshot } = candidate();
  const capturedAt = new Date(snapshot.origin?.capturedAt ?? '');
  expect(Number.isFinite(capturedAt.getTime()), 'candidate capture clock is missing').toBe(true);
  const now = new Date();
  const capturedRows = (snapshot.content.types.schedule_entries as unknown as Record<string, unknown>[])
    .map((entry) => entry as unknown as Entry)
    .filter((entry) => entry.status === 'active' && isBeforeStart(entry, capturedAt))
    .sort((a, b) => calendarDay(a.startAt).localeCompare(calendarDay(b.startAt)));
  return { now, today: calendarDay(now.toISOString()), capturedRows,
    rows: capturedRows.filter((entry) => isBeforeStart(entry, now)) };
}
const item = '[data-schedule-item]';

test('@month-search-order candidate schedule agrees with current Moscow date, card order and month choices', async ({ page }) => {
  const { now, rows, capturedRows, today } = entries(); await page.clock.setFixedTime(now); await page.goto('/raspisanie-i-tseny');
  const staticCount = await page.locator(item).count();
  const cutoff = capturedRows.length - staticCount;
  expect(cutoff, 'candidate contains more cards than the captured active schedule').toBeGreaterThanOrEqual(0);
  expect(capturedRows.slice(0, cutoff).every((row) => !isBeforeStart(row, now)), 'candidate omitted a future offer').toBe(true);
  const builtRows = capturedRows.slice(cutoff);
  await expect(page.locator(item)).toHaveCount(builtRows.length);
  expect(await page.locator(item).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-start-at')))).toEqual(builtRows.map((row) => row.startAt));
  expect(await page.locator(`${item} [data-testid="schedule-card-title"] a`).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')?.split('/').at(-1)))).toEqual(builtRows.map((row) => row.seminar.slug));
  expect(await page.locator(item).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-months')))).toEqual(builtRows.map((row) => monthKeys(row, calendarDay(row.startAt)).join(' ')));
  const month = page.locator('[data-schedule-filter="month"]');
  expect(await month.locator('option').evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).filter(Boolean))).toEqual(monthOptions(rows, today).map((option) => option.key));
  if (rows.length) await expect(month).toBeEnabled(); else {
    await expect(month).toBeDisabled(); await expect(page.locator('[data-schedule-empty]')).toBeVisible();
  }
  await expect(page.locator(`${item}:visible`)).toHaveCount(Math.min(25, rows.length));
  if (rows.length > 25) {
    await page.getByRole('button', { name: 'Следующая страница', exact: true }).click();
    await expect(page.locator(`${item}:visible`)).toHaveCount(Math.min(25, rows.length - 25));
  } else await expect(page.locator('[data-schedule-pagination]')).toBeHidden();
});

test('@month-city @month-empty-state @month-page-reset candidate schedule combines real month, city and search; clears and shows empty state', async ({ page }) => {
  const { now, rows, today } = entries(); await page.clock.setFixedTime(now); await page.goto('/raspisanie-i-tseny');
  const month = page.locator('[data-schedule-filter="month"]');
  const city = page.locator('[data-schedule-filter="city"]');
  const search = page.locator('[data-schedule-search]');
  if (rows.length) {
    const key = monthKeys(rows[0], today)[0];
    await month.selectOption(key);
    await expect(page.locator(`${item}:visible`)).toHaveCount(Math.min(25, rows.filter((row) => monthKeys(row, today).includes(key)).length));
    const chosenCity = cityName(rows[0]) || 'unknown';
    await city.selectOption(slug(chosenCity));
    const expected = rows.filter((row) => monthKeys(row, today).includes(key) && (cityName(row) || 'unknown') === chosenCity);
    await expect(page.locator(`${item}:visible`)).toHaveCount(Math.min(25, expected.length));
    const title = (await page.locator(`${item}:visible [data-testid="schedule-card-title"]`).first().innerText()).trim();
    await search.fill(title.toLowerCase().slice(0, 18));
    expect(await page.locator(`${item}:visible`).count()).toBeGreaterThan(0);
    for (const text of await page.locator(`${item}:visible [data-testid="schedule-card-title"]`).allTextContents()) expect(text.toLowerCase()).toContain(title.toLowerCase().slice(0, 18));
  } else {
    await expect(month).toBeDisabled();
    expect(await city.locator('option').count()).toBe(1);
  }
  await search.fill('__candidate_no_schedule_matches_52b__');
  await expect(page.locator(`${item}:visible`)).toHaveCount(0);
  await expect(page.locator('[data-schedule-empty]')).toBeVisible();
  await search.fill(''); await city.selectOption('');
  if (rows.length) await month.selectOption('');
  await expect(page.locator(`${item}:visible`)).toHaveCount(Math.min(25, rows.length));
});
