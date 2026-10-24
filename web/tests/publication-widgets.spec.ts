import { test, expect, candidate, actualTemplates } from './helpers/publication-candidate';
import { installThirdPartyGuard, FIXED_SIZE_WIDGET_BODY } from './helpers/third-party-guard';
import { attr, findAll, textOf } from './helpers/dom';

test('candidate SDK loads on page entry, preserves review geometry, and uses isolated requests', async ({ page }) => {
  const built = candidate();
  const { chatLoaderSrc } = built;
  const expectedChatLoaderSrc = process.env.CHAT_LOADER_SRC;
  expect(expectedChatLoaderSrc, 'publication browser check must configure its expected chat loader independently')
    .toBeDefined();
  expect(chatLoaderSrc, 'built chat loader must match the independently configured publication value')
    .toBe(expectedChatLoaderSrc === 'none' ? null : expectedChatLoaderSrc);
  if (expectedChatLoaderSrc && expectedChatLoaderSrc !== 'none') {
    const home = built.pages.find((page) => page.route === '/')!;
    const trigger = findAll(home.html, (node) => attr(node, 'data-chat-trigger') !== null)[0];
    expect(home.html.includes('data-chat-greeting'), 'built homepage must not duplicate the provider greeting').toBe(false);
    expect(home.html.includes('Вера Рум'), 'built homepage must not contain the retired local persona card').toBe(false);
    expect(trigger, 'built homepage must contain the keyboard-only helper').toBeDefined();
    expect(trigger && textOf(trigger)).toContain('Написать нам');
  }
  const guard = await installThirdPartyGuard(page, { chatLoaderSrc, reviewsWidgetBody: FIXED_SIZE_WIDGET_BODY });
  await page.goto('/');
  const reviews = page.locator('[data-reviews-embed]');
  await expect(reviews).toHaveCount(1);
  expect(guard.toHost('yandex.ru').filter((url) => url.startsWith('https://yandex.ru/maps-reviews-widget/'))).toEqual([]);
  await expect(reviews.locator('iframe')).toHaveCount(0);
  const before = await reviews.boundingBox();
  const siblingPosition = () => reviews.evaluate((node) => {
    const next = node.closest('section')!.nextElementSibling!;
    const nextTop = next.getBoundingClientRect().top;
    const scrollport = node.closest<HTMLElement>('[data-page-scrollport]');
    return scrollport
      ? nextTop - scrollport.getBoundingClientRect().top + scrollport.scrollTop
      : nextTop + window.scrollY;
  });
  const siblingBefore = await siblingPosition();
  await reviews.scrollIntoViewIfNeeded(); await expect(reviews.locator('iframe')).toHaveCount(1);
  await expect.poll(() => guard.toHost('yandex.ru').some((url) => url.startsWith('https://yandex.ru/maps-reviews-widget/'))).toBe(true);
  const after = await reviews.boundingBox();
  expect(after!.height).toBe(before!.height); expect(after!.width).toBe(before!.width);
  expect(await siblingPosition()).toBeCloseTo(siblingBefore, 0);
  if (chatLoaderSrc) {
    await expect.poll(() => guard.urls.filter((url) => url.startsWith(chatLoaderSrc)).length,
      'ordinary page entry loads the configured SDK once').toBe(1);
    await expect(page.locator('[data-chat-stub-launcher]'), 'SDK creates native launcher').toBeVisible();
    await expect(page.locator('[data-chat-stub-chooser]'), 'SDK load does not auto-open chooser').toHaveCount(0);
    const helper = page.locator('[data-chat-trigger]');
    await expect.poll(() => helper.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      return visible && rect.width > 2 && rect.height > 2
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    }), 'unfocused helper is not a visible permanent CTA').toBe(false);
    await helper.focus();
    await expect(helper).toBeFocused();
    await helper.click();
    await expect(page.locator('[data-chat-stub-chooser]'), 'explicit helper action opens native chooser').toBeVisible();
  } else {
    await expect(page.locator('[data-chat-trigger]')).toHaveCount(0);
    await expect(page.locator('[data-chat-stub-launcher]')).toHaveCount(0);
  }
});

test('candidate overlays leave critical controls reachable on actual templates', async ({ page }) => {
  test.setTimeout(120_000);
  let controls = 0;
  const chatLoaderSrc = candidate().chatLoaderSrc;
  for (const route of actualTemplates()) {
    await page.goto(route);
    if (chatLoaderSrc) {
      const greeting = page.locator('[data-chat-stub-greeting]');
      await expect(greeting, 'configured provider greeting is present before checking background controls').toBeVisible();
      await greeting.locator('[data-chat-stub-greeting-close]').click();
      await expect(greeting, 'the provider greeting closes through its own control').toHaveCount(0);
      await expect(page.locator('[data-chat-stub-launcher]'), 'closing the greeting leaves the native launcher available').toBeVisible();
    }
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
