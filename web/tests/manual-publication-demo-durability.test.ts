import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { saveDemoOperation } from '../scripts/lib/demo-publication-evidence.ts';
import { runPublicationRollback } from '../scripts/lib/publication-rollback.ts';
import { rollbackFixture } from './helpers/publication-rollback-fixture.ts';
import { runNewPublication } from '../scripts/lib/publication-runner.ts';
import { runnerFixture } from './helpers/publication-runner-fixture.ts';

const boundary = vi.hoisted(() => ({ opened: new Map<number, string>(), synced: [] as string[], fail: '' }));
// Real open/fsync/close calls, with one injectable fsync error. This verifies the
// process durability boundary and fail-closed behavior, not physical power loss.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const openSync: typeof fs.openSync = (path, flags, mode) => {
    const fd = fs.openSync(path, flags, mode); boundary.opened.set(fd, String(path)); return fd;
  };
  return { ...fs, openSync,
    fsyncSync(fd: number) {
      const path = boundary.opened.get(fd) ?? '<untracked>'; boundary.synced.push(path);
      if (path === boundary.fail) throw new Error('injected evidence fsync failure');
      fs.fsyncSync(fd);
    },
    closeSync(fd: number) { fs.closeSync(fd); boundary.opened.delete(fd); },
  };
});
const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); boundary.opened.clear(); boundary.synced.length = 0; boundary.fail = ''; });
function fixture() {
  const root = mkdtempSync(join(homedir(), '.ikpk-durable-test-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const runner = runnerFixture(); cleanups.push(runner.clean);
  const evidence = join(root, 'evidence', runner.input.publicationId);
  const snapshot = join(evidence, 'snapshot', 'snapshot.json'), media = join(evidence, 'snapshot', 'media', 'captured-bytes');
  const report = join(evidence, 'reports', 'publication.json');
  for (const path of [snapshot, media, report]) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(snapshot, JSON.stringify(runner.snapshot)); writeFileSync(media, 'captured media bytes'); writeFileSync(report, JSON.stringify(runner.report));
  Object.assign(runner.input, { sourcePolicy: 'demo-publication-only', origin: 'https://staging.ikpk.su' });
  delete runner.snapshot.provenance;
  Object.assign(runner.snapshot, { sourcePolicy: 'demo-publication-only', sourceAge: 'untracked',
    origin: { kind: 'server-db', sourceId: 'demo193-cms', capturedAt: '2026-09-19T12:59:00.000Z' },
    captureProof: { version: 1, method: 'quiesced-sqlite-backup', sourceId: 'demo193-cms', captureId: runner.input.publicationId,
      schemaDigest: '1'.repeat(64), databaseDigest: '2'.repeat(64), mediaManifestDigest: '3'.repeat(64), bundleDigest: '4'.repeat(64) } });
  runner.ports.preserveEvidence = async (operation) => { saveDemoOperation(evidence, operation); };
  return { root, evidence, snapshot, media, report, runner };
}
it('syncs snapshot, media, reports, final operation and directories bottom-up before transport', async () => {
  const f = fixture(); const create = f.runner.ports.createTransport;
  f.runner.ports.createTransport = (input) => {
    for (const file of [f.snapshot, f.media, f.report, join(f.evidence, 'operation.json')]) {
      expect(boundary.synced).toContain(file);
      expect(boundary.synced.indexOf(file)).toBeLessThan(boundary.synced.indexOf(dirname(file)));
    }
    for (let dir = f.evidence; dir !== '/'; dir = dirname(dir)) {
      expect(boundary.synced).toContain(dir);
      expect(boundary.synced.indexOf(dir)).toBeLessThan(boundary.synced.indexOf(dirname(dir)));
    }
    expect(boundary.opened.size).toBe(0);
    return create(input);
  };
  await runNewPublication(f.runner.input, f.runner.ports);
  expect(f.runner.current()).toBe(f.runner.input.releaseId);
});
it.each(['report', 'media', 'directory'] as const)('fsync failure for %s refuses before transport and activation', async (fault) => {
  const f = fixture(); boundary.fail = fault === 'directory' ? dirname(f.evidence) : f[fault];
  await expect(runNewPublication(f.runner.input, f.runner.ports)).rejects.toThrow('injected evidence fsync failure');
  expect(f.runner.state.connections).toBe(0); expect(f.runner.current()).toBe('old'); expect(f.runner.index).toEqual([]);
  expect(boundary.opened.size).toBe(0);
});
it('rollback report and final operation use the same durable subtree boundary', () => {
  const f = fixture(); const rollbackReport = join(f.evidence, 'reports', 'rollback.json');
  writeFileSync(rollbackReport, JSON.stringify(f.runner.report));
  saveDemoOperation(f.evidence, f.runner.operation());
  expect(boundary.synced).toContain(rollbackReport);
  expect(boundary.synced).toContain(join(f.evidence, 'operation.json'));
  expect(boundary.synced.indexOf(rollbackReport)).toBeLessThan(boundary.synced.indexOf(f.evidence));
});
it.each(['symlink', 'fifo'] as const)('rejects %s in evidence without following or opening it', async (kind) => {
  const f = fixture(); const path = join(f.evidence, kind);
  if (kind === 'symlink') symlinkSync(f.media, path); else execFileSync('mkfifo', [path]);
  await expect(runNewPublication(f.runner.input, f.runner.ports)).rejects.toThrow(/evidence.*(regular|symlink|unsafe)/);
  expect(f.runner.state.connections).toBe(0); expect(f.runner.current()).toBe('old');
  expect(boundary.opened.size).toBe(0);
});

it('rollback report fsync failure preserves the current release and never activates the retained one', async () => {
  const f = fixture();
  const rollback = rollbackFixture({ destinationId: 'stand', deployMode: 'stand', origin: 'https://staging.ikpk.su' });
  cleanups.push(rollback.clean);
  const report = join(f.evidence, 'reports', 'rollback.json'); boundary.fail = report;
  Object.assign(rollback.ports, { async preserveEvidence(operation: Parameters<typeof saveDemoOperation>[1] & { rollbackChecks: unknown }) {
    writeFileSync(report, JSON.stringify(operation.rollbackChecks)); saveDemoOperation(f.evidence, operation);
  } });
  await expect(runPublicationRollback(rollback.input, rollback.ports)).rejects.toThrow('injected evidence fsync failure');
  expect(rollback.state.currentReleaseId).toBe('current-release'); expect(rollback.appended).toEqual([]);
  expect(boundary.opened.size).toBe(0);
});
