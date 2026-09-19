import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RollbackCheckContext } from '../scripts/lib/publication-rollback-checks.ts';
import { fixtureDigest } from './helpers/publication-readers-fixtures.ts';
import { rollbackFixture, type RollbackAuthorizer } from './helpers/publication-rollback-fixture.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OPERATOR = join(ROOT, 'web/scripts/publication-operator.ts');
const RUNTIME_SHA = 'c'.repeat(40), CANARY = 'operator-secret-canary-43b711';
const cleanups: (() => void)[] = [];
function write(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value, { mode: 0o600 }); }
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); for (const clean of cleanups.splice(0)) clean(); });

async function fixture(loadOperator = true) {
  const f = rollbackFixture(); cleanups.push(f.clean);
  const installed = join(realpathSync(f.temp), 'protected'), launcher = join(installed, 'publication-launcher.mjs');
  const cwd = join(installed, 'runtime'), entry = join(cwd, 'web/scripts/publication-operator.ts');
  const configPath = join(installed, 'config.json'), manifest = join(cwd, 'runtime.json');
  write(manifest, JSON.stringify({ version: 1, commit: RUNTIME_SHA }));
  write(entry, '// Native-path trust fixture; module under test is imported through Vitest.\n');
  copyFileSync(join(ROOT, 'scripts/publication-launcher.mjs'), launcher); chmodSync(launcher, 0o700);
  write(join(installed, 'known_hosts'), '# fixture\n');
  const config = { canonicalRepository: join(f.temp, 'canonical-offline.git'), sshTarget: 'deploy@host.test.invalid',
    destinationId: 'prod', deployMode: 'prod', paymentRole: 'stand', actor: 'protected-actor', siteUrl: f.input.origin,
    webRoot: '/var/www/ikpk', knownHostsFile: join(installed, 'known_hosts'), keepReleases: 5, chatLoaderSrc: 'none',
    payment: { endpoint: 'https://payment.test.invalid', mode: 'test', shopId: '1440249', siteOrigin: f.input.origin } };
  const saveConfig = () => write(configPath, JSON.stringify(config)); saveConfig();
  const env: Record<string, string | undefined> = { PUBLICATION_CONFIG: configPath, PUBLICATION_LAUNCHER: launcher,
    PUBLICATION_RUNTIME_SHA: RUNTIME_SHA, PUBLICATION_DESTINATION_ID: 'prod', DEPLOY_MODE: 'prod',
    SSH_AUTH_SOCK: join(f.temp, CANARY), GH_TOKEN: CANARY, CMS_TOKEN: CANARY, CMS_URL: 'https://cms.offline.invalid',
    NODE_OPTIONS: '--import=evil.mjs', SNAPSHOT_SOURCE: 'pinned', CONTENT_SNAPSHOT_DIR: '/evil/snapshot',
    PUBLICATION_WORKER: '/evil/worker.ts', PUBLICATION_REPORT: '/evil/report.json', PATH: process.env.PATH, HOME: f.temp };
  const argv = ['rollback', '--release-id', f.input.releaseId, '--confirm', '--reason', f.input.reason];
  const stateFactory = vi.fn((options: { gitEnv: Record<string, string>; remote: string }) => { void options; return f.ports.state; });
  const transport = vi.fn((options: { authorize: RollbackAuthorizer }) => f.ports.createTransport(options));
  const contexts: RollbackCheckContext[] = [];
  function check(name: string) { return vi.fn(async (context: RollbackCheckContext) => {
    expect(f.state.locked, `${name} must execute while retained bytes are locked`).toBe(true);
    expect(context.treeDir).toBe(realpathSync(f.treeDir)); contexts.push(context); return { conclusion: 'success' as const, executedTests: 3 };
  }); }
  const adapterPorts = { checkDestination: check('destination'), checkBrowser: check('browser'), checkPaymentAbsent: check('absent'),
    checkPaymentReadiness: check('readiness'), checkPaymentPreflight: check('preflight'), digest: vi.fn(async (path: string) => fixtureDigest(path)) };
  const adapters = vi.fn((options: { webRoot: string; treeDir: string }, overrides?: object) => { void options; void overrides; return adapterPorts; });
  const forbidden = vi.fn(() => { throw new Error('forbidden fresh CMS/main/CI/build effect'); });
  const subprocesses: { file: string; args: string[] }[] = [];
  const moduleLoads: string[] = [];
  vi.doMock('tsx/esm/api', async () => { moduleLoads.push('dependencies'); return vi.importActual('tsx/esm/api'); });
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return { ...actual, execFileSync(file: string, args: string[], options: object) {
      subprocesses.push({ file, args });
      // The one permitted Git operation detects a repository; no remote, revision or installation query.
      if (file === '/usr/bin/git' && args.includes('rev-parse') && args.includes('--absolute-git-dir')) return actual.execFileSync(file, args, options);
      throw new Error('installed rollback may not run npm, main fetch or source execution');
    }, spawnSync: forbidden, spawn: forbidden };
  });
  vi.doMock('../scripts/lib/publication-state-store.ts', () => { moduleLoads.push('state'); return { createPublicationStateStore: stateFactory }; });
  vi.doMock('../../scripts/publication-transport.mjs', () => { moduleLoads.push('transport'); return { createSshTransport: transport }; });
  vi.doMock('../scripts/lib/publication-check-adapters.ts', () => { moduleLoads.push('checks'); return { createRollbackCheckPorts: adapters, createPublicationCheckPorts: forbidden }; });
  vi.doMock('../scripts/lib/publication-ci.ts', () => ({ readCiEvidence: forbidden }));
  vi.doMock('../scripts/lib/publication-snapshot.ts', () => ({ readPublicationSnapshot: forbidden }));
  vi.stubGlobal('fetch', f.ports.fetch);
  // Resolve implementation OUTSIDE rejects, so missing code cannot satisfy a refusal test.
  let run: (args?: string[]) => Promise<import('./helpers/publication-rollback-fixture.ts').RollbackOperation> = async () => { throw new Error('fixture-only: operator not loaded'); };
  if (loadOperator) {
    expect(existsSync(OPERATOR), 'concrete fixed installed operator must exist').toBe(true);
    const module = await import(/* @vite-ignore */ OPERATOR);
    expect(module.runPublicationOperator).toBeTypeOf('function');
    run = (args = argv) => module.runPublicationOperator({ argv: args, env, cwd });
  }
  return { ...f, cwd, config, configPath, manifest, entry, env, argv, stateFactory, transport, adapters, adapterPorts,
    contexts, forbidden, subprocesses, moduleLoads, saveConfig, run };
}

describe('fixed installed rollback operator binds real coordinator and retained checks', () => {
  it('fixture positive control executes real rollback coordinator and real three-group checks to index append', async () => {
    const f = await fixture(false);
    const { runPublicationRollback } = await import('../scripts/lib/publication-rollback.ts');
    const { runRollbackChecks } = await import('../scripts/lib/publication-rollback-checks.ts');
    const result = await runPublicationRollback(f.input, { ...f.ports, runChecks: (input) => runRollbackChecks({ ...input,
      reportPath: join(f.temp, 'control-report.json'), env: {} }, f.adapterPorts) });
    expect(f.appended).toEqual([result]); expect(result.rollbackChecks.groups).toHaveLength(3);
    expect(f.contexts).toHaveLength(3); expect(f.events.map(({ name }) => name)).toContain('switch');
  });
  it('restores indexed retained bytes, uses stored payment role and appends a new immutable rollback operation', async () => {
    const f = await fixture(); const original = structuredClone(f.original); const result = await f.run();
    expect(result).toMatchObject({ commit: original.commit, releaseId: original.releaseId, treeDigest: original.treeDigest,
      actor: f.config.actor, reason: f.input.reason, rollbackOfPublicationId: original.publicationId, paymentRole: 'ci', deployMode: 'prod' });
    expect(result.publicationId).not.toBe(original.publicationId); expect(f.appended).toEqual([result]); expect(f.original).toEqual(original);
    expect(f.state.currentReleaseId).toBe(original.releaseId); expect(f.state.pending).toBeUndefined();
    expect(result.rollbackChecks.groups).toEqual(['destination-mode', 'browser-smoke', 'payment-destination'].map((name) => ({ name, conclusion: 'success', executedTests: 3 })));
    expect(f.stateFactory).toHaveBeenCalledWith(expect.objectContaining({ remote: f.config.canonicalRepository }));
    expect(f.transport).toHaveBeenCalledWith(expect.objectContaining({ host: 'host.test.invalid', user: 'deploy', root: f.config.webRoot,
      knownHostsFile: f.config.knownHostsFile, destinationId: 'prod', authorize: expect.any(Function) }));
    expect(f.adapters).toHaveBeenCalledTimes(1);
    expect(f.adapters.mock.calls[0][0]).toMatchObject({ webRoot: join(f.cwd, 'web'), treeDir: f.treeDir });
    expect(f.adapterPorts.checkPaymentAbsent).toHaveBeenCalledTimes(1);
    expect(f.adapterPorts.checkPaymentReadiness).not.toHaveBeenCalled(); expect(f.adapterPorts.checkPaymentPreflight).not.toHaveBeenCalled();
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.subprocesses.every(({ file, args }) => file === '/usr/bin/git' && args.includes('--absolute-git-dir'))).toBe(true);
    expect(f.events.map(({ name }) => name)).toContain('switch');
    expect(f.state.requests.map((url) => new URL(url).origin)).toEqual([f.config.siteUrl, f.config.siteUrl]);
  });

  it('active stored role probes readiness once inside the existing retained lock', async () => {
    const f = await fixture(); f.original.paymentRole = 'stand';
    let locks = 0;
    const probe = vi.fn(async () => {
      expect(f.state.locked).toBe(true);
      return { status: 200, contentType: 'application/json', body: { status: 'ready', mode: 'test', shopId: '1440249' } };
    });
    f.transport.mockImplementation((options) => {
      const transport = f.ports.createTransport(options);
      return { async withLock(callback) {
        expect(++locks, 'rollback readiness must reuse the retained lock').toBe(1);
        return transport.withLock((session) => {
          const readySession = { ...session, paymentReadiness: probe };
          return callback(readySession);
        });
      } };
    });
    f.adapters.mockImplementation((_options, overrides) => ({ ...f.adapterPorts,
      checkPaymentReadiness: vi.fn(async (context: RollbackCheckContext) => {
        expect(overrides).toMatchObject({ paymentReadiness: expect.any(Function) });
        const response = await (overrides as { paymentReadiness(): Promise<unknown> }).paymentReadiness();
        expect(response).toMatchObject({ status: 200, body: { mode: 'test', shopId: '1440249' } });
        return f.adapterPorts.checkPaymentReadiness(context);
      }),
    }));
    const result = await f.run();
    expect(result.paymentRole).toBe('stand'); expect(locks).toBe(1); expect(probe).toHaveBeenCalledTimes(1);
    expect(f.adapterPorts.checkPaymentPreflight).toHaveBeenCalledTimes(1); expect(f.appended).toHaveLength(1);
  });

  it('refuses an active retained role when protected configuration supplies another payment identity', async () => {
    const f = await fixture(); f.original.paymentRole = 'prod';
    await expect(f.run()).rejects.toThrow();
    expect(f.events.map(({ name }) => name)).not.toContain('switch');
    expect(f.adapterPorts.checkPaymentReadiness).not.toHaveBeenCalled(); expect(f.appended).toEqual([]);
  });

  it('keeps broker credentials and caller-controlled snapshot/report/startup inputs out of retained checks', async () => {
    const f = await fixture(); await f.run(); expect(f.contexts).toHaveLength(3);
    for (const context of f.contexts) {
      expect(JSON.stringify(context)).not.toContain(CANARY);
      const env = context.env as Record<string, string>;
      for (const name of ['SSH_AUTH_SOCK', 'GH_TOKEN', 'CMS_TOKEN', 'CMS_URL', 'NODE_OPTIONS', 'PUBLICATION_WORKER', 'PUBLICATION_REPORT', 'CONTENT_SNAPSHOT_DIR', 'SNAPSHOT_SOURCE']) expect(env[name], name).toBeUndefined();
      expect(env.PAYMENT_ROLE).toBe('ci'); expect(env.HOME).not.toBe(f.env.HOME);
    }
    const stateOptions = f.stateFactory.mock.calls[0][0] as unknown as { gitEnv: Record<string, string> };
    expect(stateOptions.gitEnv.SSH_AUTH_SOCK).toBe(f.env.SSH_AUTH_SOCK);
    for (const name of ['CMS_TOKEN', 'CMS_URL', 'NODE_OPTIONS']) expect(stateOptions.gitEnv[name], name).toBeUndefined();
    expect(f.appended).toHaveLength(1);
  });

  it.each(['PUBLICATION_CONFIG', 'PUBLICATION_LAUNCHER', 'PUBLICATION_RUNTIME_SHA'])('missing protected %s refuses before fixed external modules execute', async (name) => {
    const f = await fixture(); delete f.env[name]; await expect(f.run()).rejects.toThrow(); expect(f.moduleLoads).toEqual([]);
    expect(f.stateFactory).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled(); expect(f.adapters).not.toHaveBeenCalled();
  });

  it.each(['manifest', 'writable-config', 'destination', 'origin', 'actor'])('invalid protected %s refuses before state or transport', async (fault) => {
    const f = await fixture();
    if (fault === 'manifest') write(f.manifest, JSON.stringify({ version: 1, commit: 'f'.repeat(40) }));
    if (fault === 'writable-config') chmodSync(f.configPath, 0o666);
    if (fault === 'destination') f.env.PUBLICATION_DESTINATION_ID = 'foreign';
    if (fault === 'origin') { f.config.siteUrl = 'https://site.test.invalid/path'; f.saveConfig(); }
    if (fault === 'actor') { f.config.actor = ' '; f.saveConfig(); }
    await expect(f.run()).rejects.toThrow(); expect(f.moduleLoads).toEqual([]); expect(f.stateFactory).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(['confirmation', 'reason', 'source', 'authorize'])('invalid operator %s cannot bypass fixed rollback', async (fault) => {
    const f = await fixture(); let argv = [...f.argv];
    if (fault === 'confirmation') argv = argv.filter((arg) => arg !== '--confirm');
    if (fault === 'reason') argv[argv.indexOf('--reason') + 1] = ' ';
    if (fault === 'source') argv.push('--source-dir', '/evil/source');
    if (fault === 'authorize') argv.push('--authorize', '/evil/allow.ts');
    await expect(f.run(argv)).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled(); expect(f.adapters).not.toHaveBeenCalled();
  });

  it('unindexed target never opens retained transport even if caller supplies old evidence', async () => {
    const f = await fixture(); f.history.splice(0, 1); f.env.PUBLICATION_REPORT = JSON.stringify(f.original);
    await expect(f.run()).rejects.toThrow(/verified|original|retained/i); expect(f.transport).not.toHaveBeenCalled(); expect(f.appended).toEqual([]);
  });

  it('real retained-check failure stops before rollback and durable index append', async () => {
    const f = await fixture(); f.adapterPorts.checkBrowser.mockResolvedValueOnce({ conclusion: 'success', executedTests: 0 });
    await expect(f.run()).rejects.toThrow(); expect(f.adapterPorts.checkBrowser).toHaveBeenCalledTimes(1);
    expect(f.events.map(({ name }) => name)).not.toContain('switch'); expect(f.appended).toEqual([]);
  });
});

describe('builtin rollback audit producer', () => {
  it('curates the selected original pair and counts fresh rollback groups instead of original full publication groups', async () => {
    const f = rollbackFixture(); cleanups.push(f.clean);
    const { createWorkerAudit } = await import('../scripts/publication-worker.ts');
    const operation = { ...f.original, snapshotId: `snap:${'b'.repeat(64)}`, publicationId: 'new-rollback-operation',
      rollbackOfPublicationId: f.original.publicationId, reason: CANARY, rollbackChecks: f.report };
    const audit = createWorkerAudit({ operation });
    expect(audit).toMatchObject({ version: 1, status: 'success', code: 'rolled-back', commit: f.original.commit,
      releaseId: f.original.releaseId, snapshotId: operation.snapshotId, treeDigest: f.original.treeDigest,
      publicationId: operation.publicationId, revision: 7, localExecutedTests: 9, ciExecutedTests: 51 });
    expect(JSON.stringify(audit)).not.toContain(CANARY);
    expect(audit.commit).not.toBe(RUNTIME_SHA);
  });

  it('native operator without protected context emits one curated fd3 refusal before loading dependencies', async () => {
    expect(existsSync(OPERATOR), 'concrete fixed installed operator must exist').toBe(true);
    const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const result = spawnSync(process.execPath, [OPERATOR, 'rollback', '--release-id', 'retained-release', '--confirm', '--reason', CANARY], {
      cwd: ROOT, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout + result.stderr).toBe('');
    expect(JSON.parse(String(result.output[3]))).toEqual({ version: 1, status: 'refused', code: 'rollback-failed' });
  });
});
