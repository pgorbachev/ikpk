import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  loadDependabotAutoMerge,
  type ProvenanceEvidenceCandidate,
  type TrustedEvidencePolicy,
} from './helpers/dependabot-auto-merge-contract';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const CALLER_FILE = 'dependabot-auto-merge.yml';
const POLICY_FILE = 'dependabot-auto-merge-policy.yml';
const POLICY_PATH = join(WORKFLOW_DIR, POLICY_FILE);

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function workflow(file: string): RecordValue {
  const path = join(WORKFLOW_DIR, file);
  expect(existsSync(path), `${file} must exist`).toBe(true);
  return record(parse(readFileSync(path, 'utf8')));
}

function jobs(document: RecordValue): Record<string, RecordValue> {
  return Object.fromEntries(Object.entries(record(document.jobs)).map(([name, value]) => [name, record(value)]));
}

function steps(job: RecordValue): RecordValue[] {
  return Array.isArray(job.steps) ? job.steps.map(record) : [];
}

function permissions(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).map(([name, level]) => [name, String(level)]));
}

function sourceOf(value: unknown): string {
  return JSON.stringify(value);
}

function autoMergeWorkflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => /^dependabot-(?:auto-merge|rebase).*\.ya?ml$/.test(file))
    .sort();
}

describe('trusted pull_request_target producer', () => {
  it('loads the caller from the default branch event and delegates only to an immutable reusable SHA', () => {
    if (!existsSync(join(WORKFLOW_DIR, CALLER_FILE))) {
      const activeTargetCallers = autoMergeWorkflowFiles().filter((file) => {
        const document = workflow(file);
        return Object.hasOwn(record(document.on ?? document.true), 'pull_request_target');
      });
      expect(activeTargetCallers, 'an inactive engine must not have a partial target caller').toEqual([]);
      return;
    }
    const caller = workflow(CALLER_FILE);
    const triggers = record(caller.on ?? caller.true);

    expect(triggers).toHaveProperty('pull_request_target');
    expect(triggers).not.toHaveProperty('pull_request');

    const calls = Object.values(jobs(caller)).filter((job) => typeof job.uses === 'string');
    expect(calls, 'target caller must contain exactly one reusable policy call').toHaveLength(1);
    expect(calls[0].uses).toMatch(
      /^pgorbachev\/ikpk\/\.github\/workflows\/dependabot-auto-merge-policy\.yml@[0-9a-f]{40}$/,
    );
    expect(steps(calls[0]), 'target caller must not execute pull-request steps itself').toHaveLength(0);
  });

  it('checks out trusted policy source by job.workflow_repository and job.workflow_sha, never moving main', () => {
    const policy = workflow(POLICY_FILE);
    const checkoutSteps = Object.values(jobs(policy)).flatMap(steps)
      .filter((step) => String(step.uses ?? '').startsWith('actions/checkout@'));

    expect(checkoutSteps, 'trusted policy checkout is missing').toHaveLength(1);
    const withInputs = record(checkoutSteps[0].with);
    expect(withInputs.repository).toBe('${{ job.workflow_repository }}');
    expect(withInputs.ref).toBe('${{ job.workflow_sha }}');
    expect(sourceOf(checkoutSteps[0])).not.toContain('ref":"main"');
    expect(sourceOf(checkoutSteps[0])).not.toContain('pull_request.head');
  });

  it('has one step-bearing publisher with only checks:write and no second automation publisher', () => {
    const writeJobs = autoMergeWorkflowFiles().flatMap((file) =>
      Object.entries(jobs(workflow(file))).flatMap(([jobName, job]) => {
        if (steps(job).length === 0) return [];
        return permissions(job.permissions).checks === 'write' ? [{ file, jobName, job }] : [];
      }));

    expect(writeJobs, 'exactly one executable automation job may publish checks').toHaveLength(1);
    expect(permissions(writeJobs[0].job.permissions)).toEqual({ checks: 'write' });
  });

  it('publishes distinct head-bound gate and provenance check runs with typed machine external ids', () => {
    const policy = workflow(POLICY_FILE);
    const publisher = Object.values(jobs(policy)).find((job) => permissions(job.permissions).checks === 'write');
    expect(publisher, 'checks:write publisher job is missing').toBeDefined();

    const contract = sourceOf(publisher);
    expect(contract).toMatch(/\/check-runs|createCheckRun/i);
    expect(contract).toMatch(/external[_-]?id/i);
    expect(contract).toMatch(/head[_-]?sha/i);
    expect(contract).toMatch(/policy[_-]?sha|workflow[_-]?sha/i);
    expect(contract).toContain('Eligibility gate');
    expect(contract).toContain('Provenance evidence');
    expect(contract).toMatch(/type|kind/i);
  });
});

describe('fresh marker and head snapshot', () => {
  it('does not use the event auto_merge snapshot to make an assessment-failure gate green', () => {
    const policySource = readFileSync(POLICY_PATH, 'utf8');
    expect(policySource).not.toMatch(/AUTO_MERGE_ENABLED:\s*\$\{\{\s*github\.event\.pull_request\.auto_merge/);

    const policy = workflow(POLICY_FILE);
    const publisher = Object.values(jobs(policy)).find((job) => permissions(job.permissions).checks === 'write');
    expect(publisher, 'fresh API result must feed the check publisher').toBeDefined();
    const contract = sourceOf(publisher);
    expect(contract).toMatch(/fresh|snapshot|current/i);
    expect(contract).toMatch(/auto[_-]?merge/i);
    expect(contract).toMatch(/head[_-]?sha/i);
    expect(contract).toMatch(/assessment|assess/i);
  });

  it('requires a successful fresh read proving both the current head and absent marker for manual fallback', () => {
    const policy = workflow(POLICY_FILE);
    const publisher = Object.values(jobs(policy)).find((job) => permissions(job.permissions).checks === 'write');
    expect(publisher, 'fresh API result must feed the check publisher').toBeDefined();
    const contract = sourceOf(publisher);

    expect(contract).toMatch(/snapshot|fresh/i);
    expect(contract).toMatch(/success|ok|known/i);
    expect(contract).toMatch(/head/i);
    expect(contract).toMatch(/match|current/i);
    expect(contract).toMatch(/auto[_-]?merge/i);
    expect(contract).toMatch(/false|null|absent/i);
  });
});

describe('consumer identity for externally published provenance', () => {
  const policy: TrustedEvidencePolicy = {
    sha: '1111111111111111111111111111111111111111',
    checkName: 'Dependabot auto-merge / Provenance evidence',
    appSlug: 'github-actions',
    appId: 15368,
    eventName: 'pull_request_target',
    externalId: 'provenance:1111111111111111111111111111111111111111:2222222222222222222222222222222222222222',
    callerWorkflowPath: '.github/workflows/dependabot-auto-merge.yml',
    reusablePolicyPath: '.github/workflows/dependabot-auto-merge-policy.yml',
    reusablePolicySha: '2222222222222222222222222222222222222222',
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

  it('accepts the fully bound target-producer result (control)', async () => {
    const { isTrustedPositiveEvidence } = await loadDependabotAutoMerge();
    expect(isTrustedPositiveEvidence(candidate, policy)).toBe(true);
  });

  it('rejects a same-name pull_request job even when every legacy identity field matches', async () => {
    const { isTrustedPositiveEvidence } = await loadDependabotAutoMerge();
    expect(isTrustedPositiveEvidence({ ...candidate, eventName: 'pull_request' }, policy)).toBe(false);
  });

  it('rejects a result with the wrong machine external id', async () => {
    const { isTrustedPositiveEvidence } = await loadDependabotAutoMerge();
    expect(isTrustedPositiveEvidence({ ...candidate, externalId: `${candidate.externalId}:forged` }, policy)).toBe(false);
  });

  it('rejects a result from a different GitHub App id despite a matching slug', async () => {
    const { isTrustedPositiveEvidence } = await loadDependabotAutoMerge();
    expect(isTrustedPositiveEvidence({ ...candidate, appId: candidate.appId + 1 }, policy)).toBe(false);
  });
});
