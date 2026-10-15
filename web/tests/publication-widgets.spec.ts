import { test, expect, candidate, actualTemplates } from './helpers/publication-candidate';
import { installThirdPartyGuard, FIXED_SIZE_WIDGET_BODY } from './helpers/third-party-guard';

test('candidate declared widgets load lazily, preserve geometry and use isolated requests', async ({ page }) => {
  const { chatLoaderSrc } = candidate();
  const guard = await installThirdPartyGuard(page, { chatLoaderSrc, reviewsWidgetBody: FIXED_SIZE_WIDGET_BODY });
  await page.goto('/');
  const reviews = page.locator('[data-reviews-embed]');
  await expect(reviews).toHaveCount(1);
  expect(guard.toHost('yandex.ru').filter((url) => url.includes('/maps-reviews-widget/'))).toEqual([]);
  await expect(reviews.locator('iframe')).toHaveCount(0);
  const before = await reviews.boundingBox();
  const siblingBefore = await reviews.evaluate((node) => { const next = node.closest('section')!.nextElementSibling!; return next.getBoundingClientRect().top + scrollY; });
  await reviews.scrollIntoViewIfNeeded(); await expect(reviews.locator('iframe')).toHaveCount(1);
  await expect.poll(() => guard.toHost('yandex.ru').some((url) => url.includes('/maps-reviews-widget/'))).toBe(true);
  const after = await reviews.boundingBox();
  expect(after!.height).toBe(before!.height); expect(after!.width).toBe(before!.width);
  expect(await reviews.evaluate((node) => node.closest('section')!.nextElementSibling!.getBoundingClientRect().top + scrollY)).toBeCloseTo(siblingBefore, 0);
  if (chatLoaderSrc) {
    expect(guard.urls.some((url) => url.startsWith(chatLoaderSrc))).toBe(false);
    await page.locator('[data-chat-trigger]').click();
    await expect.poll(() => guard.urls.some((url) => url.startsWith(chatLoaderSrc))).toBe(true);
    await expect(page.locator('[data-chat-stub-panel]')).toBeVisible();
  } else await expect(page.locator('[data-chat-facade]')).toHaveCount(0);
});

test('candidate overlays leave critical controls reachable on actual templates', async ({ page }) => {
  test.setTimeout(120_000);
  let controls = 0;
  for (const route of actualTemplates()) {
    await page.goto(route);
    const targets = page.locator('main a.btn, main button:enabled, main input, main select:enabled, .newsletter-signup-button, .seminar-register-link');
    for (const control of await targets.all()) {
      if (!await control.isVisible()) continue;
      await control.scrollIntoViewIfNeeded();
      const clear = await control.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const top = Math.max(box.top, 0); const bottom = Math.min(box.bottom, innerHeight);
        const left = Math.max(box.left, 0); const right = Math.min(box.right, innerWidth);
        if (bottom <= top || right <= left) return false;
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return Boolean(hit && (node.contains(hit) || hit.contains(node)));
      });
      expect(clear, `${route}: ${await control.textContent()} covered by overlay`).toBe(true); controls++;
    }
  }
  expect(controls, 'no critical controls exercised').toBeGreaterThan(0);
});
