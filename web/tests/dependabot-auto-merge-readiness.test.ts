import { describe, expect, it } from 'vitest';
import { loadDependabotAutoMerge, type MergeReadinessInput } from './helpers/dependabot-auto-merge-contract';

const readiness = (overrides: Partial<MergeReadinessInput> = {}): MergeReadinessInput => ({
  requiredChecks: [{ name: 'Tests', state: 'success' }, { name: 'Scripts unit tests', state: 'success' }],
  baseUpToDate: true,
  mergeCombinationChecks: [{ name: 'merge-with-main', state: 'success' }],
  ...overrides,
});

describe('automatic merge readiness', () => {
  it('waits while a required check is still running', async () => {
    const { evaluateMergeReadiness } = await loadDependabotAutoMerge();
    expect(evaluateMergeReadiness(readiness({ requiredChecks: [{ name: 'Tests', state: 'pending' }] })).ok)
      .toBe(false);
  });

  it('does not merge when a required check fails', async () => {
    const { evaluateMergeReadiness } = await loadDependabotAutoMerge();
    expect(evaluateMergeReadiness(readiness({ requiredChecks: [{ name: 'Tests', state: 'failure' }] })).ok)
      .toBe(false);
  });

  it('does not merge a stale PR base', async () => {
    const { evaluateMergeReadiness } = await loadDependabotAutoMerge();
    expect(evaluateMergeReadiness(readiness({ baseUpToDate: false })).ok).toBe(false);
  });

  it('does not merge when the PR is green alone but the merge with current main fails', async () => {
    const { evaluateMergeReadiness } = await loadDependabotAutoMerge();
    expect(evaluateMergeReadiness(readiness({
      mergeCombinationChecks: [{ name: 'merge-with-main', state: 'failure' }],
    })).ok).toBe(false);
  });
});
