import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadDependencyUpdateGates,
  type RuntimeAuditScopeInput,
} from './helpers/dependency-update-gates-contract';

const WEB = join(import.meta.dirname, '..');
const CLI = join(WEB, 'scripts', 'check-dependency-update-gates.ts');
const TSX = join(WEB, 'node_modules', '.bin', 'tsx');

const report = (dependencies: Record<string, unknown>): string =>
  JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies });

const packageNode = (dependencies: Record<string, unknown> = {}): unknown => ({
  version: '1.0.0',
  dependencies,
});

function input(overrides: Partial<RuntimeAuditScopeInput> = {}): RuntimeAuditScopeInput {
  const full = report({
    astro: packageNode({ vite: packageNode(), rollup: packageNode() }),
    '@astrojs/sitemap': packageNode(),
  });
  return {
    packageName: 'web',
    base: { exitCode: 0, reportJson: full },
    head: { exitCode: 0, reportJson: full },
    ...overrides,
  };
}

describe('dependency update gate: runtime audit scope', () => {
  it('passes only after measuring the same non-empty runtime tree before and after', async () => {
    const { checkRuntimeAuditScope } = await loadDependencyUpdateGates();
    expect(checkRuntimeAuditScope(input())).toMatchObject({
      ok: true,
      baseCount: 4,
      headCount: 4,
    });
  });

  it('detects a dependencies-to-devDependencies move that removes a package and its subtree', async () => {
    const { checkRuntimeAuditScope } = await loadDependencyUpdateGates();
    const result = checkRuntimeAuditScope(
      input({
        head: {
          exitCode: 0,
          reportJson: report({ '@astrojs/sitemap': packageNode() }),
        },
      }),
    );

    expect(result).toMatchObject({ ok: false, baseCount: 4, headCount: 1 });
    expect(result.message).toMatch(/web/);
    expect(result.message).toMatch(/4/);
    expect(result.message).toMatch(/1/);
  });

  it.each([
    ['base process failed', { base: { exitCode: 1, reportJson: '' } }],
    ['head report is absent', { head: { exitCode: 0, reportJson: '' } }],
    ['head report is empty', { head: { exitCode: 0, reportJson: report({}) } }],
    ['head report is malformed', { head: { exitCode: 0, reportJson: '{not json' } }],
  ])('fails when runtime scope was not measured: %s', async (_label, overrides) => {
    const { checkRuntimeAuditScope } = await loadDependencyUpdateGates();
    const result = checkRuntimeAuditScope(input(overrides));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/runtime|audit|report|measure|измер|отч[её]т/i);
  });
});

describe('dependency update gate CLI: missing runtime measurement', () => {
  const run = (baseReport: string, headReportPath: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'dependency-runtime-audit-'));
    const base = join(dir, 'base.json');
    writeFileSync(base, baseReport, 'utf8');
    return spawnSync(
      TSX,
      [
        CLI,
        'runtime-audit-scope',
        '--package',
        'web',
        '--base-report',
        base,
        '--head-report',
        headReportPath,
      ],
      { cwd: WEB, encoding: 'utf8' },
    );
  };

  it('accepts two readable non-empty measurements', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dependency-runtime-head-'));
    const head = join(dir, 'head.json');
    const measured = report({ astro: packageNode() });
    writeFileSync(head, measured, 'utf8');
    const result = run(measured, head);
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
  });

  it('returns failure and names the absent head report instead of treating it as zero findings', () => {
    const absent = join(tmpdir(), 'dependency-runtime-report-that-does-not-exist.json');
    const result = run(report({ astro: packageNode() }), absent);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/head|report|measure|измер|отч[её]т/i);
  });
});
