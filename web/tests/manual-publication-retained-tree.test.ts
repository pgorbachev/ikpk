import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tree } from './publication/helpers.ts';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('fixed production assertions accept the trusted absolute downloaded retained tree outside web/dist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-retained-assertions-')); dirs.push(dir);
  const retained = join(dir, 'retained'); mkdirSync(retained);
  writeFileSync(join(retained, 'index.html'), '<main>Previously checked artifact</main>');
  vi.stubEnv('PUBLICATION_TREE_DIR', retained);
  expect(tree()).toBe(retained);
});

it('fixed production assertions reject relative tree paths rather than resolving operator cwd', () => {
  vi.stubEnv('PUBLICATION_TREE_DIR', 'dist');
  expect(() => tree()).toThrow();
});
