import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dist, walkHtml } from './helpers/dist-pages';
import {
  extractMarkedRegions,
  htmlFileRoute,
  matchOccurrences,
  unmarkedDocumentHazards,
} from './helpers/rich-content-safety/hazard-scan.js';
import { validateClosedMatrixHtml } from './helpers/rich-content-safety/closed-matrix-validate.js';
import { loadFixture } from './helpers/rich-content-safety/load-fixture.js';
import { openOracleHarness, type OracleHarness } from './helpers/rich-content-safety/chromium-oracle.js';
import type { ExecutableSlot } from './helpers/rich-content-safety/ast-sinks.js';
import { publicationOccurrences } from './publication/occurrences.js';

describe('rich-content contract: whole-document hazard scan (production dist)', () => {
  let harness: OracleHarness;

  beforeAll(async () => {
    harness = await openOracleHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('dist разбирается Chromium DOMParser; occurrence, refresh-meta и closed matrix marked regions', async () => {
    expect(existsSync(dist), 'dist не собран').toBe(true);
    const files = [...walkHtml()];
    expect(files.length, 'dist без html — vacuous green').toBeGreaterThan(10);
    const registered = loadFixture<{
      occurrences: { slotId: string; route: string; placement: string; identity: string; count: number }[];
    }>('output-occurrence-registry.json');
    expect(registered.occurrences.length, 'occurrence rules пусты — CI не должен зеленеть вхолостую').toBeGreaterThan(0);
    const sourceSlots = loadFixture<ExecutableSlot[]>('executable-source-slots.json');
    const rendered = loadFixture<{ sinks: { id: string }[] }>('rendered-registry.json');
    const knownSinkIds = rendered.sinks.map((s) => s.id);
    const snapshotPath = join(dirname(dist), 'dist-snapshot', 'snapshot.json');
    expect(existsSync(snapshotPath), 'нет исходного snapshot для occurrence projection').toBe(true);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as {
      origin?: { url?: string };
      content?: { types?: { articles?: unknown } };
    };
    expect(Array.isArray(snapshot.content?.types?.articles), 'snapshot без content.types.articles').toBe(true);
    const occurrences = publicationOccurrences(
      registered.occurrences,
      sourceSlots,
      snapshot.content!.types!.articles as Parameters<typeof publicationOccurrences>[2],
      process.env.PAYMENT_ROLE ?? 'ci',
      snapshot.origin?.url,
    );
    expect(occurrences.length, 'projected occurrence rules пусты').toBeGreaterThan(0);

    const errors: string[] = [];
    for (const file of files) {
      const html = readFileSync(file, 'utf-8');
      const route = htmlFileRoute(file, dist);
      const parsed = await harness.parse(html);
      expect(parsed.continuedRequests, route).toEqual([]);
      expect(parsed.mainFrameUrl).toMatch(/^about:blank/);
      const recovered = parsed.serialized;
      errors.push(
        ...matchOccurrences(recovered, route, occurrences, sourceSlots, { ignoreMarkedRegions: true, build: 'production' }),
      );
      for (const hit of unmarkedDocumentHazards(recovered)) {
        errors.push(`${route}: ${hit.reason} на <${hit.tag} ${hit.attr}>`);
      }
      for (const region of extractMarkedRegions(recovered)) {
        for (const err of validateClosedMatrixHtml(region.outer, { knownSinkIds })) {
          errors.push(`${route} [${region.sinkId}]: ${err}`);
        }
      }
    }
    expect(errors, errors.slice(0, 20).join('\n')).toEqual([]);
  }, 120_000);
});
