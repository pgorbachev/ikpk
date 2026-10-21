# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat-entry-visibility.spec.ts >> chat entry visibility approved contract >> anchor, history, wheel, touch-like scroll, keyboard scroll, and focus reveal stay in the shared scrollport
- Location: tests/chat-entry-visibility.spec.ts:359:3

# Error details

```
Error: back restores the schedule scrollport position

back restores the schedule scrollport position

expect(received).toBe(expected) // Object.is equality

Expected: 22299
Received: 21795

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Test source

```ts
  433 |       await page.keyboard.press('PageUp');
  434 |       await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'PageUp returns to the scrollport start').toBe(0);
  435 |       await page.keyboard.press('End');
  436 |       await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'End reaches the scrollport bottom')
  437 |         .toBe(pageFocusBeforeKey.port.maxScroll);
  438 |       await page.keyboard.press('Home');
  439 |       await expect.poll(() => keyboardScrollport.evaluate((el) => el.scrollTop), 'Home returns to the scrollport start').toBe(0);
  440 | 
  441 |       await resetPort();
  442 |       const beforeWheel = (await snapshotLayout(page)).scrollportScrollTop;
  443 |       await page.mouse.wheel(0, 480);
  444 |       await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
  445 |         'wheel advances the shared scrollport').toBeGreaterThan(beforeWheel);
  446 | 
  447 |       await resetPort();
  448 |       const session = await page.context().newCDPSession(page);
  449 |       const beforeTouch = (await snapshotLayout(page)).scrollportScrollTop;
  450 |       await session.send('Input.synthesizeScrollGesture', { x: 180, y: 300, yDistance: -420, speed: 650, gestureSourceType: 'touch' });
  451 |       await session.detach();
  452 |       await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
  453 |         'Chromium touch-like scroll gesture advances the shared scrollport').toBeGreaterThan(beforeTouch);
  454 | 
  455 |       await page.goto(activeUrl('/raspisanie-i-tseny'));
  456 |       await page.evaluate(() => {
  457 |         const key = '__chatEntryHistoryDiagnosis';
  458 |         const snapshot = (label: string) => {
  459 |           const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
  460 |           const state = history.state && typeof history.state === 'object' ? history.state.__ikpkChatPageScroll : null;
  461 |           const saved = (() => { try { return JSON.parse(sessionStorage.getItem('ikpk.chat-page-scroll.v1') ?? '[]'); } catch { return null; } })();
  462 |           const entries = Array.isArray(saved) ? saved.filter((entry) => Array.isArray(entry) && entry[0] === state?.id) : [];
  463 |           const images = [...document.images];
  464 |           const item = {
  465 |             label,
  466 |             time: performance.now(),
  467 |             scrollTop: port?.scrollTop ?? null,
  468 |             scrollHeight: port?.scrollHeight ?? null,
  469 |             clientHeight: port?.clientHeight ?? null,
  470 |             maxScroll: port ? port.scrollHeight - port.clientHeight : null,
  471 |             fonts: document.fonts.status,
  472 |             images: { total: images.length, loaded: images.filter((image) => image.complete && image.naturalWidth > 0).length,
  473 |               pending: images.filter((image) => !image.complete).map((image) => image.currentSrc || image.src) },
  474 |             entry: state,
  475 |             storedEntry: entries[0] ?? null,
  476 |             active: document.activeElement instanceof HTMLElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : null,
  477 |           };
  478 |           const trace = JSON.parse(sessionStorage.getItem(key) ?? '[]');
  479 |           trace.push(item);
  480 |           sessionStorage.setItem(key, JSON.stringify(trace));
  481 |         };
  482 |         snapshot('schedule-ready');
  483 |         window.addEventListener('pagehide', () => snapshot('schedule-pagehide'));
  484 |         window.addEventListener('pageshow', () => {
  485 |           snapshot('schedule-pageshow-sync');
  486 |           requestAnimationFrame(() => snapshot('schedule-pageshow-raf'));
  487 |           setTimeout(() => snapshot('schedule-pageshow-timeout'), 0);
  488 |         });
  489 |         window.addEventListener('popstate', () => {
  490 |           snapshot('schedule-popstate-sync');
  491 |           requestAnimationFrame(() => snapshot('schedule-popstate-raf'));
  492 |           setTimeout(() => snapshot('schedule-popstate-timeout'), 0);
  493 |         });
  494 |         window.addEventListener('scroll', () => snapshot('schedule-scroll'), { passive: true });
  495 |       });
  496 |       await page.evaluate(() => {
  497 |         const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
  498 |           const style = getComputedStyle(el);
  499 |           return /(auto|scroll)/.test(style.overflowY) && el.hasAttribute('data-page-scrollport');
  500 |         });
  501 |         if (port) port.scrollTop = Math.max(0, port.scrollHeight - port.clientHeight - 180);
  502 |         else window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 180);
  503 |       });
  504 |       const schedulePosition = await snapshotLayout(page);
  505 |       const scheduleUrl = page.url();
  506 |       await page.goto(activeUrl('/kontakty'));
  507 |       await page.evaluate(() => {
  508 |         const port = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
  509 |           const style = getComputedStyle(el);
  510 |           return /(auto|scroll)/.test(style.overflowY) && el.hasAttribute('data-page-scrollport');
  511 |         });
  512 |         if (port) port.scrollTop = Math.max(0, port.scrollHeight - port.clientHeight - 120);
  513 |         else window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 120);
  514 |       });
  515 |       const contactsPosition = await snapshotLayout(page);
  516 |       await page.goBack();
  517 |       await expect(page).toHaveURL(scheduleUrl);
  518 |       await page.evaluate(() => {
  519 |         const trace = JSON.parse(sessionStorage.getItem('__chatEntryHistoryDiagnosis') ?? '[]');
  520 |         const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
  521 |         const state = history.state && typeof history.state === 'object' ? history.state.__ikpkChatPageScroll : null;
  522 |         trace.push({ label: 'schedule-after-back-poll', time: performance.now(), scrollTop: port?.scrollTop ?? null,
  523 |           scrollHeight: port?.scrollHeight ?? null, clientHeight: port?.clientHeight ?? null,
  524 |           maxScroll: port ? port.scrollHeight - port.clientHeight : null,
  525 |           fonts: document.fonts.status, images: { total: document.images.length,
  526 |             loaded: [...document.images].filter((image) => image.complete && image.naturalWidth > 0).length,
  527 |             pending: [...document.images].filter((image) => !image.complete).map((image) => image.currentSrc || image.src) },
  528 |           entry: state, saved: sessionStorage.getItem('ikpk.chat-page-scroll.v1') });
  529 |         sessionStorage.setItem('__chatEntryHistoryDiagnosis', JSON.stringify(trace));
  530 |         console.log(`HISTORY_DIAG ${JSON.stringify(trace)}`);
  531 |       });
  532 |       await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
> 533 |         'back restores the schedule scrollport position').toBe(schedulePosition.scrollportScrollTop);
      |                                                           ^ Error: back restores the schedule scrollport position
  534 |       await page.goForward();
  535 |       await expect(page).toHaveURL(/kontakty/);
  536 |       await expect.poll(async () => (await snapshotLayout(page)).scrollportScrollTop,
  537 |         'forward restores the contacts scrollport position').toBe(contactsPosition.scrollportScrollTop);
  538 | 
  539 |       const focusable = page.locator('footer a[href]').first();
  540 |       await focusable.focus();
  541 |       const focused = await focusable.evaluate((el) => {
  542 |         const rect = el.getBoundingClientRect();
  543 |         const host = [...document.querySelectorAll<HTMLElement>('body *')].find((candidate) => {
  544 |           const style = getComputedStyle(candidate);
  545 |           return /(auto|scroll)/.test(style.overflowY) && candidate.hasAttribute('data-page-scrollport') && candidate.contains(el);
  546 |         });
  547 |         const box = host?.getBoundingClientRect();
  548 |         return Boolean(box && rect.top >= box.top && rect.bottom <= box.bottom);
  549 |       });
  550 |       expect.soft(focused, 'keyboard focus reveal keeps the full footer control inside the shared scrollport').toBe(true);
  551 |     }
  552 |   });
  553 | 
  554 |   test('history restores distinct scroll positions for separate entries with the same URL', async ({ page }) => {
  555 |     await protectThirdParties(page);
  556 |     await page.setViewportSize({ width: 375, height: 812 });
  557 |     await page.goto(activeUrl('/raspisanie-i-tseny'));
  558 |     const port = page.locator('[data-page-scrollport]');
  559 |     await expect(port).toHaveCount(1);
  560 |     await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 400, behavior: 'instant' }));
  561 |     const entryUrl = page.url();
  562 |     await page.goto(activeUrl('/kontakty'));
  563 |     const contactsPort = page.locator('[data-page-scrollport]');
  564 |     await contactsPort.evaluate((el: HTMLElement) => el.scrollTo({ top: 700, behavior: 'instant' }));
  565 |     await page.goto(entryUrl);
  566 |     await expect(port).toHaveCount(1);
  567 |     await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 1300, behavior: 'instant' }));
  568 | 
  569 |     await page.goBack();
  570 |     await expect(page).toHaveURL(/kontakty/);
  571 |     await expect.poll(() => contactsPort.evaluate((el: HTMLElement) => el.scrollTop),
  572 |       'back restores the intermediary entry position').toBe(700);
  573 |     await page.goBack();
  574 |     await expect(page).toHaveURL(entryUrl);
  575 |     await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
  576 |       'back restores the first same-URL entry position').toBe(400);
  577 |     await page.goForward();
  578 |     await expect(page).toHaveURL(/kontakty/);
  579 |     await expect.poll(() => contactsPort.evaluate((el: HTMLElement) => el.scrollTop),
  580 |       'forward restores the intermediary entry position').toBe(700);
  581 |     await page.goForward();
  582 |     await expect(page).toHaveURL(entryUrl);
  583 |     await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
  584 |       'forward restores the second same-URL entry position').toBe(1300);
  585 |   });
  586 | 
  587 |   test('native same-document hash Back and Forward restore the shared scrollport', async ({ page }) => {
  588 |     await protectThirdParties(page);
  589 |     await page.setViewportSize({ width: 375, height: 812 });
  590 |     await page.goto(activeUrl('/kontakty'));
  591 |     await page.goto(activeUrl('/'));
  592 |     const port = page.locator('[data-page-scrollport]');
  593 |     await expect(port).toHaveCount(1);
  594 |     await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 500, behavior: 'instant' }));
  595 |     const anchor = page.locator('a[href="#upcoming"]').first();
  596 |     await expect(anchor).toBeVisible();
  597 |     await anchor.scrollIntoViewIfNeeded();
  598 |     const initialPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);
  599 |     await anchor.click();
  600 |     await expect(page).toHaveURL(/#upcoming$/);
  601 |     await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop)).toBeGreaterThan(initialPosition);
  602 |     await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 900, behavior: 'instant' }));
  603 |     const hashPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);
  604 |     await page.goto(activeUrl('/kontakty'));
  605 |     await page.goBack();
  606 |     await expect(page).toHaveURL(/#upcoming$/);
  607 |     await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
  608 |       'full-page Back restores the hash entry position after a document change').toBe(hashPosition);
  609 |     await page.goBack();
  610 |     await expect(page).not.toHaveURL(/#upcoming$/);
  611 |     await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
  612 |       'native same-document Back restores the measured pre-hash position').toBe(initialPosition);
  613 |     await page.goForward();
  614 |     await expect(page).toHaveURL(/#upcoming$/);
  615 |     await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
  616 |       'native same-document Forward restores the measured hash-entry position').toBe(hashPosition);
  617 |     await page.goForward();
  618 |     await expect(page).toHaveURL(/kontakty/);
  619 |   });
  620 | 
  621 |   test('history keeps a forward fragment position after its document is left and reloaded', async ({ page }) => {
  622 |     await protectThirdParties(page);
  623 |     await page.setViewportSize({ width: 375, height: 812 });
  624 |     await page.goto(activeUrl('/kontakty'));
  625 |     await page.goto(activeUrl('/'));
  626 |     const originalDocumentTime = await page.evaluate(() => performance.timeOrigin);
  627 |     await page.evaluate(() => window.addEventListener('unload', () => undefined));
  628 |     const port = page.locator('[data-page-scrollport]');
  629 |     await expect(port).toHaveCount(1);
  630 |     await port.evaluate((el: HTMLElement) => el.scrollTo({ top: 500, behavior: 'instant' }));
  631 |     const anchor = page.locator('a[href="#upcoming"]').first();
  632 |     await anchor.scrollIntoViewIfNeeded();
  633 |     const firstEntryPosition = await port.evaluate((el: HTMLElement) => el.scrollTop);
```