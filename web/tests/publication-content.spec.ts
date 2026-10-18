import { candidateRoute, candidateSearchSubject } from './helpers/publication-candidate-data';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, actualTemplates, candidate, candidateSiteOrigin } from './helpers/publication-candidate';
import { isCurrentOrFuture, type ScheduleWindowEntry } from '../src/lib/schedule-window';

test('candidate templates have content, SEO, navigable internal links and centered section titles', async ({ page }) => {
  test.setTimeout(180_000);
  const siteOrigin = candidateSiteOrigin();
  let titles = 0;
  for (const route of actualTemplates()) {
    expect((await page.goto(route))?.status(), route).toBe(200);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('h1').first()).toBeVisible();
    expect((await page.title()).trim().length, route).toBeGreaterThan(0);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /\S/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${siteOrigin}${route === '/' ? '/' : route}`);
    const links = await page.locator('main a[href^="/"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')!));
    const { pages } = candidate();
    for (const href of links) {
      const url = new URL(href, siteOrigin);
      if (url.pathname.includes('.') || url.pathname === '/demo-zayavka') continue;
      expect(pages.some((entry) => entry.route === url.pathname.replace(/\/$/, '') || (entry.route === '/' && url.pathname === '/')), `${route} links to missing ${href}`).toBe(true);
    }
    const geometry = await page.locator('.section-title').evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect(); const parent = node.parentElement!.getBoundingClientRect();
      return { text: node.textContent, align: getComputedStyle(node).textAlign, offset: box.x + box.width / 2 - parent.x - parent.width / 2 };
    }));
    titles += geometry.length;
    for (const title of geometry) { expect(title.align, `${route}: ${title.text}`).toBe('center'); expect(Math.abs(title.offset), `${route}: ${title.text}`).toBeLessThanOrEqual(1); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), route).toBeLessThanOrEqual(1);
  }
  expect(titles, 'no section titles exercised').toBeGreaterThan(0);
});

test('candidate actual templates and dark home have no serious or critical accessibility violations', async ({ page }) => {
  test.setTimeout(240_000);
  const routes = [...actualTemplates(), '/'];
  for (const [index, route] of routes.entries()) {
    if (index === routes.length - 1) await page.addInitScript(() => localStorage.setItem('ikpk.theme', 'dark'));
    expect((await page.goto(route))?.status(), route).toBe(200);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .exclude('.contact-shell-map iframe').exclude('.video-facade iframe').analyze();
    expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? '')).map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) })), route).toEqual([]);
  }
});

test('candidate global search opens, returns captured content, navigates and closes', async ({ page }) => {
  const subject = candidateSearchSubject(candidate().snapshot.content.types);
  await page.goto('/');
  if ((page.viewportSize()?.width ?? 0) <= 900) {
    await page.getByLabel('Открыть меню').click(); await page.locator('[data-search-open]').click();
  } else await page.locator('#header-search-toggle').click();
  const input = page.locator('.pagefind-ui__search-input');
  await expect(input).toBeVisible();
  if (subject) {
    await input.fill(subject.query);
    const hrefs = [subject.route, new URL(subject.route, page.url()).href].flatMap((href) => [href, `${href}/`]);
    const result = page.locator(hrefs.map((href) => `.pagefind-ui__result-link[href=${JSON.stringify(href)}]`).join(',')).first();
    await expect(result).toBeVisible({ timeout: 20_000 });
    await result.click(); await expect.poll(() => new URL(page.url()).pathname.replace(/\/$/, '')).toBe(subject.route);
    await expect(page.locator('h1').first()).toBeVisible();
    if ((page.viewportSize()?.width ?? 0) <= 900) {
      await page.getByLabel('Открыть меню').click(); await page.locator('[data-search-open]').click();
    } else await page.locator('#header-search-toggle').click();
  } else {
    // No indexable article token in this source: exercise the empty interaction.
    await input.fill(' '); await input.fill('');
    await expect(input).toHaveValue('');
    await expect(page.locator('.pagefind-ui__result-link')).toHaveCount(0);
  }
  await page.locator('#header-search-close').click(); await expect(page.locator('.pagefind-ui__search-input')).toBeHidden();
});

test('candidate seminar uses actual dates, responsive panel and safe registration navigation', async ({ page, context }) => {
  const { snapshot, pages } = candidate();
  const entries = (snapshot.content.types.schedule_entries as unknown as (ScheduleWindowEntry & { status: string; seminar: { slug: string } })[])
    .filter((row) => row.status === 'active' && isCurrentOrFuture(row, snapshot.referenceDate));
  const slug = entries[0]?.seminar.slug ?? snapshot.content.types.seminars[0]?.slug;
  const seminar = snapshot.content.types.seminars.find((entity) => entity.slug === slug);
  expect(seminar, 'missing captured seminar').toBeDefined();
  const route = candidateRoute(snapshot.content.types, 'seminars', seminar!);
  expect(pages.some((page) => page.route === route), `missing actual seminar route: ${route}`).toBe(true); await page.goto(route);
  const panel = page.locator('[data-seminar-schedule-panel]');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-seminar-schedule-card]')).toHaveCount(entries.filter((row) => row.seminar.slug === slug).length);
  const mobile = (page.viewportSize()?.width ?? 0) <= 1024;
  const style = await panel.evaluate((node) => ({ position: getComputedStyle(node).position, overflow: getComputedStyle(node).overflowY }));
  expect(style.position).toBe(mobile ? 'static' : 'sticky');
  expect(style.overflow).toBe(mobile ? 'visible' : 'auto');
  const description = page.locator('.seminar-content');
  if (await description.count()) {
    const p = (await panel.boundingBox())!; const d = (await description.boundingBox())!;
    if (mobile) expect(p.y + p.height).toBeLessThanOrEqual(d.y + 2);
    else expect(p.x).toBeGreaterThanOrEqual(d.x + d.width - 2);
  }
  const register = page.locator('.seminar-register-link');
  for (const link of await register.all()) {
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^https:\/\/[^/]+\.bitrix24(?:site)?\.ru\/|^\/demo-zayavka/);
    await link.scrollIntoViewIfNeeded(); await expect(link).toBeVisible();
    // Exercise browser navigation against a local response, without contacting CRM.
    await context.route(href!.startsWith('/') ? `**${href}` : href!, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Isolated registration destination</title><h1>Registration navigation verified</h1>' }));
    if (await link.getAttribute('target') === '_blank') {
      const popupPromise = context.waitForEvent('page');
      await link.click(); const popup = await popupPromise; await popup.waitForLoadState();
      await expect(popup.getByRole('heading')).toHaveText('Registration navigation verified'); await popup.close();
    } else {
      // Same-tab demo destination is also isolated. Avoid leaving a pending popup wait.
      await link.click(); await expect(page.getByRole('heading')).toHaveText('Registration navigation verified'); await page.goto(route!);
    }
  }
  if (!entries.length) await expect(page.locator('[data-testid="seminar-schedule-empty"]')).toBeVisible();
});

test('candidate filter controls retain visible keyboard focus and reduced motion', async ({ page }) => {
  let focused = 0; let motion = 0;
  for (const route of ['/statyi', '/raspisanie-i-tseny']) {
    await page.goto(route);
    const fields = page.locator('main input, main select:enabled');
    for (const field of await fields.all()) {
      await field.focus(); await expect(field).toBeFocused();
      const visible = await field.evaluate((node) => {
        const style = getComputedStyle(node);
        return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
          (style.boxShadow !== 'none' && !/rgba\([^)]*0?\.0?[0-9]\)/.test(style.boxShadow));
      });
      expect(visible, `${route}: filter focus invisible`).toBe(true); focused++;
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const card of await page.locator('.schedule-card:visible, .article-card:visible').all()) {
      await card.scrollIntoViewIfNeeded(); await card.hover();
      const transform = await card.evaluate((node) => getComputedStyle(node).transform);
      expect(transform === 'none' || /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(transform), `${route}: card moves under reduced motion`).toBe(true); motion++;
    }
  }
  expect(focused).toBeGreaterThan(0); expect(motion).toBeGreaterThan(0);
});
