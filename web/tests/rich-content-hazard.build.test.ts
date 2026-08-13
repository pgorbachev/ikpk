import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dist, walkHtml } from './helpers/dist-pages';
import { htmlFileRoute, matchOccurrences, unmarkedDocumentHazards } from './helpers/rich-content-safety/hazard-scan.js';
import { loadFixture } from './helpers/rich-content-safety/load-fixture.js';
import { openOracleHarness, type OracleHarness } from './helpers/rich-content-safety/chromium-oracle.js';

describe('rich-content contract: whole-document hazard scan (production dist)', () => {
  let harness: OracleHarness;

  beforeAll(async () => {
    harness = await openOracleHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('dist разбирается Chromium DOMParser; occurrence и refresh-meta проверяются', async () => {
    expect(existsSync(dist), 'dist не собран').toBe(true);
    const files = [...walkHtml()];
    expect(files.length, 'dist без html — vacuous green').toBeGreaterThan(10);
    const occ = loadFixture<{
      occurrences: { slotId: string; route: string; placement: string; identity: string; count: number }[];
    }>('output-occurrence-registry.json');
    expect(occ.occurrences.length, 'occurrence rules пусты — CI не должен зеленеть вхолостую').toBeGreaterThan(0);

    const errors: string[] = [];
    for (const file of files) {
      const html = readFileSync(file, 'utf-8');
      const route = htmlFileRoute(file, dist);
      const parsed = await harness.parse(html);
      expect(parsed.continuedRequests, route).toEqual([]);
      expect(parsed.mainFrameUrl).toMatch(/^about:blank/);
      const recovered = parsed.serialized;
      errors.push(...matchOccurrences(recovered, route, occ.occurrences));
      for (const hit of unmarkedDocumentHazards(recovered)) {
        errors.push(`${route}: ${hit.reason} на <${hit.tag} ${hit.attr}>`);
      }
    }
    expect(errors, errors.slice(0, 20).join('\n')).toEqual([]);
  }, 120_000);
});
