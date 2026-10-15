import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { readPublicationSnapshot } from '../../scripts/lib/publication-snapshot';
import { walkHtml } from './dist-pages';
import { attr, findAll, textOf } from './dom';
import { candidateTemplateRoutes } from './publication-candidate-data';
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
  return candidateTemplateRoutes(snapshot.content.types, pages);
}
export const test = base.extend({
  page: async ({ page }, use) => {
    await installThirdPartyGuard(page, { chatLoaderSrc: candidate().chatLoaderSrc });
    await use(page);
  },
});
export { expect, attr, findAll, textOf };
