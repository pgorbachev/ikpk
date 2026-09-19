import { test, expect } from '@playwright/test';
import { isAbsolute, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { readPublicationSnapshot } from '../scripts/lib/publication-snapshot';
import { attr, findAll, textOf } from './helpers/dom';
import { walkHtml } from './helpers/dist-pages';
import { installThirdPartyGuard } from './helpers/third-party-guard';

function context() {
  const snapshotDir = process.env.CONTENT_SNAPSHOT_DIR;
  const treeDir = process.env.PUBLICATION_TREE_DIR;
  const retained = process.env.PUBLICATION_RETAINED_TREE === '1';
  if ((!snapshotDir && !retained) || !treeDir || !isAbsolute(treeDir) || !process.env.PUBLICATION_BASE_URL) throw new Error('owned publication context required');
  return { snapshot: retained ? undefined : readPublicationSnapshot(snapshotDir!), treeDir };
}
test.beforeEach(async ({ page }) => {
  await installThirdPartyGuard(page);
});
test('main published pages have readable content', async ({ page }) => {
  context();
  for (const route of ['/', '/raspisanie-i-tseny', '/statyi', '/kontakty', '/oplata']) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('h1').first()).toBeVisible();
  }
});
test('desktop and mobile navigation reaches the schedule', async ({ page }, info) => {
  context();
  await page.goto('/');
  await expect(page.locator('header.topnav')).toBeVisible();
  const navigation = info.project.name === 'mobile'
    ? page.getByRole('navigation', { name: 'Мобильная навигация' })
    : page.getByRole('navigation', { name: 'Основная навигация' });
  if (info.project.name === 'mobile') await page.getByLabel('Открыть меню').click();
  await navigation.getByRole('link', { name: 'Расписание', exact: true }).click();
  await expect(page).toHaveURL(/\/raspisanie-i-tseny\/?$/);
  await expect(page.locator('h1')).toBeVisible();
});
test('article and seminar routes open on this exact artifact', async ({ page }) => {
  const { snapshot, treeDir } = context();
  const files = [...walkHtml(treeDir)];
  for (const type of ['articles', 'seminars']) {
    const slug = snapshot?.content.types[type]?.[0]?.slug;
    if (snapshot) expect(typeof slug).toBe('string');
    const file = snapshot
      ? files.find((file) => file.endsWith(`/${String(slug)}/index.html`))
      : files.find((file) => {
        const path = relative(treeDir, file);
        if (!(type === 'articles' ? /^statyi\/[^/]+\/index\.html$/ : /^[^/]+\/[^/]+\/[^/]+\/index\.html$/).test(path)) return false;
        const scripts = findAll(readFileSync(file, 'utf8'), (element) => element.tagName === 'script' && attr(element, 'type') === 'application/ld+json');
        return scripts.some((script) => {
          const schema = JSON.parse(textOf(script)) as { '@type'?: string };
          return (type === 'articles' ? ['Article'] : ['Event', 'Course']).includes(schema['@type'] ?? '');
        });
      });
    expect(file, `missing ${type} in checked artifact`).toBeDefined();
    const route = `/${relative(treeDir, file!).replace(/index\.html$/, '')}`;
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator('h1').first()).toBeVisible();
  }
});
test('schedule renders its cards and registration links without submitting them', async ({ page }) => {
  const { treeDir } = context();
  const html = readFileSync(`${treeDir}/raspisanie-i-tseny/index.html`, 'utf8');
  const count = [...html.matchAll(/\bdata-schedule-item(?:[\s=>])/g)].length;
  await page.goto('/raspisanie-i-tseny');
  expect(count, 'empty schedule in checked artifact').toBeGreaterThan(0);
  await expect(page.locator('[data-schedule-item]')).toHaveCount(count);
  await expect(page.locator('[data-schedule-item]:visible').first(), 'no visible schedule cards').toBeVisible();
  await expect(page.locator('[data-testid="schedule-toolbar"]')).toBeVisible();
  const links = page.locator('a[href*="bitrix24"], a[href^="/demo-zayavka"]');
  expect(await links.count(), 'no registration or subscription link').toBeGreaterThan(0);
  await expect(links.filter({ visible: true }).first(), 'no visible registration or subscription link').toBeVisible();
  const role = process.env.DEPLOY_MODE;
  for (const href of await links.evaluateAll((elements) => elements.map((element) => element.getAttribute('href')))) {
    expect(href).toMatch(role === 'stand' && process.env.DEMO_FORMS === 'stub' ? /^\/demo-zayavka/ : /^https:\/\/[^/]+\.bitrix24(?:site)?\.ru\//);
  }
});
