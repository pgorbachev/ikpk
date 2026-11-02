import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRefresh, runLockedRestore, switchCurrent, writeJsonAtomic, readStateFile } from '../src/seminar-management/site-refresh-operation.js';

function fixture(t, absolute = true) {
  const root = mkdtempSync(join(process.cwd(), '.absolute-target-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['old', 'new', 'foreign']) mkdirSync(join(root, 'releases', name), { recursive: true });
  const current = join(root, 'current');
  const state = join(root, 'state.json');
  const old = absolute ? join(root, 'releases', 'old') : 'releases/old';
  symlinkSync(old, current);
  const deps = {
    webRoot: root,
    pid: process.pid, now: () => new Date().toISOString(),
    workspaceReady: () => true, capture: async () => ({ok: true}),
    reuseDerivatives: () => 'fixture',
    build: async () => ({ok: true, releaseId: 'new', identity: {commit: 'a'.repeat(40), snapshotId: 'snap:test'}}),
    canVerify: () => true, readCurrent: () => readlinkSync(current),
    switchRelease: (id, expected) => switchCurrent(root, id, expected),
    verify: async () => ({ok: true}), write: (record) => writeJsonAtomic(state, record),
  };
  return { root, current, state, old, deps };
}

for (const absolute of [true, false]) test(`refresh accepts ${absolute ? 'absolute' : 'relative'} previous pointer and records a usable restore target`, async (t) => {
  const f = fixture(t, absolute);
  let expected;
  f.deps.switchRelease = (id, raw) => { expected = raw; return switchCurrent(f.root, id, raw); };
  const result = await runRefresh(f.deps);
  assert.equal(result.status, 'succeeded');
  assert.equal(expected, f.old, 'compare against exact raw pointer');
  assert.equal(JSON.parse(readFileSync(f.state)).previousReleaseId, 'releases/old');
});

test('old absolute previousReleaseId is accepted only under this configured release root', (t) => {
  const f = fixture(t);
  const record = {status: 'verification-failed', phase: 'verifying', releaseId: 'new', switched: true, previousReleaseId: f.old};
  writeFileSync(f.state, JSON.stringify(record));
  assert.equal(readStateFile(f.state, f.root).record?.previousReleaseId, 'releases/old');
  writeFileSync(f.state, JSON.stringify({...record, previousReleaseId: join(f.root, 'other', 'old')}));
  assert.equal(readStateFile(f.state, f.root).readable, false);
});

for (const absolute of [true, false]) test(`current ${absolute ? 'absolute' : 'relative'} symlink to a release-directory symlink escaping the root refuses before switching`, async (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.root, 'releases', 'escape'));
  const target = absolute ? join(f.root, 'releases', 'escape') : 'releases/escape';
  unlinkSync(f.current); symlinkSync(target, f.current);
  await assert.rejects(runRefresh(f.deps), /invalid|unsafe/i);
  assert.equal(readlinkSync(f.current), target);
});

test('Restore refuses if current was advanced after the saved refresh record', async (t) => {
  const f = fixture(t, false);
  unlinkSync(f.current); symlinkSync('releases/foreign', f.current);
  const state = {status: 'verification-failed', phase: 'verifying', releaseId: 'new', previousReleaseId: 'releases/old', switched: true};
  writeJsonAtomic(f.state, state);
  let calls = 0;
  const result = await runLockedRestore({
    lock: `${f.state}.lock`, pid: process.pid, current: state,
    readCurrent: () => readStateFile(f.state, f.root).record,
    readCurrentTarget: () => readlinkSync(f.current), webRoot: f.root,
    write: (record) => writeJsonAtomic(f.state, record),
    switchRelease: (id, raw) => { calls++; return switchCurrent(f.root, id, raw); },
    identityOf: () => ({commit: 'a'.repeat(40), snapshotId: 'snap:test'}),
    installedCommit: 'a'.repeat(40), verify: async () => ({ok: true}),
  });
  assert.notEqual(result.status, 'succeeded');
  assert.equal(calls, 0);
  assert.equal(readlinkSync(f.current), 'releases/foreign');
  assert.deepEqual(JSON.parse(readFileSync(f.state)), state);
});
