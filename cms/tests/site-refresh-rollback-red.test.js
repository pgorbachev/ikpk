// A readCurrent() callback and switchRelease(id, expectedPrevious) are the
// proposed internal seam needed for durable intent and checked switching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runRefresh, switchCurrent, writeJsonAtomic } from '../src/seminar-management/site-refresh-operation.js';

function fixture(t) {
  const root = mkdtempSync(join(process.cwd(), '.rollback-red-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['old', 'new', 'foreign']) mkdirSync(join(root, 'releases', name), { recursive: true });
  const current = join(root, 'current');
  const state = join(root, 'state.json');
  symlinkSync('releases/old', current);
  const deps = {
    pid: process.pid,
    now: () => new Date().toISOString(),
    workspaceReady: () => true,
    capture: async () => ({ ok: true }),
    reuseDerivatives: () => 'fixture',
    build: async () => ({ ok: true, releaseId: 'new', identity: { commit: 'a'.repeat(40), snapshotId: 'snap:fixture' } }),
    canVerify: () => true,
    readCurrent: () => readlinkSync(current),
    switchRelease: (id, expectedPrevious) => switchCurrent(root, id, expectedPrevious),
    verify: async () => ({ ok: true }),
    write: (record) => writeJsonAtomic(state, record),
  };
  return { root, current, state, deps };
}

test('an interrupted write immediately after actual switch leaves the prior target in durable state', async (t) => {
  const f = fixture(t);
  f.deps.write = (record) => {
    if (record.phase === 'verifying') throw new Error('simulated interruption before verification state');
    writeJsonAtomic(f.state, record);
  };
  await assert.rejects(runRefresh(f.deps), /simulated interruption/);
  assert.equal(readlinkSync(f.current), 'releases/new', 'the temporary site actually switched');
  const durable = JSON.parse(readFileSync(f.state, 'utf8'));
  assert.equal(durable.phase, 'switching');
  assert.equal(durable.previousReleaseId, 'releases/old', 'the prior target must already be durable before switch');
});

test('a changed current pointer before switch is preserved and publication is not accepted', async (t) => {
  const f = fixture(t);
  f.deps.write = (record) => {
    writeJsonAtomic(f.state, record);
    if (record.phase === 'switching') {
      unlinkSync(f.current);
      symlinkSync('releases/foreign', f.current);
    }
  };
  const result = await runRefresh(f.deps);
  assert.notEqual(result.status, 'succeeded');
  assert.equal(readlinkSync(f.current), 'releases/foreign', 'a foreign current pointer must not be replaced');
});

test('without an intervening change the new release can be accepted', async (t) => {
  const f = fixture(t);
  const result = await runRefresh(f.deps);
  assert.equal(result.status, 'succeeded');
  assert.equal(readlinkSync(f.current), 'releases/new');
});
