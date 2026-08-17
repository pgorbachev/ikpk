import { describe, expect, it } from 'vitest';
import { loadDependencyUpdateGates, type TestExecutionInput } from './helpers/dependency-update-gates-contract';

const vitestReport = (passed: number, failed = 0, skipped = 0) => ({
  numPassedTests: passed,
  numFailedTests: failed,
  numPendingTests: skipped,
});
const playwrightReport = (expected: number, unexpected = 0, flaky = 0, skipped = 0) => ({
  stats: { expected, unexpected, flaky, skipped },
});

function input(overrides: Partial<TestExecutionInput> = {}): TestExecutionInput {
  return {
    runner: 'vitest',
    threshold: 100,
    changedFiles: ['web/package.json', 'web/package-lock.json'],
    baseReport: vitestReport(120),
    headReport: vitestReport(120),
    ...overrides,
  };
}

describe('dependency update gate: executed test count', () => {
  it.each([
    ['vitest', vitestReport(120), vitestReport(120)],
    ['playwright', playwrightReport(118, 1, 1), playwrightReport(118, 1, 1)],
  ] as const)('passes when %s executed volume is preserved', async (runner, baseReport, headReport) => {
    const { checkTestExecution } = await loadDependencyUpdateGates();
    expect(checkTestExecution(input({ runner, baseReport, headReport }))).toMatchObject({
      ok: true,
      headCount: 120,
      baseCount: 120,
    });
  });

  it('fails a dependency-only PR when some tests stop running above threshold', async () => {
    const { checkTestExecution } = await loadDependencyUpdateGates();
    const result = checkTestExecution(input({ headReport: vitestReport(110, 0, 10) }));
    expect(result).toMatchObject({ ok: false, headCount: 110, baseCount: 120 });
    expect(result.message).toMatch(/120/);
    expect(result.message).toMatch(/110/);
  });

  it('does not count skipped tests as executed', async () => {
    const { checkTestExecution } = await loadDependencyUpdateGates();
    const result = checkTestExecution(input({ threshold: 120, headReport: vitestReport(110, 0, 10) }));
    expect(result).toMatchObject({ ok: false, headCount: 110 });
  });

  it('allows deletion of a test above threshold because base comparison is out of scope', async () => {
    const { checkTestExecution } = await loadDependencyUpdateGates();
    const result = checkTestExecution(
      input({ changedFiles: ['web/tests/obsolete.test.ts'], headReport: vitestReport(110) }),
    );
    expect(result).toMatchObject({ ok: true, headCount: 110 });
  });

  it('fails instead of treating a missing machine report as zero successful defects', async () => {
    const { checkTestExecution } = await loadDependencyUpdateGates();
    const result = checkTestExecution(input({ headReport: null }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/report|measure|измер|отч[её]т/i);
  });
});
