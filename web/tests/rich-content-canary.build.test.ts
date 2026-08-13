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
    const page = join(dist, CANARY_PATH.replace(/^\//, ''), 'index.html');
    expect(existsSync(page), `нет canary path ${CANARY_PATH}`).toBe(true);
    const html = readFileSync(page, 'utf-8');
    const controls = html.split(CANARY_CONTROL_TOKEN).length - 1;
    expect(controls, 'fixture-control token').toBe(1);
    expect(html).toMatch(/data-safe-rich-content="/);
  });
});

describe('rich-content contract: marker inventory (production)', () => {
  it('каждая ожидаемая область имеет data-safe-rich-content', () => {
    const rendered = loadFixture<{ sinks: { id: string; production: { paths: string[]; count: number } }[] }>(
      'rendered-registry.json',
    );
    const missing: string[] = [];
    for (const sink of rendered.sinks) {
      if (sink.production.count === 0) continue;
      for (const path of sink.production.paths.slice(0, 3)) {
        const page = path === '/' ? join(dist, 'index.html') : join(dist, path.replace(/^\//, ''), 'index.html');
        if (!existsSync(page)) {
          missing.push(`${sink.id} ${path} (нет файла)`);
          continue;
        }
        const html = readFileSync(page, 'utf-8');
        if (!html.includes(`data-safe-rich-content="${sink.id}"`)) {
          missing.push(`${sink.id} ${path}`);
        }
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
