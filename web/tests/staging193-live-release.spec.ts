import { test, expect } from '@playwright/test';

const expectedSha = process.env.STAGING193_EXPECTED_SHA ?? '';
const expectedDigest = process.env.STAGING193_EXPECTED_STATIC_DIGEST ?? '';

test.beforeAll(() => {
  if (!/^[a-f0-9]{40}$/.test(expectedSha) || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('staging193 browser check requires the exact admitted source SHA and static digest');
  }
});

test('served release declaration matches the exact admitted candidate', async ({ request }) => {
  const response = await request.get('/release.json');
  expect(response.status()).toBe(200);
  const release = await response.json() as { commit?: string; staticTreeSha256?: string; snapshotId?: string };
  expect(release.commit).toBe(expectedSha);
  expect(release.staticTreeSha256).toBe(expectedDigest);
  expect(release.snapshotId).toMatch(/^snap:/);
});

test('main routes and their images are served by the candidate', async ({ page }) => {
  for (const route of ['/', '/raspisanie-i-tseny', '/statyi', '/kontakty']) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('main h1').first()).toBeVisible();
    const failures = await page.locator('main img').evaluateAll((images) => images
      .filter((image) => image instanceof HTMLImageElement && image.currentSrc.startsWith(location.origin))
      .filter((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 0)
      .map((image) => (image as HTMLImageElement).currentSrc));
    expect(failures, `broken same-origin image on ${route}`).toEqual([]);
  }

  await page.goto('/statyi');
  const imageArticle = page.locator('.articles-grid > a[href^="/statyi/"]').filter({ has: page.locator('img') }).first();
  await expect(imageArticle, 'captured publication catalog must contain an image-bearing article').toBeVisible();
  const detailPath = await imageArticle.getAttribute('href');
  expect(detailPath).toMatch(/^\/statyi\/[A-Za-z0-9_-]+$/);
  await imageArticle.click();
  await expect(page.locator('article.article-main h1').first()).toBeVisible();
  const hero = page.locator('main img').first();
  await expect(hero, 'article image from the captured CMS media must render').toBeVisible();
  await expect.poll(() => hero.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
