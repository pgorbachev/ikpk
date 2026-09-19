import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync, type ExecFileSyncOptions } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentFingerprint, snapshotId } from '../scripts/lib/content-snapshot.ts';
import { PUBLICATION_CI_POLICY, PUBLICATION_GROUPS } from '../scripts/lib/publish-gate.ts';
import { digestTree } from '../../scripts/publication-launcher.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CANARY = 'worker-secret-canary-688ef4';
const tempRoots: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), 'ikpk-worker-')); tempRoots.push(path); return path; }
const gitEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Worker test', GIT_AUTHOR_EMAIL: 'worker@example.invalid', GIT_COMMITTER_NAME: 'Worker test', GIT_COMMITTER_EMAIL: 'worker@example.invalid' };
function git(cwd: string, ...args: string[]) { return execFileSync('/usr/bin/git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function write(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }

// No runner/authorizer substitution: the real runner consumes these effect-boundary
// doubles. A successful control must reach stage, activation and the durable index.
async function fixture() {
  const temp = temporary(); const cwd = join(temp, 'checkout'); const remote = join(temp, 'canonical.git');
  const protectedDir = join(temp, 'protected'); const launcher = join(protectedDir, 'publication-launcher.mjs');
  const configPath = join(protectedDir, 'config.json'); const knownHostsFile = join(protectedDir, 'known_hosts');
  write(join(cwd, 'web/package.json'), '{"private":true}'); write(join(cwd, 'web/package-lock.json'), '{}');
  git(cwd, 'init', '--initial-branch=main'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'fixture canonical source');
  git(temp, 'clone', '--bare', cwd, remote); git(cwd, 'remote', 'add', 'origin', remote);
  const commit = git(cwd, 'rev-parse', 'HEAD');
  mkdirSync(protectedDir); copyFileSync(join(ROOT, 'scripts/publication-launcher.mjs'), launcher); chmodSync(launcher, 0o700);
  write(knownHostsFile, 'fixture-host-key\n');
  const config = { canonicalRepository: remote, sshTarget: 'deploy@stand.test.invalid', destinationId: 'stand', deployMode: 'stand',
    paymentRole: 'ci', siteUrl: 'https://stand.test.invalid', actor: 'operator@example.invalid', webRoot: '/var/www/ikpk',
    knownHostsFile, keepReleases: 5, chatLoaderSrc: 'none', credentialBroker: [process.execPath, join(protectedDir, 'broker.mjs')] };
  function saveConfig() { write(configPath, JSON.stringify(config)); chmodSync(configPath, 0o600); }
  saveConfig();
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: temp, DEPLOY_MODE: config.deployMode,
    PUBLICATION_CONFIG: configPath, PUBLICATION_LAUNCHER: launcher, PUBLICATION_SOURCE_SHA: commit, PUBLICATION_DESTINATION_ID: 'stand',
    GH_TOKEN: CANARY, CMS_TOKEN: CANARY, CMS_URL: 'https://cms.test.invalid', SSH_AUTH_SOCK: join(protectedDir, CANARY),
    SSH_KEY: CANARY, IKPK_SECRET: CANARY, NODE_OPTIONS: '--import=evil.mjs', NPM_CONFIG_USERCONFIG: '/unsafe/npmrc',
    SNAPSHOT_SOURCE: 'pinned', CONTENT_SNAPSHOT_DIR: '/unsafe/snapshot', PUBLICATION_REPORT: '/unsafe/report.json' };
  const content = { types: { articles: [{ slug: 'article', title: 'Captured article' }] }, media: [] };
  const fingerprint = contentFingerprint(content);
  const snapshot = { content, fingerprint, referenceDate: '2026-09-19', snapshotId: snapshotId({ fingerprint, referenceDate: '2026-09-19' }),
    origin: { kind: 'live', url: env.CMS_URL, capturedAt: new Date().toISOString() }, provenance: { observedEntry: 1, revision: 1, highWaterMark: 1 } };
  const evidence = { repository: PUBLICATION_CI_POLICY.repository, workflow: PUBLICATION_CI_POLICY.workflow, branch: 'main', commit,
    event: 'push', runId: 800, conclusion: 'success', executedTests: 37,
    jobs: PUBLICATION_CI_POLICY.requiredJobs.map((name) => ({ name, conclusion: 'success' })) };
  const state = { read: vi.fn(async () => ({ head: commit, entries: [{ number: 1, previous: null, fingerprint, marker: 'edit' }],
    observation: { observedEntry: 1, revision: 1, highWaterMark: 1, requiresConfirmation: false }, publications: [] })),
    readHistory: vi.fn(async () => ({ head: commit, publications: [] })),
    appendPublication: vi.fn(async () => ({ head: commit, changed: true })) };
  const ci = vi.fn(async () => evidence);
  const stateFactory = vi.fn((options: { workDir: string }) => { void options; return state; });
  const checkPorts = { marker: 'fixed adapter ports' };
  const adapters = vi.fn((options: Record<string, unknown>) => { void options; return checkPorts; });
  const checks = vi.fn(async (input: { treeDir: string; commit: string; destinationId: string }, ports: unknown) => {
    expect(ports).toBe(checkPorts);
    const options = adapters.mock.calls.at(-1)?.[0] as unknown as { snapshotDir: string };
    write(join(options.snapshotDir, 'snapshot.json'), JSON.stringify(snapshot));
    write(join(input.treeDir, 'index.html'), '<main>checked artifact</main>');
    write(join(input.treeDir, 'release.json'), JSON.stringify({ commit, snapshotId: snapshot.snapshotId }));
    return { commit: input.commit, destinationId: input.destinationId, snapshotId: snapshot.snapshotId,
      treeDigest: await digestTree(input.treeDir, ['index.html', 'release.json']),
      groups: PUBLICATION_GROUPS.map((name) => ({ name, conclusion: 'success', executedTests: 2 })) };
  });
  const stage = vi.fn(async () => {});
  const activate = vi.fn(async (input: { beforeActivate(): Promise<void>; recordIndex(record: unknown): Promise<void>; operation: unknown }) => {
    await input.beforeActivate(); await input.recordIndex(input.operation);
  });
  const transport = vi.fn((options: { authorize(request: unknown): Promise<unknown> }) => ({
    async withLock(callback: (session: unknown) => Promise<unknown>) {
      await options.authorize({ action: 'connect', destinationId: config.destinationId });
      return callback({ stage, activate });
    },
  }));
  const installs: { file: string; args: string[]; options: ExecFileSyncOptions }[] = [];
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return { ...actual, execFileSync(file: string, args: string[], options: ExecFileSyncOptions) {
      if (/^npm(?:\.cmd)?$/.test(basename(file))) { installs.push({ file, args, options }); return ''; }
      return actual.execFileSync(file, args, options);
    } };
  });
  vi.doMock('../scripts/lib/publication-ci.ts', () => ({ readCiEvidence: ci }));
  vi.doMock('../scripts/lib/publication-state-store.ts', async () => ({
    ...await vi.importActual('../scripts/lib/publication-state-store.ts'), createPublicationStateStore: stateFactory,
  }));
  vi.doMock('../scripts/lib/publication-check-adapters.ts', () => ({ createPublicationCheckPorts: adapters }));
  vi.doMock('../scripts/lib/publication-checks.ts', () => ({ runPublicationChecks: checks }));
  vi.doMock('../../scripts/publication-transport.mjs', () => ({ createSshTransport: transport }));
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const parsed = new URL(url); expect(parsed.origin).toBe(config.siteUrl);
    return new Response(parsed.pathname === '/release.json' ? JSON.stringify({ commit, snapshotId: snapshot.snapshotId }) : '<main>live</main>', { status: 200 });
  }));
  // Assert outside rejection checks so an absent worker cannot satisfy a refusal test.
  const path = join(ROOT, 'web/scripts/publication-worker.ts');
  expect(existsSync(path), 'concrete publication worker must exist').toBe(true);
  async function run(argv = [config.sshTarget]) {
    const { runPublicationWorker } = await import(/* @vite-ignore */ path);
    return runPublicationWorker({ argv, env, cwd });
  }
  return { temp, cwd, config, configPath, launcher, env, commit, snapshot, evidence, state, ci, stateFactory, adapters, checks,
    stage, activate, transport, installs, saveConfig, run };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); for (const path of tempRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('concrete publication worker integration', () => {
  it('binds the real runner to fixed CI, state, check and transport modules and reaches index recording', async () => {
    const f = await fixture(); await f.run();
    expect(f.ci).toHaveBeenCalledWith(expect.objectContaining({ commit: f.commit, token: CANARY }));
    expect(f.stateFactory).toHaveBeenCalledWith(expect.objectContaining({ remote: f.config.canonicalRepository }));
    expect(f.adapters).toHaveBeenCalledTimes(1); expect(f.checks).toHaveBeenCalledTimes(1);
    expect(f.adapters.mock.calls[0][0].ledgerDir).toBe(join(f.stateFactory.mock.calls[0][0].workDir, 'ledger'));
    expect(f.transport).toHaveBeenCalledWith(expect.objectContaining({ host: 'stand.test.invalid', user: 'deploy', root: '/var/www/ikpk',
      destinationId: 'stand', knownHostsFile: f.config.knownHostsFile, authorize: expect.any(Function) }));
    expect(f.stage).toHaveBeenCalledTimes(1); expect(f.activate).toHaveBeenCalledTimes(1); expect(f.state.appendPublication).toHaveBeenCalledTimes(1);
    expect(f.state.appendPublication).toHaveBeenCalledWith(expect.objectContaining({ commit: f.commit, snapshotId: f.snapshot.snapshotId, paymentRole: 'ci', deployMode: 'stand' }));
  });

  it('dependency installation and build/check inputs do not inherit credentials or startup hooks', async () => {
    const f = await fixture(); await f.run();
    expect(f.installs.length).toBeGreaterThan(0);
    expect(f.installs.some(({ args }) => args.includes('ci'))).toBe(true);
    for (const { args, options } of f.installs) {
      expect(JSON.stringify(args)).not.toContain(CANARY);
      expect(options.env, 'an explicit child environment is required').toBeDefined();
      expect(JSON.stringify(options.env)).not.toContain(CANARY);
      for (const name of ['NODE_OPTIONS', 'NPM_CONFIG_USERCONFIG', 'SSH_AUTH_SOCK', 'SSH_KEY', 'GH_TOKEN', 'CMS_TOKEN', 'IKPK_SECRET', 'SNAPSHOT_SOURCE', 'CONTENT_SNAPSHOT_DIR']) {
        expect(options.env?.[name], name).toBeUndefined();
      }
      expect(options.env?.HOME).not.toBe(f.env.HOME);
    }
    const input = f.checks.mock.calls[0][0] as unknown as { env?: Record<string, string> };
    expect(JSON.stringify(input.env ?? {})).not.toContain(CANARY);
    expect(input.env?.SNAPSHOT_SOURCE).toBeUndefined();
    expect(f.adapters).toHaveBeenCalledWith(expect.objectContaining({ captureEnv: expect.objectContaining({ CMS_TOKEN: CANARY }) }),
      expect.objectContaining({ paymentReadiness: expect.any(Function) }));
    const captureEnv = f.adapters.mock.calls[0][0].captureEnv as Record<string, string>;
    for (const name of ['GH_TOKEN', 'SSH_AUTH_SOCK', 'SSH_KEY', 'IKPK_SECRET', 'NODE_OPTIONS', 'SNAPSHOT_SOURCE']) expect(captureEnv[name], name).toBeUndefined();
    expect(f.stage).toHaveBeenCalledTimes(1); // Nonvacuous: publication remained usable.
  });

  it('CI read failure stops before local checks or transfer even with a supplied success report', async () => {
    const f = await fixture(); f.ci.mockRejectedValueOnce(new Error('no-successful-mandatory-main-run'));
    f.env.PUBLICATION_REPORT = JSON.stringify({ conclusion: 'success', executedTests: 100 });
    await expect(f.run()).rejects.toThrow('no-successful-mandatory-main-run');
    expect(f.ci).toHaveBeenCalledTimes(1); expect(f.checks).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(['PUBLICATION_CONFIG', 'PUBLICATION_LAUNCHER', 'PUBLICATION_SOURCE_SHA'] as const)('missing %s fails before install or transfer', async (name) => {
    const f = await fixture(); delete f.env[name]; await expect(f.run()).rejects.toThrow();
    expect(f.installs).toHaveLength(0); expect(f.ci).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(['source', 'destination', 'target', 'writable-config'])('%s inconsistency fails before install or transfer', async (fault) => {
    const f = await fixture();
    if (fault === 'source') f.env.PUBLICATION_SOURCE_SHA = 'f'.repeat(40);
    if (fault === 'destination') f.env.PUBLICATION_DESTINATION_ID = 'foreign';
    if (fault === 'writable-config') chmodSync(f.configPath, 0o666);
    await expect(f.run(fault === 'target' ? ['deploy@foreign.test.invalid'] : undefined)).rejects.toThrow();
    expect(f.installs).toHaveLength(0); expect(f.ci).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });

  it('CLI cannot replace fixed checks with operator reports or an authorization module', async () => {
    const f = await fixture();
    await expect(f.run([f.config.sshTarget, '--report', '/tmp/green.json', '--authorize', '/tmp/approve.mjs'])).rejects.toThrow();
    expect(f.installs).toHaveLength(0); expect(f.transport).not.toHaveBeenCalled();
  });

  it('production CRM preserves the explicitly independent ci payment role', async () => {
    const f = await fixture(); f.config.deployMode = 'prod'; f.env.DEPLOY_MODE = 'prod'; f.saveConfig(); await f.run();
    expect(f.state.appendPublication).toHaveBeenCalledWith(expect.objectContaining({ deployMode: 'prod', paymentRole: 'ci' }));
  });

  it('uses the configured public site origin independently of the SSH target', async () => {
    const f = await fixture(); f.config.siteUrl = 'https://public-site.test.invalid'; f.saveConfig();
    await f.run();
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.origin === f.config.siteUrl)).toBe(true);
    expect(f.stage).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '', 'not-a-url', 'https://public.test.invalid/path'])('refuses invalid site origin %s before install or transport', async (siteUrl) => {
    const f = await fixture();
    if (siteUrl === undefined) delete (f.config as Partial<typeof f.config>).siteUrl;
    else f.config.siteUrl = siteUrl;
    f.saveConfig();
    await expect(f.run()).rejects.toThrow();
    expect(f.installs).toHaveLength(0); expect(f.transport).not.toHaveBeenCalled();
  });
});

describe('deploy-web.sh executable entrypoint', () => {
  it('writes one curated fd3 refusal from the real native worker CLI', () => {
    const temp = temporary();
    const result = spawnSync(process.execPath, [join(ROOT, 'web/scripts/publication-worker.ts')], {
      cwd: ROOT, env: { PATH: process.env.PATH, HOME: temp, PUBLICATION_SOURCE_SHA: 'a'.repeat(40) },
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toBe('');
    expect(JSON.parse(String(result.output[3]))).toEqual({ version: 1, status: 'refused', code: 'publication-failed', commit: 'a'.repeat(40) });
  });
  it('shell dispatches the fixed native Node worker before dependency installation', () => {
    const temp = temporary(); const bin = join(temp, 'bin'); const trace = join(temp, 'node-args'); const npmTrace = join(temp, 'npm-called');
    write(join(bin, 'node'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${trace}'\nexit 73\n`); chmodSync(join(bin, 'node'), 0o700);
    write(join(bin, 'npm'), `#!/bin/sh\nprintf called > '${npmTrace}'\nexit 73\n`); chmodSync(join(bin, 'npm'), 0o700);
    const result = spawnSync('/bin/bash', [join(ROOT, 'scripts/deploy-web.sh'), 'deploy@stand.test.invalid'], {
      cwd: ROOT, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: temp, DEPLOY_MODE: 'stand' }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(73);
    expect(existsSync(npmTrace), 'shell must not install with ambient credentials').toBe(false);
    expect(existsSync(trace), 'fixed worker invocation must be observed').toBe(true);
    const args = readFileSync(trace, 'utf8').trim().split('\n');
    expect(args).toContain(join(ROOT, 'web/scripts/publication-worker.ts'));
    expect(args.at(-1)).toBe('deploy@stand.test.invalid');
    expect(args).not.toContain('--import'); // tsx is installed by the builtin-only bootstrap.
  });

  it('direct invocation without protected launcher context refuses before executing npm', () => {
    const temp = temporary(); const bin = join(temp, 'bin'); const trace = join(temp, 'npm-called');
    write(join(bin, 'npm'), `#!/bin/sh\nprintf called > '${trace}'\nexit 73\n`); chmodSync(join(bin, 'npm'), 0o700);
    const result = spawnSync('/bin/bash', [join(ROOT, 'scripts/deploy-web.sh'), 'stand.test.invalid'], {
      cwd: ROOT, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: temp, DEPLOY_MODE: 'stand', PAYMENT_ROLE: 'ci' },
      encoding: 'utf8', timeout: 15_000,
    });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0);
    expect(existsSync(trace), 'untrusted direct worker must not install dependencies').toBe(false);
  });
});

// Fixed CLI producer: caller-controlled log strings are never audit records.
async function auditFor(input: { operation?: unknown; error?: unknown }) {
  const path = join(ROOT, 'web/scripts/publication-worker.ts');
  const worker = await import(/* @vite-ignore */ path);
  expect(worker.createWorkerAudit, 'builtin-only worker audit curator must exist').toBeTypeOf('function');
  return worker.createWorkerAudit(input);
}
async function failure(run: () => Promise<unknown>) {
  try { await run(); } catch (error) { expect(error).toBeInstanceOf(Error); return error; }
  throw new Error('fixture unexpectedly published; expected a real runner refusal');
}
describe('worker audit producer preserves only concrete publication evidence', () => {
  it('derives identity, digest and executed counts from the actual successful operation', async () => {
    const f = await fixture(); const operation = await f.run();
    const audit = await auditFor({ operation });
    expect(audit).toMatchObject({ version: 1, status: 'success', code: 'published', commit: f.commit,
      snapshotId: f.snapshot.snapshotId, treeDigest: operation.treeDigest, publicationId: operation.publicationId,
      observedEntry: 1, revision: 1, highWaterMark: 1, localExecutedTests: PUBLICATION_GROUPS.length * 2, ciExecutedTests: 37 });
    expect(JSON.stringify(audit)).not.toContain(CANARY); expect(f.stage).toHaveBeenCalledTimes(1);
  });
  it('keeps zero executed checks distinct from unavailable counts and names the failing fixed group', async () => {
    const f = await fixture(); const original = f.checks.getMockImplementation()!;
    f.checks.mockImplementation(async (...args) => {
      const report = await original(...args);
      return { ...report, groups: report.groups.map((group) => ({ ...group, executedTests: 0 })) };
    });
    const error = await failure(f.run); const audit = await auditFor({ error });
    expect(audit).toMatchObject({ version: 1, status: 'refused', code: 'checks-failed', check: 'snapshot-provenance',
      localExecutedTests: 0, ciExecutedTests: 37 });
    expect(f.checks).toHaveBeenCalledTimes(1); expect(f.transport).not.toHaveBeenCalled();
  });
  it('retains observed/latest entries, revision and high water mark from a real stale-state refusal', async () => {
    const f = await fixture(); const state = await f.state.read();
    state.entries.push({ ...state.entries[0], number: 2, fingerprint: 'different-content' });
    state.observation.highWaterMark = 2; f.state.read.mockResolvedValue(state);
    const error = await failure(f.run); const audit = await auditFor({ error });
    expect(audit).toMatchObject({ version: 1, status: 'refused', code: 'provenance-changed',
      observedEntry: 1, revision: 1, latestEntry: 2, highWaterMark: 2 });
    expect(f.checks).toHaveBeenCalledTimes(1); expect(f.transport).not.toHaveBeenCalled();
  });
  it('reports the already active pair after index failure without serializing its error or cause', async () => {
    const f = await fixture();
    f.activate.mockImplementation(async (input) => {
      await input.beforeActivate();
      throw Object.assign(new Error(`index failure ${CANARY}`, { cause: new Error(CANARY) }), { activeOperation: input.operation });
    });
    const error = await failure(f.run); const audit = await auditFor({ error });
    const operation = f.activate.mock.calls[0][0].operation as { releaseId: string };
    expect(audit).toMatchObject({ version: 1, status: 'refused', code: 'active-unindexed',
      activePair: { commit: f.commit, snapshotId: f.snapshot.snapshotId, releaseId: operation.releaseId } });
    expect(JSON.stringify(audit)).not.toContain(CANARY); expect(f.stage).toHaveBeenCalledTimes(1);
  });
  it('unknown or forged free-text errors yield a generic refusal without invented counts', async () => {
    for (const message of [CANARY, `publication provenance changed: observedEntry=1 revision=1 latestEntry=2 highWaterMark=2 ${CANARY}`]) {
      const audit = await auditFor({ error: new Error(message) });
      expect(audit).toEqual({ version: 1, status: 'refused', code: 'publication-failed' });
    }
  });
});
