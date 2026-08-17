import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasTrigger, loadWorkflows, REPO_ROOT } from './helpers/workflows';

const CLI_PATH = join(REPO_ROOT, 'web', 'scripts', 'check-dependency-update-gates.ts');

describe('published main head monitor workflow', () => {
  it('is scheduled, manually reproducible, and enforces the approved 30 minute lag', () => {
    const monitors = loadWorkflows().filter((workflow) =>
      hasTrigger(workflow, 'schedule') &&
      hasTrigger(workflow, 'workflow_dispatch') &&
      Object.values(workflow.jobs).some((job) =>
        job.steps.some((step) => (step.run ?? '').includes('published-head')),
      ),
    );

    expect(monitors, 'no scheduled + workflow_dispatch published-head monitor found').toHaveLength(1);
    const monitor = monitors[0];
    if (!monitor) return;

    expect(monitor.triggers.schedule, 'publish monitor has no cron schedule').toEqual(
      expect.arrayContaining([expect.objectContaining({ cron: expect.any(String) })]),
    );

    const jobs = Object.values(monitor.jobs);
    expect(jobs.some((job) => job.continueOnError === true), 'publish failure must remain a signal')
      .toBe(false);

    const workflowSource = readFileSync(join(REPO_ROOT, '.github', 'workflows', monitor.file), 'utf8');
    const cliSource = readFileSync(CLI_PATH, 'utf8');
    const executableContract = `${workflowSource}\n${cliSource}`;

    expect(executableContract).toMatch(/check-dependency-update-gates\.ts[\s\\]+published-head/);
    expect(
      executableContract,
      'the approved lag must be encoded as 30 minutes (or 1,800,000 ms)',
    ).toMatch(/(?:max[-_ ]?lag[^\n]*(?:30|1800000)|(?:30|1800000)[^\n]*max[-_ ]?lag)/i);
    expect(executableContract, 'monitor must resolve the current main head').toMatch(/\bmain\b/i);
    expect(executableContract, 'monitor must inspect Pages deployments').toMatch(/deployments?/i);
    expect(executableContract, 'monitor must select the github-pages environment').toMatch(/github-pages/i);
    expect(executableContract, 'only a successful Pages deployment is publication').toMatch(/success/i);
    expect(executableContract, 'monitor must be able to query GitHub').toMatch(/GITHUB_TOKEN|GH_TOKEN/);
  });
});
