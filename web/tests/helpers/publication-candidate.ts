import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { readPublicationSnapshot } from '../../scripts/lib/publication-snapshot';
import { walkHtml } from './dist-pages';
import { attr, findAll, textOf } from './dom';
import { installThirdPartyGuard } from './third-party-guard';

/** Read only the operator's captured source and the exact output being admitted. */
export function candidate() {
  const snapshotDir = process.env.CONTENT_SNAPSHOT_DIR;
  const treeDir = process.env.PUBLICATION_TREE_DIR;
  if (!snapshotDir || !treeDir || !isAbsolute(treeDir) || !process.env.PUBLICATION_BASE_URL) throw new Error('owned candidate context required');
  const snapshot = readPublicationSnapshot(snapshotDir);
  const pages = [...walkHtml(treeDir)].map((file) => ({
    route: `/${relative(treeDir, file).replace(/index\.html$/, '').replace(/\/$/, '')}`,
    html: readFileSync(file, 'utf8'),
  }));
  const home = pages.find((page) => page.route === '/')!;
  expect(home, 'candidate homepage missing').toBeDefined();
  const trigger = findAll(home.html, (node) => attr(node, 'data-chat-loader-src') !== null)[0];
  return { snapshot, treeDir, pages, chatLoaderSrc: trigger ? attr(trigger, 'data-chat-loader-src') : null };
}
export function actualTemplates() {
  const { pages, snapshot } = candidate();
  const routes = new Set(['/', '/statyi', '/raspisanie-i-tseny', '/kontakty', '/oplata', '/svedeniya-ob-obrazovatelnoy-organizatsii']);
  for (const type of ['institutes', 'course_groups', 'seminars', 'articles', 'teachers', 'video_playlists']) {
    const entities = snapshot.content.types[type] ?? [];
    if (!entities.length) continue;
    const first = pages.find(({ route }) => route.split('/').at(-1) === String(entities[0].slug));
    expect(first, `missing representative ${type} route`).toBeDefined();
    routes.add(first!.route);
  }
  // Both populated and empty seminar panels are real template states, when present.
  for (const populated of [true, false]) {
    const page = pages.find(({ html }) => html.includes('data-seminar-schedule-panel') && html.includes('data-seminar-schedule-card') === populated);
    if (page) routes.add(page.route);
  }
  const video = pages.find(({ route }) => /^\/video\/[^/]+$/.test(route));
  if (video) routes.add(video.route);
  return [...routes];
}
export const test = base.extend({
  page: async ({ page }, use) => {
    await installThirdPartyGuard(page, { chatLoaderSrc: candidate().chatLoaderSrc });
    await use(page);
  },
});
export { expect, attr, findAll, textOf };
