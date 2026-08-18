import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadDependencyUpdateGates,
  type LintCoverageInput,
  type TestExecutionInput,
} from './helpers/dependency-update-gates-contract';

const WEB = join(import.meta.dirname, '..');
const CLI = join(WEB, 'scripts', 'check-dependency-update-gates.ts');
const TSX = join(WEB, 'node_modules', '.bin', 'tsx');
const ACTION_CHANGE = ['.github/workflows/test.yml'];

const lintReport = (count: number): string => JSON.stringify(
  Array.from({ length: count }, (_, index) => ({
    filePath: `/repo/src/file-${index}.ts`,
    messages: [],
  })),
);

const vitestReport = (passed: number) => ({
  numPassedTests: passed,
  numFailedTests: 0,
  numPendingTests: 0,
});

function lintInput(overrides: Partial<LintCoverageInput> = {}): LintCoverageInput {
  return {
    packageName: 'web',
    threshold: 100,
    changedFiles: ACTION_CHANGE,
    autoMergeEligible: true,
    base: { exitCode: 0, reportJson: lintReport(120) },
    head: { exitCode: 0, reportJson: lintReport(110) },
    ...overrides,
  };
}

function testInput(overrides: Partial<TestExecutionInput> = {}): TestExecutionInput {
  return {
    runner: 'vitest',
    threshold: 100,
    changedFiles: ACTION_CHANGE,
    autoMergeEligible: true,
    baseReport: vitestReport(120),
    headReport: vitestReport(110),
    ...overrides,
  };
}

describe('dependency invariant base-comparison scope', () => {
  it('compares lint coverage with base for an eligible github-actions PR without manifest changes', async () => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    expect(checkLintCoverage(lintInput())).toMatchObject({
      ok: false,
      baseCount: 120,
      headCount: 110,
    });
  });

  it('fails closed when eligible github-actions lint comparison has no base measurement', async () => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    const result = checkLintCoverage(lintInput({ base: undefined }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/base|базов/i);
  });

  it('compares executed tests with base for an eligible github-actions PR without manifest changes', async () => {
    const { checkTestExecution } = await loadDependencyUpdateGates();
    expect(checkTestExecution(testInput())).toMatchObject({
      ok: false,
      baseCount: 120,
      headCount: 110,
    });
  });

  it('fails closed when eligible github-actions test comparison has no base measurement', async () => {
    const { checkTestExecution } = await loadDependencyUpdateGates();
    const result = checkTestExecution(testInput({ baseReport: undefined }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/base|базов/i);
  });

  it('keeps a non-dependency human source PR on the previous lint threshold-only path', async () => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    expect(checkLintCoverage(lintInput({
      changedFiles: ['web/src/obsolete.ts'],
      autoMergeEligible: false,
    }))).toMatchObject({ ok: true, headCount: 110 });
  });

  it('keeps a non-dependency human test PR on the previous test threshold-only path', async () => {
    const { checkTestExecution } = await loadDependencyUpdateGates();
    expect(checkTestExecution(testInput({
      changedFiles: ['web/tests/obsolete.test.ts'],
      autoMergeEligible: false,
    }))).toMatchObject({ ok: true, headCount: 110 });
  });
});

describe('dependency invariant CLI base-comparison scope', () => {
  it.each([
    ['lint-coverage', 'lint'],
    ['test-count', 'test'],
  ] as const)('plumbs eligible github-actions scope through %s', (command, kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'dependency-auto-merge-scope-'));
    const basePath = join(dir, 'base.json');
    const headPath = join(dir, 'head.json');
    writeFileSync(basePath, kind === 'lint' ? lintReport(120) : JSON.stringify(vitestReport(120)), 'utf8');
    writeFileSync(headPath, kind === 'lint' ? lintReport(110) : JSON.stringify(vitestReport(110)), 'utf8');

    const common = [
      CLI,
      command,
      '--threshold', '100',
      '--changed-file', ACTION_CHANGE[0],
      '--auto-merge-eligible',
      '--base-report', basePath,
      '--head-report', headPath,
    ];
    const args = kind === 'lint'
      ? [...common, '--package', 'web']
      : [...common, '--runner', 'vitest'];
    const result = spawnSync(TSX, args, { cwd: WEB, encoding: 'utf8' });

    expect(result.status, `${result.stderr}${result.stdout}`).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toMatch(/120/);
    expect(`${result.stderr}${result.stdout}`).toMatch(/110/);
  });
});
