import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPublicationChecks, type PublicationCheckInput } from '../scripts/lib/publication-checks.ts';
import { createWorkerAudit } from '../scripts/publication-worker.ts';
import { PUBLICATION_GROUPS } from '../scripts/lib/publish-gate.ts';
import { CANARY, SHA, fixtureDigest, localFixture } from './helpers/publication-readers-fixtures.ts';

const directories: string[] = [];
function fixture() { const f = localFixture(); directories.push(f.temp); return f; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('local publication check coordinator (injected effect ports, not an Astro build)', () => {
  it('retains actual partial and zero counts through a real check failure without leaking exception text', async () => {
    for (const zero of [true, false]) {
      const f = fixture();
      if (zero) f.results.checkSnapshot = { conclusion: 'failure', executedTests: 0 };
      else f.ports.checkBuild = async () => { throw new Error(CANARY); };
      const error = await runPublicationChecks(f.input, f.ports).then(() => { throw new Error('unexpected success'); }, (error: unknown) => error);
      const audit = createWorkerAudit({ error });
      expect(audit).toMatchObject({ code: 'checks-failed', check: zero ? 'snapshot-provenance' : 'build-content',
        localExecutedTests: zero ? 0 : f.results.checkSnapshot.executedTests });
      expect(JSON.stringify(audit)).not.toContain(CANARY);
    }
  });
  it('captures and builds once, checks all five groups and records the same snapshot/destination/tree', async () => {
    const f = fixture();
    const result = await runPublicationChecks(f.input, f.ports);
    expect(result).toBeDefined();
    expect(result).toMatchObject({ commit: SHA, snapshotId: f.snapshot.snapshotId, destinationId: 'stand', treeDigest: fixtureDigest(f.input.treeDir) });
    expect(result.groups.map((group) => group.name)).toEqual([...PUBLICATION_GROUPS]);
    expect(result.groups.every((group) => group.conclusion === 'success' && group.executedTests > 0)).toBe(true);
    expect(f.events.filter((event) => event === 'capture')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'build')).toHaveLength(1);
    expect(f.events.indexOf('checkSnapshot')).toBeLessThan(f.events.indexOf('build'));
    expect(f.contexts.length).toBeGreaterThanOrEqual(6);
    for (const { context } of f.contexts) expect(context).toMatchObject(f.snapshot);
    expect(JSON.parse(readFileSync(f.input.reportPath, 'utf8'))).toEqual(result);
  });

  it('a failed snapshot/provenance check stops before build and every downstream group', async () => {
    const f = fixture(); f.results.checkSnapshot = { conclusion: 'failure', executedTests: 2 };
    await expect(runPublicationChecks(f.input, f.ports)).rejects.toThrow();
    expect(f.events).toEqual(['capture', 'checkSnapshot']);
    expect(existsSync(f.input.reportPath)).toBe(false);
  });

  it('a capture without snapshot identity or location cannot start a build', async () => {
    for (const missing of ['snapshotId', 'snapshotDir'] as const) {
      const f = fixture(); f.snapshot[missing] = '';
      await expect(runPublicationChecks(f.input, f.ports)).rejects.toThrow();
      expect(f.events).not.toContain('build');
    }
  });

  it('every fixed group must have a nonzero successful result, never skipped or missing', async () => {
    for (const port of ['checkSnapshot', 'checkBuild', 'checkDestination', 'checkBrowser', 'checkPaymentAbsent']) {
      for (const result of [{ conclusion: 'success', executedTests: 0 }, { conclusion: 'skipped', executedTests: 2 }, { conclusion: 'failure', executedTests: 2 }] as const) {
        const f = fixture(); f.results[port] = result;
        await expect(runPublicationChecks(f.input, f.ports), `${port}:${result.conclusion}:${result.executedTests}`).rejects.toThrow();
        expect(existsSync(f.input.reportPath)).toBe(false);
      }
    }
  });

  it('the report cannot be placed in the artifact tree and alter its own digest', async () => {
    const f = fixture(); f.input.reportPath = join(f.input.treeDir, 'publication-report.json');
    await expect(runPublicationChecks(f.input, f.ports)).rejects.toThrow();
    expect(f.events).toEqual([]);
  });

  it('writes release.json after build but before artifact checks and the first digest', async () => {
    const f = fixture(); const checked: string[] = [];
    const observe = (phase: string) => {
      expect(JSON.parse(readFileSync(join(f.input.treeDir, 'release.json'), 'utf8'))).toEqual({ commit: SHA, snapshotId: f.snapshot.snapshotId });
      checked.push(phase);
    };
    const originalDigest = f.ports.digest;
    f.ports.digest = async (root) => { observe('digest'); return originalDigest(root); };
    for (const name of ['checkBuild', 'checkDestination', 'checkBrowser', 'checkPaymentAbsent'] as const) {
      const original = f.ports[name]; f.ports[name] = async (context) => { observe(name); return original(context); };
    }
    await runPublicationChecks(f.input, f.ports);
    expect(checked).toContain('digest');
    expect(checked).toContain('checkBuild');
    expect(checked).toContain('checkBrowser');
    expect(f.events.filter((event) => event === 'build')).toHaveLength(1);
  });

  it('refuses an artifact changed by a check instead of authorizing the later bytes', async () => {
    const f = fixture(); const browser = f.ports.checkBrowser;
    f.ports.checkBrowser = async (context) => {
      const result = await browser(context);
      writeFileSync(join(f.input.treeDir, 'index.html'), 'changed after the build/content checks');
      return result;
    };
    await expect(runPublicationChecks(f.input, f.ports)).rejects.toThrow();
    expect(f.events.filter((event) => event === 'digest').length).toBeGreaterThanOrEqual(2);
    expect(existsSync(f.input.reportPath)).toBe(false);
  });

  it('build and browser receive an allowlisted environment, excluding arbitrary credential names', async () => {
    const f = fixture();
    f.input.env = { ...f.input.env, HOME: '/operator/private-home', RANDOM_UNRECOGNIZED_KEY: CANARY,
      GH_TOKEN: CANARY, CMS_TOKEN: CANARY, SSH_AUTH_SOCK: '/private/agent.sock', NODE_OPTIONS: CANARY };
    await runPublicationChecks(f.input, f.ports);
    for (const port of ['build', 'checkBrowser']) {
      const selected = f.contexts.filter((entry) => entry.port === port);
      expect(selected).toHaveLength(1);
      const env = selected[0].context.env;
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.LANG).toBe('C.UTF-8');
      expect(JSON.stringify(env)).not.toContain(CANARY);
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.HOME).not.toBe('/operator/private-home');
    }
  });

  it('production CRM plus payment role ci positively checks absence without payment API effects', async () => {
    const f = fixture(); f.input.deployMode = 'prod'; f.input.paymentRole = 'ci'; f.input.destinationId = 'production';
    const result = await runPublicationChecks(f.input, f.ports);
    expect(result).toBeDefined();
    expect(f.events.filter((event) => event === 'checkPaymentAbsent')).toHaveLength(1);
    expect(f.events).not.toContain('checkPaymentReadiness');
    expect(f.events).not.toContain('checkPaymentPreflight');
    for (const { context } of f.contexts) expect(context).toMatchObject({ deployMode: 'prod', paymentRole: 'ci' });
    expect(result.groups.find((group) => group.name === 'payment-destination')).toMatchObject({ conclusion: 'success', executedTests: 2 });
  });

  it('both active payment roles require readiness and preflight with a combined nonzero result', async () => {
    for (const role of ['stand', 'prod'] as const) {
      const f = fixture(); f.input.paymentRole = role;
      f.results.checkPaymentReadiness.executedTests = 3; f.results.checkPaymentPreflight.executedTests = 4;
      const result = await runPublicationChecks(f.input, f.ports);
      expect(result).toBeDefined();
      expect(f.events.filter((event) => event === 'checkPaymentReadiness')).toHaveLength(1);
      expect(f.events.filter((event) => event === 'checkPaymentPreflight')).toHaveLength(1);
      expect(f.events).not.toContain('checkPaymentAbsent');
      expect(result.groups.find((group) => group.name === 'payment-destination')).toMatchObject({ conclusion: 'success', executedTests: 7 });
    }
  });

  it('a failing or empty readiness/preflight result cannot be hidden in a successful combined payment group', async () => {
    for (const port of ['checkPaymentReadiness', 'checkPaymentPreflight']) {
      for (const result of [{ conclusion: 'failure', executedTests: 2 }, { conclusion: 'success', executedTests: 0 }] as const) {
        const f = fixture(); f.input.paymentRole = 'stand'; f.results[port] = result;
        await expect(runPublicationChecks(f.input, f.ports), `${port}:${result.conclusion}`).rejects.toThrow();
        expect(existsSync(f.input.reportPath)).toBe(false);
      }
    }
  });

  it('an operator-supplied subset or commands cannot replace the fixed checks', async () => {
    const f = fixture(); const marker = join(f.temp, 'command-executed');
    const extra = { ...f.input, groups: ['browser-smoke'], command: `touch ${marker}` } as PublicationCheckInput;
    // Either explicitly reject unknown controls or perform the complete fixed set.
    const outcome = await runPublicationChecks(extra, f.ports).then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
    if (outcome.error === undefined) {
      const result = outcome.result;
      expect(result).toBeDefined();
      expect(result!.groups.map((group) => group.name)).toEqual([...PUBLICATION_GROUPS]);
    } else {
      const error = outcome.error;
      expect(error).toBeInstanceOf(Error);
      expect(f.events).toEqual([]);
      expect(String(error)).toMatch(/unsupported|unknown|subset|groups|command/i);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('a build failure stops artifact checks and never produces a successful report', async () => {
    const f = fixture(); f.ports.build = async () => { f.events.push('build'); throw new Error('fixture build failed'); };
    await expect(runPublicationChecks(f.input, f.ports)).rejects.toThrow();
    expect(f.events).toEqual(['capture', 'checkSnapshot', 'build']);
    expect(existsSync(f.input.reportPath)).toBe(false);
  });

  it('malformed check results and fractional test counts are refused, not coerced to success', async () => {
    for (const invalid of [undefined, {}, { conclusion: 'success', executedTests: 0.5 }, { conclusion: 'success', executedTests: '2' }]) {
      const f = fixture(); f.ports.checkBrowser = async () => invalid as Awaited<ReturnType<typeof f.ports.checkBrowser>>;
      await expect(runPublicationChecks(f.input, f.ports)).rejects.toThrow();
      expect(existsSync(f.input.reportPath)).toBe(false);
    }
  });

  it('the saved report contains only publication evidence and no port contexts or credentials', async () => {
    const f = fixture(); f.input.env = { ...f.input.env, UNUSUAL_SECRET: CANARY };
    const result = await runPublicationChecks(f.input, f.ports);
    expect(result).toBeDefined();
    expect(existsSync(f.input.reportPath)).toBe(true);
    const saved = readFileSync(f.input.reportPath, 'utf8');
    expect(JSON.parse(saved)).toEqual(result);
    expect(saved).not.toContain(CANARY);
    expect(saved).not.toContain('snapshotDir');
    expect(saved).not.toContain('env');
  });
});
