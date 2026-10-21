# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat-entry-visibility.spec.ts >> chat entry visibility approved contract >> anchor, history, wheel, touch-like scroll, keyboard scroll, and focus reveal stay in the shared scrollport
- Location: tests/chat-entry-visibility.spec.ts:351:3

# Error details

```
Error: PageDown advances the shared scrollport

PageDown advances the shared scrollport

expect(received).toBeGreaterThan(expected)

Expected: > 480
Received:   480

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Test source

```ts
  275 |     await page.goto(activeUrl('/'));
  276 |     for (const width of WIDTHS) {
  277 |       for (const theme of ['light', 'dark'] as const) await contrastAndButtonState(page, width, theme);
  278 |     }
  279 |   });
  280 | 
  281 |   test('page flow has one real scrollport and an 80px sibling lower zone without clipped visible overlap', async ({ page }) => {
  282 |     await protectThirdParties(page);
  283 |     const templates = TEMPLATES;
  284 |     expect(templates.map(({ name }) => name).filter((name) => TD52.has(name)).sort()).toEqual([...TD52].sort());
  285 | 
  286 |     for (const width of WIDTHS) {
  287 |       await page.setViewportSize({ width, height: width === 375 ? 812 : 720 });
  288 |       for (const { name, path } of templates) {
  289 |         const response = await page.goto(activeUrl(path));
  290 |         expect(response?.status(), `${name}: applicable page is present in this preview fixture`).toBe(200);
  291 |         await expect(page.locator(TRIGGER), `${name}: chat remains the subject`).toHaveCount(1);
  292 |         for (const position of ['start', 'middle', 'footer'] as const) {
  293 |           const before = await snapshotLayout(page);
  294 |           expect.soft(before.scrollportFound, `${name} ${width} ${position}: header/main/newsletter/footer share a real scrollport`).toBe(true);
  295 |           expect.soft(before.lowerZone, `${name} ${width} ${position}: adjacent lower zone exists`).not.toBeNull();
  296 |           expect.soft(before.lowerZone?.height, `${name} ${width} ${position}: useful lower-zone height is 80 CSS px at zero safe-area`).toBe(80);
  297 |           expect.soft(before.buttonParentIsBody, `${name} ${width} ${position}: button is outside the content scrollport`).toBe(false);
  298 |           expect.soft(before.buttonInsideScrollport, `${name} ${width} ${position}: button is not inside the content scrollport`).toBe(false);
  299 |           expect.soft(before.buttonInsideLowerZone, `${name} ${width} ${position}: button belongs to the separate lower zone`).toBe(true);
  300 |           expect.soft(before.scrollportEndsBeforeLowerZone, `${name} ${width} ${position}: scrollport ends before lower zone`).toBe(true);
  301 |           if (position === 'start') await page.evaluate(() => {
  302 |             const header = document.querySelector('header');
  303 |             const main = document.querySelector('main');
  304 |             const footer = document.querySelector('footer');
  305 |             const candidate = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
  306 |               const s = getComputedStyle(el);
  307 |               return Boolean(header && main && footer && el.contains(header) && el.contains(main) && el.contains(footer))
  308 |                 && /(auto|scroll)/.test(s.overflowY) && el.hasAttribute('data-page-scrollport');
  309 |             });
  310 |             if (candidate) candidate.scrollTop = 0;
  311 |             window.scrollTo(0, 0);
  312 |           });
  313 |           else if (position === 'middle') await page.evaluate(() => {
  314 |             const header = document.querySelector('header');
  315 |             const main = document.querySelector('main');
  316 |             const footer = document.querySelector('footer');
  317 |             const candidate = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
  318 |               const s = getComputedStyle(el);
  319 |               return Boolean(header && main && footer && el.contains(header) && el.contains(main) && el.contains(footer))
  320 |                 && /(auto|scroll)/.test(s.overflowY) && el.hasAttribute('data-page-scrollport');
  321 |             });
  322 |             if (candidate) candidate.scrollTop = (candidate.scrollHeight - candidate.clientHeight) / 2;
  323 |             else window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2);
  324 |           });
  325 |           else await page.evaluate(() => {
  326 |             const header = document.querySelector('header');
  327 |             const main = document.querySelector('main');
  328 |             const footer = document.querySelector('footer');
  329 |             const candidate = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
  330 |               const s = getComputedStyle(el);
  331 |               return Boolean(header && main && footer && el.contains(header) && el.contains(main) && el.contains(footer))
  332 |                 && /(auto|scroll)/.test(s.overflowY) && el.hasAttribute('data-page-scrollport');
  333 |             });
  334 |             if (candidate) candidate.scrollTop = candidate.scrollHeight;
  335 |             else window.scrollTo(0, document.documentElement.scrollHeight);
  336 |           });
  337 |           await page.waitForTimeout(40);
  338 |           const measured = await snapshotLayout(page);
  339 |           expect.soft(measured.scrollportFound, `${name} ${width} ${position}: scrolling content is the shared scrollport`).toBe(true);
  340 |           expect.soft(measured.overlap, `${name} ${width} ${position}: no visible clipped text/control intersects the trigger`).toEqual([]);
  341 |           expect.soft(measured.documentScrollTop, `${name} ${width} ${position}: document has no competing scroll position`).toBe(0);
  342 |           if (position === 'start') expect.soft(measured.scrollportScrollTop, `${name} ${width}: start position resets the shared scrollport`).toBe(0);
  343 |           if (position !== 'start' && measured.scrollportScrollHeight > measured.scrollportClientHeight + 1) {
  344 |             expect.soft(measured.scrollportScrollTop, `${name} ${width}: ${position} position scrolls a long shared scrollport`).toBeGreaterThan(0);
  345 |           }
  346 |         }
  347 |       }
  348 |     }
  349 |   });
  350 | 
  351 |   test('anchor, history, wheel, touch-like scroll, keyboard scroll, and focus reveal stay in the shared scrollport', async ({ page }) => {
  352 |     await protectThirdParties(page);
  353 |     for (const width of WIDTHS) {
  354 |       await page.setViewportSize({ width, height: 420 });
  355 |       await page.goto(activeUrl('/institut-apledzhera#programs'));
  356 |       const hasTarget = await page.locator('#programs').count();
  357 |       expect(hasTarget, 'anchor target is present on the selected page').toBe(1);
  358 |       const scroll = await snapshotLayout(page);
  359 |       expect.soft(scroll.scrollportFound, 'anchor navigation uses a real shared scrollport').toBe(true);
  360 |       const targetVisible = await page.locator('#programs').evaluate((el) => {
  361 |         const target = el.getBoundingClientRect();
  362 |         const header = document.querySelector('header')?.getBoundingClientRect();
  363 |         return target.top >= (header?.bottom ?? 0) && target.top < innerHeight;
  364 |       });
  365 |       expect.soft(targetVisible, '#programs is revealed below the sticky header').toBe(true);
  366 | 
  367 |       await page.goto(activeUrl('/raspisanie-i-tseny'));
  368 |       const beforeWheel = (await snapshotLayout(page)).scrollportScrollTop;
  369 |       await page.mouse.wheel(0, 480);
  370 |       await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
  371 |         'wheel advances the shared scrollport').toBeGreaterThan(beforeWheel);
  372 |       const beforeKeyboard = (await snapshotLayout(page)).scrollportScrollTop;
  373 |       await page.keyboard.press('PageDown');
  374 |       await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
> 375 |         'PageDown advances the shared scrollport').toBeGreaterThan(beforeKeyboard);
      |                                                    ^ Error: PageDown advances the shared scrollport
  376 | 
  377 |       const session = await page.context().newCDPSession(page);
  378 |       const beforeTouch = (await snapshotLayout(page)).scrollportScrollTop;
  379 |       await session.send('Input.synthesizeScrollGesture', { x: 180, y: 300, yDistance: -420, speed: 650, gestureSourceType: 'touch' });
  380 |       await session.detach();
  381 |       await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
  382 |         'Chromium touch-like scroll gesture advances the shared scrollport').toBeGreaterThan(beforeTouch);
  383 | 
  384 |       await page.goto(activeUrl('/raspisanie-i-tseny'));
  385 |       await page.evaluate(() => {
  386 |         const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
  387 |           const style = getComputedStyle(el);
  388 |           return /(auto|scroll)/.test(style.overflowY) && el.hasAttribute('data-page-scrollport');
  389 |         });
  390 |         if (port) port.scrollTop = Math.max(0, port.scrollHeight - port.clientHeight - 180);
  391 |         else window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 180);
  392 |       });
  393 |       const schedulePosition = await snapshotLayout(page);
  394 |       const scheduleUrl = page.url();
  395 |       await page.goto(activeUrl('/kontakty'));
  396 |       await page.evaluate(() => {
  397 |         const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
  398 |           const style = getComputedStyle(el);
  399 |           return /(auto|scroll)/.test(style.overflowY) && el.hasAttribute('data-page-scrollport');
  400 |         });
  401 |         if (port) port.scrollTop = Math.max(0, port.scrollHeight - port.clientHeight - 120);
  402 |         else window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 120);
  403 |       });
  404 |       const contactsPosition = await snapshotLayout(page);
  405 |       await page.goBack();
  406 |       await expect(page).toHaveURL(scheduleUrl);
  407 |       await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
  408 |         'back restores the schedule scrollport position').toBe(schedulePosition.scrollportScrollTop);
  409 |       await page.goForward();
  410 |       await expect(page).toHaveURL(/kontakty/);
  411 |       await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
  412 |         'forward restores the contacts scrollport position').toBe(contactsPosition.scrollportScrollTop);
  413 | 
  414 |       const focusable = page.locator('footer a[href]').first();
  415 |       await focusable.focus();
  416 |       const focused = await focusable.evaluate((el) => {
  417 |         const rect = el.getBoundingClientRect();
  418 |         const host = [...document.querySelectorAll<HTMLElement>('body *')].find((candidate) => {
  419 |           const style = getComputedStyle(candidate);
  420 |           return /(auto|scroll)/.test(style.overflowY) && candidate.hasAttribute('data-page-scrollport') && candidate.contains(el);
  421 |         });
  422 |         const box = host?.getBoundingClientRect();
  423 |         return Boolean(box && rect.top >= box.top && rect.bottom <= box.bottom);
  424 |       });
  425 |       expect.soft(focused, 'keyboard focus reveal keeps the full footer control inside the shared scrollport').toBe(true);
  426 |     }
  427 |   });
  428 | 
  429 |   test('short mobile viewport keeps the full menu and search controls inside the shared scrollport', async ({ page }) => {
  430 |     await protectThirdParties(page);
  431 |     for (const width of [320, 375]) {
  432 |       await page.setViewportSize({ width, height: 420 });
  433 |       await page.goto(activeUrl('/'));
  434 |       const port = page.locator('[data-page-scrollport]');
  435 |       await expect(port).toHaveCount(1);
  436 |       await page.locator('details.topnav-mobile > summary').click();
  437 |       const drawer = page.locator('.topnav-drawer');
  438 |       await expect(drawer).toBeVisible();
  439 |       const initial = await page.evaluate(() => ({
  440 |         drawer: document.querySelector<HTMLElement>('.topnav-drawer')!.getBoundingClientRect().toJSON(),
  441 |         port: document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect().toJSON(),
  442 |       }));
  443 |       expect(initial.drawer.bottom, `${width}: mobile menu starts and ends inside the clipped content region`).toBeLessThanOrEqual(initial.port.bottom + 1);
  444 | 
  445 |       await drawer.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
  446 |       const lastPhone = drawer.locator('.drawer-phone').last();
  447 |       const lastLink = await lastPhone.evaluate((el) => {
  448 |         const rect = el.getBoundingClientRect();
  449 |         const menu = el.closest<HTMLElement>('.topnav-drawer')!.getBoundingClientRect();
  450 |         const clip = document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect();
  451 |         return {
  452 |           visible: rect.top >= menu.top && rect.bottom <= menu.bottom && rect.top >= clip.top && rect.bottom <= clip.bottom,
  453 |           text: el.textContent?.trim(),
  454 |         };
  455 |       });
  456 |       expect(lastLink.text, `${width}: last phone link remains the final menu control`).toBeTruthy();
  457 |       expect(lastLink.visible, `${width}: last menu control is reachable within the visible scrollport`).toBe(true);
  458 | 
  459 |       const openSearch = page.locator('[data-search-open]');
  460 |       await openSearch.scrollIntoViewIfNeeded();
  461 |       await openSearch.click();
  462 |       const search = page.locator('#header-search');
  463 |       const closeSearch = page.locator('#header-search-close');
  464 |       await expect(search).toBeVisible();
  465 |       await closeSearch.scrollIntoViewIfNeeded();
  466 |       const searchBounds = await page.evaluate(() => {
  467 |         const panel = document.querySelector<HTMLElement>('#header-search')!.getBoundingClientRect();
  468 |         const close = document.querySelector<HTMLElement>('#header-search-close')!.getBoundingClientRect();
  469 |         const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect();
  470 |         return {
  471 |           panelBottom: panel.bottom,
  472 |           closeInside: close.top >= panel.top && close.bottom <= panel.bottom
  473 |             && close.top >= port.top && close.bottom <= port.bottom,
  474 |         };
  475 |       });
```