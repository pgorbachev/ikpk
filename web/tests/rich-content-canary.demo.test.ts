import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { demoDist, demoPagePath, demoPages } from './helpers/demo-dist';
import {
  CANARY_CONTROL_TOKEN,
  CANARY_HOSTILE_TOKEN,
  CANARY_PATH,
} from './helpers/rich-content-safety/closed-matrix.js';

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
    const pages = demoPages();
    const canary = pages.find((f) => demoPagePath(f).includes(`${CANARY_PATH}/`) || demoPagePath(f) === `${CANARY_PATH}/index.html` || demoPagePath(f) === `${CANARY_PATH}index.html`);
    expect(canary, `нет canary path ${CANARY_PATH} в dist-demo`).toBeTruthy();
    const html = readFileSync(canary!, 'utf-8');
    expect(html.split(CANARY_CONTROL_TOKEN).length - 1).toBe(1);
    expect(html).toMatch(/data-safe-rich-content="/);
  });
});
