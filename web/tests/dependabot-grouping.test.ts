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
    groups?: Record<string, {
      'dependency-type'?: string;
      'group-by'?: string;
      'update-types'?: string[];
    }>;
  }>;
};

const npmUpdates = () => (config.updates ?? []).filter((u) => u['package-ecosystem'] === 'npm');
const dirs = (u: ReturnType<typeof npmUpdates>[number]) => u.directories ?? (u.directory ? [u.directory] : []);

describe('Dependabot grouping contract', () => {
  it('uses one update scope for the same minor dependency in allowed web and scripts packages', () => {
    const shared = npmUpdates().filter((u) => dirs(u).includes('/web') && dirs(u).includes('/scripts'));
    expect(shared, 'web and scripts must share a directories scope so one dependency can produce one PR').toHaveLength(1);
    expect(new Set(dirs(shared[0]))).toEqual(new Set(['/web', '/scripts']));

    const groups = Object.values(shared[0].groups ?? {});
    expect(groups, 'the shared scope must define exactly one unambiguous grouping rule').toHaveLength(1);
    expect(groups[0]?.['group-by'], 'different dependency names must produce different PRs')
      .toBe('dependency-name');
    expect(['minor', 'patch'].every((kind) => groups[0]?.['update-types']?.includes(kind))).toBe(true);
    expect(groups[0]?.['update-types']).not.toContain('major');
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
    const groups = Object.values(shared?.groups ?? {});
    expect(groups, 'shared web/scripts grouping rule not found').toHaveLength(1);
    expect(
      groups[0]?.['dependency-type'],
      'dependencies/devDependencies must not affect grouping of the same dependency',
    ).toBeUndefined();
  });

  it('keeps different cms dependencies in separate pull requests', () => {
    const cms = npmUpdates().filter((u) => dirs(u).includes('/cms'));
    expect(cms, 'cms must have one independent update scope').toHaveLength(1);
    expect(new Set(dirs(cms[0]))).toEqual(new Set(['/cms']));
    expect(
      Object.keys(cms[0].groups ?? {}),
      'a broad cms patch/minor group would mix different dependency names in one PR',
    ).toEqual([]);
  });

  it('keeps semver-major updates out of patch/minor groups', () => {
    const bad = npmUpdates().flatMap((u) =>
      Object.entries(u.groups ?? {})
        .filter(([, group]) => group['update-types']?.includes('major'))
        .map(([name]) => `${dirs(u).join(',')}:${name}`),
    );
    expect(bad).toEqual([]);
  });

  it('has no empty npm scope and every multi-directory scope defines grouping', () => {
    expect(npmUpdates().length, 'no npm Dependabot entries found').toBeGreaterThan(0);
    for (const update of npmUpdates()) {
      expect(dirs(update).length).toBeGreaterThan(0);
      if (dirs(update).length > 1) {
        expect(Object.keys(update.groups ?? {}).length).toBeGreaterThan(0);
      }
    }
  });
});
