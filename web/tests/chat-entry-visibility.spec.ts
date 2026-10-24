import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { serveStatic, type StaticSite } from './helpers/static-serve';
import { PROBE_CHAT_LOADER_SRC, buildProbe, type ProbeBuild } from './helpers/widget-probe-build';
import { TEMPLATES } from './helpers/templates';
import { installThirdPartyGuard } from './helpers/third-party-guard';

const WIDTHS = [320, 375, 1280] as const;
const TD52 = new Set(['home', 'course', 'seminar', 'seminar-dated', 'kontakty', 'statyi', 'raspisanie']);
const TRIGGER = '[data-chat-trigger]';
const NATIVE_LAUNCHER = '[data-chat-stub-launcher]';
const NATIVE_GREETING = '[data-chat-stub-greeting]';
const NATIVE_CHOOSER = '[data-chat-stub-chooser]';
const KEYBOARD_HELPER = '[data-chat-trigger]';
const PAYMENT_ROOT = '#payment-dialog-root';
const PAYMENT_DIALOG = '.payment-dialog';
const PAYMENT_ENTRY = '[data-payment-entry]';
const PAYMENT_FORM = '[data-payment-form]';
const GREETING_CLOSE = '[data-chat-stub-greeting-close]';

async function helperVisualState(page: Page) {
  return page.locator(KEYBOARD_HELPER).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    let visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
    let left = Math.max(0, rect.left);
    let top = Math.max(0, rect.top);
    let right = Math.min(innerWidth, rect.right);
    let bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = el.parentElement; parent && visible; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden' || Number(parentStyle.opacity) === 0) {
        visible = false;
        break;
      }
      if (/(hidden|clip|scroll|auto)/.test(`${parentStyle.overflowX} ${parentStyle.overflowY}`)) {
        const clip = parent.getBoundingClientRect();
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    const visibleWidth = Math.max(0, right - left);
    const visibleHeight = Math.max(0, bottom - top);
    const outline = getComputedStyle(el, ':focus-visible');
    const focusedStyle = document.activeElement === el ? style : outline;
    const focusIndicator = (focusedStyle.outlineStyle !== 'none' && parseFloat(focusedStyle.outlineWidth) > 0)
      || (focusedStyle.boxShadow !== 'none' && focusedStyle.boxShadow !== '');
    return {
      visuallyReadable: visible && visibleWidth > 2 && visibleHeight > 2,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      fullyInViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      focusIndicator,
    };
  });
}

let activeBuild: ProbeBuild;
let activeSite: StaticSite;

test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  test.setTimeout(10 * 60 * 1000);
  // This is a real preview-role payment artifact with forms stubbed locally. DEMO_OUTPUT
  // is removed even if the shell happened to provide it; the payment dialog and chat
  // trigger must both exist in the exact browser fixture used below.
  activeBuild = buildProbe('non-demo preview payment plus chat', {
    CHAT_LOADER_SRC: PROBE_CHAT_LOADER_SRC,
    PAYMENT_ROLE: 'preview',
    DEMO_FORMS: 'stub',
    DEMO_OUTPUT: undefined,
  }, { keepOnDisk: true });
  if (activeBuild.pages.size === 0) throw new Error('non-demo probe has no HTML pages');
  if (!activeBuild.root) throw new Error('preview probe output was not retained for local Pagefind indexing');
  execFileSync(join(process.cwd(), 'node_modules/.bin/pagefind'), ['--site', activeBuild.root], {
    cwd: process.cwd(),
    stdio: 'pipe',
    encoding: 'utf8',
  });
  activeSite = await serveStatic(activeBuild.root!);

});

test.afterAll(async () => {
  await activeSite?.close();
  activeBuild?.dispose();
});

const activeUrl = (path: string) => `${activeSite.origin}${path}`;

async function protectThirdParties(page: Page) {
  return installThirdPartyGuard(page, { chatLoaderSrc: PROBE_CHAT_LOADER_SRC });
}

// Hash-history tests need a stable target even when the dated #upcoming block is empty.
async function installHistoryFragment(page: Page) {
  await page.addInitScript(() => {
    const install = () => {
      const footer = document.querySelector('footer');
      const actions = document.querySelector('.hero-d-actions');
      if (footer) footer.id = 'history-fragment-target';
      if (actions && !actions.querySelector('[data-history-fragment-link]')) {
        const anchor = document.createElement('a');
        anchor.href = '#history-fragment-target';
        anchor.textContent = 'К подвалу';
        anchor.setAttribute('data-history-fragment-link', '');
        actions.append(anchor);
      }
      if (footer && actions) observer.disconnect();
    };
    const observer = new MutationObserver(install);
    observer.observe(document, { childList: true, subtree: true });
    install();
  });
}

async function snapshotLayout(page: Page) {
  return page.evaluate((args) => {
    const header = document.querySelector('header');
    const main = document.querySelector('main');
    const footer = document.querySelector('footer');
    const button = document.querySelector<HTMLElement>(args.nativeLauncherSelector);
    const greeting = document.querySelector<HTMLElement>(args.greetingSelector);
    const greetingRect = greeting?.getBoundingClientRect() ?? null;
    const greetingStyle = greeting ? getComputedStyle(greeting) : null;
    const greetingVisible = Boolean(greetingRect && greetingStyle && greetingRect.width > 0 && greetingRect.height > 0
      && greetingStyle.display !== 'none' && greetingStyle.visibility !== 'hidden' && Number(greetingStyle.opacity) > 0);
    const candidates = [...document.querySelectorAll<HTMLElement>('body *')];
    const scrollport = candidates.find((el) => {
      const style = getComputedStyle(el);
      return Boolean(header && main && footer && el.contains(header) && el.contains(main) && el.contains(footer))
        && /(auto|scroll)/.test(style.overflowY)
        && el.hasAttribute('data-page-scrollport');
    }) ?? null;
    const frame = scrollport?.parentElement ?? null;
    const rect = (el: Element | DOMRect | null) => {
      if (!el) return null;
      const r = el instanceof DOMRect ? el : el.getBoundingClientRect();
      return { x: r.x, y: r.y, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const visibleRect = (r: DOMRect, clip: DOMRect) => {
      const left = Math.max(r.left, clip.left, 0);
      const top = Math.max(r.top, clip.top, 0);
      const right = Math.min(r.right, clip.right, innerWidth);
      const bottom = Math.min(r.bottom, clip.bottom, innerHeight);
      return right > left && bottom > top ? { left, top, right, bottom } : null;
    };
    const clip = scrollport?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const overlaps: string[] = [];
    const intersect = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    if (button) {
      const box = button.getBoundingClientRect();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim() || button.contains(node.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          const shown = visibleRect(r, clip);
          if (shown) {
            const description = `text:${node.textContent.trim().slice(0, 32)}`;
            if (intersect(shown, box) && !overlaps.includes(description)) overlaps.push(description);
          }
        }
        range.detach();
      }
      for (const el of document.querySelectorAll<HTMLElement>('a,button,input,select,textarea,[role="button"]')) {
        if (button.contains(el) || el.contains(button)) continue;
        if (el.closest('details:not([open])')) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || el.hidden) continue;
        const shown = visibleRect(el.getBoundingClientRect(), clip);
        if (shown) {
          const description = `control:${el.tagName.toLowerCase()}:${el.textContent?.trim().slice(0, 24)}`;
          if (intersect(shown, box)) overlaps.push(description);
        }
      }
    }
    const insetProbe = document.createElement('div');
    insetProbe.style.cssText = 'position:fixed;left:-10000px;padding-bottom:env(safe-area-inset-bottom)';
    document.body.append(insetProbe);
    const safeAreaInset = parseFloat(getComputedStyle(insetProbe).paddingBottom) || 0;
    insetProbe.remove();
    const scrollportRect = scrollport?.getBoundingClientRect() ?? null;
    const lowerRect = scrollportRect
      ? new DOMRect(0, scrollportRect.bottom, innerWidth, Math.max(0, innerHeight - scrollportRect.bottom))
      : null;
    return {
      scrollport: rect(scrollport),
      scrollportFound: Boolean(scrollport),
      documentScrollHeight: document.documentElement.scrollHeight,
      pageFrameChildren: frame ? [...frame.children].map((el) => el.tagName.toLowerCase()) : [],
      lowerZone: rect(lowerRect),
      lowerUsefulHeight: lowerRect ? lowerRect.height - safeAreaInset : null,
      safeAreaInset,
      buttonInsideUsefulArea: Boolean(button && lowerRect && button.getBoundingClientRect().top >= lowerRect.top
        && button.getBoundingClientRect().bottom <= lowerRect.bottom - safeAreaInset),
      button: rect(button),
      buttonParentIsBody: button?.parentElement === document.body,
      buttonInsideScrollport: Boolean(scrollport && button && scrollport.contains(button)),
      scrollportScrollTop: scrollport?.scrollTop ?? 0,
      scrollportScrollHeight: scrollport?.scrollHeight ?? 0,
      scrollportClientHeight: scrollport?.clientHeight ?? 0,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      buttonInsideLowerZone: Boolean(lowerRect && button && button.getBoundingClientRect().top >= lowerRect.top
        && button.getBoundingClientRect().bottom <= lowerRect.bottom),
      greetingFound: Boolean(greeting),
      greetingVisible,
      greetingbox: rect(greeting),
      overlap: overlaps.slice(0, 8),
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  }, { nativeLauncherSelector: NATIVE_LAUNCHER, greetingSelector: NATIVE_GREETING });
}

async function visibleScrollportGestureArea(page: Page) {
  return page.evaluate(() => {
    const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
    if (!port) throw new Error('shared scrollport is missing before gesture');
    const portRect = port.getBoundingClientRect();
    const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? portRect.top;
    const visualTop = window.visualViewport?.offsetTop ?? 0;
    const visualBottom = Math.min(innerHeight, visualTop + (window.visualViewport?.height ?? innerHeight));
    const top = Math.max(portRect.top, headerBottom, visualTop) + 4;
    const bottom = Math.min(portRect.bottom, visualBottom) - 4;
    return { x: Math.min(innerWidth - 8, Math.max(8, portRect.left + portRect.width / 2)), top, bottom, height: bottom - top };
  });
}

async function expectNativeLauncher(page: Page, width: number) {
  const launcher = page.locator(NATIVE_LAUNCHER);
  await expect(launcher, `${width}px: native launcher is created by the provider stub`).toHaveCount(1);
  await expect(launcher, `${width}px: closed native launcher is visible`).toBeVisible();
  const box = await launcher.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      width: r.width, height: r.height,
      right: innerWidth - r.right, bottom: innerHeight - r.bottom,
      position: style.position, zIndex: Number.parseInt(style.zIndex, 10),
      name: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      tabIndex: el.getAttribute('tabindex'),
    };
  });
  expect.soft(box.width, `${width}px: measured native button width`).toBe(66);
  expect.soft(box.height, `${width}px: measured native button height`).toBe(66);
  expect.soft(box.right, `${width}px: native button right offset`).toBe(50);
  expect.soft(box.bottom, `${width}px: native button bottom offset`).toBe(50);
  expect.soft(box.position, `${width}px: provider launcher is viewport-fixed`).toBe('fixed');
  expect.soft(box.zIndex, `${width}px: provider launcher remains above its greeting`).toBe(10150);
  expect.soft(box.name, `${width}px: test stub does not invent a native accessible name`).toBeNull();
  expect.soft(box.role, `${width}px: test stub does not invent a native ARIA role`).toBeNull();
  expect.soft(box.tabIndex, `${width}px: test stub does not invent keyboard focusability`).toBeNull();
}

/** Повторно использует общий layout snapshot для геометрии приветствия. */
async function greetingGeometry(page: Page) {
  const layout = await snapshotLayout(page);
  if (!layout.greetingFound || !layout.greetingbox) return null;
  return {
    top: layout.greetingbox.top,
    bottom: layout.greetingbox.bottom,
    left: layout.greetingbox.x,
    right: layout.greetingbox.right,
  };
}

test.describe('chat entry visibility approved contract', () => {
  test('normal page load fetches Bitrix once without opening its chooser or adding a site card', async ({ page }) => {
    const seen = await protectThirdParties(page);
    const response = await page.goto(activeUrl('/oplata'));
    expect(response?.status(), 'the non-demo payment page must be served').toBe(200);
    await expect(page.locator('[data-payment-role="preview"]'), 'payment preview role is present in this fixture').toHaveCount(1);
    await expect(page.locator(PAYMENT_FORM), 'a real payment form exists in this fixture').toHaveCount(1);
    await expect(page.locator(NATIVE_LAUNCHER), 'the SDK-created launcher exists after ordinary load').toBeVisible();
    expect(seen.toHost(new URL(PROBE_CHAT_LOADER_SRC).hostname), 'ordinary load fetches the SDK exactly once')
      .toHaveLength(1);
    await expect(page.locator(NATIVE_CHOOSER), 'ordinary SDK load does not open the chooser').toHaveCount(0);
    await expect(page.locator('[data-chat-greeting]'), 'the site does not duplicate the provider greeting').toHaveCount(0);
    await expect.poll(async () => (await helperVisualState(page)).visuallyReadable,
      'the unfocused helper is not a visible permanent CTA').toBe(false);
    await expect(page.locator(TRIGGER), 'the compact keyboard helper is the only owned chat action').toHaveCount(1);
  });

  test('native launcher keeps its measured fixed geometry at mobile, narrow-desktop, and desktop widths', async ({ page }) => {
    await protectThirdParties(page);
    await page.goto(activeUrl('/'));
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 720 });
      await expectNativeLauncher(page, width);
    }
  });

  test('all seven templates reserve 120px plus safe area for the closed native launcher without overlap', async ({ page }) => {
    await protectThirdParties(page);
    const templates = TEMPLATES;
    expect(templates.map(({ name }) => name).filter((name) => TD52.has(name)).sort()).toEqual([...TD52].sort());

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 720 });
      for (const { name, path } of templates) {
        const response = await page.goto(activeUrl(path));
        expect(response?.status(), `${name}: applicable page is present in this preview fixture`).toBe(200);
        await expect(page.locator(NATIVE_LAUNCHER), `${name}: native launcher is present`).toBeVisible();
        await expect(page.locator(NATIVE_GREETING), `${name}: provider greeting is overlaid before close`).toBeVisible();
        await page.locator(GREETING_CLOSE).click();
        await expect(page.locator(NATIVE_GREETING), `${name}: greeting can be dismissed`).toHaveCount(0);
        for (const position of ['start', 'middle', 'footer'] as const) {
          const before = await snapshotLayout(page);
          expect.soft(before.scrollportFound, `${name} ${width} ${position}: header/main/newsletter/footer share a real scrollport`).toBe(true);
          expect.soft(before.lowerZone, `${name} ${width} ${position}: actual viewport reserve is measurable`).not.toBeNull();
          expect.soft(before.lowerUsefulHeight, `${name} ${width} ${position}: reserve is at least 120px plus safe area`).toBeGreaterThanOrEqual(120);
          expect.soft(before.buttonParentIsBody, `${name} ${width} ${position}: native launcher is a provider body child`).toBe(true);
          expect.soft(before.buttonInsideScrollport, `${name} ${width} ${position}: native launcher is outside content scrollport`).toBe(false);
          expect.soft(before.buttonInsideLowerZone, `${name} ${width} ${position}: launcher lies in the viewport reserve`).toBe(true);
          expect.soft(before.greetingFound, `${name} ${width} ${position}: closed greeting is absent`).toBe(false);
          if (position === 'start') await page.evaluate(() => {
            const header = document.querySelector('header');
            const main = document.querySelector('main');
            const footer = document.querySelector('footer');
            const candidate = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
              const s = getComputedStyle(el);
              return Boolean(header && main && footer && el.contains(header) && el.contains(main) && el.contains(footer))
                && /(auto|scroll)/.test(s.overflowY) && el.hasAttribute('data-page-scrollport');
            });
            if (candidate) candidate.scrollTop = 0;
            window.scrollTo(0, 0);
          });
          else if (position === 'middle') await page.evaluate(() => {
            const header = document.querySelector('header');
            const main = document.querySelector('main');
            const footer = document.querySelector('footer');
            const candidate = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
              const s = getComputedStyle(el);
              return Boolean(header && main && footer && el.contains(header) && el.contains(main) && el.contains(footer))
                && /(auto|scroll)/.test(s.overflowY) && el.hasAttribute('data-page-scrollport');
            });
            if (candidate) candidate.scrollTop = (candidate.scrollHeight - candidate.clientHeight) / 2;
            else window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2);
          });
          else await page.evaluate(() => {
            const header = document.querySelector('header');
            const main = document.querySelector('main');
            const footer = document.querySelector('footer');
            const candidate = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
              const s = getComputedStyle(el);
              return Boolean(header && main && footer && el.contains(header) && el.contains(main) && el.contains(footer))
                && /(auto|scroll)/.test(s.overflowY) && el.hasAttribute('data-page-scrollport');
            });
            if (candidate) candidate.scrollTop = candidate.scrollHeight;
            else window.scrollTo(0, document.documentElement.scrollHeight);
          });
          await page.waitForTimeout(40);
          const measured = await snapshotLayout(page);
          expect.soft(measured.scrollportFound, `${name} ${width} ${position}: scrolling content is the shared scrollport`).toBe(true);
          expect.soft(measured.lowerUsefulHeight, `${name} ${width} ${position}: reserve retains at least 120 useful px`).toBeGreaterThanOrEqual(120);
          expect.soft(measured.overlap, `${name} ${width} ${position}: no visible clipped text/control intersects the trigger`).toEqual([]);
          expect.soft(measured.documentScrollTop, `${name} ${width} ${position}: document has no competing scroll position`).toBe(0);
          if (position === 'start') expect.soft(measured.scrollportScrollTop, `${name} ${width}: start position resets the shared scrollport`).toBe(0);
          if (position !== 'start' && measured.scrollportScrollHeight > measured.scrollportClientHeight + 1) {
            expect.soft(measured.scrollportScrollTop, `${name} ${width}: ${position} position scrolls a long shared scrollport`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  test('stub greeting is provider-owned and auto opening does not move focus or add local greeting markup', async ({ page }) => {
    const seen = await protectThirdParties(page);
    await page.goto(activeUrl('/'));
    const greeting = page.locator(NATIVE_GREETING);
    await expect(greeting, 'native provider overlay appears in the isolated stub').toBeVisible();
    await expect(greeting.locator(GREETING_CLOSE), 'native stub greeting can be dismissed').toBeVisible();
    await expect(page.getByText('Вера Рум', { exact: true }), 'the site does not render the retired local persona card').toHaveCount(0);
    await expect(page.locator('[data-chat-greeting]'), 'the site does not render a duplicate greeting').toHaveCount(0);
    await expect.poll(async () => (await helperVisualState(page)).visuallyReadable,
      'unfocused helper is not a visible wide CTA').toBe(false);
    expect(seen.toHost(new URL(PROBE_CHAT_LOADER_SRC).hostname), 'normal load fetches exactly one loader').toHaveLength(1);
    await expect(page.locator(NATIVE_CHOOSER), 'greeting display does not open native chooser').toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement === document.body), 'provider greeting does not steal focus').toBe(true);
  });

  test('greeting close leaves the native launcher available at top, middle, and footer', async ({ page }) => {
    await protectThirdParties(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 720 });
      await page.goto(activeUrl('/'));
      await expectNativeLauncher(page, width);
      await page.locator(GREETING_CLOSE).click();
      for (const position of ['start', 'middle', 'footer'] as const) {
        const port = page.locator('[data-page-scrollport]');
        await expect(port, `${width}px: a real content scrollport is available`).toHaveCount(1);
        const target = await port.evaluate((el: HTMLElement, where) => where === 'middle'
          ? Math.floor((el.scrollHeight - el.clientHeight) / 2)
          : where === 'footer' ? el.scrollHeight - el.clientHeight : 0, position);
        await port.evaluate((el: HTMLElement, top) => el.scrollTo({ top, behavior: 'instant' }), target);
        await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop), `${width}px: ${position} scroll settles`)
          .toBe(target);
        await expect(page.locator(NATIVE_LAUNCHER), `${width}px ${position}: native launcher stays visible`).toBeInViewport();
        const layout = await snapshotLayout(page);
        expect(layout.overlap, `${width}px ${position}: closed launcher does not cover clipped text or controls`).toEqual([]);
        expect(layout.buttonInsideLowerZone, `${width}px ${position}: native launcher stays inside bottom reserve`).toBe(true);
        await page.locator(NATIVE_LAUNCHER).click();
        await expect(page.locator(NATIVE_CHOOSER), `${width}px ${position}: explicit launcher action opens native chooser`).toBeVisible();
        await page.locator('[data-chat-stub-chooser-close]').click();
        await expect(page.locator(NATIVE_CHOOSER), `${width}px ${position}: chooser closes`).toHaveCount(0);
      }
    }
  });

  test('keyboard helper is focus-only and opens then escapes the native chooser with focus restored', async ({ page }) => {
    await protectThirdParties(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/'));
    const helper = page.locator(KEYBOARD_HELPER);
    await expect(helper, 'exactly one site-owned keyboard helper exists').toHaveCount(1);
    await expect.poll(async () => (await helperVisualState(page)).visuallyReadable,
      'unfocused helper is visually clipped or offscreen, regardless of its CSS technique').toBe(false);
    await expect(page.locator(NATIVE_CHOOSER), 'provider chooser starts closed').toHaveCount(0);
    await page.mouse.move(10, 10);
    await expect.poll(async () => (await helperVisualState(page)).visuallyReadable,
      'mouse movement does not make the helper visually readable').toBe(false);
    for (let step = 0; step < 100; step += 1) {
      await page.keyboard.press('Tab');
      if (await helper.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(helper, 'Tab reaches the helper through normal keyboard navigation').toBeFocused();
    const focusedState = await helperVisualState(page);
    expect(focusedState.visuallyReadable, 'keyboard focus makes the helper visually readable').toBe(true);
    expect(focusedState.fullyInViewport, 'focused helper fits in the viewport').toBe(true);
    expect(focusedState.focusIndicator, 'focused helper has a visible focus indicator').toBe(true);
    await helper.press('Enter');
    await expect(page.locator(NATIVE_CHOOSER), 'Enter calls the measured native chooser path').toBeVisible();
    const nativePlaceholder = page.locator('[data-chat-stub-native-placeholder]');
    const overlayHit = await helper.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(hit && (hit === el || el.contains(hit)));
    });
    expect(overlayHit, 'helper receives pointer hit-testing above the native overlay').toBe(true);
    await nativePlaceholder.focus();
    await expect(nativePlaceholder, 'the stub represents a provider focus target without moving focus automatically').toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator(NATIVE_CHOOSER), 'Escape closes chooser opened by helper').toHaveCount(0);
    await expect(helper, 'Escape restores focus to the helper').toBeFocused();
    await helper.press('Space');
    await expect(page.locator(NATIVE_CHOOSER), 'Space calls the same native chooser path').toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(NATIVE_CHOOSER), 'second Escape closes the native chooser').toHaveCount(0);
    await expect(helper, 'second Escape restores helper focus').toBeFocused();
  });

  test('native launcher explicitly opens and closes chooser without reloading the SDK', async ({ page }) => {
    const seen = await protectThirdParties(page);
    await page.goto(activeUrl('/'));
    await expect(page.locator(NATIVE_LAUNCHER), 'native launcher survives greeting overlay').toBeVisible();
    await expect(page.locator(NATIVE_CHOOSER), 'SDK load itself leaves chooser closed').toHaveCount(0);
    expect(seen.toHost(new URL(PROBE_CHAT_LOADER_SRC).hostname), 'SDK loads once before visitor action').toHaveLength(1);
    await page.locator(NATIVE_LAUNCHER).click();
    await expect(page.locator(NATIVE_CHOOSER), 'mouse action on the native launcher opens provider chooser').toBeVisible();
    await page.locator('[data-chat-stub-chooser-close]').click();
    await expect(page.locator(NATIVE_CHOOSER), 'provider close action dismisses chooser').toHaveCount(0);
    await expect(page.locator(NATIVE_LAUNCHER), 'native launcher remains visible after chooser closes').toBeVisible();
    expect(seen.toHost(new URL(PROBE_CHAT_LOADER_SRC).hostname), 'opening chooser does not fetch SDK again').toHaveLength(1);
  });

  test('payment overlay paints above the greeting and keeps focus inside the dialog', async ({ page }) => {
    await protectThirdParties(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/oplata'));
    await expect(page.locator(NATIVE_GREETING), 'provider stub exposes greeting overlay before payment').toBeVisible();
    const greeting = await greetingGeometry(page);
    expect(greeting, 'the greeting panel has its own lower-zone box').not.toBeNull();
    const opener = page.locator(PAYMENT_ENTRY);
    await expect(opener, 'the existing payment action is present').toHaveCount(1);
    await opener.click();
    const dialog = page.locator(PAYMENT_DIALOG);
    await expect(dialog, 'payment dialog opens above the greeting').toBeVisible();
    const layered = await page.evaluate((args) => {
      const root = document.querySelector<HTMLElement>(args.root);
      const dialog = document.querySelector<HTMLElement>(args.dialog);
      const hit = document.elementFromPoint(args.point.x, args.point.y);
      return {
        overlayCoversGreeting: Boolean(root && hit && root.contains(hit)),
        focusInsideDialog: Boolean(dialog && document.activeElement && dialog.contains(document.activeElement)),
      };
    }, {
      root: PAYMENT_ROOT,
      dialog: PAYMENT_DIALOG,
      point: { x: (greeting!.left + greeting!.right) / 2, y: (greeting!.top + greeting!.bottom) / 2 },
    });
    expect(layered.overlayCoversGreeting, 'the payment overlay intercepts the greeting area').toBe(true);
    expect(layered.focusInsideDialog, 'opening payment does not leave focus in or return it to the greeting').toBe(true);
  });

  test('anchor, history, wheel, touch-like scroll, keyboard scroll, and focus reveal stay in the shared scrollport', async ({ page }) => {
    await protectThirdParties(page);
    const pageShowKey = '__chatEntryTestPageShowCount';
    const departureKey = '__chatEntryTestDepartingScrollSnapshotV1';
    await page.addInitScript((key) => {
      window.addEventListener('pageshow', () => {
        const count = Number(sessionStorage.getItem(key) ?? '0') + 1;
        sessionStorage.setItem(key, String(count));
      });
    }, pageShowKey);
    await page.addInitScript((key) => {
      document.addEventListener('DOMContentLoaded', () => {
        window.addEventListener('pagehide', () => {
          const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
          if (!port) return;
          const frame = port.getBoundingClientRect();
          const snapshot = { url: location.href, top: port.scrollTop, height: port.scrollHeight,
            clientHeight: port.clientHeight, frameTop: frame.top, frameHeight: frame.height,
            maxScroll: port.scrollHeight - port.clientHeight };
          let entries: Record<string, typeof snapshot> = {};
          try { entries = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, typeof snapshot>; } catch { /* test-only observation */ }
          entries[snapshot.url] = snapshot;
          sessionStorage.setItem(key, JSON.stringify(entries));
        });
      });
    }, departureKey);
    let pageShows = 0;
    const waitForPresentedPage = async (minimumCount: number) => {
      await page.waitForFunction(({ key, count }) => Number(sessionStorage.getItem(key) ?? '0') >= count,
        { key: pageShowKey, count: minimumCount });
      await page.evaluate(() => { for (const image of document.images) image.loading = 'eager'; });
      await page.waitForFunction(() => [...document.images].every((image) => image.complete));
      await page.evaluate(async () => {
        await document.fonts.ready;
        const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
        const dimensions = () => port ? [port.scrollHeight, port.clientHeight] : [];
        let previous = '';
        let stableFrames = 0;
        for (let frame = 0; frame < 12 && stableFrames < 2; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const current = JSON.stringify(dimensions());
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
        }
        if (stableFrames < 2) throw new Error('page scrollport geometry did not settle over animation frames');
      });
      pageShows = Math.max(pageShows, minimumCount);
    };
    const navigateTo = async (url: string) => {
      const nextPageShow = pageShows + 1;
      await page.goto(url);
      await waitForPresentedPage(nextPageShow);
    };
    const readPort = () => page.evaluate(() => {
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
      const bounds = port.getBoundingClientRect();
      return { top: port.scrollTop, height: port.scrollHeight, clientHeight: port.clientHeight,
        maxScroll: port.scrollHeight - port.clientHeight, frameTop: bounds.top, frameHeight: bounds.height };
    });
    const readDeparture = (url: string) => page.evaluate(({ key, target }) => {
      let entries: Record<string, unknown> = {};
      try { entries = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, unknown>; } catch { /* test-only observation */ }
      return entries[target] ?? null;
    }, { key: departureKey, target: url });
    const armGestureScrollEnd = (before: number) => page.evaluate((startTop) => {
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
      if (!port) throw new Error('shared scrollport is missing before gesture');
      const scope = window as Window & { __chatEntryScrollEnd?: { top: number; time: number } | null };
      scope.__chatEntryScrollEnd = null;
      const onEnd = () => {
        if (port.scrollTop <= startTop) return;
        scope.__chatEntryScrollEnd = { top: port.scrollTop, time: performance.now() };
        port.removeEventListener('scrollend', onEnd);
      };
      port.addEventListener('scrollend', onEnd);
    }, before);
    const waitForGestureScrollEnd = async (before: number, label: string) => {
      await expect.poll(() => page.evaluate(() => (window as Window & { __chatEntryScrollEnd?: { top: number; time: number } | null }).__chatEntryScrollEnd ?? null), label)
        .toMatchObject({ top: expect.any(Number) });
      const settled = await page.evaluate(() => (window as Window & { __chatEntryScrollEnd?: { top: number; time: number } | null }).__chatEntryScrollEnd ?? null);
      expect(settled?.top, label).toBeGreaterThan(before);
    };
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 420 });
      await navigateTo(activeUrl('/institut-apledzhera#programs'));
      const hasTarget = await page.locator('#programs').count();
      expect(hasTarget, 'anchor target is present on the selected page').toBe(1);
      const scroll = await snapshotLayout(page);
      expect.soft(scroll.scrollportFound, 'anchor navigation uses a real shared scrollport').toBe(true);
      const targetVisible = await page.locator('#programs').evaluate((el) => {
        const target = el.getBoundingClientRect();
        const header = document.querySelector('header')?.getBoundingClientRect();
        return target.top >= (header?.bottom ?? 0) && target.top < innerHeight;
      });
      expect.soft(targetVisible, '#programs is revealed below the sticky header').toBe(true);

      await navigateTo(activeUrl('/raspisanie-i-tseny'));
      const keyboardScrollport = page.locator('[data-page-scrollport]');
      await page.keyboard.press('Tab');
      await expect(keyboardScrollport, 'the shared page scrollport is reachable by keyboard before its contents').toBeFocused();
      const keyboardFocusBefore = await page.evaluate(() => ({
        documentHasFocus: document.hasFocus(),
        active: document.activeElement instanceof HTMLElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : String(document.activeElement),
      }));
      await page.evaluate(() => {
        (window as Window & { __pageDownEvents?: unknown[] }).__pageDownEvents = [];
        const record = (phase: string) => (event: KeyboardEvent) => {
          if (event.key !== 'PageDown') return;
          const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
          (window as Window & { __pageDownEvents?: unknown[] }).__pageDownEvents?.push({
            phase,
            target: event.target instanceof HTMLElement ? `${event.target.tagName}.${event.target.className}` : String(event.target),
            active: document.activeElement instanceof HTMLElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : String(document.activeElement),
            defaultPrevented: event.defaultPrevented,
            port: port && { clientHeight: port.clientHeight, scrollHeight: port.scrollHeight, scrollTop: port.scrollTop, maxScroll: port.scrollHeight - port.clientHeight, tabIndex: port.tabIndex, overflowY: getComputedStyle(port).overflowY },
          });
        };
        document.addEventListener('keydown', record('keydown-capture'), true);
        document.addEventListener('keydown', record('keydown-bubble'));
        document.addEventListener('keyup', record('keyup-capture'), true);
        document.addEventListener('keyup', record('keyup-bubble'));
      });
      const resetPort = async () => {
        await page.evaluate(() => {
          const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
          if (!port) throw new Error('shared scrollport is missing before reset');
          const scope = window as Window & { __chatEntryResetScrollComplete?: boolean };
          scope.__chatEntryResetScrollComplete = port.scrollTop === 0;
          if (scope.__chatEntryResetScrollComplete) return;
          const onEnd = () => {
            if (port.scrollTop !== 0) return;
            scope.__chatEntryResetScrollComplete = true;
            port.removeEventListener('scrollend', onEnd);
          };
          port.addEventListener('scrollend', onEnd);
          port.scrollTo({ top: 0, behavior: 'instant' });
        });
        await expect.poll(() => page.evaluate(() =>
          (window as Window & { __chatEntryResetScrollComplete?: boolean }).__chatEntryResetScrollComplete === true),
        'programmatic scrollport reset settles before the next gesture').toBe(true);
      };
      const beforeKeyboard = await keyboardScrollport.evaluate((el) => el.scrollTop);
      const pageFocusBeforeKey = await page.evaluate(() => ({
        documentHasFocus: document.hasFocus(),
        active: document.activeElement instanceof HTMLElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : String(document.activeElement),
        port: (() => { const el = document.querySelector<HTMLElement>('[data-page-scrollport]')!; return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, maxScroll: el.scrollHeight - el.clientHeight, rect: el.getBoundingClientRect().toJSON() }; })(),
        header: document.querySelector<HTMLElement>('header.topnav')?.getBoundingClientRect().toJSON() ?? null,
      }));
      await page.keyboard.press('PageDown');
      const pageDownState = await page.evaluate(() => ({
        documentHasFocus: document.hasFocus(),
        active: document.activeElement instanceof HTMLElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : String(document.activeElement),
        events: (window as Window & { __pageDownEvents?: unknown[] }).__pageDownEvents ?? [],
        port: (() => { const el = document.querySelector<HTMLElement>('[data-page-scrollport]')!; return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, maxScroll: el.scrollHeight - el.clientHeight, tabIndex: el.tabIndex, overflowY: getComputedStyle(el).overflowY }; })(),
      }));
      await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop),
        `PageDown advances the shared scrollport from its start on a fresh page: ${JSON.stringify({ before: keyboardFocusBefore, immediatelyBefore: pageFocusBeforeKey, after: pageDownState })}`).toBeGreaterThan(beforeKeyboard);
      const pageDownBubble = (pageDownState.events as Array<{ phase: string; defaultPrevented: boolean }>).find((event) => event.phase === 'keydown-bubble');
      expect(pageDownBubble?.defaultPrevented, 'the focused scrollport owns PageDown and prevents duplicate browser scrolling').toBe(true);
      const headerRect = pageFocusBeforeKey.header as { top: number; bottom: number } | null;
      const portRect = pageFocusBeforeKey.port.rect as { top: number; bottom: number };
      const stickyHeaderHeight = headerRect
        ? Math.max(0, Math.min(portRect.bottom, headerRect.bottom) - Math.max(portRect.top, headerRect.top))
        : 0;
      const usefulPageStep = Math.max(1, pageFocusBeforeKey.port.clientHeight - stickyHeaderHeight - 24);
      const expectedPageTop = Math.min(pageFocusBeforeKey.port.maxScroll, beforeKeyboard + usefulPageStep);
      await expect.poll(async () => Math.abs((await keyboardScrollport.evaluate((el) => el.scrollTop)) - expectedPageTop),
        'PageDown advances by the useful page area below the sticky header within one CSS pixel of CSSOM rounding')
        .toBeLessThanOrEqual(1);
      await page.keyboard.press('PageUp');
      await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'PageUp returns to the scrollport start').toBe(0);
      await page.keyboard.press('End');
      await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'End reaches the scrollport bottom')
        .toBe(pageFocusBeforeKey.port.maxScroll);
      await page.keyboard.press('Home');
      await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'Home returns to the scrollport start').toBe(0);

      await resetPort();
      // This test measures the site's scrollport, not provider-overlay hit testing.
      // Dismiss the native greeting through its own visible close control first so
      // its fixed overlay cannot intercept the center of a wheel/touch gesture.
      await page.locator(GREETING_CLOSE).click();
      await expect(page.locator(NATIVE_GREETING), 'native greeting is dismissed through its own UI before gestures').toHaveCount(0);
      await expect(page.locator(NATIVE_LAUNCHER), 'native launcher remains visible after greeting dismissal').toBeVisible();
      const beforeWheel = (await snapshotLayout(page)).scrollportScrollTop;
      const wheelArea = await visibleScrollportGestureArea(page);
      expect(wheelArea.height, 'wheel gesture has visible scrollport area below the sticky header and greeting zone').toBeGreaterThan(0);
      await armGestureScrollEnd(beforeWheel);
      await page.mouse.move(wheelArea.x, (wheelArea.top + wheelArea.bottom) / 2);
      await page.mouse.wheel(0, 480);
      await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
        'wheel advances the shared scrollport').toBeGreaterThan(beforeWheel);
      await waitForGestureScrollEnd(beforeWheel, 'wheel gesture settles on the shared scrollport');
      await expect(page.locator(NATIVE_GREETING), 'wheel scrolling does not recreate the dismissed provider greeting').toHaveCount(0);

      await resetPort();
      const session = await page.context().newCDPSession(page);
      const beforeTouch = (await snapshotLayout(page)).scrollportScrollTop;
      const touchArea = await visibleScrollportGestureArea(page);
      expect(touchArea.height, 'touch gesture endpoints have positive travel inside the visible scrollport').toBeGreaterThan(4);
      await armGestureScrollEnd(beforeTouch);
      try {
        await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        const startY = touchArea.bottom - 2;
        const endY = touchArea.top + 2;
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchArea.x, y: startY, id: 1 }] });
        const steps = Math.ceil((startY - endY) / 20);
        for (let step = 1; step <= steps; step += 1) {
          const y = startY - ((startY - endY) * step) / steps;
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchArea.x, y, id: 1 }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
          'trusted CDP touch input advances the shared scrollport').toBeGreaterThan(beforeTouch);
        await waitForGestureScrollEnd(beforeTouch, 'trusted touch gesture settles on the shared scrollport');
        await expect(page.locator(NATIVE_GREETING), 'touch scrolling does not recreate the dismissed provider greeting').toHaveCount(0);
      } finally {
        try {
          await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        } finally {
          await session.detach();
        }
      }

      await navigateTo(activeUrl('/raspisanie-i-tseny'));
      const schedulePort = page.locator('[data-page-scrollport]');
      await expect(schedulePort, `${width}: schedule has one shared scrollport after a fresh Document`).toHaveCount(1);
      const scheduleTarget = await schedulePort.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight - 180);
      await schedulePort.evaluate((el: HTMLElement, top) => el.scrollTo({ top, behavior: 'instant' }), scheduleTarget);
      await expect.poll(() => schedulePort.evaluate((el: HTMLElement) => el.scrollTop),
        `${width}: instant near-footer schedule position is reached before navigation`).toBe(scheduleTarget);
      const schedulePosition = await readPort();
      const scheduleUrl = page.url();

      await navigateTo(activeUrl('/kontakty'));
      const contactsPort = page.locator('[data-page-scrollport]');
      await expect(contactsPort, `${width}: contacts has one shared scrollport`).toHaveCount(1);
      const contactsTarget = await contactsPort.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight - 120);
      await contactsPort.evaluate((el: HTMLElement, top) => el.scrollTo({ top, behavior: 'instant' }), contactsTarget);
      await expect.poll(() => contactsPort.evaluate((el: HTMLElement) => el.scrollTop),
        `${width}: instant near-footer contacts position is reached before navigation`).toBe(contactsTarget);
      const contactsPosition = await readPort();
      const contactsUrl = page.url();

      await page.goBack();
      await expect(page).toHaveURL(scheduleUrl);
      await waitForPresentedPage(pageShows + 1);
      await expect.poll(() => readDeparture(scheduleUrl), `${width}: outgoing schedule snapshot matches the verified position and geometry`)
        .toEqual({ url: scheduleUrl, ...schedulePosition });
      await expect.poll(readPort, `${width}: Back restores schedule top and geometry`).toEqual(schedulePosition);
      await page.goForward();
      await expect(page).toHaveURL(/kontakty/);
      await waitForPresentedPage(pageShows + 1);
      await expect.poll(() => readDeparture(contactsUrl), `${width}: outgoing contacts snapshot matches the verified position and geometry`)
        .toEqual({ url: contactsUrl, ...contactsPosition });
      await expect.poll(readPort, `${width}: Forward restores contacts top and geometry`).toEqual(contactsPosition);

      const focusable = page.locator('footer a[href]').first();
      await focusable.focus();
      const focused = await focusable.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const host = [...document.querySelectorAll<HTMLElement>('body *')].find((candidate) => {
          const style = getComputedStyle(candidate);
          return /(auto|scroll)/.test(style.overflowY) && candidate.hasAttribute('data-page-scrollport') && candidate.contains(el);
        });
        const box = host?.getBoundingClientRect();
        return Boolean(box && rect.top >= box.top && rect.bottom <= box.bottom);
      });
      expect.soft(focused, 'keyboard focus reveal keeps the full footer control inside the shared scrollport').toBe(true);
    }
  });

  test('history restores distinct scroll positions for separate entries with the same URL', async ({ page }) => {
    await protectThirdParties(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/raspisanie-i-tseny'));
    const port = page.locator('[data-page-scrollport]');
    await expect(port).toHaveCount(1);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 400, behavior: 'instant' }));
    const entryUrl = page.url();
    await page.goto(activeUrl('/kontakty'));
    const contactsPort = page.locator('[data-page-scrollport]');
    await contactsPort.evaluate((el: HTMLElement) => el.scrollTo({ top: 700, behavior: 'instant' }));
    await page.goto(entryUrl);
    await expect(port).toHaveCount(1);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 1300, behavior: 'instant' }));

    await page.goBack();
    await expect(page).toHaveURL(/kontakty/);
    await expect.poll(() => contactsPort.evaluate((el: HTMLElement) => el.scrollTop),
      'back restores the intermediary entry position').toBe(700);
    await page.goBack();
    await expect(page).toHaveURL(entryUrl);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
      'back restores the first same-URL entry position').toBe(400);
    await page.goForward();
    await expect(page).toHaveURL(/kontakty/);
    await expect.poll(() => contactsPort.evaluate((el: HTMLElement) => el.scrollTop),
      'forward restores the intermediary entry position').toBe(700);
    await page.goForward();
    await expect(page).toHaveURL(entryUrl);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
      'forward restores the second same-URL entry position').toBe(1300);
  });

  test('native same-document hash Back and Forward restore the shared scrollport', async ({ page }) => {
    await protectThirdParties(page);
    await installHistoryFragment(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/kontakty'));
    await page.goto(activeUrl('/'));
    const port = page.locator('[data-page-scrollport]');
    await expect(port).toHaveCount(1);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 500, behavior: 'instant' }));
    const anchor = page.locator('[data-history-fragment-link]');
    await expect(anchor).toBeVisible();
    await anchor.scrollIntoViewIfNeeded();
    const initialPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);
    await anchor.click();
    await expect(page).toHaveURL(/#history-fragment-target$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop)).toBeGreaterThan(initialPosition);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 900, behavior: 'instant' }));
    const hashPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);
    await page.goto(activeUrl('/kontakty'));
    await page.goBack();
    await expect(page).toHaveURL(/#history-fragment-target$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
      'full-page Back restores the hash entry position after a document change').toBe(hashPosition);
    await page.goBack();
    await expect(page).not.toHaveURL(/#history-fragment-target$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
      'native same-document Back restores the measured pre-hash position').toBe(initialPosition);
    await page.goForward();
    await expect(page).toHaveURL(/#history-fragment-target$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
      'native same-document Forward restores the measured hash-entry position').toBe(hashPosition);
    await page.goForward();
    await expect(page).toHaveURL(/kontakty/);
  });

  test('history keeps a forward fragment position after its document is left and reloaded', async ({ page }) => {
    await protectThirdParties(page);
    await installHistoryFragment(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/kontakty'));
    await page.goto(activeUrl('/'));
    const originalDocumentTime = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(() => window.addEventListener('unload', () => undefined));
    const port = page.locator('[data-page-scrollport]');
    await expect(port).toHaveCount(1);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 500, behavior: 'instant' }));
    const anchor = page.locator('[data-history-fragment-link]');
    await anchor.scrollIntoViewIfNeeded();
    const firstEntryPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);
    await anchor.click();
    await expect(page).toHaveURL(/#history-fragment-target$/);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 900, behavior: 'instant' }));
    const fragmentEntryPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);

    await page.goBack();
    await expect(page).not.toHaveURL(/#history-fragment-target$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop)).toBe(firstEntryPosition);
    await page.goBack();
    await expect(page).toHaveURL(/kontakty/);
    await page.evaluate(() => history.go(2));
    await expect(page).toHaveURL(/#history-fragment-target$/);
    expect(await page.evaluate(() => performance.timeOrigin), 'the original A document was destroyed before restoring its forward fragment entry')
      .not.toBe(originalDocumentTime);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
      'session entry positions restore the now-forward fragment after its original document is gone').toBe(fragmentEntryPosition);
  });

  test('desktop dropdown exposes the final navigation link at a short viewport', async ({ page }) => {
    await protectThirdParties(page);
    await page.setViewportSize({ width: 1280, height: 280 });
    await page.goto(activeUrl('/'));
    const education = page.locator('header.topnav .topnav-menu .has-dropdown').first();
    await education.hover();
    const dropdown = education.locator('.dropdown');
    const lastLink = dropdown.locator('a[href="/oplata"]');
    await expect(lastLink).toBeVisible();
    await dropdown.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
    const geometry = await lastLink.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const dropdown = el.closest<HTMLElement>('.dropdown')!;
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
      const portRect = port.getBoundingClientRect();
      return {
        link: rect.toJSON(),
        dropdown: dropdown.getBoundingClientRect().toJSON(),
        maxHeight: getComputedStyle(dropdown).maxHeight,
        overflowY: getComputedStyle(dropdown).overflowY,
        lastLinkHit: (() => {
          const hit = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 120), rect.top + rect.height / 2);
          return Boolean(hit && (hit === el || el.contains(hit)));
        })(),
        port: { top: portRect.top, bottom: portRect.bottom, scrollTop: port.scrollTop, scrollHeight: port.scrollHeight },
      };
    });
    expect(geometry.overflowY, `desktop dropdown must provide its own scroll when clipped: ${JSON.stringify(geometry)}`).toMatch(/auto|scroll/);
    expect(geometry.link.top, `last desktop dropdown link is unreachable at 1280x280: ${JSON.stringify(geometry)}`).toBeGreaterThanOrEqual(geometry.dropdown.top - 1);
    expect(geometry.link.bottom, `last desktop dropdown link is unreachable at 1280x280: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.dropdown.bottom + 1);
    expect(geometry.link.bottom, `last desktop dropdown link remains below the clipped scrollport: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.port.bottom + 1);
    expect(geometry.lastLinkHit, `last dropdown link receives a hit at its measured center: ${JSON.stringify(geometry)}`).toBe(true);
    expect(geometry.port.scrollTop, 'scrolling the desktop dropdown does not scroll the page').toBe(0);
  });

  test('short mobile viewport keeps the full menu and search controls inside the shared scrollport', async ({ page }) => {
    await protectThirdParties(page);
    const browserDiagnostics: string[] = [];
    page.on('pageerror', (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') browserDiagnostics.push(`console: ${message.text()}`); });
    page.on('requestfailed', (request) => browserDiagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
    await page.addInitScript(() => {
      (window as Window & { __searchButtonClickState?: unknown }).__searchButtonClickState = null;
      document.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('[data-search-open]') : null;
        if (!button) return;
        (window as Window & { __searchButtonCapture?: boolean }).__searchButtonCapture = true;
      }, true);
      const viewport = window.visualViewport;
      if (!viewport) return;
      const state = { height: viewport.height, offsetTop: viewport.offsetTop };
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => state.height });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => state.offsetTop });
      (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void })
        .__setVisualViewportForTest = (height, offsetTop) => {
          state.height = height;
          state.offsetTop = offsetTop;
          viewport.dispatchEvent(new Event('resize'));
        };
    });
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 420 });
      await page.goto(activeUrl('/'));
      const port = page.locator('[data-page-scrollport]');
      await expect(port).toHaveCount(1);
      await page.locator('details.topnav-mobile > summary').click();
      const drawer = page.locator('.topnav-drawer');
      await expect(drawer).toBeVisible();
      const beforeShrinkScroll = await port.evaluate((el: HTMLElement) => el.scrollTop);
      await page.evaluate(() => (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void })
        .__setVisualViewportForTest?.(300, 0));
      const shrunkDrawer = await page.evaluate(() => ({
        drawerBottom: document.querySelector<HTMLElement>('.topnav-drawer')!.getBoundingClientRect().bottom,
        portBottom: document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect().bottom,
        scrollTop: document.querySelector<HTMLElement>('[data-page-scrollport]')!.scrollTop,
        drawer: (() => {
          const drawer = document.querySelector<HTMLElement>('.topnav-drawer')!;
          const style = getComputedStyle(drawer);
          const summary = document.querySelector<HTMLElement>('details.topnav-mobile > summary')!;
          const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
          return {
            rect: drawer.getBoundingClientRect().toJSON(),
            maxHeight: style.maxHeight,
            minHeight: style.minHeight,
            boxSizing: style.boxSizing,
            overflowY: style.overflowY,
            padding: [style.paddingTop, style.paddingBottom],
            border: [style.borderTopWidth, style.borderBottomWidth],
            summary: summary.getBoundingClientRect().toJSON(),
            header: document.querySelector<HTMLElement>('header.topnav')!.getBoundingClientRect().toJSON(),
            port: port.getBoundingClientRect().toJSON(),
            cssLimit: getComputedStyle(document.body).getPropertyValue('--chat-drawer-max-height').trim(),
          };
        })(),
      }));
      expect(shrunkDrawer.drawerBottom, `${width}: open menu resizes to reduced visual viewport without manual scrolling ${JSON.stringify(shrunkDrawer.drawer)}`).toBeLessThanOrEqual(shrunkDrawer.portBottom + 1);
      expect(shrunkDrawer.scrollTop, `${width}: popup resize does not move the page scrollport`).toBe(beforeShrinkScroll);
      const initial = await page.evaluate(() => ({
        drawer: document.querySelector<HTMLElement>('.topnav-drawer')!.getBoundingClientRect().toJSON(),
        port: document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect().toJSON(),
      }));
      expect(initial.drawer.top, `${width}: mobile menu stays inside the clipped content region`).toBeGreaterThanOrEqual(initial.port.top - 1);
      expect(initial.drawer.bottom, `${width}: mobile menu starts and ends inside the clipped content region`).toBeLessThanOrEqual(initial.port.bottom + 1);

      await drawer.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
      const lastPhone = drawer.locator('.drawer-phone').last();
      const lastLink = await lastPhone.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const menu = el.closest<HTMLElement>('.topnav-drawer')!.getBoundingClientRect();
        const clip = document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect();
        return {
          visible: rect.top >= menu.top && rect.bottom <= menu.bottom && rect.top >= clip.top && rect.bottom <= clip.bottom,
          text: el.textContent?.trim(),
        };
      });
      expect(lastLink.text, `${width}: last phone link remains the final menu control`).toBeTruthy();
      expect(lastLink.visible, `${width}: last menu control is reachable within the visible scrollport`).toBe(true);

      await page.evaluate(() => (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void })
        .__setVisualViewportForTest?.(420, 0));
      const openSearch = page.locator('[data-search-open]');
      await openSearch.scrollIntoViewIfNeeded();
      await openSearch.evaluate((button) => button.addEventListener('click', () => {
        const search = document.querySelector<HTMLElement>('#header-search');
        const toggle = document.querySelector<HTMLElement>('#header-search-toggle');
        const details = button.closest('details');
        (window as Window & { __searchButtonClickState?: unknown }).__searchButtonClickState = {
          hidden: search?.hidden,
          expanded: toggle?.getAttribute('aria-expanded'),
          detailsOpen: details instanceof HTMLDetailsElement ? details.open : null,
        };
      }, { once: true }));
      await openSearch.click();
      const search = page.locator('#header-search');
      const closeSearch = page.locator('#header-search-close');
      const searchOpenState = await page.evaluate(() => ({
        hidden: document.querySelector<HTMLElement>('#header-search')?.hidden,
        expanded: document.querySelector<HTMLElement>('#header-search-toggle')?.getAttribute('aria-expanded'),
        captured: (window as Window & { __searchButtonCapture?: boolean }).__searchButtonCapture ?? false,
        clickState: (window as Window & { __searchButtonClickState?: unknown }).__searchButtonClickState,
        scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
      }));
      await expect(search, `search popup state ${JSON.stringify(searchOpenState)}; ${browserDiagnostics.join(' | ')}`).toBeVisible();
      await closeSearch.scrollIntoViewIfNeeded();
      const searchBounds = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('#header-search')!.getBoundingClientRect();
        const close = document.querySelector<HTMLElement>('#header-search-close')!.getBoundingClientRect();
        const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect();
        return {
          panelTop: panel.top,
          panelBottom: panel.bottom,
          portTop: port.top,
          portBottom: port.bottom,
          closeInside: close.top >= panel.top && close.bottom <= panel.bottom
            && close.top >= port.top && close.bottom <= port.bottom,
        };
      });
      expect(searchBounds.panelTop, `${width}: search popup starts inside the clipped scrollport`).toBeGreaterThanOrEqual(searchBounds.portTop - 1);
      expect(searchBounds.panelBottom, `${width}: search popup fits under the reduced visual viewport`).toBeLessThanOrEqual(searchBounds.portBottom + 1);
      expect(searchBounds.closeInside, `${width}: search has a reachable close control in its clipped region`).toBe(true);

      const query = page.locator('#header-search-pagefind .pagefind-ui__search-input');
      await expect(query, `${width}: search input is available in the popup`).toBeVisible();
      await query.fill('семинар');
      const results = page.locator('#header-search-pagefind .pagefind-ui__result');
      await expect.poll(() => results.count(), `${width}: local Pagefind returns results`).toBeGreaterThan(0);
      const resultDrawer = page.locator('#header-search-pagefind .pagefind-ui__drawer');
      const lastResult = results.last();
      await resultDrawer.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
      const lastTitleLink = lastResult.locator('.pagefind-ui__result-link');
      await lastTitleLink.scrollIntoViewIfNeeded();
      const inspectTitleLines = async () => lastTitleLink.evaluate((el) => {
        const drawerElement = el.closest<HTMLElement>('.pagefind-ui__drawer')!;
        const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
        const pageScrollTop = port.scrollTop;
        const range = document.createRange();
        range.selectNodeContents(el);
        const initialDrawerTop = drawerElement.getBoundingClientRect().top;
        const initialLines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => ({ contentTop: rect.top - initialDrawerTop + drawerElement.scrollTop, height: rect.height }));
        el.focus();
        const lines = initialLines.map((line) => {
          const maxScroll = drawerElement.scrollHeight - drawerElement.clientHeight;
          drawerElement.scrollTop = Math.max(0, Math.min(maxScroll,
            line.contentTop - Math.max(0, (drawerElement.clientHeight - line.height) / 2)));
          const rect = [...range.getClientRects()].filter((candidate) => candidate.width > 0 && candidate.height > 0)
            .map((candidate) => candidate.toJSON()).find((candidate) => {
              const drawerTop = drawerElement.getBoundingClientRect().top;
              return Math.abs(candidate.top - drawerTop + drawerElement.scrollTop - line.contentTop) < 2;
            });
          if (!rect) return { ...line, reachable: false, reason: 'line-not-found-after-scroll' };
          const drawer = drawerElement.getBoundingClientRect();
          const panel = el.closest<HTMLElement>('#header-search')!.getBoundingClientRect();
          const clip = port.getBoundingClientRect();
          const centerX = Math.max(rect.left, Math.min(rect.right, el.getBoundingClientRect().right)) - 1;
          const centerY = (rect.top + rect.bottom) / 2;
          const hit = document.elementFromPoint(centerX, centerY);
          return {
            ...line,
            rect,
            drawerTop: drawer.top,
            drawerBottom: drawer.bottom,
            panelTop: panel.top,
            panelBottom: panel.bottom,
            clipTop: clip.top,
            clipBottom: clip.bottom,
            hitLink: Boolean(hit && (hit === el || el.contains(hit))),
            reachable: rect.top >= drawer.top && rect.bottom <= drawer.bottom
              && rect.top >= panel.top && rect.bottom <= panel.bottom
              && rect.top >= clip.top && rect.bottom <= clip.bottom
              && Boolean(hit && (hit === el || el.contains(hit))),
          };
        });
        range.detach();
        return {
          lineCount: initialLines.length,
          lines,
          focused: document.activeElement === el,
          isKeyboardLink: el instanceof HTMLAnchorElement && el.hasAttribute('href') && el.tabIndex >= 0,
          pageScrollTopBefore: pageScrollTop,
          pageScrollTopAfter: port.scrollTop,
          drawer: { scrollTop: drawerElement.scrollTop, scrollHeight: drawerElement.scrollHeight, clientHeight: drawerElement.clientHeight },
          title: el.getBoundingClientRect().toJSON(),
        };
      });
      const lastResultBounds = await inspectTitleLines();
      if (width === 320) console.log(`320px final search control bounds: ${JSON.stringify(lastResultBounds)}`);
      expect(lastResultBounds.lineCount, `${width}: final title contains reachable text lines`).toBeGreaterThan(0);
      expect(lastResultBounds.lines.every((line) => line.reachable),
        `${width}: each final title line can be scrolled fully into the drawer and hit-tested: ${JSON.stringify(lastResultBounds)}`).toBe(true);
      expect(lastResultBounds.focused && lastResultBounds.isKeyboardLink,
        `${width}: the final search title remains a focusable actionable link`).toBe(true);
      expect(lastResultBounds.pageScrollTopAfter,
        `${width}: revealing search title lines changes only the nested result drawer`).toBe(lastResultBounds.pageScrollTopBefore);
      const beforeSearchShrinkScroll = await port.evaluate((el: HTMLElement) => el.scrollTop);
      await resultDrawer.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
      await page.evaluate(() => (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void })
        .__setVisualViewportForTest?.(340, 0));
      const resultsCanScroll = await resultDrawer.evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight);
      expect(resultsCanScroll, `${width}: search results remain scrollable after visual viewport shrink`).toBe(true);
      const resizedSearch = await inspectTitleLines();
      const resizedSearchBounds = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('#header-search')!.getBoundingClientRect();
        const close = document.querySelector<HTMLElement>('#header-search-close')!.getBoundingClientRect();
        const lastLink = document.querySelector<HTMLElement>('#header-search-pagefind .pagefind-ui__result:last-child .pagefind-ui__result-link')!;
        const last = lastLink.getBoundingClientRect();
        const card = lastLink.closest<HTMLElement>('.pagefind-ui__result')!.getBoundingClientRect();
        const drawer = document.querySelector<HTMLElement>('#header-search-pagefind .pagefind-ui__drawer')!;
        const drawerRect = drawer.getBoundingClientRect();
        const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
        const clip = port.getBoundingClientRect();
        return {
          panelBottom: panel.bottom,
          closeVisible: close.top >= panel.top && close.bottom <= panel.bottom && close.bottom <= clip.bottom,
          card: card.toJSON(),
          title: last.toJSON(),
          drawer: { rect: drawerRect.toJSON(), scrollTop: drawer.scrollTop, scrollHeight: drawer.scrollHeight, clientHeight: drawer.clientHeight },
          scrollTop: port.scrollTop,
          portBottom: clip.bottom,
        };
      });
      expect(resizedSearchBounds.panelBottom, `${width}: open search resizes to reduced visual viewport without manual scrolling`).toBeLessThanOrEqual(resizedSearchBounds.portBottom + 1);
      expect(resizedSearchBounds.closeVisible, `${width}: close control remains reachable after visual viewport shrink`).toBe(true);
      expect(resizedSearch.lines.every((line) => line.reachable),
        `${width}: each title line stays reachable after visual viewport shrink: ${JSON.stringify({ ...resizedSearch, bounds: resizedSearchBounds })}`).toBe(true);
      expect(resizedSearch.focused && resizedSearch.isKeyboardLink,
        `${width}: final title remains a focusable actionable link after shrink`).toBe(true);
      expect(resizedSearch.pageScrollTopAfter, `${width}: search resize and nested reveal do not move the page scrollport`).toBe(beforeSearchShrinkScroll);
    }
  });

  test('safe-area extends the native launcher reserve to 120px plus the measured inset', async ({ page }) => {
    await protectThirdParties(page);
    await page.setViewportSize({ width: 375, height: 640 });
    await page.goto(activeUrl('/'));
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 20 } });
    const expanded = await snapshotLayout(page);
    expect(expanded.safeAreaInset, 'CDP overrides the safe-area inset for this Chromium fixture').toBe(20);
    expect(expanded.lowerUsefulHeight ?? -Infinity, 'launcher reserve keeps 120 useful CSS px after inset').toBeGreaterThanOrEqual(120);
    expect(expanded.greetingVisible, 'greeting is visible in the expanded lower zone').toBe(true);
    expect(expanded.buttonInsideUsefulArea, 'capsule remains above the safe-area inset while greeting is visible').toBe(true);

    await page.locator(GREETING_CLOSE).click();
    await expect(page.locator(NATIVE_GREETING), 'dismissal hides the provider greeting').toHaveCount(0);
    const collapsed = await snapshotLayout(page);
    expect(collapsed.safeAreaInset, 'safe-area inset remains applied after dismissal').toBe(20);
    expect(collapsed.lowerUsefulHeight, 'reserved useful zone remains 120 CSS px').toBe(120);
    expect(collapsed.lowerZone?.height, '120px useful reserve plus 20px safe-area is 140px overall').toBe(140);
    expect(collapsed.buttonInsideUsefulArea, 'capsule remains inside the collapsed useful zone').toBe(true);
    const nativeBounds = await page.locator(NATIVE_LAUNCHER).boundingBox();
    expect(nativeBounds, 'native launcher remains after greeting dismissal').not.toBeNull();
    expect(nativeBounds!.y + nativeBounds!.height, 'dismissed native launcher stays above the 20px safe area inset')
      .toBeLessThanOrEqual(621);
    await expect(page.locator(NATIVE_LAUNCHER), 'native launcher persists after greeting dismissal').toBeVisible();
    await session.detach();
  });

  test('shared scrollport drives the header shadow and the no-IntersectionObserver reviews fallback', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: undefined });
    });
    await protectThirdParties(page);
    await page.setViewportSize({ width: 375, height: 420 });
    await page.goto(activeUrl('/'));
    const port = page.locator('[data-page-scrollport]');
    await expect(port).toHaveCount(1);
    const reviews = page.locator('[data-reviews-embed]').first();
    await expect(reviews).toHaveCount(1);
    const initial = await page.evaluate(() => {
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
      const box = document.querySelector<HTMLElement>('[data-reviews-embed]')!;
      return {
        port: port.getBoundingClientRect().toJSON(),
        box: box.getBoundingClientRect().toJSON(),
        hasFrame: Boolean(box.querySelector('iframe')),
      };
    });
    expect(initial.box.top, 'reviews start below the clipped visible region').toBeGreaterThanOrEqual(initial.port.bottom);
    expect(initial.hasFrame, 'fallback does not load the review iframe before the page scrollport reveals it').toBe(false);

    await port.evaluate((el: HTMLElement) => { el.scrollTop = 20; });
    await expect(page.locator('header.topnav')).toHaveAttribute('data-scrolled', '');
    await port.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
    await expect(page.locator('header.topnav')).not.toHaveAttribute('data-scrolled', '');

    await port.evaluate((el: HTMLElement) => {
      const box = document.querySelector<HTMLElement>('[data-reviews-embed]')!;
      el.scrollTop = Math.max(0, box.offsetTop - el.offsetTop);
    });
    await expect(reviews.locator('iframe')).toHaveCount(1);
  });

  test('layout resize and reduced visualViewport keep page fields and payment controls visible', async ({ page }) => {
    await protectThirdParties(page);
    await page.addInitScript(() => {
      const viewport = window.visualViewport;
      if (!viewport) return;
      const state = { height: viewport.height, offsetTop: viewport.offsetTop };
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => state.height });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => state.offsetTop });
      (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void }).__setVisualViewportForTest = (height, offsetTop) => {
        state.height = height;
        state.offsetTop = offsetTop;
        viewport.dispatchEvent(new Event('resize'));
      };
    });
    await page.setViewportSize({ width: 375, height: 420 });
    await page.goto(activeUrl('/raspisanie-i-tseny'));
    const pageField = page.locator('[data-schedule-search]');
    await expect(pageField, 'page contains the existing schedule search field').toHaveCount(1);
    await pageField.scrollIntoViewIfNeeded();
    await pageField.evaluate((field) => {
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
      const fieldRect = field.getBoundingClientRect();
      const portRect = port.getBoundingClientRect();
      port.scrollTop += fieldRect.bottom - (portRect.bottom - 20);
    });
    await pageField.focus();
    const pageFieldBeforeShrink = await pageField.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect();
      const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? port.top;
      const viewport = window.visualViewport;
      return rect.top >= Math.max(port.top, headerBottom, viewport?.offsetTop ?? 0)
        && rect.bottom <= Math.min(port.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight));
    });
    expect(pageFieldBeforeShrink, 'focused schedule search field starts inside the lower edge of the scrollport').toBe(true);
    await page.evaluate(() => (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void }).__setVisualViewportForTest?.(260, 20));
    await expect.poll(() => pageField.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect();
      const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? port.top;
      const viewport = window.visualViewport;
      return rect.top >= Math.max(port.top, headerBottom, viewport?.offsetTop ?? 0)
        && rect.bottom <= Math.min(port.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight));
    }), 'focused lower page field stays revealed when the visual viewport shrinks').toBe(true);
    const focusedBeforeWheel = await page.evaluate(() => ({
      active: document.activeElement === document.querySelector('[data-schedule-search]'),
      scrollTop: document.querySelector<HTMLElement>('[data-page-scrollport]')!.scrollTop,
    }));
    const wheelArea = await visibleScrollportGestureArea(page);
    expect(wheelArea.height, 'wheel target remains in visible scrollport below the sticky header and greeting zone').toBeGreaterThan(0);
    await page.mouse.move(wheelArea.x, (wheelArea.top + wheelArea.bottom) / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => page.locator('[data-page-scrollport]').evaluate((el) => el.scrollTop),
      'wheel scrolling can move away from the focused field').toBeGreaterThan(focusedBeforeWheel.scrollTop);
    await expect(page.locator(NATIVE_GREETING), 'wheel scrolling does not dismiss provider greeting').toBeVisible();
    expect(await page.evaluate(() => document.activeElement === document.querySelector('[data-schedule-search]')),
      'ordinary scrolling keeps the field focused without snapping the page back').toBe(focusedBeforeWheel.active);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/oplata'));
    const entry = page.locator(PAYMENT_ENTRY);
    await expect(entry, 'payment entry was enhanced into a real button').toHaveCount(1);
    await entry.click();
    await expect(page.locator(PAYMENT_DIALOG)).toBeVisible();
    const email = page.locator('#payment-email');
    await email.focus();
    await page.evaluate(() => {
      (window as Window & { __viewportResizeEvents?: number; __visualViewportResizeEvents?: number }).__viewportResizeEvents = 0;
      (window as Window & { __visualViewportResizeEvents?: number }).addEventListener('resize', () => {
        const state = window as Window & { __viewportResizeEvents?: number };
        state.__viewportResizeEvents = (state.__viewportResizeEvents ?? 0) + 1;
      }, { once: true });
      window.visualViewport?.addEventListener('resize', () => {
        const state = window as Window & { __visualViewportResizeEvents?: number };
        state.__visualViewportResizeEvents = (state.__visualViewportResizeEvents ?? 0) + 1;
      }, { once: true });
    });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void }).__setVisualViewportForTest?.(360, 0));
    await expect.poll(() => email.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const p = document.querySelector('.payment-dialog-panel')!.getBoundingClientRect();
      const vv = visualViewport;
      const visibleTop = Math.max(p.top, vv?.offsetTop ?? 0);
      const visibleBottom = Math.min(p.bottom, (vv?.offsetTop ?? 0) + (vv?.height ?? innerHeight));
      return r.top >= visibleTop && r.bottom <= visibleBottom;
    }), 'existing payment updater and focused-field reveal keep email visible after resize').toBe(true);
    const viewportMetrics = await page.evaluate(() => ({
      layoutHeight: innerHeight,
      visualHeight: visualViewport?.height ?? null,
      layoutEvents: (window as Window & { __viewportResizeEvents?: number }).__viewportResizeEvents ?? 0,
      visualEvents: (window as Window & { __visualViewportResizeEvents?: number }).__visualViewportResizeEvents ?? 0,
      safeAreaBottom: (() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;left:-10000px;padding-bottom:env(safe-area-inset-bottom)';
        document.body.append(probe);
        const inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
        probe.remove();
        return inset;
      })(),
    }));
    expect.soft(viewportMetrics.layoutHeight, 'layout viewport reflects the resized browser window').toBe(640);
    expect.soft(viewportMetrics.visualHeight, 'test fixture reduces the visual viewport while layout viewport remains 640px').toBe(360);
    expect.soft(viewportMetrics.layoutEvents, 'layout viewport resize event was delivered').toBeGreaterThan(0);
    expect.soft(viewportMetrics.visualEvents, 'visualViewport resize event was delivered').toBeGreaterThan(0);
    expect.soft(viewportMetrics.safeAreaBottom, 'headless Chromium reports the actual safe-area inset for this fixture').toBe(0);
    const lowerPaymentField = page.locator('#payment-consent');
    await lowerPaymentField.focus();
    await page.evaluate(() => (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void }).__setVisualViewportForTest?.(300, 0));
    await expect.poll(() => lowerPaymentField.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const panel = document.querySelector<HTMLElement>('.payment-dialog-panel')!.getBoundingClientRect();
      const vv = visualViewport;
      const top = Math.max(panel.top, vv?.offsetTop ?? 0);
      const bottom = Math.min(panel.bottom, (vv?.offsetTop ?? 0) + (vv?.height ?? innerHeight));
      return rect.top >= top && rect.bottom <= bottom;
    }), 'payment consent remains visible after a second keyboard viewport resize').toBe(true);
    const visibleBounds = await page.evaluate(() => {
      const vv = window.visualViewport!;
      const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return el.hasAttribute('data-page-scrollport') && el.contains(document.querySelector('main')) && /(auto|scroll)/.test(style.overflowY);
      });
      return { visibleBottom: vv.offsetTop + vv.height, portBottom: port?.getBoundingClientRect().bottom ?? null };
    });
    expect.soft(visibleBounds.portBottom, 'scrollport exists after visual viewport reduction').not.toBeNull();
    expect.soft(visibleBounds.portBottom ?? Infinity, 'scrollport follows reduced visual viewport').toBeLessThanOrEqual(visibleBounds.visibleBottom + 1);
    await page.setViewportSize({ width: 320, height: 300 });
    const nativeBounds = await page.locator(NATIVE_LAUNCHER).boundingBox();
    expect(nativeBounds, 'native launcher stays rendered after an actual browser viewport resize').not.toBeNull();
    expect(nativeBounds!.y + nativeBounds!.height, 'native launcher stays inside the actual resized layout viewport')
      .toBeLessThanOrEqual(301);
  });

  test('payment stays above late provider nodes, makes helper and chat inert, and restores scroll and focus', async ({ page }) => {
    await protectThirdParties(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/oplata'));
    const trigger = page.locator(KEYBOARD_HELPER);
    const nativeLauncher = page.locator(NATIVE_LAUNCHER);
    const root = page.locator(PAYMENT_ROOT);
    await expect(trigger, 'the compact keyboard helper is present').toHaveCount(1);
    await expect(nativeLauncher, 'provider launcher is injected by the ordinary SDK load').toBeVisible();
    await expect(root, 'real payment root is present').toHaveCount(1);
    await expect(page.locator(PAYMENT_FORM), 'real payment form is present').toHaveCount(1);
    await expect(page.locator(PAYMENT_ENTRY), 'actual payment opener is present').toHaveCount(1);

    const opener = page.locator(PAYMENT_ENTRY);
    await opener.scrollIntoViewIfNeeded();
    await opener.focus();
    await opener.click();
    await expect(page.locator(PAYMENT_DIALOG)).toBeVisible();
    await page.evaluate(() => {
      const lateProviderNode = document.createElement('div');
      lateProviderNode.setAttribute('data-chat-stub-late-launcher', '');
      lateProviderNode.style.cssText = 'position:fixed;right:50px;bottom:50px;width:66px;height:66px;z-index:10150';
      document.body.append(lateProviderNode);
    });
    await expect.poll(() => page.locator('[data-chat-stub-late-launcher]').evaluate((el) =>
      (el as HTMLElement).inert || el.closest('[inert]') !== null,
    ), 'a provider body child injected after payment opens becomes inert').toBe(true);
    const overlay = await page.evaluate((args) => {
      const paymentRoot = document.querySelector<HTMLElement>(args.root)!;
      const dialog = document.querySelector<HTMLElement>(args.dialog)!;
      const launcher = document.querySelector<HTMLElement>(args.launcher)!;
      const wrapper = document.querySelector<HTMLElement>('[data-chat-stub-wrapper]')!;
      const r = launcher.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const scrollport = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return el.hasAttribute('data-page-scrollport') && el.contains(document.querySelector('main')) && /(auto|scroll)/.test(style.overflowY);
      });
      return {
        paymentRootBodyChild: paymentRoot.parentElement === document.body,
        providerNodeBodyChild: launcher.parentElement === document.body,
        providerWrapperInert: wrapper.inert || wrapper.closest('[inert]') !== null,
        providerWrapperZ: Number.parseInt(getComputedStyle(wrapper).zIndex, 10),
        paymentRootOutsideScrollport: !scrollport?.contains(paymentRoot),
        dialogVisible: !dialog.hidden,
        dialogZ: Number.parseInt(getComputedStyle(dialog).zIndex, 10),
        helperInert: document.querySelector<HTMLElement>(args.helper)?.closest('[inert]') !== null,
        helperFocused: document.activeElement === document.querySelector<HTMLElement>(args.helper),
        launcherInert: launcher.inert || launcher.closest('[inert]') !== null,
        lateProviderNodeInert: (() => {
          const late = document.querySelector<HTMLElement>('[data-chat-stub-late-launcher]');
          return Boolean(late && (late.inert || late.closest('[inert]')));
        })(),
        scrollportFound: Boolean(scrollport),
        scrollportInert: scrollport?.inert ?? false,
        hitByOverlay: Boolean(hit && (dialog === hit || dialog.contains(hit))),
        activeInsideDialog: dialog.contains(document.activeElement),
      };
    }, { root: PAYMENT_ROOT, dialog: PAYMENT_DIALOG, launcher: NATIVE_LAUNCHER, helper: KEYBOARD_HELPER });
    expect.soft(overlay.paymentRootBodyChild, 'payment root is a direct body sibling outside the page scrollport').toBe(true);
    expect.soft(overlay.providerNodeBodyChild, 'provider launcher is injected outside the scrollport').toBe(true);
    expect.soft(overlay.paymentRootOutsideScrollport, 'payment dialog root stays outside the page scrollport').toBe(true);
    expect.soft(overlay.scrollportFound, 'page scrollport exists').toBe(true);
    expect.soft(overlay.scrollportInert, 'page scrollport is inert while payment is open').toBe(true);
    expect.soft(overlay.helperInert, 'site helper is inert while payment is open').toBe(true);
    expect.soft(overlay.launcherInert, 'late provider launcher is inert while payment is open').toBe(true);
    expect.soft(overlay.lateProviderNodeInert, 'late body-level provider insertion is inert while payment is open').toBe(true);
    expect.soft(overlay.providerWrapperZ, 'stub uses the measured provider wrapper layer').toBe(10150);
    expect.soft(overlay.dialogZ > overlay.providerWrapperZ!, 'payment overlay paints above native provider wrapper').toBe(true);
    expect.soft(overlay.hitByOverlay, 'click at the covered native launcher is intercepted by payment overlay').toBe(true);
    expect.soft(overlay.activeInsideDialog, 'focus is moved inside payment dialog').toBe(true);
    expect.soft(overlay.helperFocused, 'payment never moves focus to the helper').toBe(false);

    const dialogFocus = page.locator('.payment-dialog-close');
    await dialogFocus.focus();
    const lockedBeforeEscape = await snapshotLayout(page);
    await page.keyboard.press('PageDown');
    await page.mouse.wheel(0, 500);
    expect((await snapshotLayout(page)).scrollportScrollTop, 'PageDown and wheel input cannot move the background while payment is open')
      .toBe(lockedBeforeEscape.scrollportScrollTop);
    await page.keyboard.press('Escape');
    await expect(page.locator(PAYMENT_DIALOG), 'Escape closes the payment dialog through its existing behavior').toBeHidden();
    await expect(page.locator(NATIVE_CHOOSER), 'Escape while payment is active never opens the provider chooser').toHaveCount(0);
    expect(await page.evaluate((selector) => document.activeElement !== document.querySelector(selector), KEYBOARD_HELPER),
      'Escape in the payment focus cycle does not hand focus to the helper').toBe(true);
    await expect(opener, 'Escape restores focus to the payment opener').toBeFocused();
    await opener.click();
    await expect(page.locator(PAYMENT_DIALOG), 'payment dialog reopens for the remaining inert-input checks').toBeVisible();
    const before = await snapshotLayout(page);
    await dialogFocus.focus();
    const lockedBeforeTouch = await snapshotLayout(page);
    const session = await page.context().newCDPSession(page);
    await session.send('Input.synthesizeScrollGesture', { x: 180, y: 300, yDistance: -350, speed: 650, gestureSourceType: 'touch' });
    await session.detach();
    const afterBackgroundInput = await snapshotLayout(page);
    expect.soft(afterBackgroundInput.scrollportScrollTop, 'touch-like input cannot move the background while payment is reopened')
      .toBe(lockedBeforeTouch.scrollportScrollTop);

    await page.locator('[data-payment-close]').click();
    await expect(page.locator(PAYMENT_DIALOG)).toBeHidden();
    await expect(opener, 'focus returns to the original opener').toBeFocused();
    const after = await snapshotLayout(page);
    expect.soft(after.scrollportScrollTop, 'closing restores the page scroll position').toBe(before.scrollportScrollTop);
  });

  test('none, unset, demo output, and 404 do not reserve an empty chat slot', async ({ page }) => {
    await protectThirdParties(page);
    const cases = [
      { name: 'none', env: { CHAT_LOADER_SRC: 'none', PAYMENT_ROLE: 'ci', DEMO_FORMS: 'stub', DEMO_OUTPUT: undefined } },
      { name: 'unset', env: { CHAT_LOADER_SRC: undefined, PAYMENT_ROLE: 'ci', DEMO_FORMS: 'stub', DEMO_OUTPUT: undefined } },
      { name: 'demo', env: { CHAT_LOADER_SRC: PROBE_CHAT_LOADER_SRC, PAYMENT_ROLE: 'ci', DEMO_FORMS: 'stub', DEMO_OUTPUT: '1' } },
      { name: '404', site: activeSite, path: '/this-chat-entry-route-does-not-exist' },
    ];
    for (const entry of cases) {
      let build: ProbeBuild | undefined;
      let site: StaticSite | undefined;
      const { name } = entry;
      try {
        if ('env' in entry && entry.env) {
          build = buildProbe(name, entry.env, { keepOnDisk: true });
          site = await serveStatic(build.root!);
        } else {
          site = entry.site;
        }
        await page.setViewportSize({ width: 375, height: 812 });
        const response = await page.goto(`${site.origin}${'path' in entry ? entry.path : '/'}`);
        if (name === '404') expect(response?.status(), 'missing route resolves to the real 404').toBe(404);
        else expect(response?.status(), `${name} page exists`).toBe(200);
        await expect(page.locator(TRIGGER), `${name}: no chat trigger`).toHaveCount(0);
        await page.evaluate(() => {
        const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
          const style = getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY) && el.hasAttribute('data-page-scrollport')
            && el.contains(document.querySelector('main'));
        });
        if (port) port.scrollTo({ top: port.scrollHeight, behavior: 'instant' });
        else document.scrollingElement?.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        });
        await expect.poll(async () => page.locator('footer').evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight + 1), `${name}: scrolling reaches the footer in ordinary document flow`).toBe(true);
        const layout = await page.evaluate(() => {
        const header = document.querySelector('header');
        const main = document.querySelector('main');
        const footer = document.querySelector('footer');
        const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
          const style = getComputedStyle(el);
          return Boolean(header && main && footer && el.contains(header) && el.contains(main) && el.contains(footer))
            && /(auto|scroll)/.test(style.overflowY) && el.hasAttribute('data-page-scrollport');
        });
        const siblings = port?.parentElement ? [...port.parentElement.children].filter((el) => el !== port) : [];
        const visibleContent = (el: Element) => {
          const text = document.createRange();
          text.selectNodeContents(el);
          const hasText = [...text.getClientRects()].some((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight);
          text.detach();
          const hasControl = [...el.querySelectorAll('a,button,input,select,textarea,[role="button"]')]
            .some((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; });
          return hasText || hasControl;
        };
        const emptyReserveSibling = siblings.some((el) => {
          const r = el.getBoundingClientRect();
          return r.height >= 120 && r.bottom >= innerHeight - 1 && !visibleContent(el);
        });
        const portRect = port?.getBoundingClientRect();
        const footerRect = footer?.getBoundingClientRect();
        return {
          viewportHeight: innerHeight,
          scrollportFound: Boolean(port),
          documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
          documentMaxScroll: Math.max(0, (document.scrollingElement?.scrollHeight ?? 0) - innerHeight),
          footerBottom: footerRect?.bottom ?? 0,
          scrollportBottom: portRect?.bottom ?? null,
          emptyReserveSibling,
        };
        });
        await expect(page.locator(NATIVE_LAUNCHER), `${name}: disabled chat creates no provider launcher`).toHaveCount(0);
        expect.soft(layout.emptyReserveSibling, `${name}: no empty 120px chat reserve is created when chat is disabled`).toBe(false);
        if (layout.scrollportFound) {
          expect.soft(layout.scrollportBottom ?? -Infinity, `${name}: chatless scrollport reaches the viewport bottom`).toBeGreaterThanOrEqual(layout.viewportHeight - 1);
          expect.soft(layout.documentScrollTop, `${name}: chatless layout has no competing document scroll`).toBe(0);
        } else {
          expect.soft(layout.documentMaxScroll, `${name}: ordinary page flow remains document-scrollable`).toBeGreaterThan(0);
          expect.soft(layout.documentScrollTop, `${name}: ordinary document scroll reaches the footer`).toBeGreaterThan(0);
          expect.soft(layout.footerBottom, `${name}: ordinary document scrolling reaches the footer`).toBeLessThanOrEqual(layout.viewportHeight + 1);
        }
      } finally {
        if ('env' in entry) {
          await site?.close();
          build?.dispose();
        }
      }
    }
  });
});
