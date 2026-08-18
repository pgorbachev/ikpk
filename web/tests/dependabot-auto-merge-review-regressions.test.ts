import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  loadDependabotAutoMerge,
  type ProvenanceEvidenceCandidate,
  type TrustedEvidencePolicy,
} from './helpers/dependabot-auto-merge-contract';

const SCRIPT = readFileSync(
  new URL('../scripts/check-dependabot-auto-merge.ts', import.meta.url),
  'utf8',
);
const WORKFLOW_SOURCE = readFileSync(
  new URL('../../.github/workflows/dependabot-auto-merge-policy.yml', import.meta.url),
  'utf8',
);
const WORKFLOW = parse(WORKFLOW_SOURCE) as {
  jobs?: Record<string, {
    if?: string;
    needs?: string | string[];
    steps?: Array<{ name?: string; if?: string; env?: Record<string, string>; run?: string }>;
  }>;
};

function eligibilityGateStep(): { env: Record<string, string>; run: string } {
  const job = WORKFLOW.jobs?.['eligibility-gate'];
  const step = job?.steps?.find(({ name }) => name?.toLowerCase().includes('fail-closed'));
  expect(step, 'mandatory eligibility gate step is missing').toBeDefined();
  expect(step?.run, 'mandatory eligibility gate has no executable contract').toBeTypeOf('string');
  return { env: step?.env ?? {}, run: step?.run ?? '' };
}

function runEligibilityGate(overrides: Record<string, string>) {
  const step = eligibilityGateStep();
  return spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ASSESS_RESULT: 'failure',
      AUTO_MERGE_ENABLED: 'false',
      GATE_OK: '',
      REASON: 'assessment unavailable',
      ...overrides,
    },
  });
}

describe('review regressions: Dependabot metadata adapter', () => {
  it('normalizes fetch-metadata github_actions to the policy ecosystem name', async () => {
    const { normalizeDependabotEcosystem } = await loadDependabotAutoMerge();
    expect(normalizeDependabotEcosystem('github_actions')).toBe('github-actions');
    expect(normalizeDependabotEcosystem('npm_and_yarn')).toBe('npm');
  });

  it('routes fetched packageEcosystem through the normalization seam', () => {
    expect(SCRIPT).toContain('normalizeDependabotEcosystem');
    expect(SCRIPT).not.toMatch(/ecosystem\s*=\s*\[\.\.\.ecosystems\]\[0\][\s\S]{0,200}ecosystem === 'github-actions'/);
  });
});

describe('review regressions: provenance evidence identity', () => {
  const policy: TrustedEvidencePolicy = {
    sha: 'parent-sha',
    checkName: 'Dependabot auto-merge / Provenance evidence',
    appSlug: 'github-actions',
    callerWorkflowPath: '.github/workflows/pull-request.yml',
    reusablePolicyPath: '.github/workflows/dependabot-auto-merge-policy.yml',
    reusablePolicySha: 'trusted-policy-sha',
  };
  const candidate: ProvenanceEvidenceCandidate = {
    sha: policy.sha,
    name: policy.checkName,
    status: 'completed',
    conclusion: 'success',
    appSlug: policy.appSlug,
    callerWorkflowPath: policy.callerWorkflowPath,
    reusablePolicyPath: policy.reusablePolicyPath,
    reusablePolicySha: policy.reusablePolicySha,
  };

  it('accepts evidence only when the check, trusted caller and reusable policy SHA all match', async () => {
    const { isTrustedPositiveEvidence } = await loadDependabotAutoMerge();
    expect(isTrustedPositiveEvidence(candidate, policy)).toBe(true);
  });

  it('rejects a same-name GitHub Actions check from another caller', async () => {
    const { isTrustedPositiveEvidence } = await loadDependabotAutoMerge();
    expect(isTrustedPositiveEvidence({
      ...candidate,
      callerWorkflowPath: '.github/workflows/attacker.yml',
    }, policy)).toBe(false);
  });

  it('rejects the trusted caller when it references an untrusted reusable policy SHA', async () => {
    const { isTrustedPositiveEvidence } = await loadDependabotAutoMerge();
    expect(isTrustedPositiveEvidence({ ...candidate, reusablePolicySha: 'untrusted-policy-sha' }, policy)).toBe(false);
  });

  it('uses the strict evidence predicate in the API-backed lookup', () => {
    expect(SCRIPT).toContain('isTrustedPositiveEvidence');
  });
});

describe('review regressions: mandatory gate failure semantics', () => {
  it('keeps the mandatory gate green when assessment fails on the manual path', () => {
    const step = eligibilityGateStep();
    expect(JSON.stringify(step.env)).toContain('pull_request.auto_merge');
    const result = runEligibilityGate({ AUTO_MERGE_ENABLED: 'false' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('fails closed when assessment fails for a PR that is still marked for auto-merge', () => {
    const result = runEligibilityGate({ AUTO_MERGE_ENABLED: 'true' });
    expect(result.status, result.stderr || result.stdout).not.toBe(0);
  });
});

describe('review regressions: explicit disable accelerator', () => {
  it('executes an explicit disable for an invalid marked head without replacing the gate', () => {
    const jobs = WORKFLOW.jobs ?? {};
    expect(jobs['eligibility-gate'], 'the mandatory protection gate must remain present').toBeDefined();

    const disable = Object.entries(jobs).flatMap(([jobName, job]) =>
      (job.steps ?? []).map((step) => ({ jobName, job, step })))
      .find(({ step }) => /--disable-auto|disablePullRequestAutoMerge/.test(step.run ?? ''));
    expect(disable, 'no executable auto-merge disable accelerator was found').toBeDefined();

    const contract = JSON.stringify(disable);
    expect(contract).toMatch(/auto[_-]?merge|autoMerge/i);
    expect(contract).toMatch(/assess|gate|invalid|origin|eligible/i);
    expect(disable?.jobName).not.toBe('eligibility-gate');
  });
});
