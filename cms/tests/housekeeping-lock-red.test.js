// OpenSpec release-housekeeping: design decision 2, foreign and ambiguous PID locks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideLock, isPidAlive, lockPid, reconcile, transferLock, tryLock, unlock } from '../src/seminar-management/site-refresh-operation.js';

test('a delayed observation of a dead worker does not release a newer live owner lock', () => {
  const dir = mkdtempSync(join(process.cwd(), '.housekeeping-lock-'));
  try {
    const lockPath = join(dir, 'lock');
    assert.equal(tryLock(lockPath, 77), true);
    const decision = decideLock({ readable: true, lockPath,
      record: { status: 'running', phase: 'build', pid: 55, switched: false },
      pidAlive: (pid) => pid === 77 });
    assert.equal(decision.releaseLock, false, 'the stale record must not authorize unlinking a live foreign lock');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a newly created empty lock stays busy while its owner is writing it', () => {
  const dir = mkdtempSync(join(process.cwd(), '.housekeeping-lock-'));
  try {
    const lockPath = join(dir, 'lock');
    writeFileSync(lockPath, '');
    const decision = decideLock({ readable: true, lockPath, record: null, pidAlive: () => false });
    assert.equal(decision.releaseLock, false, 'an empty or ambiguous lock must not be unlinked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a live owner remains protected in a normal readable state', () => {
  const dir = mkdtempSync(join(process.cwd(), '.housekeeping-lock-'));
  try {
    const lockPath = join(dir, 'lock');
    assert.equal(tryLock(lockPath, 77), true);
    const decision = decideLock({ readable: true, lockPath,
      record: { status: 'running', pid: 77 }, pidAlive: (pid) => pid === 77 });
    assert.equal(decision.releaseLock, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('EPERM and unknown process probes remain busy; ESRCH is dead', () => {
  const probe = (code) => () => { throw Object.assign(new Error('probe'), { code }); };
  assert.equal(isPidAlive(9, probe('EPERM')), true);
  assert.equal(isPidAlive(9, probe('EACCES')), true);
  assert.equal(isPidAlive(9, probe('ESRCH')), false);
});

test('reconcile leaves running records with missing or invalid PIDs untouched', () => {
  const record = { status: 'running', phase: 'build', switched: false };
  assert.equal(reconcile(record, () => false), record);
  assert.equal(reconcile({ ...record, pid: 0 }, () => false).status, 'running');
});

test('controller transfers its lock to the worker, and only the worker releases it', () => {
  const dir = mkdtempSync(join(process.cwd(), '.housekeeping-lock-'));
  try {
    const lockPath = join(dir, 'lock');
    assert.equal(tryLock(lockPath, 101), true);
    assert.equal(transferLock(lockPath, 101, 202), true);
    assert.equal(lockPid(lockPath), 202);
    assert.equal(unlock(lockPath, 101), false);
    assert.equal(existsSync(lockPath), true);
    assert.equal(unlock(lockPath, 202), true);
    assert.equal(existsSync(lockPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown PID lock cannot be removed while reconciling a dead recorded worker', () => {
  const dir = mkdtempSync(join(process.cwd(), '.housekeeping-lock-'));
  try {
    const lockPath = join(dir, 'lock');
    writeFileSync(lockPath, 'worker-starting');
    const decision = decideLock({ readable: true, lockPath,
      record: { status: 'running', phase: 'build', pid: 55, switched: false },
      pidAlive: () => false });
    assert.equal(decision.releaseLock, false);
    assert.equal(existsSync(lockPath), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
