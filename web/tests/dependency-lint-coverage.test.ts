import { describe, expect, it } from 'vitest';
import { loadDependencyUpdateGates, type LintCoverageInput } from './helpers/dependency-update-gates-contract';

const report = (count: number): string =>
  JSON.stringify(Array.from({ length: count }, (_, i) => ({ filePath: `/repo/src/file-${i}.ts`, messages: [] })));

function input(overrides: Partial<LintCoverageInput> = {}): LintCoverageInput {
  return {
    packageName: 'web',
    threshold: 128,
    changedFiles: ['web/package.json', 'web/package-lock.json'],
    base: { exitCode: 0, reportJson: report(180) },
    head: { exitCode: 0, reportJson: report(180) },
    ...overrides,
  };
}

describe('dependency update gate: lint coverage', () => {
  it('passes when head coverage is at least both threshold and dependency-only base', async () => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    expect(checkLintCoverage(input())).toMatchObject({ ok: true, headCount: 180, baseCount: 180 });
  });

  it('fails below threshold and names package, threshold, and actual count', async () => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    const result = checkLintCoverage(input({ head: { exitCode: 0, reportJson: report(127) } }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/web/);
    expect(result.message).toMatch(/128/);
    expect(result.message).toMatch(/127/);
  });

  it('fails against base for a dependency-only PR even while above threshold', async () => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    const result = checkLintCoverage(input({ head: { exitCode: 0, reportJson: report(140) } }));
    expect(result).toMatchObject({ ok: false, headCount: 140, baseCount: 180 });
    expect(result.message).toMatch(/180/);
    expect(result.message).toMatch(/140/);
  });

  it('allows source deletion above threshold because base comparison is out of scope', async () => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    const result = checkLintCoverage(
      input({ changedFiles: ['web/src/obsolete.ts'], head: { exitCode: 0, reportJson: report(140) } }),
    );
    expect(result).toMatchObject({ ok: true, headCount: 140 });
  });

  it('still fails source deletion below threshold', async () => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    const result = checkLintCoverage(
      input({ changedFiles: ['web/src/obsolete.ts'], head: { exitCode: 0, reportJson: report(127) } }),
    );
    expect(result).toMatchObject({ ok: false, headCount: 127 });
  });

  it.each([
    ['lint process error', { exitCode: 2, reportJson: report(180) }],
    ['empty report', { exitCode: 0, reportJson: '[]' }],
    ['unparseable report', { exitCode: 0, reportJson: '{not json' }],
  ])('fails when lint did not produce a usable measurement: %s', async (_label, head) => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    const result = checkLintCoverage(input({ head }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/lint|report|measure|измер|отч[её]т/i);
  });

  it('fails when a dependency-only comparison has no base measurement', async () => {
    const { checkLintCoverage } = await loadDependencyUpdateGates();
    const result = checkLintCoverage(input({ base: undefined }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/base|lint|report|measure|измер|отч[её]т/i);
  });
});
