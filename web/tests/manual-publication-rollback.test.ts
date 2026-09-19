import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseManualPublication, isPublicationRecord } from '../scripts/lib/publish-gate.ts';
import { upsertVerifiedPair } from '../scripts/lib/verified-pairs.ts';
import { rollbackFixture, NOW, type RollbackInput, type RollbackPorts, type RollbackOperation } from './helpers/publication-rollback-fixture.ts';

const fixtures: ReturnType<typeof rollbackFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.clean(); });
function fixture() { const f = rollbackFixture(); fixtures.push(f); return f; }
const names = (f: ReturnType<typeof fixture>) => f.events.map((event) => event.name);
// Load inside the test so absent implementation is an executed RED, not a collection error.
// Obtain the runner BEFORE rejects assertions: missing code must never satisfy a refusal case.
async function runner() {
  const path = new URL('../scripts/lib/publication-rollback.ts', import.meta.url).href;
  const module = await import(/* @vite-ignore */ path);
  expect(module.runPublicationRollback).toBeTypeOf('function');
  return module.runPublicationRollback as (input: RollbackInput, ports: RollbackPorts) => Promise<RollbackOperation>;
}
function unswitched(f: ReturnType<typeof fixture>) {
  expect(names(f)).not.toContain('switch'); expect(f.appended).toEqual([]); expect(f.state.requests).toEqual([]);
}

describe('installed rollback coordinator', () => {
  it('fixture evidence is accepted by the real gate and additive rollback audit survives the real index', () => {
    const f = fixture();
    expect(chooseManualPublication({ headCommit: '', headAtLastCheck: '', highWaterMark: 999,
      verifiedPairs: f.history, actor: f.input.actor, now: NOW, retentionDays: 0, destinationId: 'prod',
      treeDigest: f.original.treeDigest, localChecks: f.report,
      retainedReleases: [f.original], rollback: { snapshotId: f.original.snapshotId, releaseId: f.input.releaseId, confirmed: true, reason: f.input.reason },
    }).action).toBe('publish');
    const operation = { ...f.original, publicationId: f.input.publicationId, rollbackOfPublicationId: f.original.publicationId,
      rollbackChecks: f.report, reason: f.input.reason };
    expect(isPublicationRecord(operation)).toBe(true);
    expect(upsertVerifiedPair(f.history, operation)).toEqual([...f.history, operation]);
    const rewritten = { ...operation, reason: 'rewritten' };
    expect(() => upsertVerifiedPair([...f.history, operation], rewritten)).toThrow(/conflict/);
  });

  it('restores retained bytes with stored role and immutable audit while CMS main old CI and snapshot are unavailable', async () => {
    const run = await runner(); const f = fixture(); const historyBefore = structuredClone(f.history);
    const originalBefore = structuredClone(f.original); const reportBefore = structuredClone(f.report);
    f.hooks.afterSwitch = () => { f.original.ciEvidence.jobs[0].conclusion = 'failure'; f.report.groups[0].executedTests = 999; };
    const result = await run(f.input, f.ports);
    expect(result).toEqual({ ...originalBefore, publicationId: f.input.publicationId, actor: f.input.actor, publishedAt: NOW,
      rollbackOfPublicationId: originalBefore.publicationId, reason: f.input.reason, rollbackChecks: reportBefore });
    expect(f.appended).toEqual([result]); expect(f.state.currentReleaseId).toBe(f.input.releaseId);
    expect(f.state.checks).toEqual([{ treeDir: f.treeDir, commit: originalBefore.commit, snapshotId: originalBefore.snapshotId,
      destinationId: 'prod', deployMode: 'prod', paymentRole: 'ci' }]);
    expect(names(f)).not.toContain('forbidden-live-source'); expect(f.history).toHaveLength(historyBefore.length);
    expect(f.newer).toEqual(historyBefore[1]); expect(f.state.pending).toBeUndefined();
    expect(names(f).slice(names(f).indexOf('switch'))).toEqual(['switch', 'release-read', 'health-read', 'index', 'finish', 'unlock']);
    for (const event of f.events.filter(({ name }) => ['retained', 'digest', 'checks', 'rollback', 'switch', 'release-read', 'health-read', 'index'].includes(name))) expect(event.locked).toBe(true);
    const checkAt = names(f).indexOf('checks');
    expect(names(f).slice(0, checkAt)).toContain('digest'); expect(names(f).slice(checkAt + 1, names(f).indexOf('rollback'))).toContain('digest');
  });

  it('requires explicit confirmation actor and reason before opening the transport', async () => {
    const run = await runner();
    for (const fault of ['confirmation', 'actor', 'reason'] as const) {
      const f = fixture();
      if (fault === 'confirmation') f.input.confirmed = false;
      else f.input[fault] = ' ';
      await expect(run(f.input, f.ports)).rejects.toThrow(/confirm|actor|reason|input/i);
      unswitched(f); expect(names(f)).not.toContain('create-transport');
    }
  });

  it('requires original destination record and complete original CI and five local groups', async () => {
    const run = await runner();
    for (const fault of ['missing', 'foreign', 'ci', 'local'] as const) {
      const f = fixture();
      if (fault === 'missing') f.history.splice(0, 1);
      if (fault === 'foreign') f.original.destinationId = 'stand';
      if (fault === 'ci') f.original.ciEvidence.jobs.pop();
      if (fault === 'local') f.original.localChecks.groups.shift();
      await expect(run(f.input, f.ports)).rejects.toThrow(); unswitched(f);
      expect(names(f)).not.toContain('create-transport');
    }
  });

  it('rejects pruned already-current foreign and misidentified retained targets under the lock', async () => {
    const run = await runner();
    for (const fault of ['pruned', 'current', 'destination', 'release'] as const) {
      const f = fixture();
      if (fault === 'pruned') f.state.retained = false;
      if (fault === 'current') f.state.currentReleaseId = f.input.releaseId;
      if (fault === 'destination') f.state.retainedDestination = 'stand';
      if (fault === 'release') f.state.retainedReleaseId = 'another-release';
      await expect(run(f.input, f.ports)).rejects.toThrow(fault === 'pruned' ? /retention|retained/i : /current|previous|destination|release|identity/i);
      unswitched(f); expect(f.state.checks).toEqual([]);
    }
  });

  it('measures retained bytes before fresh checks and refuses content changed since the original publication', async () => {
    const run = await runner(); const f = fixture(); writeFileSync(join(f.treeDir, 'index.html'), 'tampered stored release');
    await expect(run(f.input, f.ports)).rejects.toThrow(/digest|checksum|tree/i);
    unswitched(f); expect(f.state.checks).toEqual([]);
  });

  it('requires all three fresh rollback groups bound to this same retained tree and destination', async () => {
    const run = await runner();
    for (const fault of ['missing', 'zero', 'partial', 'failed', 'destination', 'digest'] as const) {
      const f = fixture();
      if (fault === 'missing') f.state.report = undefined;
      if (fault === 'zero') f.report.groups[0].executedTests = 0;
      if (fault === 'partial') f.report.groups.pop();
      if (fault === 'failed') f.report.groups[1].conclusion = 'failure';
      if (fault === 'destination') f.report.destinationId = 'stand';
      if (fault === 'digest') f.report.treeDigest = '0'.repeat(64);
      await expect(run(f.input, f.ports)).rejects.toThrow(); unswitched(f); expect(names(f)).not.toContain('rollback');
    }
  });

  it('remeasures after checks and refuses changed bytes before requesting a switch', async () => {
    const run = await runner(); const f = fixture();
    f.hooks.afterChecks = () => writeFileSync(join(f.treeDir, 'index.html'), 'changed during smoke');
    await expect(run(f.input, f.ports)).rejects.toThrow(/digest|checksum|tree/i);
    unswitched(f); expect(names(f)).not.toContain('rollback');
  });

  it('holds a scoped live authorization for only the selected rollback and revokes it at completion', async () => {
    const run = await runner(); const f = fixture();
    f.hooks.beforeRollback = async () => {
      const authorize = f.state.authorize!;
      for (const action of ['stage', 'activate', 'recover'] as const) await expect(authorize({ action, destinationId: 'prod', operation: f.original, expectedDigest: f.original.treeDigest })).rejects.toThrow();
      await expect(authorize({ action: 'connect', destinationId: 'stand' })).rejects.toThrow();
      await expect(authorize({ action: 'read-retained', destinationId: 'prod', releaseId: 'foreign-release' })).rejects.toThrow();
      await expect(authorize({ action: 'rollback', destinationId: 'prod', operation: { ...f.original, publicationId: 'forged' } })).rejects.toThrow();
    };
    await run(f.input, f.ports);
    await expect(f.state.authorize!({ action: 'connect', destinationId: 'prod' })).rejects.toThrow();
  });

  it('refuses an unfinished destination operation without checks or switching', async () => {
    const run = await runner(); const f = fixture();
    f.state.pending = { ...f.original, rollbackOfPublicationId: 'older', reason: 'unfinished', rollbackChecks: f.report };
    await expect(run(f.input, f.ports)).rejects.toThrow(/unfinished|pending/i); unswitched(f); expect(f.state.checks).toEqual([]);
  });

  it('verifies post-switch release identity and health before append; failures retain the active pending audit', async () => {
    const run = await runner();
    for (const fault of ['identity', 'health', 'foreign', 'append', 'callback-operation'] as const) {
      const f = fixture();
      if (fault === 'identity') f.state.releaseBody = { commit: f.original.commit, snapshotId: 'wrong-snapshot' };
      if (fault === 'health') f.state.healthStatus = 503;
      if (fault === 'foreign') f.state.redirect = 'https://foreign.test.invalid/release.json';
      if (fault === 'append') f.state.appendFailure = true;
      if (fault === 'callback-operation') f.hooks.indexOperation = (operation) => ({ ...operation, reason: 'forged callback' });
      await expect(run(f.input, f.ports)).rejects.toMatchObject({ activeOperation: expect.objectContaining({ publicationId: f.input.publicationId, releaseId: f.input.releaseId }) });
      expect(f.state.currentReleaseId).toBe(f.input.releaseId); expect(f.state.pending).toBeDefined(); expect(f.appended).toEqual([]);
      expect(f.state.requests.every((url) => new URL(url).hostname === 'site.test.invalid')).toBe(true);
      expect(names(f).at(-1)).toBe('unlock');
    }
  });
});
