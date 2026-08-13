import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoDist, demoPagePath, demoPages } from './helpers/demo-dist';
import {
  CANARY_CONTROL_TOKEN,
  CANARY_HOSTILE_TOKEN,
  CANARY_PATH,
} from './helpers/rich-content-safety/closed-matrix.js';
import { htmlFileRoute } from './helpers/rich-content-safety/hazard-scan.js';
import { loadFixture } from './helpers/rich-content-safety/load-fixture.js';
import {
  collectMarkerInventoryErrors,
  type RenderedSink,
} from './helpers/rich-content-safety/marker-inventory.js';

function demoFile(path: string): string {
  return path === '/' ? join(demoDist, 'index.html') : join(demoDist, path.replace(/^\//, ''), 'index.html');
}

describe('rich-content contract: whole-dist canary (demo)', () => {
  it('hostile canary отсутствует во всём dist-demo', () => {
    expect(existsSync(demoDist), 'dist-demo не собран').toBe(true);
    const pages = demoPages();
    expect(pages.length, 'dist-demo без html — vacuous green').toBeGreaterThan(10);
    const hits: string[] = [];
    for (const file of pages) {
      const html = readFileSync(file, 'utf-8');
      if (html.includes(CANARY_HOSTILE_TOKEN)) hits.push(demoPagePath(file));
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('demo test-only path содержит ровно один control token и sink marker', () => {
    const page = demoFile(CANARY_PATH);
    expect(existsSync(page), `нет canary path ${CANARY_PATH} в dist-demo`).toBe(true);
    const html = readFileSync(page, 'utf-8');
    expect(html.split(CANARY_CONTROL_TOKEN).length - 1).toBe(1);
    expect(html).toMatch(/data-safe-rich-content="canary-body"/);
  });
});

describe('rich-content contract: marker inventory (demo)', () => {
  it('каждая demo-область rendered-registry имеет data-safe-rich-content, count совпадает, лишних route нет', () => {
    const files = demoPages();
    const pages = files.map((file) => ({
      route: htmlFileRoute(file, demoDist),
      html: readFileSync(file, 'utf-8'),
    }));
    const rendered = loadFixture<{ sinks: RenderedSink[] }>('rendered-registry.json');
    const missing = collectMarkerInventoryErrors(rendered.sinks, 'demo', pages);
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
