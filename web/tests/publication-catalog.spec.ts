import { test, expect, candidate, candidateSiteOrigin } from './helpers/publication-candidate';

type Article = { slug: string; title: string; body_text?: string; published_at?: string | null };
function articles() {
  const rows = candidate().snapshot.content.types.articles as unknown as Article[];
  expect(rows.length, 'candidate must contain articles').toBeGreaterThan(0);
  return rows;
}
const date = (row: Article) => Number.isFinite(Date.parse(row.published_at ?? '')) ? Date.parse(row.published_at!) : 0;
const sorted = (rows: Article[], ascending = false) => [...rows].sort((a, b) => ascending ? date(a) - date(b) : date(b) - date(a));
const hrefs = (rows: Article[]) => rows.map((row) => `/statyi/${row.slug}`);

test('candidate catalog searches all captured articles, shares query and resets', async ({ page }) => {
  const rows = articles();
  await page.goto('/statyi');
  const cards = page.locator('[data-articles-grid] a.article-card');
  await expect(cards).toHaveCount(Math.min(6, rows.length));
  const first = hrefs(sorted(rows).slice(0, 6));
  expect(await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual(first);
  const target = rows.find((row) => !first.includes(`/statyi/${row.slug}`)) ?? rows[rows.length - 1];
  const query = target.title.toLowerCase().slice(0, 22);
  const matches = sorted(rows).filter((row) => row.title.toLowerCase().includes(query) || (row.body_text ?? '').slice(0, 300).toLowerCase().includes(query));
  const search = page.locator('[data-articles-search]');
  await search.fill(query);
  await expect(cards).toHaveCount(Math.min(6, matches.length));
  expect(await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual(hrefs(matches.slice(0, 6)));
  await page.goto(`/statyi?q=${encodeURIComponent(query)}`);
  await expect(search).toHaveValue(query);
  await expect(cards).toHaveCount(Math.min(6, matches.length));
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${candidateSiteOrigin()}/statyi`);
  await search.fill('');
  await expect(cards).toHaveCount(Math.min(6, rows.length));
  const pagination = page.locator('[data-testid="articles-pagination"]');
  if (rows.length > 6) {
    await expect(pagination).toBeVisible();
    await page.locator('[data-page-next]').click();
    await expect(cards).toHaveCount(Math.min(6, rows.length - 6));
    expect(await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual(hrefs(sorted(rows).slice(6, 12)));
    await search.fill(query); await search.fill('');
    expect(await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual(first);
  } else await expect(pagination).toBeHidden();
});

test('candidate catalog sorts the entire snapshot in both directions', async ({ page }) => {
  const rows = articles(); await page.goto('/statyi');
  const sort = page.locator('[data-articles-sort]');
  expect(await sort.locator('option').evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))).toEqual(['date_desc', 'date_asc']);
  for (const direction of ['date_asc', 'date_desc']) {
    await sort.selectOption(direction);
    await expect.poll(() => page.locator('[data-articles-grid] a.article-card').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual(hrefs(sorted(rows, direction === 'date_asc').slice(0, 6)));
  }
});

test('candidate catalog has a real empty result and recovers after clearing', async ({ page }) => {
  const rows = articles(); await page.goto('/statyi');
  await page.locator('[data-articles-search]').fill('__candidate_no_article_matches_69d62__');
  await expect(page.locator('[data-articles-grid] a.article-card')).toHaveCount(0);
  await expect(page.locator('[data-articles-search]')).toBeVisible();
  await expect(page.locator('[data-testid="articles-pagination"]')).toBeHidden();
  await page.locator('[data-articles-search]').fill('');
  await expect(page.locator('[data-articles-grid] a.article-card')).toHaveCount(Math.min(6, rows.length));
});
