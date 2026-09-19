import { describe, expect, it } from 'vitest';
import { readCiEvidence } from '../scripts/lib/publication-ci.ts';
import { PUBLICATION_CI_POLICY } from '../scripts/lib/publish-gate.ts';
import { API, CANARY, OTHER_SHA, REPORT_NAMES, SHA, ciFixture } from './helpers/publication-readers-fixtures.ts';

describe('real CI evidence reader contract (HTTP fixtures, never GitHub mutation)', () => {
  it('returns exact trusted run evidence and counts passed Vitest tests, not jobs, steps or total tests', async () => {
    const f = ciFixture();
    const result = await readCiEvidence(f.input);
    expect(result).toBeDefined();
    expect(result).toMatchObject({ repository: 'pgorbachev/ikpk', workflow: PUBLICATION_CI_POLICY.workflow,
      branch: 'main', commit: SHA, runId: 801, event: 'push', conclusion: 'success', executedTests: 31 });
    expect(result.jobs.map((job) => job.name).sort()).toEqual([...PUBLICATION_CI_POLICY.requiredJobs].sort());
    expect(f.reportReads).toEqual([f.artifact]);
    expect(f.calls.length).toBeGreaterThanOrEqual(4);
    expect(f.calls.some(({ url }) => url.pathname === '/repos/pgorbachev/ikpk/actions/workflows/test.yml/runs')).toBe(true);
    for (const { url, method } of f.calls) {
      expect(method).toBe('GET');
      expect(url.origin).toBe('https://api.github.com');
      expect(url.pathname).toMatch(/^\/repos\/pgorbachev\/ikpk\//);
      expect(url.href).not.toContain(CANARY);
    }
  });

  it('accepts schedule for the exact main SHA under the same fixed workflow policy', async () => {
    const f = ciFixture(); f.run.event = 'schedule';
    expect(await readCiEvidence(f.input)).toMatchObject({ event: 'schedule', commit: SHA, executedTests: 31 });
  });

  it('refuses a PR, another repository, branch, SHA or workflow even when its conclusion is success', async () => {
    for (const mutation of [
      { event: 'pull_request' }, { event: 'repository_dispatch' },
      { repository: { full_name: 'someone/fork' } }, { head_branch: 'topic' },
      { head_sha: OTHER_SHA }, { path: '.github/workflows/not-tests.yml' },
    ]) {
      const f = ciFixture(); Object.assign(f.run, mutation);
      await expect(readCiEvidence(f.input), JSON.stringify(mutation)).rejects.toThrow();
      expect(f.reportReads).toHaveLength(0);
    }
  });

  it('does not authorize a once-successful commit when main has already moved', async () => {
    const f = ciFixture(); f.state.main = OTHER_SHA;
    await expect(readCiEvidence(f.input)).rejects.toThrow();
    expect(f.reportReads).toHaveLength(0);
  });

  it('requires completed status and success conclusion together', async () => {
    for (const mutation of [{ status: 'in_progress' }, { status: 'queued' }, { conclusion: 'failure' }, { conclusion: 'cancelled' }]) {
      const f = ciFixture(); Object.assign(f.run, mutation);
      await expect(readCiEvidence(f.input)).rejects.toThrow();
    }
  });

  it('requires exactly one result for every one of the five required jobs', async () => {
    for (const name of PUBLICATION_CI_POLICY.requiredJobs) {
      for (const duplicate of [false, true]) {
        const f = ciFixture();
        const matched = f.jobs.find((job) => job.name === name)!;
        f.state.jobPages = [duplicate ? [...f.jobs, matched] : f.jobs.filter((job) => job.name !== name)];
        await expect(readCiEvidence(f.input), `${name}; duplicate=${duplicate}`).rejects.toThrow();
      }
    }
  });

  it('a skipped, cancelled, failed or unfinished required job does not count as passing', async () => {
    for (const mutation of [{ conclusion: 'skipped' }, { conclusion: 'cancelled' }, { conclusion: 'failure' }, { status: 'in_progress' }]) {
      const f = ciFixture(); Object.assign(f.jobs[0], mutation);
      await expect(readCiEvidence(f.input)).rejects.toThrow();
    }
  });

  it('follows pagination for run selection, required jobs and the counts artifact', async () => {
    const f = ciFixture();
    f.state.runPages = [[{ ...f.run, id: 800, head_sha: OTHER_SHA }], [f.run]];
    f.state.jobPages = [f.jobs.slice(0, 2), f.jobs.slice(2)];
    f.state.artifactPages = [[{ ...f.artifact, id: 900, name: 'unrelated-artifact' }], [f.artifact]];
    expect(await readCiEvidence(f.input)).toMatchObject({ runId: 801, executedTests: 31 });
    for (const suffix of ['/runs', '/jobs', '/artifacts']) {
      expect(f.calls.some(({ url }) => url.pathname.endsWith(suffix) && url.searchParams.get('page') === '2'), suffix).toBe(true);
    }
    expect(f.reportReads).toEqual([f.artifact]);
  });

  it('each of the three fixed report files is required', async () => {
    for (const name of REPORT_NAMES) {
      const f = ciFixture(); delete f.reports[name];
      await expect(readCiEvidence(f.input), name).rejects.toThrow();
    }
  });

  it('zero passed tests in any required report is not replaced by successful jobs or steps', async () => {
    for (const name of REPORT_NAMES) {
      const f = ciFixture(); (f.reports[name] as Record<string, unknown>).numPassedTests = 0;
      await expect(readCiEvidence(f.input), name).rejects.toThrow();
    }
  });

  it('a failed test in any report refuses the otherwise successful run', async () => {
    for (const name of REPORT_NAMES) {
      const f = ciFixture(); (f.reports[name] as Record<string, unknown>).numFailedTests = 1;
      await expect(readCiEvidence(f.input), name).rejects.toThrow();
    }
  });

  it('refuses absent, expired or other-run counts artifacts before reading their reports', async () => {
    for (const mutation of ['absent', 'expired', 'other-run', 'other-commit']) {
      const f = ciFixture();
      if (mutation === 'absent') f.state.artifactPages = [[]];
      if (mutation === 'expired') f.artifact.expired = true;
      if (mutation === 'other-run') f.artifact.workflow_run!.id = 999;
      if (mutation === 'other-commit') f.artifact.workflow_run!.head_sha = OTHER_SHA;
      await expect(readCiEvidence(f.input), mutation).rejects.toThrow();
      expect(f.reportReads).toHaveLength(0);
    }
  });

  it('ambiguous same-name artifacts cannot silently select a different report bundle', async () => {
    const f = ciFixture(); f.state.artifactPages = [[f.artifact, { ...f.artifact, id: 999 }]];
    await expect(readCiEvidence(f.input)).rejects.toThrow();
  });

  it('malformed counters and unreadable report values never become a positive test count', async () => {
    for (const invalid of [null, {}, 'not JSON', { numPassedTests: '9', numFailedTests: 0 },
      { numPassedTests: -1, numFailedTests: 0 }, { numPassedTests: 0.5, numFailedTests: 0 },
      { numPassedTests: 5 }, { numPassedTests: 5, numFailedTests: -1 }]) {
      const f = ciFixture(); f.reports[REPORT_NAMES[0]] = invalid;
      await expect(readCiEvidence(f.input)).rejects.toThrow();
    }
  });

  it('HTTP failure or report-reader failure refuses evidence rather than returning cached success', async () => {
    for (const status of [401, 403, 404, 500]) {
      const f = ciFixture(); f.state.status = status;
      await expect(readCiEvidence(f.input)).rejects.toThrow();
    }
    const f = ciFixture();
    await expect(readCiEvidence({ ...f.input, readReports: async () => { throw new Error('archive could not be read'); } })).rejects.toThrow();
    expect(f.calls.every(({ url }) => url.href.startsWith(API))).toBe(true);
  });
});
