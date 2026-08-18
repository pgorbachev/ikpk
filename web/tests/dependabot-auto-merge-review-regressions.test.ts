import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const DISPATCHER_SOURCE = readFileSync(
  new URL('../../.github/workflows/dependabot-auto-merge.yml', import.meta.url),
  'utf8',
);
const WORKFLOW = parse(WORKFLOW_SOURCE) as {
  jobs?: Record<string, {
    if?: string;
    needs?: string | string[];
    steps?: Array<{ name?: string; if?: string; env?: Record<string, string>; run?: string }>;
  }>;
};

function pinnedWorkflowSource(): string {
  const match = DISPATCHER_SOURCE.match(
    /pgorbachev\/ikpk\/\.github\/workflows\/dependabot-auto-merge-policy\.yml@([0-9a-f]{40})/,
  );
  expect(match, 'dispatcher must pin the reusable policy by an immutable SHA').not.toBeNull();
  const result = spawnSync(
    'git',
    ['show', `${match?.[1]}:.github/workflows/dependabot-auto-merge-policy.yml`],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr || 'pinned policy commit is not available').toBe(0);
  return result.stdout;
}

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
      FRESH_SNAPSHOT_RESULT: 'success',
      FRESH_HEAD_MATCHES_CURRENT: 'true',
      FRESH_AUTO_MERGE_ENABLED: 'false',
      GATE_OK: '',
      REASON: 'assessment unavailable',
      ...overrides,
    },
  });
}

function freshSnapshotStep(): { env: Record<string, string>; run: string } {
  const pinnedWorkflow = parse(pinnedWorkflowSource()) as typeof WORKFLOW;
  const job = pinnedWorkflow.jobs?.snapshot;
  const step = job?.steps?.find(({ name }) => name?.toLowerCase().includes('current head'));
  expect(step, 'fresh pull-request snapshot step is missing').toBeDefined();
  expect(step?.run, 'fresh pull-request snapshot has no executable contract').toBeTypeOf('string');
  return { env: step?.env ?? {}, run: step?.run ?? '' };
}

function runFreshSnapshot(currentPullRequest: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'dependabot-fresh-snapshot-'));
  const outputPath = join(directory, 'github-output');
  writeFileSync(outputPath, '');
  const step = freshSnapshotStep();
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `
gh() {
  test "$#" -eq 2
  test "$1" = api
  test "$2" = "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER"
  printf '%s\\n' "$MOCK_CURRENT_PR_JSON"
}
${step.run}
`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_HEAD_SHA: '1111111111111111111111111111111111111111',
      GH_TOKEN: 'test-token',
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: 'pgorbachev/ikpk',
      MOCK_CURRENT_PR_JSON: JSON.stringify(currentPullRequest),
      PR_NUMBER: '123',
    },
  });
  const output = readFileSync(outputPath, 'utf8');
  rmSync(directory, { recursive: true, force: true });
  return { output, result };
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
    appId: 15368,
    eventName: 'workflow_run',
    externalId: 'provenance:parent-sha:trusted-policy-sha',
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
    appId: policy.appId,
    eventName: policy.eventName,
    externalId: policy.externalId,
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
  it.each(['false', 'true'])('fails closed when assessment fails with marker=%s', (marker) => {
    const result = runEligibilityGate({ FRESH_AUTO_MERGE_ENABLED: marker });
    expect(result.status, result.stderr || result.stdout).not.toBe(0);
  });
});

describe('review regressions: fresh marker snapshot', () => {
  it('executes the exact policy revision pinned by the dispatcher', () => {
    expect(pinnedWorkflowSource()).toBe(WORKFLOW_SOURCE);
  });

  it('binds the snapshot inputs and token through the workflow environment', () => {
    expect(freshSnapshotStep().env).toEqual({
      EVENT_HEAD_SHA: '${{ inputs.source-head-sha }}',
      GH_TOKEN: '${{ github.token }}',
      PR_NUMBER: '${{ inputs.source-pr-number }}',
    });
  });

  it('accepts a null auto_merge marker as disabled', () => {
    const { output, result } = runFreshSnapshot({
      auto_merge: null,
      head: { sha: '1111111111111111111111111111111111111111' },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(output).toContain('auto-merge-enabled=false');
  });

  it('fails closed when the REST snapshot omits auto_merge', () => {
    const { output, result } = runFreshSnapshot({
      head: { sha: '1111111111111111111111111111111111111111' },
    });

    expect(result.status, result.stderr || result.stdout).not.toBe(0);
    expect(output).toBe('');
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
