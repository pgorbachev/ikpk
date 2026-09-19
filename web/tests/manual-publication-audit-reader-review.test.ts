import { afterEach, describe, expect, it } from 'vitest';
import { readCiEvidence } from '../scripts/lib/publication-ci.ts';
import { runNewPublication } from '../scripts/lib/publication-runner.ts';
import { runPublicationChecks } from '../scripts/lib/publication-checks.ts';
import { createPublicationCheckPorts } from '../scripts/lib/publication-check-adapters.ts';
import { createWorkerAudit } from '../scripts/publication-worker.ts';
import { ciFixture, REPORT_NAMES } from './helpers/publication-readers-fixtures.ts';
import { adapterFixture, vitestReport } from './helpers/publication-adapter-fixtures.ts';
import { runnerFixture } from './helpers/publication-runner-fixture.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const clean of cleanup.splice(0)) clean(); });
async function refused(run: () => Promise<unknown>) {
  const outcome = await run().then(() => ({ error: undefined }), (error: unknown) => ({ error }));
  expect(outcome.error, 'the real producer must refuse this report').toBeInstanceOf(Error);
  return createWorkerAudit({ error: outcome.error });
}

describe('independent review: real report readers retain zero-count audit evidence', () => {
  it('positive control reads actual fixed report counts before constructing audit', async () => {
    const ci = ciFixture();
    expect(await readCiEvidence(ci.input)).toMatchObject({ executedTests: 31 });
    const local = await adapterFixture(); cleanup.push(local.clean);
    expect(await createPublicationCheckPorts(local.options, local.runtime).checkSnapshot(local.context))
      .toEqual({ conclusion: 'success', executedTests: 3 });
  });

  it('a zero-test CI artifact remains explicitly zero in the runner and worker audit', async () => {
    const ci = ciFixture();
    for (const name of REPORT_NAMES) Object.assign(ci.reports[name] as object, { numPassedTests: 0 });
    const runner = runnerFixture(); cleanup.push(runner.clean);
    runner.ports.readCiEvidence = () => readCiEvidence(ci.input);
    const audit = await refused(() => runNewPublication(runner.input, runner.ports));
    expect(ci.reportReads).toHaveLength(1);
    expect(runner.state.connections).toBe(0);
    expect(audit).toMatchObject({ code: 'ci-failed', ciExecutedTests: 0 });
  });

  it('a completed zero-test local reporter remains explicitly zero in the coordinator and worker audit', async () => {
    const local = await adapterFixture(); cleanup.push(local.clean);
    local.state.reports.snapshot = vitestReport(0);
    const ports = createPublicationCheckPorts(local.options, local.runtime);
    const audit = await refused(() => runPublicationChecks(local.context, ports));
    expect(local.commands.some((command) => command.args.includes('tests/publication/snapshot.test.ts'))).toBe(true);
    expect(audit).toMatchObject({ code: 'checks-failed', check: 'snapshot-provenance', localExecutedTests: 0 });
  });

  it('CI refusal retains the total across all readable reports when one required report is empty', async () => {
    const ci = ciFixture();
    Object.assign(ci.reports[REPORT_NAMES[0]] as object, { numPassedTests: 0 });
    const runner = runnerFixture(); cleanup.push(runner.clean);
    runner.ports.readCiEvidence = () => readCiEvidence(ci.input);
    expect(await refused(() => runNewPublication(runner.input, runner.ports)))
      .toMatchObject({ code: 'ci-failed', ciExecutedTests: 24 });
  });

  it('an empty later local group preserves the count from completed earlier groups', async () => {
    const local = await adapterFixture(); cleanup.push(local.clean);
    local.state.reports.build = vitestReport(0);
    const ports = createPublicationCheckPorts(local.options, local.runtime);
    expect(await refused(() => runPublicationChecks(local.context, ports)))
      .toMatchObject({ code: 'checks-failed', check: 'build-content', localExecutedTests: 3 });
  });

  it('unknown CI counts do not become zero or a partial report total', async () => {
    for (const invalid of [undefined, { numPassedTests: '0', numFailedTests: 0 }, { numPassedTests: -1, numFailedTests: 0 }]) {
      const ci = ciFixture();
      Object.assign(ci.reports[REPORT_NAMES[0]] as object, { numPassedTests: 0 });
      ci.reports[REPORT_NAMES[1]] = invalid;
      const runner = runnerFixture(); cleanup.push(runner.clean);
      runner.ports.readCiEvidence = () => readCiEvidence(ci.input);
      const audit = await refused(() => runNewPublication(runner.input, runner.ports));
      expect(audit.code).toBe('ci-failed');
      expect(audit).not.toHaveProperty('ciExecutedTests');
    }
  });

  it('unreadable or inconsistent local reports do not invent zero or expose report contents', async () => {
    for (const rawReport of ['secret-canary: localExecutedTests=0', JSON.stringify({ ...vitestReport(0), numTotalTests: 5, secret: 'secret-canary' })]) {
      const local = await adapterFixture(); cleanup.push(local.clean);
      local.state.rawReport = rawReport;
      const ports = createPublicationCheckPorts(local.options, local.runtime);
      const audit = await refused(() => runPublicationChecks(local.context, ports));
      expect(audit).toMatchObject({ code: 'checks-failed', check: 'snapshot-provenance' });
      expect(audit).not.toHaveProperty('localExecutedTests');
      expect(JSON.stringify(audit)).not.toContain('secret-canary');
    }
  });
});
