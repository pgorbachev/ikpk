import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { demoDist, demoPages } from './helpers/demo-dist';
import { htmlFileRoute, matchOccurrences, unmarkedDocumentHazards } from './helpers/rich-content-safety/hazard-scan.js';
import { loadFixture } from './helpers/rich-content-safety/load-fixture.js';
import { openOracleHarness, type OracleHarness } from './helpers/rich-content-safety/chromium-oracle.js';

describe('rich-content contract: whole-document hazard scan (demo dist)', () => {
  let harness: OracleHarness;

  beforeAll(async () => {
    harness = await openOracleHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('dist-demo разбирается Chromium DOMParser; occurrence и refresh-meta проверяются', async () => {
    const pages = demoPages();
    expect(pages.length, 'dist-demo без html — vacuous green').toBeGreaterThan(10);
    const occ = loadFixture<{
      occurrences: { slotId: string; route: string; placement: string; identity: string; count: number }[];
    }>('output-occurrence-registry.json');
    expect(occ.occurrences.length, 'occurrence rules пусты').toBeGreaterThan(0);

    const errors: string[] = [];
    for (const file of pages) {
      const html = readFileSync(file, 'utf-8');
      const route = htmlFileRoute(file, demoDist);
      const parsed = await harness.parse(html);
      expect(parsed.continuedRequests, route).toEqual([]);
      errors.push(...matchOccurrences(parsed.serialized, route, occ.occurrences));
      for (const hit of unmarkedDocumentHazards(parsed.serialized)) {
        errors.push(`${route}: ${hit.reason} на <${hit.tag}>`);
      }
    }
    expect(errors, errors.slice(0, 20).join('\n')).toEqual([]);
  }, 120_000);
});
