import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRollbackChecks } from '../scripts/lib/publication-rollback-checks.ts';
import type { RollbackCheckInput, RollbackCheckPorts, RollbackCheckContext } from '../scripts/lib/publication-rollback-checks.ts';
import type { CheckResult } from '../scripts/lib/publication-checks.ts';
import { createWorkerAudit } from '../scripts/publication-worker.ts';
import { CANARY, fixtureDigest, localFixture } from './helpers/publication-readers-fixtures.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const methods = ['checkDestination', 'checkBrowser', 'checkPaymentAbsent', 'checkPaymentReadiness', 'checkPaymentPreflight'] as const;
const groups = ['destination-mode', 'browser-smoke', 'payment-destination'];
function fixture() {
  const base = localFixture(); dirs.push(base.temp);
  rmSync(base.snapshot.snapshotDir, { recursive: true });
  mkdirSync(base.input.treeDir);
  const input: RollbackCheckInput = { ...base.input, snapshotId: 'original-retained-snapshot' };
  writeFileSync(join(input.treeDir, 'index.html'), '<main>Previously published bytes</main>');
  writeFileSync(join(input.treeDir, 'release.json'), JSON.stringify({ commit: input.commit, snapshotId: input.snapshotId }));
  const events: string[] = []; const contexts: RollbackCheckContext[] = [];
  const results = Object.fromEntries(methods.map((method) => [method, { conclusion: 'success', executedTests: 2 }])) as Record<typeof methods[number], CheckResult>;
  const ports: RollbackCheckPorts = {
    ...Object.fromEntries(methods.map((method) => [method, async (context: RollbackCheckContext) => {
      events.push(method); contexts.push(context); return results[method];
    }])) as Pick<RollbackCheckPorts, typeof methods[number]>,
    async digest(root) { events.push('digest'); return fixtureDigest(root); },
  };
  return { ...base, input, ports, events, contexts, results };
}

describe('retained rollback checks, without CMS capture, source, build, or snapshot artifact', () => {
  it('records exactly the three rollback groups against the original immutable tree and identity', async () => {
    const f = fixture(); const before = fixtureDigest(f.input.treeDir);
    const forbidden: string[] = [];
    Object.assign(f.ports, Object.fromEntries(['capture', 'build', 'checkSnapshot', 'checkBuild'].map((name) => [name, async () => { forbidden.push(name); throw new Error(name); }])));
    const report = await runRollbackChecks(f.input, f.ports);
    expect(report).toMatchObject({ commit: f.input.commit, snapshotId: f.input.snapshotId, destinationId: f.input.destinationId, treeDigest: before });
    expect(report.groups.map((group) => group.name)).toEqual(groups);
    expect(report.groups.map((group) => group.executedTests)).toEqual([2, 2, 2]);
    expect(f.events).toEqual(['digest', 'checkDestination', 'checkBrowser', 'checkPaymentAbsent', 'digest']);
    expect(forbidden).toEqual([]);
    expect(fixtureDigest(f.input.treeDir)).toBe(before);
    expect(JSON.parse(readFileSync(f.input.reportPath, 'utf8'))).toEqual(report);
    for (const context of f.contexts) {
      expect(context).toMatchObject({ commit: f.input.commit, snapshotId: f.input.snapshotId });
      expect(realpathSync(context.treeDir)).toBe(realpathSync(f.input.treeDir));
      expect(context).not.toHaveProperty('snapshotDir');
      expect(context.env.CONTENT_SNAPSHOT_DIR).toBeUndefined();
    }
  });

  it('ci payment positively checks absence even with production CRM and never probes an API', async () => {
    const f = fixture(); f.input.deployMode = 'prod';
    const report = await runRollbackChecks(f.input, f.ports);
    expect(report.groups.at(-1)).toEqual({ name: 'payment-destination', conclusion: 'success', executedTests: 2 });
    expect(f.events).toContain('checkPaymentAbsent');
    expect(f.events).not.toContain('checkPaymentReadiness'); expect(f.events).not.toContain('checkPaymentPreflight');
    expect(f.contexts.every((context) => context.deployMode === 'prod' && context.paymentRole === 'ci')).toBe(true);
  });

  it.each(['stand', 'prod'] as const)('%s payment requires both current readiness and preflight', async (paymentRole) => {
    const f = fixture(); f.input.paymentRole = paymentRole;
    f.results.checkPaymentReadiness.executedTests = 3; f.results.checkPaymentPreflight.executedTests = 5;
    const report = await runRollbackChecks(f.input, f.ports);
    expect(report.groups.at(-1)).toEqual({ name: 'payment-destination', conclusion: 'success', executedTests: 8 });
    expect(f.events).toEqual(['digest', 'checkDestination', 'checkBrowser', 'checkPaymentReadiness', 'checkPaymentPreflight', 'digest']);
  });

  it('refuses zero, skipped, failed, missing and fractional evidence for each required check', async () => {
    for (const method of methods) for (const result of [undefined, { conclusion: 'success', executedTests: 0 },
      { conclusion: 'skipped', executedTests: 2 }, { conclusion: 'failure', executedTests: 2 }, { conclusion: 'success', executedTests: 0.5 }]) {
      const f = fixture(); if (method === 'checkPaymentReadiness' || method === 'checkPaymentPreflight') f.input.paymentRole = 'stand';
      f.ports[method] = async () => result as CheckResult;
      await expect(runRollbackChecks(f.input, f.ports), `${method}: ${JSON.stringify(result)}`).rejects.toThrow();
      expect(existsSync(f.input.reportPath)).toBe(false);
    }
  });

  it('rejects tree mutation by a check instead of recording success for changed bytes', async () => {
    const f = fixture();
    f.ports.checkBrowser = async () => { writeFileSync(join(f.input.treeDir, 'index.html'), 'tampered'); return f.results.checkBrowser; };
    await expect(runRollbackChecks(f.input, f.ports)).rejects.toThrow(/changed|digest/i);
    expect(f.events.filter((name) => name === 'digest')).toHaveLength(2);
    expect(existsSync(f.input.reportPath)).toBe(false);
  });

  it('rejects reports within the retained artifact, including a parent symlink, before any effect', async () => {
    for (const alias of [false, true]) {
      const f = fixture(); const parent = alias ? join(f.temp, 'tree-alias') : f.input.treeDir;
      if (alias) symlinkSync(f.input.treeDir, parent);
      f.input.reportPath = join(parent, 'checks.json');
      await expect(runRollbackChecks(f.input, f.ports)).rejects.toThrow();
      expect(f.events).toEqual([]);
    }
  });

  it('rejects a stale report and malformed retained identity before effects', async () => {
    for (const fault of ['report', 'commit', 'snapshotId', 'destinationId'] as const) {
      const f = fixture();
      if (fault === 'report') writeFileSync(f.input.reportPath, 'existing evidence'); else f.input[fault] = '';
      await expect(runRollbackChecks(f.input, f.ports)).rejects.toThrow();
      expect(f.events).toEqual([]);
    }
  });

  it('strips ambient credentials and snapshot location while using a disposable home', async () => {
    const f = fixture();
    f.input.env = { PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/operator/home', CONTENT_SNAPSHOT_DIR: CANARY,
      CMS_TOKEN: CANARY, GH_TOKEN: CANARY, NODE_OPTIONS: CANARY, SSH_AUTH_SOCK: CANARY, UNCLASSIFIED_SECRET: CANARY };
    await runRollbackChecks(f.input, f.ports);
    expect(f.contexts).toHaveLength(3);
    for (const context of f.contexts) {
      expect(JSON.stringify(context.env)).not.toContain(CANARY);
      expect(context.env.PATH).toBe('/usr/bin:/bin');
      expect(context.env.HOME).not.toBe('/operator/home');
      expect(context.env.HOME).toBeTruthy(); expect(existsSync(context.env.HOME!)).toBe(false);
    }
  });

  it('retains actual partial counts and failed group in a sanitized operator audit', async () => {
    const f = fixture(); f.ports.checkBrowser = async () => { throw new Error(CANARY); };
    const error = await runRollbackChecks(f.input, f.ports).catch((error: unknown) => error);
    const audit = createWorkerAudit({ error });
    expect(audit).toMatchObject({ code: 'checks-failed', check: 'browser-smoke', localExecutedTests: 2 });
    expect(JSON.stringify(audit)).not.toContain(CANARY);
  });

  it('operator command and group input cannot reduce the fixed required set', async () => {
    const f = fixture();
    await expect(runRollbackChecks({ ...f.input, groups: ['browser-smoke'], command: 'ignored' } as RollbackCheckInput, f.ports)).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
});
