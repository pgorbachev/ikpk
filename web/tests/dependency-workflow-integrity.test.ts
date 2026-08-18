import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { isScalar, LineCounter, parse, parseDocument, visit } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

interface WorkflowStep {
  name?: string;
  run?: string;
  if?: string;
}

interface Workflow {
  name?: string;
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

interface ActionRefProblem {
  location: string;
  problem: 'movable ref' | 'missing readable version comment' | 'invalid yaml';
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => join(WORKFLOWS, file));
}

function trackedActionFiles(): string[] {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return files.split('\0')
    .filter((file) => /(^|\/)action\.ya?ml$/.test(file))
    .map((file) => join(ROOT, file));
}

function actionDefinitionFiles(): string[] {
  return [...new Set([...workflowFiles(), ...trackedActionFiles()])];
}

function actionRefProblems(file: string, source = readFileSync(file, 'utf8')): ActionRefProblem[] {
  const problems: ActionRefProblem[] = [];
  const lines = source.split('\n');
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter });
  if (document.errors.length > 0) {
    return [{ location: `${relative(ROOT, file)}:1`, problem: 'invalid yaml' }];
  }

  visit(document, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || pair.key.value !== 'uses' || !isScalar(pair.value)) return;
      const target = pair.value.value;
      if (typeof target !== 'string' || target.startsWith('./')) return;
      const offset = pair.value.range?.[0] ?? pair.key.range?.[0] ?? 0;
      const lineNumber = lineCounter.linePos(offset).line;
      const location = `${relative(ROOT, file)}:${lineNumber}`;
      const immutable = target.startsWith('docker://')
        ? /@sha256:[0-9a-f]{64}$/i.test(target)
        : /^[^\s@]+@[0-9a-f]{40}$/i.test(target);
      if (!immutable) problems.push({ location, problem: 'movable ref' });
      if (!/#[^\n]*\bv?\d+(?:\.\d+){0,2}\b/i.test(lines[lineNumber - 1] ?? '')) {
        problems.push({ location, problem: 'missing readable version comment' });
      }
    },
  });
  return problems;
}

describe('workflow dependency integrity', () => {
  it('pins every external action in every workflow to a full SHA with a readable version comment', () => {
    const problems = actionDefinitionFiles().flatMap((file) => actionRefProblems(file));
    expect(
      problems,
      problems.map(({ location, problem }) => `${location}: ${problem}`).join('\n'),
    ).toEqual([]);
  });

  it('reports the workflow file and line for a movable action ref', () => {
    const probe = join(ROOT, '.github', 'workflows', 'probe.yml');
    expect(actionRefProblems(probe, 'steps:\n  - uses: owner/action@v4'))
      .toContainEqual({ location: '.github/workflows/probe.yml:2', problem: 'movable ref' });
  });

  it.each([
    ['flow YAML', 'steps: [{ uses: actions/checkout@v7 }]'],
    ['quoted key', 'steps:\n  - "uses" : actions/checkout@v7'],
    ['mutable Docker tag', 'steps:\n  - uses: docker://alpine:latest'],
  ])('rejects a movable external ref written as %s', (_label, source) => {
    const probe = join(ROOT, '.github', 'workflows', 'probe.yml');
    expect(actionRefProblems(probe, source).some(({ problem }) => problem === 'movable ref')).toBe(true);
  });

  it('scans tracked composite actions outside .github/actions', () => {
    expect(actionDefinitionFiles()).toContain(
      join(ROOT, 'web', 'tests', 'fixtures', 'dependency-update-gates', 'outside-action', 'action.yml'),
    );
  });
});

describe('publication gate placement', () => {
  it('runs all three dependency invariants inside the Tests workflow', () => {
    const testsPath = workflowFiles().find((file) => {
      const workflow = parse(readFileSync(file, 'utf8')) as Workflow;
      return workflow.name === 'Tests';
    });
    expect(testsPath, 'workflow Tests not found').toBeDefined();

    const workflow = parse(readFileSync(testsPath!, 'utf8')) as Workflow;
    const executableSteps = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).map((step) => `${step.name ?? ''}\n${step.run ?? ''}`),
    );
    expect(executableSteps.length, 'workflow Tests has no executable steps').toBeGreaterThan(0);

    for (const invariant of ['lint-coverage', 'platform-entries', 'test-count']) {
      expect(
        executableSteps.some((step) => step.includes(invariant)),
        `${basename(testsPath!)} does not run ${invariant} inside workflow Tests`,
      ).toBe(true);
    }
  });

  it('does not limit runtime-audit scope to dependency-only pull requests', () => {
    const testsPath = join(WORKFLOWS, 'test.yml');
    const workflow = parse(readFileSync(testsPath, 'utf8')) as Workflow;
    const runtimeStep = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? [])
      .find((step) => step.name === 'Dependency invariant - runtime-audit scope') as WorkflowStep & { if?: string };
    expect(runtimeStep, 'runtime-audit scope step not found').toBeDefined();
    expect(runtimeStep.if ?? '', 'mixed PR with a manifest transfer must not bypass runtime scope')
      .not.toContain('dependency_only');
  });
});
