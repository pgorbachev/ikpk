import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dist, walkHtml } from './helpers/dist-pages';
import { scanHtmlForHazards, matchOccurrences } from './helpers/rich-content-safety/hazard-scan.js';
import { loadFixture } from './helpers/rich-content-safety/load-fixture.js';

describe('rich-content contract: whole-document hazard scan (production dist)', () => {
  it('dist не пуст и hazard scanner находит только инвентаризированные executable nodes', () => {
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
      const route = '/' + file.slice(dist.length).replace(/\\/g, '/').replace(/\/index\.html$/, '').replace(/^\//, '');
      errors.push(...matchOccurrences(html, route === '/' ? '/' : route, occ.occurrences));
      const unmarkedHazards = scanHtmlForHazards(html, { ignoreMarkedRegions: true }).filter(
        (h) => h.reason === 'event-handler' || h.reason === 'srcdoc' || h.reason.startsWith('forbidden-scheme'),
      );
      for (const hit of unmarkedHazards) {
        errors.push(`${route}: ${hit.reason} на <${hit.tag} ${hit.attr}>`);
      }
    }
    expect(errors, errors.slice(0, 20).join('\n')).toEqual([]);
  });
});
