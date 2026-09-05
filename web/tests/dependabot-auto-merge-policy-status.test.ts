import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  loadDependabotAutoMerge,
  type ProvenanceEvidenceCandidate,
  type TrustedEvidencePolicy,
} from './helpers/dependabot-auto-merge-contract';

const SCRIPT = new URL('../scripts/check-dependabot-auto-merge.ts', import.meta.url).pathname;
const MOCK_API = new URL('./fixtures/dependabot-auto-merge/mock-policy-status-api.mjs', import.meta.url).pathname;
const POLICY_WORKFLOW = parse(readFileSync(
  new URL('../../.github/workflows/dependabot-auto-merge-policy.yml', import.meta.url),
  'utf8',
)) as {
  jobs?: Record<string, {
    if?: string;
    steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
  }>;
};

const HEAD_SHA = '1'.repeat(40);
const POLICY_SHA = 'a'.repeat(40);
const ELIGIBILITY_NAME = 'Dependabot auto-merge / Eligibility gate';
const PROVENANCE_NAME = 'Dependabot auto-merge / Provenance evidence';
const scratch: string[] = [];

function outputValue(output: string, name: string): string | undefined {
  return output.split(/\r?\n/).find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
}

function runPolicyCli(scenario: Record<string, unknown>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-policy-status-cli-'));
  scratch.push(dir);
  const scenarioPath = join(dir, 'scenario.json');
  const outputPath = join(dir, 'github-output');
  const callLogPath = join(dir, 'calls.log');
  writeFileSync(scenarioPath, JSON.stringify({ eventHeadSha: HEAD_SHA, currentHeadSha: HEAD_SHA, ...scenario }));
  writeFileSync(outputPath, '');
  writeFileSync(callLogPath, '');

  const result = spawnSync(process.execPath, [
    '--import', MOCK_API,
    '--experimental-strip-types',
    SCRIPT,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'acme/ikpk',
      GITHUB_ACTOR: String(scenario.actor ?? 'dependabot[bot]'),
      GITHUB_OUTPUT: outputPath,
      POLICY_EVENT_ACTION: String(scenario.action ?? 'opened'),
      POLICY_EVENT_ACTOR: String(scenario.actor ?? 'dependabot[bot]'),
      POLICY_EVENT_HEAD_SHA: String(scenario.eventHeadSha ?? HEAD_SHA),
      POLICY_PR_NUMBER: '7',
      TRUSTED_POLICY_SHA: POLICY_SHA,
      ...env,
      MOCK_GITHUB_SCENARIO: scenarioPath,
      MOCK_GITHUB_CALL_LOG: callLogPath,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: readFileSync(outputPath, 'utf8'),
    calls: readFileSync(callLogPath, 'utf8'),
  };
}

function workflowStep(job: string, namePart: string): string {
  const step = POLICY_WORKFLOW.jobs?.[job]?.steps?.find(({ name }) =>
    name?.toLowerCase().includes(namePart.toLowerCase()));
  expect(step?.run, `${job} must expose an executable shell step`).toBeTypeOf('string');
  return step?.run ?? '';
}

function runEligibilityShell(env: Record<string, string>) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', workflowStep('eligibility-gate', 'fail-closed')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ASSESS_RESULT: 'success',
      FRESH_SNAPSHOT_RESULT: 'success',
      FRESH_HEAD_MATCHES_CURRENT: 'true',
      GATE_OK: 'false',
      REASON: 'manual review',
      ...env,
    },
  });
}

function runPublisherShell(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-policy-status-publisher-'));
  scratch.push(dir);
  const bin = join(dir, 'bin');
  const log = join(dir, 'gh.log');
  spawnSync('mkdir', ['-p', bin]);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'CALL'
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >>"$GH_LOG"
if [[ "$*" == *'/commits/'*'/check-runs?'* ]]; then
  printf '{"check_runs":[]}'
else
  printf '{}'
fi
`);
  chmodSync(gh, 0o755);

  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', workflowStep('publish-checks', 'publish current-head')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ASSESSMENT_RESULT: 'success',
      EVENT_ACTION: 'opened',
      FRESH_HEAD_MATCHES_CURRENT: 'true',
      GATE_RESULT: 'success',
      GH_LOG: log,
      GH_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'pgorbachev/ikpk',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_RUN_ID: '1234',
      GITHUB_SERVER_URL: 'https://github.com',
      HEAD_SHA,
      POLICY_SHA,
      PROVENANCE_RESULT: 'success',
      SOURCE_RUN_ATTEMPT: '3',
      SOURCE_RUN_ID: '7001',
      ...env,
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    calls: readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean),
  };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Dependabot policy status CLI', () => {
  it('skips a fresh human PR without metadata, signature, registry, or marker mutation access', () => {
    const result = runPolicyCli({
      prAuthor: 'maintainer',
      actor: 'maintainer',
      autoMergeEnabled: true,
      forbidden: ['/graphql', '/contents/', '/check-runs'],
      files: [{ filename: 'web/package-lock.json' }],
    });

    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    expect(outputValue(result.output, 'eligibility-conclusion')).toBe('skipped');
    expect(outputValue(result.output, 'provenance-conclusion')).toBe('skipped');
    expect(outputValue(result.output, 'enable-auto-merge')).toBe('false');
    expect(outputValue(result.output, 'disable-auto-merge')).toBe('false');
    expect(result.calls).not.toMatch(/\/graphql|\/contents\/|\/check-runs/);
  });

  it('returns neutral eligibility with successful provenance for a valid manual Dependabot update', () => {
    const result = runPolicyCli({
      prAuthor: 'dependabot[bot]',
      actor: 'dependabot[bot]',
      autoMergeEnabled: true,
    }, {
      DEPENDABOT_METADATA_JSON: JSON.stringify([{
        dependencyName: 'tsx',
        dependencyType: 'direct:production',
        updateType: 'version-update:semver-major',
        directory: '/scripts',
        packageEcosystem: 'npm_and_yarn',
      }]),
    });

    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    expect(outputValue(result.output, 'eligibility-conclusion')).toBe('neutral');
    expect(outputValue(result.output, 'provenance-conclusion')).toBe('success');
    expect(outputValue(result.output, 'enable-auto-merge')).toBe('false');
    expect(outputValue(result.output, 'disable-auto-merge')).toBe('true');
  });

  it('prioritizes invalid provenance over a manual Dependabot class', () => {
    const result = runPolicyCli({
      prAuthor: 'dependabot[bot]',
      actor: 'maintainer',
      autoMergeEnabled: true,
    }, {
      DEPENDABOT_METADATA_JSON: JSON.stringify([{
        dependencyName: 'tsx',
        dependencyType: 'direct:production',
        updateType: 'version-update:semver-major',
        directory: '/scripts',
        packageEcosystem: 'npm_and_yarn',
      }]),
    });

    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    expect(outputValue(result.output, 'eligibility-conclusion')).toBe('failure');
    expect(outputValue(result.output, 'provenance-conclusion')).toBe('failure');
    expect(outputValue(result.output, 'disable-auto-merge')).toBe('true');
  });

  it('fails before publishing when the authenticated PR snapshot is stale', () => {
    const result = runPolicyCli({
      currentHeadSha: '2'.repeat(40),
      prAuthor: 'dependabot[bot]',
      actor: 'dependabot[bot]',
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it('does not overwrite provenance on reopened marker events and does not enable from stale marker evidence', () => {
    const result = runPolicyCli({
      action: 'reopened',
      prAuthor: 'dependabot[bot]',
      actor: 'maintainer',
      autoMergeEnabled: false,
      headEvidenceChecks: [{
        name: PROVENANCE_NAME,
        status: 'completed',
        conclusion: 'success',
        head_sha: HEAD_SHA,
        external_id: `provenance:${HEAD_SHA}:${POLICY_SHA}:81:1:91:2`,
        details_url: 'https://github.com/acme/ikpk/actions/runs/91',
        app: { slug: 'github-actions', id: 15368 },
      }],
    }, {
      DEPENDABOT_METADATA_JSON: JSON.stringify([{
        dependencyName: 'tsx',
        dependencyType: 'direct:production',
        updateType: 'version-update:semver-major',
        directory: '/scripts',
        packageEcosystem: 'npm_and_yarn',
      }]),
    });

    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    expect(outputValue(result.output, 'record-evidence')).toBe('false');
    expect(outputValue(result.output, 'eligibility-conclusion')).toBe('neutral');
    expect(outputValue(result.output, 'enable-auto-merge')).toBe('false');
  });
});

describe('Dependabot policy conclusions and publisher shell', () => {
  it('keeps the workflow green for a normal neutral manual-review decision', () => {
    const result = runEligibilityShell({
      GATE_CONCLUSION: 'neutral',
      GATE_OK: 'false',
      REASON: 'manual review required',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('keeps the workflow green for a normal skipped human decision', () => {
    const result = runEligibilityShell({
      GATE_CONCLUSION: 'skipped',
      GATE_OK: 'false',
      REASON: 'not a Dependabot PR',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('keeps mandatory evaluation errors red', () => {
    const result = runEligibilityShell({
      ASSESS_RESULT: 'failure',
      GATE_CONCLUSION: 'failure',
      GATE_OK: 'false',
    });

    expect(result.status).not.toBe(0);
  });

  it('publishes the explicit neutral/skipped conclusions instead of deriving them from job success', () => {
    const result = runPublisherShell({
      ELIGIBILITY_CONCLUSION: 'neutral',
      PROVENANCE_CONCLUSION: 'skipped',
      PROVENANCE_RESULT: 'skipped',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.join('\n')).toContain(`name=${ELIGIBILITY_NAME}`);
    expect(result.calls.join('\n')).toContain('conclusion=neutral');
    expect(result.calls.join('\n')).toContain(`name=${PROVENANCE_NAME}`);
    expect(result.calls.join('\n')).toContain('conclusion=skipped');
  });
});

describe('Dependabot policy positive provenance consumption', () => {
  const policy: TrustedEvidencePolicy = {
    sha: HEAD_SHA,
    checkName: PROVENANCE_NAME,
    appSlug: 'github-actions',
    appId: 15368,
    eventName: 'workflow_run',
    externalId: `provenance:${HEAD_SHA}:${POLICY_SHA}:81:1:91:2`,
    callerWorkflowPath: '.github/workflows/dependabot-auto-merge.yml',
    reusablePolicyPath: '.github/workflows/dependabot-auto-merge-policy.yml',
    reusablePolicySha: POLICY_SHA,
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

  it.each(['neutral', 'skipped', 'failure'] as const)('does not consume %s provenance as positive evidence', async (conclusion) => {
    const { isTrustedPositiveEvidence } = await loadDependabotAutoMerge();
    expect(isTrustedPositiveEvidence({ ...candidate, conclusion } as ProvenanceEvidenceCandidate, policy)).toBe(false);
  });

  it('rejects old producer evidence after the trusted immutable policy pin changes', async () => {
    const { isTrustedPositiveEvidence } = await loadDependabotAutoMerge();
    const old = { ...candidate, reusablePolicySha: '0'.repeat(40), externalId: candidate.externalId.replace(POLICY_SHA, '0'.repeat(40)) };
    expect(isTrustedPositiveEvidence(old, policy)).toBe(false);
    expect(isTrustedPositiveEvidence(candidate, policy)).toBe(true);
  });
});
