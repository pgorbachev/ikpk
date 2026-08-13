import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { demoPagePath, demoPages } from './helpers/demo-dist';
import { scanHtmlForHazards, matchOccurrences } from './helpers/rich-content-safety/hazard-scan.js';
import { loadFixture } from './helpers/rich-content-safety/load-fixture.js';

describe('rich-content contract: whole-document hazard scan (demo dist)', () => {
  it('dist-demo hazard scanner требует заполненный occurrence registry', () => {
    const pages = demoPages();
    expect(pages.length, 'dist-demo без html — vacuous green').toBeGreaterThan(10);
    const occ = loadFixture<{
      occurrences: { slotId: string; route: string; placement: string; identity: string; count: number }[];
    }>('output-occurrence-registry.json');
    expect(occ.occurrences.length, 'occurrence rules пусты').toBeGreaterThan(0);

    const errors: string[] = [];
    for (const file of pages) {
      const html = readFileSync(file, 'utf-8');
      const route = demoPagePath(file);
      errors.push(...matchOccurrences(html, route, occ.occurrences));
      for (const hit of scanHtmlForHazards(html, { ignoreMarkedRegions: true }).filter(
        (h) => h.reason === 'event-handler' || h.reason === 'srcdoc',
      )) {
        errors.push(`${route}: ${hit.reason} на <${hit.tag}>`);
      }
    }
    expect(errors, errors.slice(0, 20).join('\n')).toEqual([]);
  });
});
