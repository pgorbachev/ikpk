import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authenticationProblems,
  SIGNAL_ARTIFACT,
  SIGNAL_FILE,
  SIGNAL_SCHEMA,
  type AuthenticationProblem,
} from './helpers/dependabot-workflow-run-producer';
import { loadWorkflows, workflowRunTrigger, type Workflow } from './helpers/workflows';

const workflows = loadWorkflows();
const automation = workflows.filter(({ file }) => /^dependabot-(?:auto-merge|rebase).*\.ya?ml$/.test(file));

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function permissionEntries(workflow: Workflow): Array<[string, string]> {
  const values: unknown[] = [workflow.permissions, ...Object.values(workflow.jobs).map(({ permissions }) => permissions)];
  return values.flatMap((value) => Object.entries(record(value))
    .map(([key, level]): [string, string] => [key, String(level)]));
}

function permissionMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).map(([scope, level]) => [scope, String(level)]));
}

function workflowNamed(file: string): Workflow {
  const found = workflows.find((workflow) => workflow.file === file);
  expect(found, `${file} must exist`).toBeDefined();
  return found!;
}

function producerSignal(): Workflow {
  const candidates = automation.filter(({ file, triggers }) =>
    /^dependabot-auto-merge.*\.ya?ml$/.test(file) && Object.hasOwn(triggers, 'pull_request_target'));
  expect(candidates, 'there must be exactly one read-only pull_request_target signal').toHaveLength(1);
  return candidates[0];
}

function producerDispatcher(): Workflow {
  const candidates = automation.filter((workflow) =>
    /^dependabot-auto-merge.*\.ya?ml$/.test(workflow.file) && workflowRunTrigger(workflow) !== null);
  expect(candidates, 'there must be exactly one privileged workflow_run dispatcher').toHaveLength(1);
  return candidates[0];
}

describe('two-stage Dependabot producer topology', () => {
  it('keeps pull_request_target as a read-only metadata signal with exactly one typed artifact', () => {
    const signal = producerSignal();
    expect(permissionMap(signal.permissions)).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(permissionEntries(signal).filter(([, level]) => level === 'write'),
      `${signal.file} signal must not receive any write permission`).toEqual([]);

    const jobs = Object.values(signal.jobs);
    expect(jobs.some(({ uses }) => uses !== undefined), 'signal must not invoke privileged reusable policy').toBe(false);
    const steps = jobs.flatMap(({ steps }) => steps);
    expect(steps.some(({ uses }) => /^actions\/checkout@/.test(uses ?? '')), 'signal must not checkout PR code').toBe(false);
    expect(steps.some(({ run }) => /\b(?:npm|npx|pnpm|yarn)\s+(?:ci|install|run)\b/.test(run ?? '')),
      'signal must not install or run PR dependencies').toBe(false);
    expect(steps.filter(({ uses }) => /^dependabot\/fetch-metadata@[0-9a-f]{40}$/.test(uses ?? ''))).toHaveLength(1);

    const uploads = steps.filter(({ uses }) => /^actions\/upload-artifact@[0-9a-f]{40}$/.test(uses ?? ''));
    expect(uploads, 'signal must upload exactly one metadata artifact').toHaveLength(1);
    expect(String(uploads[0].with?.name)).toContain(SIGNAL_ARTIFACT);
    expect(String(uploads[0].with?.name)).toMatch(/run_id|github\.run_id/);
    expect(String(uploads[0].with?.name)).toMatch(/run_attempt|github\.run_attempt/);
    expect(uploads[0].with?.path).toBe(SIGNAL_FILE);
    const contract = steps.map(({ raw }) => raw).join('\n');
    expect(contract).toContain(SIGNAL_SCHEMA);
    expect(contract).toMatch(/source[_-]?run[_-]?id|github\.run_id/i);
    expect(contract).toMatch(/source[_-]?run[_-]?attempt|github\.run_attempt/i);
    expect(contract).toMatch(/action|actor/i);
    expect(contract).toMatch(/pull[_-]?request|pr[_-]?number/i);
    expect(contract).toMatch(/head[_-]?sha/i);
  });

  it('allows only opened/synchronize to mint provenance for a new head', () => {
    const signal = producerSignal();
    const trigger = record(signal.triggers.pull_request_target);
    expect(trigger.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'auto_merge_enabled',
      'auto_merge_disabled',
    ]);

    const policy = workflowNamed('dependabot-auto-merge-policy.yml');
    const provenance = Object.values(policy.jobs).find(({ key }) => key === 'provenance-evidence');
    expect(provenance, 'separate provenance job must exist').toBeDefined();
    expect(provenance!.if).toContain("inputs.source-action == 'opened'");
    expect(provenance!.if).toContain("inputs.source-action == 'synchronize'");
    expect(provenance!.if).not.toMatch(/reopened|auto_merge_enabled|auto_merge_disabled/);
  });

  it('dispatches only a completed run of that exact signal and calls policy by immutable SHA', () => {
    const signal = producerSignal();
    const dispatcher = producerDispatcher();
    const trigger = workflowRunTrigger(dispatcher)!;
    expect(trigger.workflows).toEqual([signal.displayName]);
    expect(trigger.types).toEqual(['completed']);
    expect(dispatcher.triggers).not.toHaveProperty('pull_request_target');

    const policyCalls = Object.values(dispatcher.jobs).filter(({ uses }) =>
      /pgorbachev\/ikpk\/\.github\/workflows\/dependabot-auto-merge-policy\.yml@/.test(uses ?? ''));
    expect(policyCalls, 'dispatcher must have exactly one immutable reusable policy call').toHaveLength(1);
    expect(policyCalls[0].uses).toMatch(
      /^pgorbachev\/ikpk\/\.github\/workflows\/dependabot-auto-merge-policy\.yml@[0-9a-f]{40}$/,
    );
    expect(policyCalls[0].needs.length, 'policy must depend on authenticated source/artifact validation').toBeGreaterThan(0);
  });

  it('authenticates exact source run and one digest/schema-bound archive before policy execution', () => {
    const dispatcher = producerDispatcher();
    const authenticators = Object.values(dispatcher.jobs).filter(({ steps }) =>
      steps.some(({ run }) => /actions\/runs|SOURCE_RUN_ID|workflow_run\.id/.test(run ?? '')));
    expect(authenticators, 'dispatcher authentication job is missing').toHaveLength(1);
    const script = authenticators[0].steps.map(({ run }) => run ?? '').join('\n');
    expect(authenticationProblems(script), authenticationProblems(script).join(', ')).toEqual([]);
    expect(script).toContain(`.github/workflows/${producerSignal().file}`);
    expect(script).toContain(SIGNAL_ARTIFACT);
    expect(script).toContain('dependabot[bot]');
    expect(script).toContain('pull_request_target');
    expect(script).toMatch(/run_attempt|SOURCE_RUN_ATTEMPT/);
  });

  it('uses the exact least-privilege matrix for every producer role', () => {
    const dispatcher = producerDispatcher();
    const authenticator = Object.values(dispatcher.jobs).find(({ steps }) =>
      steps.some(({ run }) => /actions\/runs|SOURCE_RUN_ID|workflow_run\.id/.test(run ?? '')));
    expect(permissionMap(authenticator?.permissions)).toEqual({ actions: 'read', 'pull-requests': 'read' });

    const policy = workflowNamed('dependabot-auto-merge-policy.yml');
    expect(permissionMap(policy.jobs.snapshot?.permissions)).toEqual({ actions: 'read', 'pull-requests': 'read' });
    expect(permissionMap(policy.jobs.assess?.permissions)).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(permissionMap(policy.jobs['publish-checks']?.permissions)).toEqual({ checks: 'write' });
    expect(permissionMap(policy.jobs['enable-auto-merge']?.permissions)).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });

    const rebase = workflowNamed('dependabot-rebase-policy.yml');
    const commenter = Object.values(rebase.jobs).find(({ steps }) =>
      steps.some(({ run }) => /@dependabot\s+rebase/.test(run ?? '')));
    expect(permissionMap(commenter?.permissions)).toEqual({ 'pull-requests': 'write' });
  });

  it('binds published machine identity to source and dispatcher run id/attempt', () => {
    const policy = workflowNamed('dependabot-auto-merge-policy.yml');
    const publisher = policy.jobs['publish-checks'];
    const contract = JSON.stringify(publisher);
    expect(contract).toMatch(/SOURCE_RUN_ID/);
    expect(contract).toMatch(/SOURCE_RUN_ATTEMPT/);
    expect(contract).toMatch(/GITHUB_RUN_ID|github\.run_id/);
    expect(contract).toMatch(/GITHUB_RUN_ATTEMPT|github\.run_attempt/);
    expect(contract).toMatch(/external[_-]?id/i);
  });

  it('does not checkout or execute pull-request code in dispatcher', () => {
    const dispatcher = producerDispatcher();
    const executable = Object.values(dispatcher.jobs).flatMap(({ steps }) => steps);
    expect(executable.some(({ uses }) => /^actions\/checkout@/.test(uses ?? ''))).toBe(false);
    expect(executable.some(({ uses }) => /^\.\//.test(uses ?? ''))).toBe(false);
    expect(executable.some(({ run }) => /\b(?:npm|npx|pnpm|yarn)\s+(?:ci|install|run)\b/.test(run ?? ''))).toBe(false);
    expect(executable.map(({ raw }) => raw).join('\n')).not.toMatch(/pull_request\.head|refs\/pull/);
  });
});

describe('dispatcher authentication test controls', () => {
  const control = readFileSync(join(
    import.meta.dirname,
    'fixtures/dependabot-auto-merge/workflow-run-authentication-control.sh',
  ), 'utf8');

  it('accepts the complete source/artifact binding control', () => {
    expect(authenticationProblems(control)).toEqual([]);
  });

  it.each<[AuthenticationProblem, RegExp]>([
    ['source-run-id', /SOURCE_RUN_ID|workflow_run\.id/g],
    ['source-run-attempt', /SOURCE_RUN_ATTEMPT|workflow_run\.run_attempt/g],
    ['source-workflow-path', /SOURCE_WORKFLOW_PATH|\.path/g],
    ['source-repository', /SOURCE_REPOSITORY|repository\.full_name/g],
    ['source-event', /pull_request_target/g],
    ['source-action', /SOURCE_ACTION|\.action/g],
    ['source-conclusion', /SOURCE_CONCLUSION|conclusion/g],
    ['source-actor', /SOURCE_ACTOR|actor\.login/g],
    ['source-pull-request', /SOURCE_PR_NUMBER|pull_requests/g],
    ['source-head', /SOURCE_HEAD_SHA|head_sha/g],
    ['single-artifact', /ARTIFACT_COUNT|artifacts \| length == 1/g],
    ['artifact-digest', /ARTIFACT_DIGEST|digest|sha256sum|sha256/g],
    ['archive-members', /ARCHIVE_MEMBERS|zipinfo/g],
    ['artifact-schema', /SIGNAL_SCHEMA|dependabot-auto-merge-signal\/v1/g],
  ])('detects independent %s mutation', (problem, token) => {
    const mutated = control.replace(token, '');
    expect(authenticationProblems(mutated)).toContain(problem);
  });
});
