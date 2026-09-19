import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkFiles } from '../helpers/dist-pages';
import { extractMarkedRegions, htmlFileRoute, matchOccurrences, unmarkedDocumentHazards } from '../helpers/rich-content-safety/hazard-scan';
import type { ExecutableSlot } from '../helpers/rich-content-safety/ast-sinks';
import { validateClosedMatrixHtml } from '../helpers/rich-content-safety/closed-matrix-validate';
import { iterateTags } from '../helpers/rich-content-safety/html-scan';
import { openOracleHarness } from '../helpers/rich-content-safety/chromium-oracle';
import { loadFixture } from '../helpers/rich-content-safety/load-fixture';
import { pages, redirectRules, required, resolves, tree } from './helpers';
import { publicationOccurrences } from './occurrences';

it('release marker names the exact commit and snapshot', () => {
  expect(JSON.parse(readFileSync(join(tree(), 'release.json'), 'utf8'))).toEqual({ commit: required('PUBLICATION_COMMIT'), snapshotId: required('PUBLICATION_SNAPSHOT_ID') });
});
it('all rendered content satisfies the existing rich-content safety matrix', async () => {
  const knownSinkIds = loadFixture<{ sinks: { id: string }[] }>('rendered-registry.json').sinks.map((sink) => sink.id);
  const registeredOccurrences = loadFixture<{ occurrences: Parameters<typeof matchOccurrences>[2] }>('output-occurrence-registry.json').occurrences;
  const sourceSlots = loadFixture<ExecutableSlot[]>('executable-source-slots.json');
  const snapshot = JSON.parse(readFileSync(join(required('CONTENT_SNAPSHOT_DIR'), 'snapshot.json'), 'utf8'));
  expect(snapshot.snapshotId).toBe(required('PUBLICATION_SNAPSHOT_ID'));
  expect(Array.isArray(snapshot.content?.types?.articles), 'missing captured articles').toBe(true);
  const occurrences = publicationOccurrences(registeredOccurrences, sourceSlots, snapshot.content.types.articles, required('PAYMENT_ROLE'));
  expect(occurrences.length, 'empty executable occurrence registry').toBeGreaterThan(0);
  const errors: string[] = []; let regions = 0;
  const oracle = await openOracleHarness({ executablePath: process.env.PUBLICATION_CHROMIUM_EXECUTABLE });
  try {
    for (const page of pages()) {
      const html = (await oracle.parse(page.html)).serialized;
      errors.push(...matchOccurrences(html, htmlFileRoute(page.file, tree()), occurrences, sourceSlots, {
        ignoreMarkedRegions: true, build: required('DEPLOY_MODE') === 'stand' ? 'demo' : 'production',
      }));
      for (const error of unmarkedDocumentHazards(html)) errors.push(`${page.route}: ${error.reason}`);
      for (const region of extractMarkedRegions(html)) {
        regions++;
        errors.push(...validateClosedMatrixHtml(region.outer, { knownSinkIds, mediaFileExists: resolves }).map((error) => `${page.route}: ${error}`));
      }
    }
  } finally { await oracle.close(); }
  expect(regions, 'no checked rich content').toBeGreaterThan(0);
  expect(errors, errors.slice(0, 20).join('\n')).toEqual([]);
});
it('all image references resolve locally and no old bucket remains in artifact text', () => {
  const errors: string[] = []; let images = 0;
  const check = (raw: string, route: string) => {
    const ref = raw.trim();
    if (!ref || /^(?:data:|#)/.test(ref)) return;
    if (/^https:\/\/(?:mc\.yandex\.ru\/watch\/|top-fwz1\.mail\.ru\/counter)/.test(ref)) return;
    if (!ref.startsWith('/') || ref.startsWith('//') || !resolves(ref.split(/[?#]/)[0])) errors.push(`${route}: ${ref}`);
  };
  for (const page of pages()) {
    for (const tag of iterateTags(page.html)) {
      if (['img', 'source'].includes(tag.name)) {
        images++;
        if (tag.attrs.src) check(tag.attrs.src, page.route);
        for (const candidate of (tag.attrs.srcset ?? '').split(',')) if (candidate.trim()) check(candidate.trim().split(/\s+/)[0], page.route);
      }
      for (const match of (tag.attrs.style ?? '').matchAll(/url\(['"]?([^'")]+)['"]?\)/gi)) check(match[1], page.route);
    }
    for (const script of page.html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      for (const match of script[1].matchAll(/"(?:image|logo|thumbnailUrl)"\s*:\s*"([^"]+)"/g)) check(match[1].replace(/^https:\/\/ikpk\.su(?=\/)/, ''), page.route);
    }
  }
  for (const file of walkFiles(tree(), ['.html', '.css', '.js', '.xml', '.json', '.txt'])) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('storage.yandexcloud.net')) errors.push(`${file}: legacy hotlink`);
    if (file.endsWith('.css')) for (const match of text.matchAll(/url\(['"]?([^'")]+)['"]?\)/gi)) check(match[1], file);
  }
  expect(images).toBeGreaterThan(0);
  expect(errors, errors.slice(0, 20).join('\n')).toEqual([]);
});
it('internal links and every declared legacy redirect resolve in the checked tree', () => {
  const redirects = redirectRules(); const destinations = new Map(redirects.map((rule) => [rule.from, rule.to]));
  const errors: string[] = [];
  for (const rule of redirects) if (!resolves(rule.to)) errors.push(`${rule.from} → ${rule.to}`);
  for (const page of pages()) for (const tag of iterateTags(page.html)) {
    if (tag.name !== 'a' || !tag.attrs.href) continue;
    const url = new URL(tag.attrs.href, `https://ikpk.su${page.route}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'ikpk.su') continue;
    if (!resolves(url.pathname) && !resolves(destinations.get(url.pathname) ?? '/__missing_publication_target__')) errors.push(`${page.route}: ${url.pathname}`);
  }
  expect(errors, errors.slice(0, 20).join('\n')).toEqual([]);
});
