import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const config = { payment: undefined as undefined | { endpoint: string; mode: string; shopId: string; siteOrigin: string; readinessUrl?: string }, canonicalRepository: remote, sshTarget: 'deploy@stand.test.invalid', destinationId: 'stand', deployMode: 'stand',
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
  const remoteProbe = vi.fn(async () => ({ status: 200, contentType: 'application/json', body: { status: 'ready', mode: config.payment?.mode, shopId: config.payment?.shopId } }));
  const readinessValues: unknown[] = []; const events: string[] = [];
  const checkPorts = { marker: 'fixed adapter ports' };
  const adapters = vi.fn((options: Record<string, unknown>, runtime?: { paymentReadiness?: () => Promise<unknown> }) => { void options; void runtime; return checkPorts; });
  const checks = vi.fn(async (input: { treeDir: string; commit: string; destinationId: string }, ports: unknown) => {
    expect(ports).toBe(checkPorts);
    if (config.paymentRole !== 'ci') {
      const runtime = adapters.mock.calls.at(-1)?.[1];
      expect(runtime?.paymentReadiness, 'worker must bind a fixed remote readiness callback').toBeTypeOf('function');
      readinessValues.push(await runtime!.paymentReadiness!());
    }
    const options = adapters.mock.calls.at(-1)?.[0] as unknown as { snapshotDir: string };
    write(join(options.snapshotDir, 'snapshot.json'), JSON.stringify(snapshot));
    write(join(input.treeDir, 'index.html'), '<main>checked artifact</main>');
    write(join(input.treeDir, 'release.json'), JSON.stringify({ commit, snapshotId: snapshot.snapshotId }));
    return { commit: input.commit, destinationId: input.destinationId, snapshotId: snapshot.snapshotId,
      treeDigest: await digestTree(input.treeDir, ['index.html', 'release.json']),
      groups: PUBLICATION_GROUPS.map((name) => ({ name, conclusion: 'success', executedTests: 2 })) };
  });
  const stage = vi.fn(async () => { events.push('stage'); });
  const activate = vi.fn(async (input: { beforeActivate(): Promise<void>; recordIndex(record: unknown): Promise<void>; operation: unknown }) => {
    events.push('activate'); await input.beforeActivate(); await input.recordIndex(input.operation);
  });
  const proofs: { action: string; proof: unknown; options: Record<string, unknown> }[] = [];
  const transport = vi.fn((options: { authorize(request: unknown): Promise<unknown> } & Record<string, unknown>) => ({
    async withLock(callback: (session: unknown) => Promise<unknown>) {
      const proof = await options.authorize({ action: 'connect', destinationId: config.destinationId });
      proofs.push({ action: 'connect', proof, options });
      return callback({ stage, activate, async paymentReadiness(...args: unknown[]) {
        expect(args).toEqual([]);
        const proof = await options.authorize({ action: 'payment-readiness', destinationId: config.destinationId });
        proofs.push({ action: 'payment-readiness', proof, options });
        events.push('readiness'); return remoteProbe();
      } });
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
    stage, activate, transport, installs, saveConfig, run, remoteProbe, proofs, events, readinessValues };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); for (const path of tempRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });

// Worker binding and source-only authorization are the subject here. The sibling
// files exercise the actual adapter and the actual readiness assertion subprocess.
function active(f: Awaited<ReturnType<typeof fixture>>, role: 'stand' | 'prod') {
  f.config.paymentRole = role;
  f.config.payment = { endpoint: 'https://payments.test.invalid/api', mode: role === 'prod' ? 'prod' : 'test', shopId: role === 'prod' ? '409285' : '1440249', siteOrigin: f.config.siteUrl };
  f.saveConfig();
}
describe('concrete worker binds readiness to the publication destination SSH transport', () => {
  it.each(['stand', 'prod'] as const)('%s needs no readiness URL and probes once before any staging or activation', async (role) => {
    const f = await fixture(); active(f, role); await f.run();
    expect(f.remoteProbe).toHaveBeenCalledExactlyOnceWith();
    expect(f.events).toEqual(['readiness', 'stage', 'activate']);
    expect(f.readinessValues).toEqual([{ status: 200, contentType: 'application/json', body: { status: 'ready', mode: f.config.payment!.mode, shopId: f.config.payment!.shopId } }]);
    expect(f.state.appendPublication).toHaveBeenCalledTimes(1);
    for (const [options] of f.transport.mock.calls) expect(options).toMatchObject({ host: 'stand.test.invalid', user: 'deploy', root: '/var/www/ikpk', destinationId: 'stand', knownHostsFile: f.config.knownHostsFile });
    const probe = f.proofs.find((entry) => entry.action === 'payment-readiness')!;
    expect(probe.proof).toEqual({ commit: f.commit, destinationId: 'stand' });
    const authorize = probe.options.authorize as (input: unknown) => Promise<unknown>;
    for (const action of ['stage', 'activate', 'recover', 'rollback']) {
      await expect(authorize({ action, destinationId: 'stand', expectedDigest: 'a'.repeat(64) })).rejects.toThrow();
    }
  });

  it.each(['stand', 'prod'] as const)('%s rejects an incorrect mode or shop before dependency installation', async (role) => {
    const f = await fixture(); active(f, role);
    f.config.payment!.mode = role === 'stand' ? 'prod' : 'test'; f.saveConfig();
    await expect(f.run()).rejects.toThrow('untrusted-config');
    active(f, role); f.config.payment!.shopId = '9999999'; f.saveConfig();
    await expect(f.run()).rejects.toThrow('untrusted-config');
    expect(f.installs).toHaveLength(0); expect(f.transport).not.toHaveBeenCalled();
  });

  it('does not use obsolete config or environment URLs to select the remote probe', async () => {
    const f = await fixture(); active(f, 'stand');
    f.config.payment!.readinessUrl = 'https://operator.invalid/not-the-vps'; f.saveConfig();
    f.env.PUBLICATION_PAYMENT_READY_URL = 'https://operator.invalid/not-the-vps'; await f.run();
    expect(f.remoteProbe).toHaveBeenCalledExactlyOnceWith(); expect(f.events).toEqual(['readiness', 'stage', 'activate']);
    for (const [options] of f.transport.mock.calls) expect(JSON.stringify(options)).not.toContain('operator.invalid');
  });

  it('remote probe failure prevents staging, activation and durable publication recording', async () => {
    const f = await fixture(); active(f, 'stand');
    // Keep the obsolete field here so RED must be a missing probe, not config rejection.
    f.config.payment!.readinessUrl = 'https://operator.invalid/readyz'; f.saveConfig();
    f.remoteProbe.mockRejectedValueOnce(new Error('remote-readiness-unavailable'));
    await expect(f.run()).rejects.toThrow(); expect(f.remoteProbe).toHaveBeenCalledTimes(1);
    expect(f.stage).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(f.state.appendPublication).not.toHaveBeenCalled();
  });

  it('ci payment with production CRM stays usable with zero readiness probes or payment API requests', async () => {
    const f = await fixture(); f.config.deployMode = 'prod'; f.env.DEPLOY_MODE = 'prod'; f.saveConfig(); await f.run();
    expect(f.remoteProbe).not.toHaveBeenCalled(); expect(f.proofs.some((entry) => entry.action === 'payment-readiness')).toBe(false);
    expect(f.stage).toHaveBeenCalledTimes(1); expect(f.activate).toHaveBeenCalledTimes(1);
    expect(f.state.appendPublication).toHaveBeenCalledWith(expect.objectContaining({ deployMode: 'prod', paymentRole: 'ci' }));
    // Fixture fetch above permits only site-origin serving verification.
  });
});
