# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat-entry-visibility.spec.ts >> chat entry visibility approved contract >> short mobile viewport keeps the full menu and search controls inside the shared scrollport
- Location: tests/chat-entry-visibility.spec.ts:682:3

# Error details

```
Error: 320: each final title line can be scrolled fully into the drawer and hit-tested: {"lineCount":4,"lines":[{"contentTop":1418.25,"height":21,"rect":{"x":35.390625,"y":34.25,"width":106.671875,"height":21,"top":34.25,"right":142.0625,"bottom":55.25,"left":35.390625},"drawerTop":87.8125,"drawerBottom":178.53125,"panelTop":22.234375,"panelBottom":190.71875,"clipTop":0,"clipBottom":340,"hitLink":false,"reachable":false},{"contentTop":1446.796875,"height":21,"rect":{"x":35.390625,"y":33.796875,"width":170.125,"height":21,"top":33.796875,"right":205.515625,"bottom":54.796875,"left":35.390625},"drawerTop":87.8125,"drawerBottom":178.53125,"panelTop":22.234375,"panelBottom":190.71875,"clipTop":0,"clipBottom":340,"hitLink":false,"reachable":false},{"contentTop":1475.34375,"height":21,"rect":{"x":35.390625,"y":34.34375,"width":178.734375,"height":21,"top":34.34375,"right":214.125,"bottom":55.34375,"left":35.390625},"drawerTop":87.8125,"drawerBottom":178.53125,"panelTop":22.234375,"panelBottom":190.71875,"clipTop":0,"clipBottom":340,"hitLink":false,"reachable":false},{"contentTop":1503.890625,"height":21,"rect":{"x":35.390625,"y":33.890625,"width":57.15625,"height":21,"top":33.890625,"right":92.546875,"bottom":54.890625,"left":35.390625},"drawerTop":87.8125,"drawerBottom":178.53125,"panelTop":22.234375,"panelBottom":190.71875,"clipTop":0,"clipBottom":340,"hitLink":false,"reachable":false}],"focused":true,"isKeyboardLink":true,"pageScrollTopBefore":0,"pageScrollTopAfter":0,"drawer":{"scrollTop":1470,"scrollHeight":1619,"clientHeight":89},"title":{"x":35.390625,"y":-51.75,"width":178.734375,"height":106.640625,"top":-51.75,"right":214.125,"bottom":54.890625,"left":35.390625}}

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  773 |         (window as Window & { __searchButtonClickState?: unknown }).__searchButtonClickState = {
  774 |           hidden: search?.hidden,
  775 |           expanded: toggle?.getAttribute('aria-expanded'),
  776 |           detailsOpen: details instanceof HTMLDetailsElement ? details.open : null,
  777 |         };
  778 |       }, { once: true }));
  779 |       await openSearch.click();
  780 |       const search = page.locator('#header-search');
  781 |       const closeSearch = page.locator('#header-search-close');
  782 |       const searchOpenState = await page.evaluate(() => ({
  783 |         hidden: document.querySelector<HTMLElement>('#header-search')?.hidden,
  784 |         expanded: document.querySelector<HTMLElement>('#header-search-toggle')?.getAttribute('aria-expanded'),
  785 |         captured: (window as Window & { __searchButtonCapture?: boolean }).__searchButtonCapture ?? false,
  786 |         clickState: (window as Window & { __searchButtonClickState?: unknown }).__searchButtonClickState,
  787 |         scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
  788 |       }));
  789 |       await expect(search, `search popup state ${JSON.stringify(searchOpenState)}; ${browserDiagnostics.join(' | ')}`).toBeVisible();
  790 |       await closeSearch.scrollIntoViewIfNeeded();
  791 |       const searchBounds = await page.evaluate(() => {
  792 |         const panel = document.querySelector<HTMLElement>('#header-search')!.getBoundingClientRect();
  793 |         const close = document.querySelector<HTMLElement>('#header-search-close')!.getBoundingClientRect();
  794 |         const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!.getBoundingClientRect();
  795 |         return {
  796 |           panelTop: panel.top,
  797 |           panelBottom: panel.bottom,
  798 |           portTop: port.top,
  799 |           portBottom: port.bottom,
  800 |           closeInside: close.top >= panel.top && close.bottom <= panel.bottom
  801 |             && close.top >= port.top && close.bottom <= port.bottom,
  802 |         };
  803 |       });
  804 |       expect(searchBounds.panelTop, `${width}: search popup starts inside the clipped scrollport`).toBeGreaterThanOrEqual(searchBounds.portTop - 1);
  805 |       expect(searchBounds.panelBottom, `${width}: search popup fits under the reduced visual viewport`).toBeLessThanOrEqual(searchBounds.portBottom + 1);
  806 |       expect(searchBounds.closeInside, `${width}: search has a reachable close control in its clipped region`).toBe(true);
  807 | 
  808 |       const query = page.locator('#header-search-pagefind .pagefind-ui__search-input');
  809 |       await expect(query, `${width}: search input is available in the popup`).toBeVisible();
  810 |       await query.fill('семинар');
  811 |       const results = page.locator('#header-search-pagefind .pagefind-ui__result');
  812 |       await expect.poll(() => results.count(), `${width}: local Pagefind returns results`).toBeGreaterThan(0);
  813 |       const resultDrawer = page.locator('#header-search-pagefind .pagefind-ui__drawer');
  814 |       const lastResult = results.last();
  815 |       await resultDrawer.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
  816 |       const lastTitleLink = lastResult.locator('.pagefind-ui__result-link');
  817 |       await lastTitleLink.scrollIntoViewIfNeeded();
  818 |       const inspectTitleLines = async () => lastTitleLink.evaluate((el) => {
  819 |         const drawerElement = el.closest<HTMLElement>('.pagefind-ui__drawer')!;
  820 |         const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
  821 |         const pageScrollTop = port.scrollTop;
  822 |         const range = document.createRange();
  823 |         range.selectNodeContents(el);
  824 |         const initialLines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
  825 |           .map((rect) => ({ contentTop: rect.top + drawerElement.scrollTop, height: rect.height }));
  826 |         el.focus();
  827 |         const lines = initialLines.map((line) => {
  828 |           const maxScroll = drawerElement.scrollHeight - drawerElement.clientHeight;
  829 |           drawerElement.scrollTop = Math.max(0, Math.min(maxScroll,
  830 |             line.contentTop - Math.max(0, (drawerElement.clientHeight - line.height) / 2)));
  831 |           const rect = [...range.getClientRects()].filter((candidate) => candidate.width > 0 && candidate.height > 0)
  832 |             .map((candidate) => candidate.toJSON()).find((candidate) =>
  833 |               Math.abs(candidate.top + drawerElement.scrollTop - line.contentTop) < 2);
  834 |           if (!rect) return { ...line, reachable: false, reason: 'line-not-found-after-scroll' };
  835 |           const drawer = drawerElement.getBoundingClientRect();
  836 |           const panel = el.closest<HTMLElement>('#header-search')!.getBoundingClientRect();
  837 |           const clip = port.getBoundingClientRect();
  838 |           const centerX = Math.max(rect.left, Math.min(rect.right, el.getBoundingClientRect().right)) - 1;
  839 |           const centerY = (rect.top + rect.bottom) / 2;
  840 |           const hit = document.elementFromPoint(centerX, centerY);
  841 |           return {
  842 |             ...line,
  843 |             rect,
  844 |             drawerTop: drawer.top,
  845 |             drawerBottom: drawer.bottom,
  846 |             panelTop: panel.top,
  847 |             panelBottom: panel.bottom,
  848 |             clipTop: clip.top,
  849 |             clipBottom: clip.bottom,
  850 |             hitLink: Boolean(hit && (hit === el || el.contains(hit))),
  851 |             reachable: rect.top >= drawer.top && rect.bottom <= drawer.bottom
  852 |               && rect.top >= panel.top && rect.bottom <= panel.bottom
  853 |               && rect.top >= clip.top && rect.bottom <= clip.bottom
  854 |               && Boolean(hit && (hit === el || el.contains(hit))),
  855 |           };
  856 |         });
  857 |         range.detach();
  858 |         return {
  859 |           lineCount: initialLines.length,
  860 |           lines,
  861 |           focused: document.activeElement === el,
  862 |           isKeyboardLink: el instanceof HTMLAnchorElement && el.hasAttribute('href') && el.tabIndex >= 0,
  863 |           pageScrollTopBefore: pageScrollTop,
  864 |           pageScrollTopAfter: port.scrollTop,
  865 |           drawer: { scrollTop: drawerElement.scrollTop, scrollHeight: drawerElement.scrollHeight, clientHeight: drawerElement.clientHeight },
  866 |           title: el.getBoundingClientRect().toJSON(),
  867 |         };
  868 |       });
  869 |       const lastResultBounds = await inspectTitleLines();
  870 |       if (width === 320) console.log(`320px final search control bounds: ${JSON.stringify(lastResultBounds)}`);
  871 |       expect(lastResultBounds.lineCount, `${width}: final title contains reachable text lines`).toBeGreaterThan(0);
  872 |       expect(lastResultBounds.lines.every((line) => line.reachable),
> 873 |         `${width}: each final title line can be scrolled fully into the drawer and hit-tested: ${JSON.stringify(lastResultBounds)}`).toBe(true);
      |                                                                                                                                      ^ Error: 320: each final title line can be scrolled fully into the drawer and hit-tested: {"lineCount":4,"lines":[{"contentTop":1418.25,"height":21,"rect":{"x":35.390625,"y":34.25,"width":106.671875,"height":21,"top":34.25,"right":142.0625,"bottom":55.25,"left":35.390625},"drawerTop":87.8125,"drawerBottom":178.53125,"panelTop":22.234375,"panelBottom":190.71875,"clipTop":0,"clipBottom":340,"hitLink":false,"reachable":false},{"contentTop":1446.796875,"height":21,"rect":{"x":35.390625,"y":33.796875,"width":170.125,"height":21,"top":33.796875,"right":205.515625,"bottom":54.796875,"left":35.390625},"drawerTop":87.8125,"drawerBottom":178.53125,"panelTop":22.234375,"panelBottom":190.71875,"clipTop":0,"clipBottom":340,"hitLink":false,"reachable":false},{"contentTop":1475.34375,"height":21,"rect":{"x":35.390625,"y":34.34375,"width":178.734375,"height":21,"top":34.34375,"right":214.125,"bottom":55.34375,"left":35.390625},"drawerTop":87.8125,"drawerBottom":178.53125,"panelTop":22.234375,"panelBottom":190.71875,"clipTop":0,"clipBottom":340,"hitLink":false,"reachable":false},{"contentTop":1503.890625,"height":21,"rect":{"x":35.390625,"y":33.890625,"width":57.15625,"height":21,"top":33.890625,"right":92.546875,"bottom":54.890625,"left":35.390625},"drawerTop":87.8125,"drawerBottom":178.53125,"panelTop":22.234375,"panelBottom":190.71875,"clipTop":0,"clipBottom":340,"hitLink":false,"reachable":false}],"focused":true,"isKeyboardLink":true,"pageScrollTopBefore":0,"pageScrollTopAfter":0,"drawer":{"scrollTop":1470,"scrollHeight":1619,"clientHeight":89},"title":{"x":35.390625,"y":-51.75,"width":178.734375,"height":106.640625,"top":-51.75,"right":214.125,"bottom":54.890625,"left":35.390625}}
  874 |       expect(lastResultBounds.focused && lastResultBounds.isKeyboardLink,
  875 |         `${width}: the final search title remains a focusable actionable link`).toBe(true);
  876 |       expect(lastResultBounds.pageScrollTopAfter,
  877 |         `${width}: revealing search title lines changes only the nested result drawer`).toBe(lastResultBounds.pageScrollTopBefore);
  878 |       const beforeSearchShrinkScroll = await port.evaluate((el: HTMLElement) => el.scrollTop);
  879 |       await resultDrawer.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
  880 |       await page.evaluate(() => (window as Window & { __setVisualViewportForTest?: (height: number, offsetTop: number) => void })
  881 |         .__setVisualViewportForTest?.(340, 0));
  882 |       const resultsCanScroll = await resultDrawer.evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight);
  883 |       expect(resultsCanScroll, `${width}: search results remain scrollable after visual viewport shrink`).toBe(true);
  884 |       const resizedSearch = await inspectTitleLines();
  885 |       const resizedSearchBounds = await page.evaluate(() => {
  886 |         const panel = document.querySelector<HTMLElement>('#header-search')!.getBoundingClientRect();
  887 |         const close = document.querySelector<HTMLElement>('#header-search-close')!.getBoundingClientRect();
  888 |         const lastLink = document.querySelector<HTMLElement>('#header-search-pagefind .pagefind-ui__result:last-child .pagefind-ui__result-link')!;
  889 |         const last = lastLink.getBoundingClientRect();
  890 |         const card = lastLink.closest<HTMLElement>('.pagefind-ui__result')!.getBoundingClientRect();
  891 |         const drawer = document.querySelector<HTMLElement>('#header-search-pagefind .pagefind-ui__drawer')!;
  892 |         const drawerRect = drawer.getBoundingClientRect();
  893 |         const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
  894 |         const clip = port.getBoundingClientRect();
  895 |         return {
  896 |           panelBottom: panel.bottom,
  897 |           closeVisible: close.top >= panel.top && close.bottom <= panel.bottom && close.bottom <= clip.bottom,
  898 |           card: card.toJSON(),
  899 |           title: last.toJSON(),
  900 |           drawer: { rect: drawerRect.toJSON(), scrollTop: drawer.scrollTop, scrollHeight: drawer.scrollHeight, clientHeight: drawer.clientHeight },
  901 |           scrollTop: port.scrollTop,
  902 |           portBottom: clip.bottom,
  903 |         };
  904 |       });
  905 |       expect(resizedSearchBounds.panelBottom, `${width}: open search resizes to reduced visual viewport without manual scrolling`).toBeLessThanOrEqual(resizedSearchBounds.portBottom + 1);
  906 |       expect(resizedSearchBounds.closeVisible, `${width}: close control remains reachable after visual viewport shrink`).toBe(true);
  907 |       expect(resizedSearch.lines.every((line) => line.reachable),
  908 |         `${width}: each title line stays reachable after visual viewport shrink: ${JSON.stringify({ ...resizedSearch, bounds: resizedSearchBounds })}`).toBe(true);
  909 |       expect(resizedSearch.focused && resizedSearch.isKeyboardLink,
  910 |         `${width}: final title remains a focusable actionable link after shrink`).toBe(true);
  911 |       expect(resizedSearch.pageScrollTopAfter, `${width}: search resize and nested reveal do not move the page scrollport`).toBe(beforeSearchShrinkScroll);
  912 |     }
  913 |   });
  914 | 
  915 |   test('safe-area inset expands the separate lower zone while preserving the 80px useful area', async ({ page }) => {
  916 |     await protectThirdParties(page);
  917 |     await page.setViewportSize({ width: 375, height: 640 });
  918 |     await page.goto(activeUrl('/'));
  919 |     const session = await page.context().newCDPSession(page);
  920 |     await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 20 } });
  921 |     const measured = await page.evaluate(() => {
  922 |       const facade = document.querySelector<HTMLElement>('[data-chat-facade]')!;
  923 |       const trigger = facade.querySelector<HTMLElement>('[data-chat-trigger]')!;
  924 |       const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
  925 |       const rect = facade.getBoundingClientRect();
  926 |       const button = trigger.getBoundingClientRect();
  927 |       const probe = document.createElement('div');
  928 |       probe.style.cssText = 'position:fixed;left:-10000px;padding-bottom:env(safe-area-inset-bottom)';
  929 |       document.body.append(probe);
  930 |       const inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  931 |       probe.remove();
  932 |       return {
  933 |         inset,
  934 |         lowerHeight: rect.height,
  935 |         usefulHeight: rect.height - inset,
  936 |         buttonInsideUsefulArea: button.top >= rect.top && button.bottom <= rect.bottom - inset,
  937 |         portBottom: port.getBoundingClientRect().bottom,
  938 |         lowerTop: rect.top,
  939 |       };
  940 |     });
  941 |     await session.detach();
  942 |     expect(measured.inset, 'CDP overrides the safe-area inset for this Chromium fixture').toBe(20);
  943 |     expect(measured.lowerHeight, 'safe area is added outside the useful lower-zone height').toBe(100);
  944 |     expect(measured.usefulHeight, 'lower zone retains 80 CSS px above the safe area').toBe(80);
  945 |     expect(measured.buttonInsideUsefulArea, 'capsule remains in the useful 80px portion').toBe(true);
  946 |     expect(measured.portBottom, 'scrollport ends before the full lower zone').toBeLessThanOrEqual(measured.lowerTop + 1);
  947 |   });
  948 | 
  949 |   test('shared scrollport drives the header shadow and the no-IntersectionObserver reviews fallback', async ({ page }) => {
  950 |     await page.addInitScript(() => {
  951 |       Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: undefined });
  952 |     });
  953 |     await protectThirdParties(page);
  954 |     await page.setViewportSize({ width: 375, height: 420 });
  955 |     await page.goto(activeUrl('/'));
  956 |     const port = page.locator('[data-page-scrollport]');
  957 |     await expect(port).toHaveCount(1);
  958 |     const reviews = page.locator('[data-reviews-embed]').first();
  959 |     await expect(reviews).toHaveCount(1);
  960 |     const initial = await page.evaluate(() => {
  961 |       const port = document.querySelector<HTMLElement>('[data-page-scrollport]')!;
  962 |       const box = document.querySelector<HTMLElement>('[data-reviews-embed]')!;
  963 |       return {
  964 |         port: port.getBoundingClientRect().toJSON(),
  965 |         box: box.getBoundingClientRect().toJSON(),
  966 |         hasFrame: Boolean(box.querySelector('iframe')),
  967 |       };
  968 |     });
  969 |     expect(initial.box.top, 'reviews start below the clipped visible region').toBeGreaterThanOrEqual(initial.port.bottom);
  970 |     expect(initial.hasFrame, 'fallback does not load the review iframe before the page scrollport reveals it').toBe(false);
  971 | 
  972 |     await port.evaluate((el: HTMLElement) => { el.scrollTop = 20; });
  973 |     await expect(page.locator('header.topnav')).toHaveAttribute('data-scrolled', '');
```