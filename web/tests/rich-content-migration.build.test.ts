import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dist } from './helpers/dist-pages.js';
import { FIXTURES_DIR } from './helpers/rich-content-safety/paths.js';
import {
  buildMigrationPageInventory,
  type MigrationPageInventory,
} from './helpers/rich-content-safety/migration-page-inventory.js';
import type { MigrationRow } from './helpers/rich-content-safety/migration.js';

describe('rich-content contract: migration classes in production output', () => {
  it('live inventory совпадает с committed evidence и article detail routes не теряют mapped classes', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'migration-manifest.json'), 'utf-8'),
    ) as MigrationRow[];
    const report = buildMigrationPageInventory(manifest, dist);
    const committed = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'evidence', 'migration-page-inventory.json'), 'utf-8'),
    ) as MigrationPageInventory;
    expect(report.renderedRoutes, 'migration routes отсутствуют — vacuous green').toBeGreaterThan(0);
    expect(report.missingPages).toEqual([]);
    expect(report.pagesWithMissingClasses).toEqual(committed.pagesWithMissingClasses);
    expect(
      report.pagesWithMissingClasses.filter((page) => /^\/statyi\/[^/]+$/.test(page.route)),
    ).toEqual([]);
    expect(report.pagesWithSvgInRich).toEqual([]);
    expect(report.pagesWithStyleInRich).toEqual([]);
  });
});
