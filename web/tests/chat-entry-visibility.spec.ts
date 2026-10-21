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
const FACADE = '[data-chat-facade]';
const PAYMENT_ROOT = '#payment-dialog-root';
const PAYMENT_DIALOG = '.payment-dialog';
const PAYMENT_ENTRY = '[data-payment-entry]';
const PAYMENT_FORM = '[data-payment-form]';

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

async function snapshotLayout(page: Page) {
  return page.evaluate((triggerSelector) => {
    const header = document.querySelector('header');
    const main = document.querySelector('main');
    const footer = document.querySelector('footer');
    const button = document.querySelector<HTMLElement>(triggerSelector);
    const candidates = [...document.querySelectorAll<HTMLElement>('body *')];
    const scrollport = candidates.find((el) => {
      const style = getComputedStyle(el);
      return Boolean(header && main && footer && el.contains(header) && el.contains(main) && el.contains(footer))
        && /(auto|scroll)/.test(style.overflowY)
        && el.hasAttribute('data-page-scrollport');
    }) ?? null;
    const frame = scrollport?.parentElement ?? null;
    const lowerZone = frame && button
      ? [...frame.children].find((el) => el !== scrollport && el.contains(button)) as HTMLElement | undefined
      : undefined;
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
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
    if (button) {
      const box = button.getBoundingClientRect();
      const hit = (r: { left: number; top: number; right: number; bottom: number }) =>
        r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim() || button.contains(node.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          const shown = visibleRect(r, clip);
          if (shown && hit(shown)) {
            overlaps.push(`text:${node.textContent.trim().slice(0, 32)}`);
            break;
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
        if (shown && hit(shown)) overlaps.push(`control:${el.tagName.toLowerCase()}:${el.textContent?.trim().slice(0, 24)}`);
      }
    }
    return {
      scrollport: rect(scrollport),
      scrollportFound: Boolean(scrollport),
      documentScrollHeight: document.documentElement.scrollHeight,
      pageFrameChildren: frame ? [...frame.children].map((el) => el.tagName.toLowerCase()) : [],
      lowerZone: rect(lowerZone ?? null),
      button: rect(button),
      buttonParentIsBody: button?.parentElement === document.body,
      buttonInsideScrollport: Boolean(scrollport && button && scrollport.contains(button)),
      scrollportScrollTop: scrollport?.scrollTop ?? 0,
      scrollportScrollHeight: scrollport?.scrollHeight ?? 0,
      scrollportClientHeight: scrollport?.clientHeight ?? 0,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      buttonInsideLowerZone: Boolean(lowerZone && button && lowerZone.contains(button)),
      scrollportEndsBeforeLowerZone: Boolean(scrollport && lowerZone && scrollport.getBoundingClientRect().bottom <= lowerZone.getBoundingClientRect().top + 1),
      overlap: overlaps.slice(0, 8),
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  }, TRIGGER);
}

async function contrastAndButtonState(page: Page, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: 720 });
  await page.locator('html').evaluate((el, value) => {
    if (value === 'dark') el.setAttribute('data-theme', 'dark');
    else el.removeAttribute('data-theme');
  }, theme);
  const trigger = page.locator(TRIGGER);
  await expect(trigger, 'non-demo probe must render an actual chat trigger').toHaveCount(1);
  await expect(trigger).toBeVisible();
  const before = await trigger.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const icon = el.querySelector<HTMLElement>('[aria-hidden="true"]');
    const caption = [...el.querySelectorAll<HTMLElement>('span')].find((node) =>
      !node.closest('[aria-hidden="true"]') && node.textContent?.trim() === 'Написать нам',
    );
    const iconRect = icon?.getBoundingClientRect();
    const range = document.createRange();
    if (caption) range.selectNodeContents(caption);
    const textRects = caption ? [...range.getClientRects()] : [];
    const captionStyle = caption ? getComputedStyle(caption) : null;
    return {
      label: el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '',
      captionText: caption?.textContent?.trim() ?? '',
      captionFontSize: captionStyle ? parseFloat(captionStyle.fontSize) : 0,
      captionVisible: Boolean(caption && captionStyle && captionStyle.display !== 'none'
        && captionStyle.visibility !== 'hidden' && Number(captionStyle.opacity) > 0
        && textRects.length === 1 && textRects[0].width > 0 && textRects[0].height > 0
        && textRects[0].left >= r.left && textRects[0].right <= r.right
        && textRects[0].top >= r.top && textRects[0].bottom <= r.bottom),
      height: r.height, width: r.width,
      paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight),
      gap: parseFloat(style.columnGap === 'normal' ? style.gap : style.columnGap),
      iconWidth: iconRect?.width ?? 0,
      iconHeight: iconRect?.height ?? 0,
    };
  });
  expect.soft(before.label, `${theme} ${width}: accessible name follows the visible caption`).toBe('Написать нам');
  expect.soft(before.captionText, `${theme} ${width}: visible caption is the expected one-line text`).toBe('Написать нам');
  expect.soft(before.captionFontSize, `${theme} ${width}: caption matches approved 14px mockup`).toBe(14);
  expect.soft(before.captionVisible, `${theme} ${width}: caption text is rendered on one visible line`).toBe(true);
  expect.soft(before.height, `${theme} ${width}: capsule height`).toBe(52);
  expect.soft(before.paddingLeft, `${theme} ${width}: left horizontal padding`).toBe(20);
  expect.soft(before.paddingRight, `${theme} ${width}: right horizontal padding`).toBe(20);
  expect.soft(before.gap, `${theme} ${width}: icon/caption gap`).toBe(10);
  expect.soft(before.iconWidth, `${theme} ${width}: icon width`).toBe(22);
  expect.soft(before.iconHeight, `${theme} ${width}: icon height`).toBe(22);

  const states: Array<{ name: string; activate: () => Promise<void> }> = [
    { name: 'normal', activate: async () => { await page.mouse.move(0, 0); await trigger.evaluate((el: HTMLElement) => el.blur()); } },
    { name: 'hover', activate: async () => { await trigger.hover(); } },
    { name: 'focus', activate: async () => {
      await trigger.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
    } },
  ];
  let unfocusedShadow = '';
  for (const state of states) {
    await state.activate();
    const metrics = await trigger.evaluate((el) => {
      const style = getComputedStyle(el);
      const caption = [...el.querySelectorAll<HTMLElement>('span')].find((node) =>
        !node.closest('[aria-hidden="true"]') && node.textContent?.trim() === 'Написать нам',
      );
      const textColor = caption ? getComputedStyle(caption).color : '';
      const rgb = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
      const linear = (v: number) => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; };
      const luminance = (value: string) => {
        const [r, g, b] = rgb(value).map(linear);
        return .2126 * r + .7152 * g + .0722 * b;
      };
      const fg = luminance(textColor);
      const bg = luminance(style.backgroundColor);
      return {
        ratio: caption ? (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) : 0,
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
        outlineColor: style.outlineColor,
        boxShadow: style.boxShadow,
        textFound: Boolean(caption),
      };
    });
    expect.soft(metrics.ratio, `${theme} ${width} ${state.name}: text contrast >= 4.5:1`).toBeGreaterThanOrEqual(4.5);
    expect.soft(metrics.textFound, `${theme} ${width} ${state.name}: actual visible caption has measurable text`).toBe(true);
    if (state.name === 'normal') unfocusedShadow = metrics.boxShadow;
    if (state.name === 'focus') {
      const outlineChannels = metrics.outlineColor.match(/[\d.]+/g)?.map(Number) ?? [];
      const outlineAlpha = outlineChannels.length >= 4 ? outlineChannels[3] : 1;
      const opaqueOutline = metrics.outlineStyle !== 'none' && metrics.outlineWidth > 0
        && outlineAlpha >= 0.99;
      const changedShadow = metrics.boxShadow !== unfocusedShadow && metrics.boxShadow !== 'none';
      const visibleFocus = opaqueOutline || changedShadow;
      expect.soft(visibleFocus,
        `${theme} ${width}: keyboard focus has a visible indicator`).toBe(true);
    }
  }
  await trigger.focus();
  await trigger.hover();
  await page.mouse.down();
  const pressed = await trigger.evaluate((el) => {
    const style = getComputedStyle(el);
    const caption = [...el.querySelectorAll<HTMLElement>('span')].find((node) =>
      !node.closest('[aria-hidden="true"]') && node.textContent?.trim() === 'Написать нам',
    );
    const color = caption ? getComputedStyle(caption).color : '';
    const luminance = (value: string) => {
      const parts = value.match(/[\d.]+/g)?.slice(0, 3).map((part) => Number(part) / 255) ?? [0, 0, 0];
      const [r, g, b] = parts.map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return .2126 * r + .7152 * g + .0722 * b;
    };
    const fg = luminance(color);
    const bg = luminance(style.backgroundColor);
    return { ratio: caption ? (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) : 0 };
  });
  // Release outside the trigger so this visual-state probe cannot activate the chat.
  await page.mouse.move(0, 0);
  await page.mouse.up();
  expect.soft(pressed.ratio, `${theme} ${width} pressed: actual caption contrast >= 4.5:1`).toBeGreaterThanOrEqual(4.5);
}

test.describe('chat entry visibility approved contract', () => {
  test('non-demo payment probe has both real product entry points and keeps the loader lazy until one activation', async ({ page }) => {
    const seen = await protectThirdParties(page);
    const response = await page.goto(activeUrl('/oplata'));
    expect(response?.status(), 'the non-demo payment page must be served').toBe(200);
    await expect(page.locator('[data-payment-role="preview"]'), 'payment preview role is present in this fixture').toHaveCount(1);
    await expect(page.locator(PAYMENT_FORM), 'a real payment form exists in this fixture').toHaveCount(1);
    const trigger = page.locator(TRIGGER);
    await expect(trigger, 'a real chat trigger exists in this fixture').toHaveCount(1);
    expect(seen.toHost(new URL(PROBE_CHAT_LOADER_SRC).hostname), 'loader request before activation').toEqual([]);
    await trigger.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('[data-chat-stub-panel]'), 'native Space activation opens the existing chat path').toHaveCount(1);
    expect(seen.toHost(new URL(PROBE_CHAT_LOADER_SRC).hostname), 'first activation loads once').toHaveLength(1);

    await page.goto(activeUrl('/oplata'));
    const enterTrigger = page.locator(TRIGGER);
    await expect(enterTrigger).toHaveCount(1);
    await enterTrigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-chat-stub-panel]'), 'native Enter activation opens the existing chat path').toHaveCount(1);
    expect(seen.toHost(new URL(PROBE_CHAT_LOADER_SRC).hostname), 'one Enter activation adds one loader request').toHaveLength(2);
  });

  test('label, capsule geometry, keyboard name, and text contrast hold in both themes and all widths', async ({ page }) => {
    await protectThirdParties(page);
    await page.goto(activeUrl('/'));
    for (const width of WIDTHS) {
      for (const theme of ['light', 'dark'] as const) await contrastAndButtonState(page, width, theme);
    }
  });

  test('page flow has one real scrollport and an 80px sibling lower zone without clipped visible overlap', async ({ page }) => {
    await protectThirdParties(page);
    const templates = TEMPLATES;
    expect(templates.map(({ name }) => name).filter((name) => TD52.has(name)).sort()).toEqual([...TD52].sort());

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 720 });
      for (const { name, path } of templates) {
        const response = await page.goto(activeUrl(path));
        expect(response?.status(), `${name}: applicable page is present in this preview fixture`).toBe(200);
        await expect(page.locator(TRIGGER), `${name}: chat remains the subject`).toHaveCount(1);
        for (const position of ['start', 'middle', 'footer'] as const) {
          const before = await snapshotLayout(page);
          expect.soft(before.scrollportFound, `${name} ${width} ${position}: header/main/newsletter/footer share a real scrollport`).toBe(true);
          expect.soft(before.lowerZone, `${name} ${width} ${position}: adjacent lower zone exists`).not.toBeNull();
          expect.soft(before.lowerZone?.height, `${name} ${width} ${position}: useful lower-zone height is 80 CSS px at zero safe-area`).toBe(80);
          expect.soft(before.buttonParentIsBody, `${name} ${width} ${position}: button is outside the content scrollport`).toBe(false);
          expect.soft(before.buttonInsideScrollport, `${name} ${width} ${position}: button is not inside the content scrollport`).toBe(false);
          expect.soft(before.buttonInsideLowerZone, `${name} ${width} ${position}: button belongs to the separate lower zone`).toBe(true);
          expect.soft(before.scrollportEndsBeforeLowerZone, `${name} ${width} ${position}: scrollport ends before lower zone`).toBe(true);
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

  test('anchor, history, wheel, touch-like scroll, keyboard scroll, and focus reveal stay in the shared scrollport', async ({ page }) => {
    await protectThirdParties(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 420 });
      await page.goto(activeUrl('/institut-apledzhera#programs'));
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

      await page.goto(activeUrl('/raspisanie-i-tseny'));
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
      const resetPort = async () => page.evaluate(() => {
        const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
        if (port) port.scrollTop = 0;
      });
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
      await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'PageDown advances by the useful page area below the sticky header')
        .toBe(Math.min(pageFocusBeforeKey.port.maxScroll, beforeKeyboard + usefulPageStep));
      await page.keyboard.press('PageUp');
      await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'PageUp returns to the scrollport start').toBe(0);
      await page.keyboard.press('End');
      await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'End reaches the scrollport bottom')
        .toBe(pageFocusBeforeKey.port.maxScroll);
      await page.keyboard.press('Home');
      await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'Home returns to the scrollport start').toBe(0);

      await resetPort();
      const beforeWheel = (await snapshotLayout(page)).scrollportScrollTop;
      await page.mouse.wheel(0, 480);
      await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
        'wheel advances the shared scrollport').toBeGreaterThan(beforeWheel);

      await resetPort();
      const session = await page.context().newCDPSession(page);
      const beforeTouch = (await snapshotLayout(page)).scrollportScrollTop;
      await session.send('Input.synthesizeScrollGesture', { x: 180, y: 300, yDistance: -420, speed: 650, gestureSourceType: 'touch' });
      await session.detach();
      await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
        'Chromium touch-like scroll gesture advances the shared scrollport').toBeGreaterThan(beforeTouch);

      await page.goto(activeUrl('/raspisanie-i-tseny'));
      await page.evaluate(() => {
        const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
          const style = getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY) && el.hasAttribute('data-page-scrollport');
        });
        if (port) port.scrollTop = Math.max(0, port.scrollHeight - port.clientHeight - 180);
        else window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 180);
      });
      const schedulePosition = await snapshotLayout(page);
      const scheduleUrl = page.url();
      await page.goto(activeUrl('/kontakty'));
      await page.evaluate(() => {
        const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
          const style = getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY) && el.hasAttribute('data-page-scrollport');
        });
        if (port) port.scrollTop = Math.max(0, port.scrollHeight - port.clientHeight - 120);
        else window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 120);
      });
      const contactsPosition = await snapshotLayout(page);
      await page.goBack();
      await expect(page).toHaveURL(scheduleUrl);
      await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
        'back restores the schedule scrollport position').toBe(schedulePosition.scrollportScrollTop);
      await page.goForward();
      await expect(page).toHaveURL(/kontakty/);
      await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
        'forward restores the contacts scrollport position').toBe(contactsPosition.scrollportScrollTop);

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
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/kontakty'));
    await page.goto(activeUrl('/'));
    const port = page.locator('[data-page-scrollport]');
    await expect(port).toHaveCount(1);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 500, behavior: 'instant' }));
    const anchor = page.locator('a[href="#upcoming"]').first();
    await expect(anchor).toBeVisible();
    await anchor.scrollIntoViewIfNeeded();
    const initialPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);
    await anchor.click();
    await expect(page).toHaveURL(/#upcoming$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop)).toBeGreaterThan(initialPosition);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 900, behavior: 'instant' }));
    const hashPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);
    await page.goto(activeUrl('/kontakty'));
    await page.goBack();
    await expect(page).toHaveURL(/#upcoming$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
      'full-page Back restores the hash entry position after a document change').toBe(hashPosition);
    await page.goBack();
    await expect(page).not.toHaveURL(/#upcoming$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
      'native same-document Back restores the measured pre-hash position').toBe(initialPosition);
    await page.goForward();
    await expect(page).toHaveURL(/#upcoming$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
      'native same-document Forward restores the measured hash-entry position').toBe(hashPosition);
    await page.goForward();
    await expect(page).toHaveURL(/kontakty/);
  });

  test('history keeps a forward fragment position after its document is left and reloaded', async ({ page }) => {
    await protectThirdParties(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/kontakty'));
    await page.goto(activeUrl('/'));
    const originalDocumentTime = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(() => window.addEventListener('unload', () => undefined));
    const port = page.locator('[data-page-scrollport]');
    await expect(port).toHaveCount(1);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 500, behavior: 'instant' }));
    const anchor = page.locator('a[href="#upcoming"]').first();
    await anchor.scrollIntoViewIfNeeded();
    const firstEntryPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);
    await anchor.click();
    await expect(page).toHaveURL(/#upcoming$/);
    await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 900, behavior: 'instant' }));
    const fragmentEntryPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);

    await page.goBack();
    await expect(page).not.toHaveURL(/#upcoming$/);
    await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop)).toBe(firstEntryPosition);
    await page.goBack();
    await expect(page).toHaveURL(/kontakty/);
    await page.evaluate(() => history.go(2));
    await expect(page).toHaveURL(/#upcoming$/);
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
        port: { top: portRect.top, bottom: portRect.bottom, scrollTop: port.scrollTop, scrollHeight: port.scrollHeight },
      };
    });
    expect(geometry.overflowY, `desktop dropdown must provide its own scroll when clipped: ${JSON.stringify(geometry)}`).toMatch(/auto|scroll/);
    expect(geometry.link.top, `last desktop dropdown link is unreachable at 1280x280: ${JSON.stringify(geometry)}`).toBeGreaterThanOrEqual(geometry.dropdown.top - 1);
    expect(geometry.link.bottom, `last desktop dropdown link is unreachable at 1280x280: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.dropdown.bottom + 1);
    expect(geometry.link.bottom, `last desktop dropdown link remains below the clipped scrollport: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.port.bottom + 1);
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
      const lastResultVisible = await lastResult.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const drawer = el.closest<HTMLElement>('.pagefind-ui__drawer')!.getBoundingClientRect();
        const panel = el.closest<HTMLElement>('#header-search')!.getBoundingClientRect();
        const clip = document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect();
        return rect.top >= drawer.top && rect.bottom <= drawer.bottom
          && rect.top >= panel.top && rect.bottom <= panel.bottom
          && rect.top >= clip.top && rect.bottom <= clip.bottom;
      });
      expect(lastResultVisible, `${width}: the final local search result remains reachable above the lower-zone clip`).toBe(true);
      const beforeSearchShrinkScroll = await port.evaluate((el: HTMLElement) => el.scrollTop);
      await resultDrawer.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
      await page.evaluate(() => (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void })
        .__setVisualViewportForTest?.(340, 0));
      const resultsCanScroll = await resultDrawer.evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight);
      expect(resultsCanScroll, `${width}: search results remain scrollable after visual viewport shrink`).toBe(true);
      await resultDrawer.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
      const resizedSearch = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('#header-search')!.getBoundingClientRect();
        const close = document.querySelector<HTMLElement>('#header-search-close')!.getBoundingClientRect();
        const results = [...document.querySelectorAll<HTMLElement>('#header-search-pagefind .pagefind-ui__result')];
        const last = results[results.length - 1]!.getBoundingClientRect();
        const drawer = document.querySelector<HTMLElement>('#header-search-pagefind .pagefind-ui__drawer')!;
        const drawerRect = drawer.getBoundingClientRect();
        const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
        const clip = port.getBoundingClientRect();
        const visibleHeight = Math.max(0, Math.min(last.bottom, drawerRect.bottom, panel.bottom, clip.bottom)
          - Math.max(last.top, drawerRect.top, panel.top, clip.top));
        return {
          panelBottom: panel.bottom,
          closeVisible: close.top >= panel.top && close.bottom <= panel.bottom && close.bottom <= clip.bottom,
          lastResultVisible: visibleHeight > 0,
          scrollTop: port.scrollTop,
          portBottom: clip.bottom,
        };
      });
      expect(resizedSearch.panelBottom, `${width}: open search resizes to reduced visual viewport without manual scrolling`).toBeLessThanOrEqual(resizedSearch.portBottom + 1);
      expect(resizedSearch.closeVisible, `${width}: close control remains reachable after visual viewport shrink`).toBe(true);
      expect(resizedSearch.lastResultVisible, `${width}: last result is reachable by scrolling only its results drawer after shrink`).toBe(true);
      expect(resizedSearch.scrollTop, `${width}: search resize does not move the page scrollport`).toBe(beforeSearchShrinkScroll);
    }
  });

  test('safe-area inset expands the separate lower zone while preserving the 80px useful area', async ({ page }) => {
    await protectThirdParties(page);
    await page.setViewportSize({ width: 375, height: 640 });
    await page.goto(activeUrl('/'));
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 20 } });
    const measured = await page.evaluate(() => {
      const facade = document.querySelector<HTMLElement>('[data-chat-facade]')!;
      const trigger = facade.querySelector<HTMLElement>('[data-chat-trigger]')!;
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
      const rect = facade.getBoundingClientRect();
      const button = trigger.getBoundingClientRect();
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-10000px;padding-bottom:env(safe-area-inset-bottom)';
      document.body.append(probe);
      const inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
      probe.remove();
      return {
        inset,
        lowerHeight: rect.height,
        usefulHeight: rect.height - inset,
        buttonInsideUsefulArea: button.top >= rect.top && button.bottom <= rect.bottom - inset,
        portBottom: port.getBoundingClientRect().bottom,
        lowerTop: rect.top,
      };
    });
    await session.detach();
    expect(measured.inset, 'CDP overrides the safe-area inset for this Chromium fixture').toBe(20);
    expect(measured.lowerHeight, 'safe area is added outside the useful lower-zone height').toBe(100);
    expect(measured.usefulHeight, 'lower zone retains 80 CSS px above the safe area').toBe(80);
    expect(measured.buttonInsideUsefulArea, 'capsule remains in the useful 80px portion').toBe(true);
    expect(measured.portBottom, 'scrollport ends before the full lower zone').toBeLessThanOrEqual(measured.lowerTop + 1);
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

  test('layout resize and reduced visualViewport keep the focused field and chat control visible', async ({ page }) => {
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
      return rect.top >= port.top && rect.bottom <= port.bottom;
    });
    expect(pageFieldBeforeShrink, 'focused schedule search field starts inside the lower edge of the scrollport').toBe(true);
    await page.evaluate(() => (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void }).__setVisualViewportForTest?.(260, 20));
    await expect.poll(() => pageField.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect();
      return rect.top >= port.top && rect.bottom <= port.bottom;
    }), 'focused lower page field stays revealed when the visual viewport shrinks').toBe(true);
    const focusedBeforeWheel = await page.evaluate(() => ({
      active: document.activeElement === document.querySelector('[data-schedule-search]'),
      scrollTop: document.querySelector<HTMLElement>('[data-page-scrollport]')!.scrollTop,
    }));
    await page.mouse.move(200, 120);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => page.locator('[data-page-scrollport]').evaluate((el) => el.scrollTop),
      'wheel scrolling can move away from the focused field').toBeGreaterThan(focusedBeforeWheel.scrollTop);
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
    const visibleBounds = await page.evaluate((triggerSelector) => {
      const vv = window.visualViewport!;
      const button = document.querySelector<HTMLElement>(triggerSelector)!.getBoundingClientRect();
      const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return el.hasAttribute('data-page-scrollport') && el.contains(document.querySelector('main')) && /(auto|scroll)/.test(style.overflowY);
      });
      return { buttonBottom: button.bottom, visibleBottom: vv.offsetTop + vv.height, portBottom: port?.getBoundingClientRect().bottom ?? null };
    }, TRIGGER);
    expect.soft(visibleBounds.buttonBottom, 'chat button stays inside reduced visual viewport').toBeLessThanOrEqual(visibleBounds.visibleBottom + 1);
    expect.soft(visibleBounds.portBottom, 'scrollport exists after visual viewport reduction').not.toBeNull();
    expect.soft(visibleBounds.portBottom ?? Infinity, 'scrollport follows reduced visual viewport').toBeLessThanOrEqual(visibleBounds.visibleBottom + 1);
  });

  test('payment overlay is a body-level sibling, blocks background input, and restores scroll and focus', async ({ page }) => {
    await protectThirdParties(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(activeUrl('/oplata'));
    const trigger = page.locator(TRIGGER);
    const root = page.locator(PAYMENT_ROOT);
    await expect(trigger, 'real chat trigger is present').toHaveCount(1);
    await expect(root, 'real payment root is present').toHaveCount(1);
    await expect(page.locator(PAYMENT_FORM), 'real payment form is present').toHaveCount(1);
    await expect(page.locator(PAYMENT_ENTRY), 'actual payment opener is present').toHaveCount(1);

    const opener = page.locator(PAYMENT_ENTRY);
    await opener.scrollIntoViewIfNeeded();
    await opener.focus();
    const before = await snapshotLayout(page);
    await opener.click();
    await expect(page.locator(PAYMENT_DIALOG)).toBeVisible();
    const overlay = await page.evaluate((args) => {
      const paymentRoot = document.querySelector<HTMLElement>(args.root)!;
      const dialog = document.querySelector<HTMLElement>(args.dialog)!;
      const chat = document.querySelector<HTMLElement>(args.chat)!;
      const button = chat.querySelector<HTMLElement>('button')!;
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const scrollport = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return el.hasAttribute('data-page-scrollport') && el.contains(document.querySelector('main')) && /(auto|scroll)/.test(style.overflowY);
      });
      return {
        paymentRootBodyChild: paymentRoot.parentElement === document.body,
        chatFacadeBodyChild: chat.parentElement === document.body,
        paymentRootOutsideScrollport: !scrollport?.contains(paymentRoot),
        dialogVisible: !dialog.hidden,
        dialogZ: Number.parseInt(getComputedStyle(dialog).zIndex, 10),
        chatZ: Number.parseInt(getComputedStyle(chat).zIndex, 10),
        chatInert: chat.inert,
        scrollportFound: Boolean(scrollport),
        scrollportInert: scrollport?.inert ?? false,
        hitByOverlay: Boolean(hit && (dialog === hit || dialog.contains(hit))),
        activeInsideDialog: dialog.contains(document.activeElement),
      };
    }, { root: PAYMENT_ROOT, dialog: PAYMENT_DIALOG, chat: FACADE });
    expect.soft(overlay.paymentRootBodyChild, 'payment root is a direct body sibling outside the page scrollport').toBe(true);
    expect.soft(overlay.chatFacadeBodyChild, 'chat facade remains a direct body sibling for existing inert behavior').toBe(true);
    expect.soft(overlay.paymentRootOutsideScrollport, 'payment dialog root stays outside the page scrollport').toBe(true);
    expect.soft(overlay.scrollportFound, 'page scrollport exists').toBe(true);
    expect.soft(overlay.scrollportInert, 'page scrollport is inert while payment is open').toBe(true);
    expect.soft(overlay.chatInert, 'chat is inert while payment is open').toBe(true);
    expect.soft(overlay.dialogZ > overlay.chatZ, 'payment overlay paints above chat').toBe(true);
    expect.soft(overlay.hitByOverlay, 'click at the covered chat button is intercepted by payment overlay').toBe(true);
    expect.soft(overlay.activeInsideDialog, 'focus is moved inside payment dialog').toBe(true);

    const dialogFocus = page.locator('.payment-dialog-close');
    await dialogFocus.focus();
    await page.keyboard.press('PageDown');
    await page.mouse.wheel(0, 500);
    const session = await page.context().newCDPSession(page);
    await session.send('Input.synthesizeScrollGesture', { x: 180, y: 300, yDistance: -350, speed: 650, gestureSourceType: 'touch' });
    await session.detach();
    const afterBackgroundInput = await snapshotLayout(page);
    expect.soft(afterBackgroundInput.scrollportScrollTop, 'keyboard/wheel/touch-like input cannot move background scrollport').toBe(before.scrollportScrollTop);

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
        const reservedSibling = siblings.some((el) => {
          const r = el.getBoundingClientRect();
          return Math.abs(r.height - 80) < 1 && r.bottom >= innerHeight - 1 && !visibleContent(el);
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
          reservedSibling,
        };
        });
        expect.soft(layout.reservedSibling, `${name}: no empty 80px sibling is reserved without chat`).toBe(false);
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
