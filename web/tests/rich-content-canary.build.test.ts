import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dist, walkHtml } from './helpers/dist-pages';
import { walkFiles } from './helpers/walk';
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

function pageFile(path: string): string {
  return path === '/' ? join(dist, 'index.html') : join(dist, path.replace(/^\//, ''), 'index.html');
}

describe('rich-content contract: whole-dist canary (production)', () => {
  it('hostile canary отсутствует во всём dist, и dist не пуст', () => {
    expect(existsSync(dist), 'dist не собран').toBe(true);
    const files = [...walkHtml()];
    expect(files.length, 'dist без html — vacuous green').toBeGreaterThan(10);
    const hits: string[] = [];
    for (const file of files) {
      const html = readFileSync(file, 'utf-8');
      if (html.includes(CANARY_HOSTILE_TOKEN)) hits.push(file);
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('ожидаемый test-only path содержит ровно один control token и sink marker', () => {
    const page = pageFile(CANARY_PATH);
    expect(existsSync(page), `нет canary path ${CANARY_PATH}`).toBe(true);
    const html = readFileSync(page, 'utf-8');
    const controls = html.split(CANARY_CONTROL_TOKEN).length - 1;
    expect(controls, 'fixture-control token').toBe(1);
    expect(html).toMatch(/data-safe-rich-content="canary-body"/);
  });
});

describe('rich-content contract: marker inventory (production)', () => {
  it('каждая ожидаемая область имеет data-safe-rich-content, count совпадает, лишних route нет', () => {
    expect(existsSync(dist), 'dist не собран').toBe(true);
    const files = [...walkHtml()];
    expect(files.length, 'dist без html — vacuous green').toBeGreaterThan(10);
    const pages = files.map((file) => ({
      route: htmlFileRoute(file, dist),
      html: readFileSync(file, 'utf-8'),
    }));
    const rendered = loadFixture<{ sinks: RenderedSink[] }>('rendered-registry.json');
    const missing = collectMarkerInventoryErrors(rendered.sinks, 'production', pages);
    expect(missing, missing.join('\n')).toEqual([]);
  });
});

describe('rich-content contract: sanitizer не в browser bundle', () => {
  it('parse5/parseFragment отсутствуют в клиентских артефактах dist', () => {
    expect(existsSync(dist), 'dist не собран').toBe(true);
    const hits: string[] = [];
    for (const file of walkFiles(dist, ['.js', '.mjs', '.html', '.css'])) {
      if (file.includes(`${join('dist', 'pagefind')}`)) continue;
      const text = readFileSync(file, 'utf-8');
      if (/parse5|parseFragment|defaultTreeAdapter/.test(text)) hits.push(file);
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
