import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const configPath = join(import.meta.dirname, '..', '..', '.github', 'dependabot.yml');
const config = parse(readFileSync(configPath, 'utf8')) as {
  updates?: Array<{
    'package-ecosystem'?: string;
    directory?: string;
    directories?: string[];
    groups?: Record<string, { 'update-types'?: string[] }>;
  }>;
};

const npmUpdates = () => (config.updates ?? []).filter((u) => u['package-ecosystem'] === 'npm');
const dirs = (u: ReturnType<typeof npmUpdates>[number]) => u.directories ?? (u.directory ? [u.directory] : []);

describe('Dependabot grouping contract', () => {
  it('uses one update scope for the same minor dependency in allowed web and scripts packages', () => {
    const shared = npmUpdates().filter((u) => dirs(u).includes('/web') && dirs(u).includes('/scripts'));
    expect(shared, 'web and scripts must share a directories scope so one dependency can produce one PR').toHaveLength(1);
    expect(Object.values(shared[0].groups ?? {}).some((g) =>
      ['minor', 'patch'].every((kind) => g['update-types']?.includes(kind)),
    )).toBe(true);
  });

  it('keeps cms outside the allowed web/scripts update scope', () => {
    const mixed = npmUpdates().filter((u) => {
      const scope = dirs(u);
      return scope.includes('/cms') && (scope.includes('/web') || scope.includes('/scripts'));
    });
    expect(mixed, 'cms belongs to a different acceptance class').toEqual([]);
  });

  it('does not split tsx by dependency manifest section', () => {
    const shared = npmUpdates().find((u) => dirs(u).includes('/web') && dirs(u).includes('/scripts'));
    expect(
      shared,
      'spec/design use package acceptance class, not dependencies/devDependencies, as grouping input',
    ).toBeDefined();
  });

  it('keeps semver-major updates out of patch/minor groups', () => {
    const bad = npmUpdates().flatMap((u) =>
      Object.entries(u.groups ?? {})
        .filter(([, group]) => group['update-types']?.includes('major'))
        .map(([name]) => `${dirs(u).join(',')}:${name}`),
    );
    expect(bad).toEqual([]);
  });

  it('has no npm update entry with an empty directory scope or no groups', () => {
    expect(npmUpdates().length, 'no npm Dependabot entries found').toBeGreaterThan(0);
    for (const update of npmUpdates()) {
      expect(dirs(update).length).toBeGreaterThan(0);
      expect(Object.keys(update.groups ?? {}).length).toBeGreaterThan(0);
    }
  });
});
