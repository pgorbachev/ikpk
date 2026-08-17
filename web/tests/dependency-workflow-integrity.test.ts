import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface Workflow {
  name?: string;
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

interface ActionRefProblem {
  location: string;
  problem: 'movable ref' | 'missing readable version comment';
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => join(WORKFLOWS, file));
}

function actionRefProblems(file: string, source = readFileSync(file, 'utf8')): ActionRefProblem[] {
  const problems: ActionRefProblem[] = [];
  source.split('\n').forEach((line, index) => {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(.*))?$/);
    if (!match) return;
    const target = match[1].replace(/^['"]|['"]$/g, '');
    if (target.startsWith('./') || target.startsWith('docker://')) return;
    const separator = target.lastIndexOf('@');
    if (separator < 1) return;

    const location = `${relative(ROOT, file)}:${index + 1}`;
    if (!/^[0-9a-f]{40}$/i.test(target.slice(separator + 1))) {
      problems.push({ location, problem: 'movable ref' });
    }
    if (!/\bv\d+(?:\.\d+){0,2}\b/i.test(match[2] ?? '')) {
      problems.push({ location, problem: 'missing readable version comment' });
    }
  });
  return problems;
}

describe('workflow dependency integrity', () => {
  it('pins every external action in every workflow to a full SHA with a readable version comment', () => {
    const problems = workflowFiles().flatMap((file) => actionRefProblems(file));
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
});
