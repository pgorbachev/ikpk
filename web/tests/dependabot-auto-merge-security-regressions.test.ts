import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadDependabotAutoMerge } from './helpers/dependabot-auto-merge-contract';

const HEAD_SHA = '1111111111111111111111111111111111111111';
const POLICY_SHA = '2222222222222222222222222222222222222222';
const ELIGIBILITY_NAME = 'Dependabot auto-merge / Eligibility gate';
const PROVENANCE_JOB = 'Provenance evidence';
const POLICY_SCRIPT_SOURCE = readFileSync(
  process.env.DEPENDABOT_PROVENANCE_CONSUMER_SOURCE
    ? new URL(process.env.DEPENDABOT_PROVENANCE_CONSUMER_SOURCE, import.meta.url)
    : new URL('../scripts/check-dependabot-auto-merge.ts', import.meta.url),
  'utf8',
);

const WORKFLOW_SOURCE = readFileSync(
  process.env.DEPENDABOT_CHECK_PUBLISHER_WORKFLOW
    ? new URL(process.env.DEPENDABOT_CHECK_PUBLISHER_WORKFLOW, import.meta.url)
    : new URL('../../.github/workflows/dependabot-auto-merge-policy.yml', import.meta.url),
  'utf8',
);
const WORKFLOW = parse(WORKFLOW_SOURCE) as {
  jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
};

function publisherScript(): string {
  const step = WORKFLOW.jobs?.['publish-checks']?.steps?.find(({ name }) =>
    name?.toLowerCase().includes('publish current-head'));
  expect(step?.run, 'custom check publisher must have an executable shell contract').toBeTypeOf('string');
  return step?.run ?? '';
}

function runPublisher(checkRuns: unknown[], secondPage: unknown[] = []): {
  status: number | null;
  stderr: string;
  calls: string[][];
} {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-check-publisher-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'gh.log');
  const gh = join(bin, 'gh');
  try {
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'CALL'
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >>"$GH_LOG"
if [[ "$*" == *'/commits/'*'/check-runs?'* ]]; then
  if [[ "$*" == *'page=2'* ]]; then
    printf '%s\\n' "$CHECK_RUNS_PAGE_2_JSON"
  else
    printf '%s\\n' "$CHECK_RUNS_JSON"
  fi
else
  printf '{}\\n'
fi
`);
    chmodSync(gh, 0o755);
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', publisherScript()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ASSESSMENT_RESULT: 'success',
        CHECK_RUNS_JSON: JSON.stringify({ check_runs: checkRuns }),
        CHECK_RUNS_PAGE_2_JSON: JSON.stringify({ check_runs: secondPage }),
        EVENT_ACTION: 'reopened',
        FRESH_AUTO_MERGE_ENABLED: 'false',
        FRESH_HEAD_MATCHES_CURRENT: 'true',
        GATE_RESULT: 'failure',
        GH_LOG: log,
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'pgorbachev/ikpk',
        GITHUB_RUN_ID: '1234',
        GITHUB_SERVER_URL: 'https://github.com',
        HEAD_SHA,
        POLICY_SHA,
        PROVENANCE_RESULT: 'skipped',
      },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t').slice(1));
    return { status: result.status, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('authoritative provenance run behind a check details_url', () => {
  const matching = {
    targetPullRequestNumber: 135,
    targetHeadSha: HEAD_SHA,
    provenanceJobName: PROVENANCE_JOB,
    expectedDispatcherWorkflowPath: '.github/workflows/dependabot-auto-merge.yml',
    expectedSignalWorkflowPath: '.github/workflows/dependabot-auto-merge-signal.yml',
    expectedSignalActor: 'dependabot[bot]',
    dispatcherRun: {
      id: 8001,
      runAttempt: 2,
      event: 'workflow_run',
      path: '.github/workflows/dependabot-auto-merge.yml',
      sourceRunId: 7001,
      sourceRunAttempt: 3,
    },
    sourceRun: {
      id: 7001,
      runAttempt: 3,
      event: 'pull_request_target',
      path: '.github/workflows/dependabot-auto-merge-signal.yml',
      conclusion: 'success',
      actorLogin: 'dependabot[bot]',
      headSha: HEAD_SHA,
      pullRequests: [{ number: 135, headSha: HEAD_SHA }],
    },
    jobsRunId: 8001,
    jobsRunAttempt: 2,
    jobs: [{ name: PROVENANCE_JOB, conclusion: 'success' as const }],
  };

  it('accepts only a dispatcher bound to its authenticated source signal and exact provenance job (control)', async () => {
    const { isAuthoritativeEvidenceRun } = await loadDependabotAutoMerge();
    expect(isAuthoritativeEvidenceRun(matching)).toBe(true);
  });

  it('rejects a dispatcher whose recorded source id points at another authenticated run', async () => {
    const { isAuthoritativeEvidenceRun } = await loadDependabotAutoMerge();
    expect(isAuthoritativeEvidenceRun({
      ...matching,
      dispatcherRun: { ...matching.dispatcherRun, sourceRunId: 7002 },
    })).toBe(false);
  });

  it.each([
    ['source artifact attempt', {
      dispatcherRun: { ...matching.dispatcherRun, sourceRunAttempt: matching.sourceRun.runAttempt + 1 },
    }],
    ['dispatcher jobs run id', { jobsRunId: matching.dispatcherRun.id + 1 }],
    ['dispatcher jobs attempt', { jobsRunAttempt: matching.dispatcherRun.runAttempt + 1 }],
  ])('rejects cross-attempt mixing of %s', async (_label, mutation) => {
    const { isAuthoritativeEvidenceRun } = await loadDependabotAutoMerge();
    expect(isAuthoritativeEvidenceRun({ ...matching, ...mutation })).toBe(false);
  });

  it.each([
    ['dispatcher event', { dispatcherRun: { ...matching.dispatcherRun, event: 'pull_request_target' } }],
    ['dispatcher path', { dispatcherRun: { ...matching.dispatcherRun, path: '.github/workflows/attacker.yml' } }],
    ['source event', { sourceRun: { ...matching.sourceRun, event: 'pull_request' } }],
    ['source path', { sourceRun: { ...matching.sourceRun, path: '.github/workflows/attacker.yml' } }],
    ['source conclusion', { sourceRun: { ...matching.sourceRun, conclusion: 'failure' } }],
    ['source actor', { sourceRun: { ...matching.sourceRun, actorLogin: 'maintainer' } }],
    ['source head', { sourceRun: { ...matching.sourceRun, headSha: '3'.repeat(40) } }],
    ['source PR association', { sourceRun: { ...matching.sourceRun, pullRequests: [{ number: 136, headSha: HEAD_SHA }] } }],
  ])('rejects an independently mutated %s', async (_label, mutation) => {
    const { isAuthoritativeEvidenceRun } = await loadDependabotAutoMerge();
    expect(isAuthoritativeEvidenceRun({ ...matching, ...mutation })).toBe(false);
  });

  it('rejects a borrowed producer URL when the exact provenance job did not succeed', async () => {
    const { isAuthoritativeEvidenceRun } = await loadDependabotAutoMerge();
    expect(isAuthoritativeEvidenceRun({
      ...matching,
      jobs: [
        { name: PROVENANCE_JOB, conclusion: 'failure' },
        { name: 'A different successful job', conclusion: 'success' },
      ],
    })).toBe(false);
  });

  it('reads jobs from the exact dispatcher attempt when authenticating provenance', () => {
    expect(POLICY_SCRIPT_SOURCE).toMatch(
      /actions\/runs\/\$\{runId\}\/attempts\/\$\{runAttempt\}\/jobs[^`]*page=\$\{page\}/,
    );
    expect(POLICY_SCRIPT_SOURCE).not.toContain('jobs?filter=latest');
  });

  it('filters and paginates historical provenance checks instead of trusting page one', () => {
    expect(POLICY_SCRIPT_SOURCE).toContain('check_name=${encodeURIComponent(EVIDENCE_CHECK_NAME)}');
    expect(POLICY_SCRIPT_SOURCE).toContain('app_id=15368');
    expect(POLICY_SCRIPT_SOURCE).toMatch(/page=\$\{page\}/);
  });
});

describe('idempotent custom check publisher', () => {
  const externalId = `eligibility:${HEAD_SHA}:${POLICY_SHA}`;

  it('POSTs a new check with the assessed head_sha', () => {
    const result = runPublisher([]);
    expect(result.status, result.stderr).toBe(0);
    const write = result.calls.at(-1) ?? [];
    expect(write).toContain('--method');
    expect(write).toContain('POST');
    expect(write).toContain(`head_sha=${HEAD_SHA}`);
  });

  it('PATCHes the precisely selected existing check without immutable head_sha and can make it failure', () => {
    const result = runPublisher([
      { id: 41, external_id: externalId, name: ELIGIBILITY_NAME, head_sha: HEAD_SHA, app: { id: 15368 } },
      { id: 91, external_id: externalId, name: 'Attacker check', head_sha: HEAD_SHA, app: { id: 15368 } },
      { id: 92, external_id: externalId, name: ELIGIBILITY_NAME, head_sha: 'other-head', app: { id: 15368 } },
      { id: 93, external_id: externalId, name: ELIGIBILITY_NAME, head_sha: HEAD_SHA, app: { id: 999 } },
    ]);
    expect(result.status, result.stderr).toBe(0);
    const write = result.calls.at(-1) ?? [];
    expect(write).toContain('PATCH');
    expect(write).toContain('repos/pgorbachev/ikpk/check-runs/41');
    expect(write).not.toContain(`head_sha=${HEAD_SHA}`);
    expect(write).toContain('conclusion=failure');
  });

  it('filters and paginates the existing-check lookup before deciding to POST', () => {
    const script = publisherScript();
    expect(script).toContain('check_name=${encoded_name}');
    expect(script).toContain('app_id=15368');
    expect(script).toMatch(/page=\$\{page\}/);
  });

  it('finds its exact existing check on page two and PATCHes instead of duplicating it', () => {
    const pageOne = Array.from({ length: 100 }, (_, id) => ({
      id: id + 1,
      external_id: `other:${id}`,
      name: ELIGIBILITY_NAME,
      head_sha: HEAD_SHA,
      app: { id: 15368 },
    }));
    const target = {
      id: 501,
      external_id: externalId,
      name: ELIGIBILITY_NAME,
      head_sha: HEAD_SHA,
      app: { id: 15368 },
    };
    const result = runPublisher(pageOne, [target]);
    expect(result.status, result.stderr).toBe(0);
    const write = result.calls.at(-1) ?? [];
    expect(write).toContain('PATCH');
    expect(write).toContain('repos/pgorbachev/ikpk/check-runs/501');
  });
});

describe('repository protection activation contract', () => {
  const plan = JSON.parse(readFileSync(
    new URL('./fixtures/dependabot-auto-merge/repository-policy-plan.json', import.meta.url),
    'utf8',
  )) as {
    eligibilityRuleset: {
      requiredCheck: string;
      bypassActors: Array<{ actor: string; mode: string }>;
    };
    ordinaryBranchProtection: {
      branch: string;
      enforceAdmins: boolean;
      bypassActors: unknown[];
      excludedChecks: string[];
    };
  };

  it('keeps the Eligibility gate in a dedicated owner PR-only bypass ruleset', () => {
    expect(plan.eligibilityRuleset.requiredCheck).toBe(ELIGIBILITY_NAME);
    expect(plan.eligibilityRuleset.bypassActors).toEqual([
      { actor: 'repository-owner', mode: 'pull_request' },
    ]);
  });

  it('keeps all other main protection enforced for admins without bypass', () => {
    expect(plan.ordinaryBranchProtection).toMatchObject({
      branch: 'main',
      enforceAdmins: true,
      bypassActors: [],
    });
    expect(plan.ordinaryBranchProtection.excludedChecks).toEqual([ELIGIBILITY_NAME]);
  });
});
