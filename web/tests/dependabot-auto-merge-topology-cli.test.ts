import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../scripts/check-dependabot-auto-merge.ts', import.meta.url).pathname;
const MOCK_API = new URL('./fixtures/dependabot-auto-merge/mock-github-topology-api.mjs', import.meta.url).pathname;
const POLICY_SHA = 'a'.repeat(40);
const MERGE_TREE = 'b'.repeat(40);
const scratch: string[] = [];

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

interface Scenario {
  parents: string[];
  parentEvidence: boolean;
  mergeTree?: string;
  expectedMergeTree?: string;
  comparisons: Record<string, {
    status: string;
    merge_base_commit?: { sha: string };
    files?: Array<Record<string, unknown>>;
  }>;
}

const baseFiles = [{ filename: 'base.txt', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ base' }];

function validScenario(): Scenario {
  return {
    parents: ['parent-head', 'base-parent'],
    parentEvidence: true,
    comparisons: {
      'base-parent...base-head': { status: 'ahead', merge_base_commit: { sha: 'base-parent' }, files: [] },
      'parent-head...merge-head': { status: 'ahead', merge_base_commit: { sha: 'parent-head' }, files: baseFiles },
      'parent-head...base-parent': { status: 'diverged', merge_base_commit: { sha: 'fork-point' }, files: baseFiles },
      'fork-point...base-parent': { status: 'ahead', merge_base_commit: { sha: 'fork-point' }, files: baseFiles },
    },
  };
}

function outputValue(output: string, name: string): string | undefined {
  return output.split(/\r?\n/).find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
}

function runScenario(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-topology-cli-'));
  scratch.push(dir);
  const scenarioPath = join(dir, 'scenario.json');
  const eventPath = join(dir, 'event.json');
  const outputPath = join(dir, 'output.txt');
  const callLogPath = join(dir, 'calls.txt');
  const bin = join(dir, 'bin');
  const git = join(bin, 'git');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(git, `#!/usr/bin/env bash
set -euo pipefail
printf 'GIT %s\\n' "$*" >>"$MOCK_GITHUB_CALL_LOG"
if [ "$1" = fetch ]; then exit 0; fi
if [ "$1" = merge-tree ]; then printf '%s\\n' "$MOCK_EXPECTED_MERGE_TREE"; exit 0; fi
exit 2
`);
  spawnSync('chmod', ['+x', git]);
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  writeFileSync(eventPath, JSON.stringify({
    action: 'synchronize',
    pull_request: {
      number: 7,
      head: { sha: 'merge-head' },
      base: { sha: 'base-head', ref: 'main' },
      user: { login: 'dependabot[bot]' },
    },
  }));
  writeFileSync(outputPath, '');
  writeFileSync(callLogPath, '');

  const result = spawnSync(process.execPath, [
    '--import', MOCK_API,
    '--experimental-strip-types', SCRIPT,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'acme/ikpk',
      GITHUB_ACTOR: 'branch-updater[bot]',
      UPDATE_MECHANISM_LOGIN: 'branch-updater[bot]',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      TRUSTED_POLICY_SHA: POLICY_SHA,
      DEPENDABOT_METADATA_JSON: JSON.stringify([{
        dependencyName: 'tsx',
        dependencyType: 'direct:production',
        updateType: 'version-update:semver-patch',
        directory: '/scripts',
        packageEcosystem: 'npm_and_yarn',
      }]),
      MOCK_GITHUB_SCENARIO: scenarioPath,
      MOCK_GITHUB_CALL_LOG: callLogPath,
      MOCK_EXPECTED_MERGE_TREE: scenario.expectedMergeTree ?? MERGE_TREE,
    },
  });
  return {
    ...result,
    output: readFileSync(outputPath, 'utf8'),
    calls: readFileSync(callLogPath, 'utf8'),
  };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('production CLI adapter: update-branch synchronize topology', () => {
  it('derives the exact clean merge tree when PR and base edit different regions of one file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dependabot-real-merge-tree-'));
    scratch.push(dir);
    gitOutput(dir, ['init', '-q']);
    gitOutput(dir, ['config', 'user.name', 'Test']);
    gitOutput(dir, ['config', 'user.email', 'test@example.com']);
    const file = join(dir, 'package-lock.json');
    writeFileSync(file, 'pr-line\nshared-line\nbase-line\n');
    gitOutput(dir, ['add', 'package-lock.json']);
    gitOutput(dir, ['commit', '-qm', 'root']);
    const root = gitOutput(dir, ['rev-parse', 'HEAD']);

    writeFileSync(file, 'pr-changed\nshared-line\nbase-line\n');
    gitOutput(dir, ['commit', '-qam', 'pr']);
    const firstParent = gitOutput(dir, ['rev-parse', 'HEAD']);

    gitOutput(dir, ['checkout', '-q', root]);
    writeFileSync(file, 'pr-line\nshared-line\nbase-changed\n');
    gitOutput(dir, ['commit', '-qam', 'base']);
    const secondParent = gitOutput(dir, ['rev-parse', 'HEAD']);
    const expectedTree = gitOutput(dir, ['merge-tree', '--write-tree', firstParent, secondParent]);

    gitOutput(dir, ['checkout', '-q', firstParent]);
    gitOutput(dir, ['merge', '--no-ff', '--no-edit', secondParent]);
    const actualTree = gitOutput(dir, ['rev-parse', 'HEAD^{tree}']);
    expect(actualTree).toBe(expectedTree);

    writeFileSync(file, 'pr-changed\nforeign-edit\nbase-changed\n');
    gitOutput(dir, ['add', 'package-lock.json']);
    const foreignTree = gitOutput(dir, ['write-tree']);
    expect(foreignTree).not.toBe(expectedTree);
  });

  it('accepts a two-parent update merge after fetching its exact topology, parent evidence and base comparisons', () => {
    const result = runScenario(validScenario());
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(outputValue(result.output, 'gate-ok')).toBe('true');
    expect(outputValue(result.output, 'origin-positive')).toBe('true');
    expect(result.calls).toMatch(/GET \/repos\/acme\/ikpk\/(?:git\/)?commits\/merge-head/);
    expect(result.calls).toContain('GET /repos/acme/ikpk/commits/parent-head/check-runs');
    expect(result.calls).toContain('GET /repos/acme/ikpk/compare/base-parent...base-head');
    expect(result.calls).toMatch(/GIT fetch .*parent-head.*base-parent/);
    expect(result.calls).toContain('GIT merge-tree --write-tree parent-head base-parent');
  });

  it('accepts a clean merge when the PR and base changed different regions of the same file', () => {
    const scenario = validScenario();
    scenario.comparisons['parent-head...merge-head'].files = [{ ...baseFiles[0], sha: 'combined-blob', patch: '@@ combined context' }];
    scenario.comparisons['fork-point...base-parent'].files = [{ ...baseFiles[0], sha: 'base-only-blob', patch: '@@ base context' }];
    const result = runScenario(scenario);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(outputValue(result.output, 'gate-ok')).toBe('true');
    expect(outputValue(result.output, 'origin-positive')).toBe('true');
  });

  it.each([
    {
      label: 'a foreign edit in the merge commit',
      mutate: (scenario: Scenario) => {
        scenario.mergeTree = 'c'.repeat(40);
        scenario.comparisons['parent-head...merge-head'].files = [
          ...baseFiles,
          { filename: 'foreign.txt', status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ foreign' },
        ];
      },
      reason: /only base|unexpected|foreign|diff|topolog/i,
      requiredCall: /GIT merge-tree --write-tree parent-head base-parent/,
    },
    {
      label: 'missing positive evidence for the first parent',
      mutate: (scenario: Scenario) => { scenario.parentEvidence = false; },
      reason: /evidence|provenance|parent/i,
      requiredCall: /GET \/repos\/acme\/ikpk\/commits\/parent-head\/check-runs/,
    },
    {
      label: 'a second parent outside the current base ancestry',
      mutate: (scenario: Scenario) => {
        scenario.comparisons['base-parent...base-head'] = {
          status: 'diverged', merge_base_commit: { sha: 'other-fork' }, files: [],
        };
      },
      reason: /ancestor|ancestry|base|second parent|topolog/i,
      requiredCall: /GET \/repos\/acme\/ikpk\/compare\/base-parent\.\.\.base-head/,
    },
    {
      label: 'a single-parent commit from the update mechanism',
      mutate: (scenario: Scenario) => { scenario.parents = ['parent-head']; },
      reason: /two parents|2 parents|parent count|single.parent|topolog/i,
      requiredCall: /GET \/repos\/acme\/ikpk\/(?:git\/)?commits\/merge-head/,
    },
  ])('rejects $label and reports the failed condition', ({ mutate, reason, requiredCall }) => {
    const scenario = validScenario();
    mutate(scenario);
    const result = runScenario(scenario);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(outputValue(result.output, 'gate-ok')).toBe('false');
    expect(outputValue(result.output, 'origin-positive')).toBe('false');
    expect(outputValue(result.output, 'reason')).toMatch(reason);
    expect(result.calls).toMatch(requiredCall);
  });
});
