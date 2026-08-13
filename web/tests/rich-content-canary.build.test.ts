import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dist, walkHtml } from './helpers/dist-pages';
import {
  CANARY_CONTROL_TOKEN,
  CANARY_HOSTILE_TOKEN,
  CANARY_PATH,
} from './helpers/rich-content-safety/closed-matrix.js';
import { loadFixture } from './helpers/rich-content-safety/load-fixture.js';

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
  it('каждая ожидаемая область имеет data-safe-rich-content, count совпадает', () => {
    const rendered = loadFixture<{ sinks: { id: string; production: { paths: string[]; count: number } }[] }>(
      'rendered-registry.json',
    );
    const missing: string[] = [];
    for (const sink of rendered.sinks) {
      if (sink.production.count === 0) {
        expect(sink.production.paths, sink.id).toEqual([]);
        continue;
      }
      let markers = 0;
      for (const path of sink.production.paths) {
        const page = pageFile(path);
        if (!existsSync(page)) {
          missing.push(`${sink.id} ${path} (нет файла)`);
          continue;
        }
        const html = readFileSync(page, 'utf-8');
        const count = html.split(`data-safe-rich-content="${sink.id}"`).length - 1;
        if (count === 0) missing.push(`${sink.id} ${path}`);
        markers += count;
      }
      if (markers !== sink.production.count) {
        missing.push(`${sink.id} count: registry=${sink.production.count} live=${markers}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
