import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { candidateInventory, rollbackInventory } from './helpers/publication-browser-inventory';
import { PUBLICATION_BROWSER_ARGS, ROLLBACK_BROWSER_ARGS } from '../scripts/lib/publication-check-adapters';

it('fixed candidate and retained commands collect their complete inventory without a build or server', () => {
  for (const [args, inventory] of [[PUBLICATION_BROWSER_ARGS, candidateInventory], [ROLLBACK_BROWSER_ARGS, rollbackInventory]] as const) {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/playwright/cli.js'), ...args, '--list'], {
      cwd: join(import.meta.dirname, '..'), env: { ...process.env, PUBLICATION_BASE_URL: 'http://127.0.0.1:1' }, encoding: 'utf8', timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.errors).toEqual([]);
    expect(report.config.webServer ?? null).toBeNull();
    const collected: Record<string, number> = {};
    type Suite = { file: string; specs?: { file: string; tests: { projectName: string; expectedStatus: string; annotations: { type: string }[] }[] }[]; suites?: Suite[] };
    function visit(suites: Suite[]) {
      for (const suite of suites) {
        for (const spec of suite.specs ?? []) for (const test of spec.tests) {
          expect(test.expectedStatus).toBe('passed');
          expect(test.annotations.filter((annotation) => ['skip', 'fixme'].includes(annotation.type))).toEqual([]);
          const key = `${spec.file ?? suite.file}@${test.projectName}`;
          collected[key] = (collected[key] ?? 0) + 1;
        }
        visit(suite.suites ?? []);
      }
    }
    visit(report.suites);
    expect(collected).toEqual(inventory);
  }
}, 60_000);
