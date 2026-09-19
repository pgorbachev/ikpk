import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNewPublication } from '../scripts/lib/publication-runner.ts';
import { runnerFixture, OTHER_SHA, SHA } from './helpers/publication-runner-fixture.ts';

const fixtures: ReturnType<typeof runnerFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.clean(); });
function fixture() { const f = runnerFixture(); fixtures.push(f); return f; }
function unconnected(f: ReturnType<typeof fixture>) {
  expect(f.state.connections).toBe(0); expect(f.current()).toBe('old'); expect(f.index).toEqual([]);
  expect(f.events.some((event) => event.name === 'create-transport')).toBe(false);
}
async function rejectsBeforeConnection(f: ReturnType<typeof fixture>) {
  await expect(runNewPublication(f.input, f.ports)).rejects.toThrow(); unconnected(f);
}
function names(f: ReturnType<typeof fixture>) { return f.events.map((event) => event.name); }

// Deterministic effect machines test orchestration. SSH mechanics and real HTTP /
// build adapters have separate contracts; these tests perform no network effects.
describe('new publication authorizes full evidence before connecting', () => {
  it('missing or unsuitable CI refuses before capture checks build and SSH', async () => {
    for (const fault of ['missing', 'sha', 'workflow', 'job', 'zero'] as const) {
      const f = fixture();
      if (fault === 'missing') f.state.ci = undefined;
      if (fault === 'sha') f.ci.commit = OTHER_SHA;
      if (fault === 'workflow') f.ci.workflow = '.github/workflows/unrelated.yml';
      if (fault === 'job') f.ci.jobs[0].conclusion = 'skipped';
      if (fault === 'zero') f.ci.executedTests = 0;
      await rejectsBeforeConnection(f);
      expect(f.state.checks).toBe(0); expect(f.state.captures).toBe(0);
    }
  });

  it('unreadable CI stops before local preparation and does not fall back to caller evidence', async () => {
    const f = fixture(); f.ports.readCiEvidence = async () => { throw new Error('GitHub unavailable'); };
    await rejectsBeforeConnection(f); expect(f.state.checks).toBe(0);
  });

  it('successful publication executes one capture/checks and uploads exactly the checked tree', async () => {
    const f = fixture(); const capturedBytes = readFileSync(join(f.snapshotDir, 'snapshot.json'));
    f.input.origin = 'http://stand.test.invalid';
    f.state.redirectRelease = 'https://stand.test.invalid/release.json';
    f.state.redirectHealth = 'https://stand.test.invalid/';
    const result = await runNewPublication(f.input, f.ports);
    expect(result).toEqual(f.operation()); expect(f.state.checks).toBe(1); expect(f.state.captures).toBe(1);
    expect(f.state.connections).toBe(1); expect(f.current()).toBe(f.input.releaseId);
    expect(readFileSync(join(f.remote, 'releases', f.input.releaseId, 'index.html'))).toEqual(readFileSync(join(f.input.treeDir, 'index.html')));
    expect(readFileSync(join(f.snapshotDir, 'snapshot.json'))).toEqual(capturedBytes);
    expect(existsSync(f.pendingPath)).toBe(false); expect(f.index).toEqual([result]);
    expect(f.state.requests).toHaveLength(4); // Same-host HTTP→HTTPS final 200 is allowed.
  });

  it('missing zero partial foreign or failed local reports refuse before transport creation', async () => {
    for (const fault of ['missing', 'zero', 'partial', 'destination', 'commit', 'snapshot', 'failed'] as const) {
      const f = fixture();
      if (fault === 'missing') f.state.report = undefined;
      if (fault === 'zero') f.report.groups[0].executedTests = 0;
      if (fault === 'partial') f.report.groups.pop();
      if (fault === 'destination') f.report.destinationId = 'foreign';
      if (fault === 'commit') f.report.commit = OTHER_SHA;
      if (fault === 'snapshot') f.report.snapshotId = 'foreign';
      if (fault === 'failed') f.report.groups[0].conclusion = 'failure';
      await rejectsBeforeConnection(f);
    }
  });

  it('local capture or checks failure cannot create a transport or publication record', async () => {
    const f = fixture(); f.ports.runChecks = async () => { throw new Error('snapshot group failed'); };
    await rejectsBeforeConnection(f);
  });

  it('requires live capture derived identity actual content fingerprint and complete provenance', async () => {
    for (const fault of ['pinned', 'fingerprint', 'content', 'identity', 'provenance'] as const) {
      const f = fixture();
      if (fault === 'pinned') f.snapshot.origin = { kind: 'pinned' };
      if (fault === 'fingerprint') f.snapshot.fingerprint = 'forged';
      if (fault === 'content') f.snapshot.content.types.articles[0].title = 'Changed after capture';
      if (fault === 'identity') f.snapshot.snapshotId = 'forged';
      if (fault === 'provenance') delete f.snapshot.provenance;
      await rejectsBeforeConnection(f);
    }
  });

  it('requires captured accepted state to match latest journal entry fingerprint revision and high-water mark', async () => {
    for (const fault of ['fingerprint', 'latest', 'revision', 'hwm', 'confirmation'] as const) {
      const f = fixture();
      if (fault === 'fingerprint') f.state.provenance.entries.at(-1)!.fingerprint = 'unknown-new-content';
      if (fault === 'latest') f.changedEvent();
      if (fault === 'revision') f.state.provenance.observation.revision = 3;
      if (fault === 'hwm') f.state.provenance.observation.highWaterMark = 5;
      if (fault === 'confirmation') f.state.provenance.observation.requiresConfirmation = true;
      await rejectsBeforeConnection(f);
    }
  });

  it('remeasures actual local bytes before connection and rejects a tree changed after checks', async () => {
    const f = fixture(); const original = f.ports.runChecks;
    f.ports.runChecks = async (input) => { const result = await original(input); writeFileSync(join(f.input.treeDir, 'index.html'), 'unchecked bytes'); return result; };
    await rejectsBeforeConnection(f); expect(names(f)).toContain('digest');
  });
});

describe('host lock contains final source checks switch health and append', () => {
  it('keeps all publication effects under one lock with final reads after prepare directly before switch', async () => {
    const f = fixture(); await runNewPublication(f.input, f.ports);
    const order = names(f);
    expect(order.indexOf('ci')).toBeLessThan(order.indexOf('checks'));
    expect(order.indexOf('checks')).toBeLessThan(order.indexOf('create-transport'));
    const prepare = order.indexOf('prepare'), last = order.indexOf('final-complete');
    expect(prepare).toBeGreaterThan(order.indexOf('stage'));
    expect(order.slice(prepare + 1, last).sort()).toEqual(['main', 'state']);
    expect(order.slice(last, order.indexOf('finish') + 1)).toEqual(['final-complete', 'switch', 'release-read', 'health-read', 'index', 'finish']);
    expect(order.at(-1)).toBe('unlock');
    for (const event of f.events.filter((event) => ['stage', 'prepare', 'final-complete', 'switch', 'release-read', 'health-read', 'index', 'finish'].includes(event.name))) expect(event.locked).toBe(true);
  });

  it('a main change observed after upload refuses activation and writes no index', async () => {
    const f = fixture(); f.hooks.afterStage = () => { f.state.main = OTHER_SHA; };
    await expect(runNewPublication(f.input, f.ports)).rejects.toThrow();
    expect(f.current()).toBe('old'); expect(f.index).toEqual([]); expect(f.state.requests).toEqual([]);
    expect(names(f)).toContain('cancel'); expect(existsSync(f.pendingPath)).toBe(false);
  });

  it('a CMS event before the last check refuses even with successful build and uploaded bytes', async () => {
    const f = fixture(); f.hooks.afterStage = f.changedEvent;
    await expect(runNewPublication(f.input, f.ports)).rejects.toThrow();
    expect(names(f)).toContain('stage'); expect(names(f)).toContain('cancel');
    expect(f.current()).toBe('old'); expect(f.index).toEqual([]); expect(f.state.requests).toEqual([]);
  });

  it('final check independently rejects changed HWM fingerprint or revision at an unchanged entry number', async () => {
    for (const fault of ['hwm', 'fingerprint', 'revision'] as const) {
      const f = fixture(); f.hooks.afterStage = () => {
        if (fault === 'hwm') f.state.provenance.observation.highWaterMark = 5;
        if (fault === 'fingerprint') f.state.provenance.entries.at(-1)!.fingerprint = 'different-content';
        if (fault === 'revision') f.state.provenance.observation.revision = 3;
      };
      await expect(runNewPublication(f.input, f.ports)).rejects.toThrow();
      expect(f.current()).toBe('old'); expect(f.index).toEqual([]);
    }
  });

  it('changes after the successful final check are the accepted residual window and preserve observed evidence', async () => {
    const f = fixture(); f.hooks.afterFinal = () => { f.changedEvent(); f.state.main = OTHER_SHA; };
    const result = await runNewPublication(f.input, f.ports);
    expect(result).toMatchObject({ observedEntry: 4, highWaterMark: 4, headAtLastCheck: SHA, revision: 4 });
    expect(f.current()).toBe(f.input.releaseId); expect(f.index).toEqual([result]);
    expect(names(f).slice(names(f).indexOf('final-complete'))).not.toContain('state');
    expect(names(f).slice(names(f).indexOf('final-complete'))).not.toContain('main');
  });

  it('transfer checksum failure cannot switch run health checks or append a publication', async () => {
    const f = fixture(); f.state.stageFailure = true;
    await expect(runNewPublication(f.input, f.ports)).rejects.toThrow();
    expect(names(f)).toContain('stage'); expect(names(f)).not.toContain('prepare');
    expect(f.current()).toBe('old'); expect(f.index).toEqual([]); expect(f.state.requests).toEqual([]);
  });

  it('atomic activation failure never records an intended publication as successful', async () => {
    const f = fixture(); f.state.switchFailure = true;
    await expect(runNewPublication(f.input, f.ports)).rejects.toThrow();
    expect(names(f)).toContain('final-complete'); expect(names(f)).not.toContain('switch');
    expect(f.current()).toBe('old'); expect(f.index).toEqual([]); expect(f.state.requests).toEqual([]);
  });

  it('post-switch unreadable wrong-pair non200 or foreign-host serving leaves pending and names the active operation', async () => {
    for (const fault of ['network', 'pair', 'malformed', 'release-status', 'health-status', 'release-host', 'health-host'] as const) {
      const f = fixture();
      if (fault === 'network') f.state.fetchFailure = true;
      if (fault === 'pair') f.state.releaseBody = { commit: OTHER_SHA, snapshotId: f.snapshot.snapshotId };
      if (fault === 'malformed') f.state.releaseBody = { publishedAt: 'old timestamp endpoint' };
      if (fault === 'release-status') f.state.releaseStatus = 404;
      if (fault === 'health-status') f.state.healthStatus = 503;
      if (fault === 'release-host') f.state.redirectRelease = 'https://foreign.test.invalid/release.json';
      if (fault === 'health-host') f.state.redirectHealth = 'https://foreign.test.invalid/';
      const promise = runNewPublication(f.input, f.ports);
      await expect(promise).rejects.toMatchObject({ activeOperation: expect.objectContaining({ publicationId: f.input.publicationId, releaseId: f.input.releaseId }) });
      expect(f.current()).toBe(f.input.releaseId); expect(existsSync(f.pendingPath)).toBe(true); expect(f.index).toEqual([]);
      expect(f.state.requests.every((request) => new URL(request.url).hostname === 'stand.test.invalid')).toBe(true);
    }
  });

  it('failed index append after health preserves active pending operation and fails the command', async () => {
    const f = fixture(); f.state.appendFailure = true;
    await expect(runNewPublication(f.input, f.ports)).rejects.toMatchObject({ activeOperation: expect.objectContaining({ commit: SHA, snapshotId: f.snapshot.snapshotId, destinationId: 'stand' }) });
    expect(names(f).slice(-4)).toEqual(['release-read', 'health-read', 'index', 'unlock']);
    expect(f.current()).toBe(f.input.releaseId); expect(existsSync(f.pendingPath)).toBe(true); expect(f.index).toEqual([]);
  });

  it('records the full original immutable evidence once even if producer objects are changed after the final check', async () => {
    const f = fixture(); const expected = f.operation();
    f.hooks.afterSwitch = () => { f.ci.jobs[0].conclusion = 'failure'; f.report.groups[0].executedTests = 999; };
    const result = await runNewPublication(f.input, f.ports);
    expect(result).toEqual(expected); expect(f.index).toEqual([expected]);
    expect(result.ciEvidence).not.toBe(f.ci); expect(result.localChecks).not.toBe(f.report);
    expect(result.localChecks.groups).toHaveLength(5);
  });

  it('the runner-created transport authorization expires after publication', async () => {
    const f = fixture(); await runNewPublication(f.input, f.ports);
    expect(f.state.authorize).toBeTypeOf('function');
    await expect(f.state.authorize!({ action: 'connect', destinationId: 'stand' })).rejects.toThrow();
    await expect(f.state.authorize!({ action: 'activate', destinationId: 'stand', operation: f.operation() })).rejects.toThrow();
  });
});
