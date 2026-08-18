import { describe, expect, it } from 'vitest';
import {
  loadDependabotAutoMerge,
  type HeadEvaluationInput,
  type StoredResult,
} from './helpers/dependabot-auto-merge-contract';

const PRODUCER = 'dependabot-auto-merge/provenance';
const PLATFORM_SIGNATURE = { valid: true, wasSignedByGitHub: true, signerLogin: 'web-flow' };

const head = (overrides: Partial<HeadEvaluationInput> = {}): HeadEvaluationInput => ({
  sha: 'head-1',
  autoMergeEnabled: true,
  classificationEligible: true,
  prAuthor: 'dependabot[bot]',
  signature: PLATFORM_SIGNATURE,
  actor: { login: 'dependabot[bot]', kind: 'dependabot' },
  expectedEvidenceProducer: PRODUCER,
  ...overrides,
});

const evidence = (overrides: Partial<StoredResult> = {}): StoredResult => ({
  sha: 'parent',
  kind: 'provenance',
  producer: PRODUCER,
  conclusion: 'positive',
  ...overrides,
});

const update = (overrides: Partial<HeadEvaluationInput> = {}): HeadEvaluationInput => head({
  actor: { login: 'branch-updater[bot]', kind: 'update-mechanism' },
  topology: {
    parentShas: ['parent', 'base'],
    secondParentInBase: true,
    introducesOnlyBaseChanges: true,
  },
  storedResults: [evidence()],
  ...overrides,
});

describe('mandatory eligibility gate and separate provenance evidence', () => {
  it('does not block an ordinary human PR on the manual path', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    expect(evaluateHead(head({ autoMergeEnabled: false, prAuthor: 'maintainer', actor: { login: 'maintainer', kind: 'human' } })).gate)
      .toMatchObject({ ok: true });
  });

  it('does not block a manual-path Dependabot major or cms PR', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    expect(evaluateHead(head({ autoMergeEnabled: false, classificationEligible: false })).gate)
      .toMatchObject({ ok: true });
  });

  it('fails when auto-merge is enabled for an invalid origin', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    expect(evaluateHead(head({ actor: { login: 'maintainer', kind: 'human' } })).gate)
      .toMatchObject({ ok: false });
  });

  it('rejects a GitHub-signed API commit when the event actor is a human', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    expect(evaluateHead(head({ actor: { login: 'maintainer', kind: 'human' } })).gate.ok).toBe(false);
  });

  it('rejects a Dependabot event actor when the commit lacks a platform signature', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    expect(evaluateHead(head({ signature: { valid: false, wasSignedByGitHub: false, signerLogin: null } })).gate.ok)
      .toBe(false);
  });

  it('accepts a real Dependabot shape signed by the platform service account', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    const result = evaluateHead(head());
    expect(result.gate.ok).toBe(true);
    expect(head().signature.signerLogin).toBe('web-flow');
    expect(result.evidence).toMatchObject({ kind: 'provenance', conclusion: 'positive', producer: PRODUCER });
  });

  it('rejects an otherwise trusted updater actor on a single-parent commit', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    expect(evaluateHead(update({ topology: { parentShas: ['parent'], secondParentInBase: true, introducesOnlyBaseChanges: true } })).gate.ok)
      .toBe(false);
  });

  it('accepts two consecutive updater merges when every intermediate SHA has trusted evidence', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    const first = evaluateHead(update({ sha: 'update-1' }));
    expect(first.gate.ok).toBe(true);
    const second = evaluateHead(update({
      sha: 'update-2',
      topology: { parentShas: ['update-1', 'base-2'], secondParentInBase: true, introducesOnlyBaseChanges: true },
      storedResults: [first.evidence],
    }));
    expect(second.gate.ok).toBe(true);
  });

  it.each([
    ['missing intermediate evidence', []],
    ['evidence by another producer', [evidence({ producer: 'attacker/check' })]],
    ['green eligibility gate instead of evidence', [evidence({ kind: 'eligibility-gate' })]],
  ])('rejects updater chain with %s', async (_label, storedResults) => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    expect(evaluateHead(update({ storedResults })).gate.ok).toBe(false);
  });

  it('records negative evidence for a human commit while leaving the manual gate green', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    const result = evaluateHead(head({
      autoMergeEnabled: false,
      actor: { login: 'maintainer', kind: 'human' },
    }));
    expect(result.gate.ok).toBe(true);
    expect(result.evidence).toMatchObject({ kind: 'provenance', conclusion: 'negative' });
  });

  it('rejects a subsequent updater merge over a parent with negative evidence', async () => {
    const { evaluateHead } = await loadDependabotAutoMerge();
    expect(evaluateHead(update({ storedResults: [evidence({ conclusion: 'negative' })] })).gate.ok).toBe(false);
  });
});
