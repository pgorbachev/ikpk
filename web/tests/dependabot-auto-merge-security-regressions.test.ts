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

function runPublisher(checkRuns: unknown[]): { status: number | null; stderr: string; calls: string[][] } {
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
  printf '%s\\n' "$CHECK_RUNS_JSON"
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
    run: { pullRequests: [{ number: 135, headSha: HEAD_SHA }] },
    jobs: [{ name: PROVENANCE_JOB, conclusion: 'success' as const }],
  };

  it('accepts a run only when its authoritative PR head and exact provenance job match (control)', async () => {
    const { isAuthoritativeEvidenceRun } = await loadDependabotAutoMerge();
    expect(isAuthoritativeEvidenceRun(matching)).toBe(true);
  });

  it('rejects a borrowed producer URL whose authoritative run belongs to another PR head', async () => {
    const { isAuthoritativeEvidenceRun } = await loadDependabotAutoMerge();
    expect(isAuthoritativeEvidenceRun({
      ...matching,
      run: { pullRequests: [{ number: 135, headSha: '3333333333333333333333333333333333333333' }] },
    })).toBe(false);
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
