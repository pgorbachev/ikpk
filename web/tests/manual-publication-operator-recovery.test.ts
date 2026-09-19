import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger } from '../scripts/lib/provenance-ledger.ts';
import { createPublicationStateStore, type PublicationStateStoreOptions } from '../scripts/lib/publication-state-store.ts';
import { verifyServedPublication } from '../scripts/lib/published-state.ts';
import { rollbackFixture } from './helpers/publication-rollback-fixture.ts';
import type { PublicationRecord } from '../scripts/lib/publish-gate.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OPERATOR = join(ROOT, 'web/scripts/publication-operator.ts');
const SHA = 'c'.repeat(40), CANARY = 'recovery-credential-canary-617a';
const BRANCH = 'state/cms-provenance';
const cleanups: (() => void)[] = [];
function write(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value, { mode: 0o600 }); }
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); for (const clean of cleanups.splice(0)) clean(); });
type AuthRequest = { action: string; destinationId: string; operation?: PublicationRecord };
type Authorize = (request: AuthRequest) => Promise<{ destinationId: string; commit: string; snapshotId?: string; treeDigest?: string }>;
async function fixture(load = true) {
  const f = rollbackFixture(); cleanups.push(f.clean);
  const temp = realpathSync(f.temp), installed = join(temp, 'protected'), cwd = join(installed, 'runtime');
  const launcher = join(installed, 'publication-launcher.mjs'), configPath = join(installed, 'config.json');
  const remote = join(temp, 'state.git'), author = join(temp, 'author');
  const gitEnv = { PATH: process.env.PATH!, HOME: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Recovery fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Recovery fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (where: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: where, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(temp, 'init', '--bare', '--initial-branch=main', remote); mkdirSync(author); git(author, 'init', `--initial-branch=${BRANCH}`);
  const ledger = createLedger({ dir: join(author, 'ledger') });
  await ledger.recordEvent({ fingerprint: 'A', marker: 'initial-migration' });
  await ledger.recordEvent({ fingerprint: 'B', marker: 'edit' });
  await ledger.recordEvent({ fingerprint: 'A', marker: 'restore' });
  write(join(author, 'verified-pairs.json'), '[]\n');
  git(author, 'add', '.'); git(author, 'commit', '-m', 'Shared journal'); git(author, 'remote', 'add', 'origin', remote); git(author, 'push', 'origin', BRANCH);
  const remoteFile = (name: string) => git(temp, '--git-dir', remote, 'show', `${BRANCH}:${name}`);
  const head = () => git(temp, '--git-dir', remote, 'rev-parse', BRANCH);
  const event = async () => { await ledger.recordEvent({ fingerprint: 'C', marker: 'edit' }); git(author, 'add', '.'); git(author, 'commit', '-m', 'Concurrent CMS event'); git(author, 'push', 'origin', BRANCH); };
  write(join(cwd, 'runtime.json'), JSON.stringify({ version: 1, commit: SHA }));
  write(join(cwd, 'web/scripts/publication-operator.ts'), '// trust-path fixture; implementation imported through Vitest\n');
  copyFileSync(join(ROOT, 'scripts/publication-launcher.mjs'), launcher); chmodSync(launcher, 0o700);
  write(join(installed, 'known_hosts'), '# fixture');
  const config = { canonicalRepository: remote, actor: 'protected-operator', destinationId: 'prod', deployMode: 'prod', paymentRole: 'ci',
    sshTarget: 'deploy@host.test.invalid', webRoot: '/var/www/ikpk', siteUrl: 'https://site.test.invalid', knownHostsFile: join(installed, 'known_hosts'), keepReleases: 5, chatLoaderSrc: 'none' };
  write(configPath, JSON.stringify(config));
  const env = { PATH: process.env.PATH, HOME: temp, PUBLICATION_CONFIG: configPath, PUBLICATION_LAUNCHER: launcher,
    PUBLICATION_RUNTIME_SHA: SHA, PUBLICATION_DESTINATION_ID: 'prod', DEPLOY_MODE: 'prod', SSH_AUTH_SOCK: CANARY, GH_TOKEN: CANARY,
    CMS_TOKEN: CANARY, CMS_URL: 'https://unavailable.invalid', PUBLICATION_REPORT: '/untrusted/report', NODE_OPTIONS: '--import=evil.mjs' };
  const operation = { ...structuredClone(f.original), snapshotId: `snap:${'b'.repeat(64)}` };
  operation.localChecks.snapshotId = operation.snapshotId;
  const state = { locked: false, pending: true, prepared: false, servedMismatch: false, appendFailure: false, committingOld: false, substituteRecord: false, probeAuthorization: false };
  const events: string[] = [], appended: PublicationRecord[] = [], auth: Authorize[] = [];
  const realState = createPublicationStateStore({ remote, workDir: join(temp, 'state-control'), gitEnv });
  const stateFactory = vi.fn((options: PublicationStateStoreOptions) => {
    const real = createPublicationStateStore(options);
    return { ...real, async appendPublication(record: PublicationRecord) {
      expect(state.locked).toBe(true); events.push('append');
      if (state.appendFailure) throw new Error(`index write failed ${CANARY}`);
      const result = await real.appendPublication(record); appended.push(structuredClone(record)); return result;
    } };
  });
  const transport = vi.fn((options: { authorize: Authorize }) => {
    auth.push(options.authorize);
    return { async recover({ recordIndex }: { recordIndex(record: PublicationRecord): Promise<void> }) {
      await options.authorize({ action: 'connect', destinationId: 'prod' }); state.locked = true; events.push('lock');
      try {
        if (!state.pending) return { recovered: false };
        if (state.committingOld) throw new Error('pending current release mismatch: manual repair required');
        const proof = await options.authorize({ action: 'recover', destinationId: 'prod', operation });
        expect(proof).toMatchObject({ destinationId: operation.destinationId, commit: operation.commit, snapshotId: operation.snapshotId, treeDigest: operation.treeDigest });
        if (state.probeAuthorization) {
          for (const action of ['stage', 'activate', 'rollback']) await expect(options.authorize({ action, destinationId: 'prod', operation })).rejects.toThrow();
          await expect(options.authorize({ action: 'recover', destinationId: 'foreign', operation })).rejects.toThrow();
          await expect(options.authorize({ action: 'recover', destinationId: 'prod', operation: { ...operation, publicationId: 'substituted' } })).rejects.toThrow();
        }
        if (state.prepared) { state.pending = false; events.push('cancel'); return { recovered: false, cancelled: true, operation }; }
        await recordIndex({ ...structuredClone(operation), ...(state.substituteRecord ? { publicationId: 'substituted' } : {}) }); state.pending = false; events.push('finish');
        return { recovered: true, operation };
      } finally { events.push('unlock'); state.locked = false; }
    } };
  });
  const fetch = vi.fn(async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource)); expect(state.locked).toBe(true); expect(init?.redirect).toBe('manual'); expect(url.origin).toBe(config.siteUrl);
    events.push(url.pathname === '/release.json' ? 'served-pair' : 'health');
    return new Response(url.pathname === '/release.json' ? JSON.stringify({ commit: state.servedMismatch ? 'f'.repeat(40) : operation.commit, snapshotId: operation.snapshotId }) : 'ok', { status: 200 });
  });
  const forbidden = vi.fn(() => { throw new Error('current CMS/main/CI/build must not execute'); });
  let run: (argv: string[]) => Promise<unknown> = async () => { throw new Error('positive control only'); };
  if (load) {
    // Controls use real ports directly and must not leave unconsumed operator mocks.
    vi.doMock('../scripts/lib/publication-state-store.ts', () => ({ createPublicationStateStore: stateFactory }));
    vi.doMock('../../scripts/publication-transport.mjs', () => ({ createSshTransport: transport }));
    vi.doMock('../scripts/lib/publication-ci.ts', () => ({ readCiEvidence: forbidden }));
    vi.doMock('../scripts/lib/publication-snapshot.ts', () => ({ readPublicationSnapshot: forbidden }));
    vi.doMock('../scripts/lib/publication-check-adapters.ts', () => ({ createPublicationCheckPorts: forbidden, createRollbackCheckPorts: forbidden }));
    vi.stubGlobal('fetch', fetch);

    // Outside rejects: missing code cannot pass refusal tests.
    expect(existsSync(OPERATOR), 'fixed installed recovery/accept-state operator must exist').toBe(true);
    const module = await import(/* @vite-ignore */ OPERATOR); expect(module.runPublicationOperator).toBeTypeOf('function');
    run = (argv) => module.runPublicationOperator({ argv, env, cwd });
  }
  return { ...f, run, env, cwd, config, remote, realState, remoteFile, head, event, operation, state, events, appended, auth, stateFactory, transport, fetch, forbidden };
}
const acceptArgs = ['accept-state', '--observed-entry', '3', '--fingerprint', 'A', '--confirm'];

describe('installed accept-state binds the shared Git ledger protocol', () => {
  it('positive control writes durable acceptance and clears regression using the real state store', async () => {
    const f = await fixture(false); const result = await f.realState.acceptState({ expectedObservedEntry: 3, fingerprint: 'A', actor: f.config.actor });
    expect(result.entry).toMatchObject({ number: 4, marker: 'accept-state', confirmedBy: f.config.actor });
    expect((await f.realState.read('A')).observation).toMatchObject({ revision: 4, highWaterMark: 4, requiresConfirmation: false });
    expect(JSON.parse(f.remoteFile('verified-pairs.json'))).toEqual([]);
    await expect(f.realState.acceptState({ expectedObservedEntry: 3, fingerprint: 'A', actor: f.config.actor })).rejects.toThrow(/stale|observed-entry/);
  });
  it('explicit confirmation records protected actor and makes subsequent snapshots eligible without renewed confirmation', async () => {
    const f = await fixture(); await f.run(acceptArgs);
    expect(JSON.parse(f.remoteFile('ledger/entry-000004.json'))).toMatchObject({ number: 4, previous: 3, fingerprint: 'A', marker: 'accept-state', confirmedBy: f.config.actor });
    expect((await f.realState.read('A')).observation).toMatchObject({ revision: 4, highWaterMark: 4, requiresConfirmation: false });
    expect(f.remoteFile('verified-pairs.json')).toBe('[]'); expect(f.transport).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
    const options = f.stateFactory.mock.calls[0][0]; expect(options.remote).toBe(f.remote); expect(options.gitEnv?.SSH_AUTH_SOCK).toBe(CANARY);
    for (const key of ['CMS_TOKEN', 'CMS_URL', 'NODE_OPTIONS', 'PUBLICATION_REPORT']) expect(options.gitEnv?.[key]).toBeUndefined();
  });
  it('new CMS event invalidates old explicit confirmation without writing an acceptance', async () => {
    const f = await fixture(); await f.event(); const before = f.head();
    await expect(f.run(acceptArgs)).rejects.toThrow(/stale|observed-entry/); expect(f.head()).toBe(before);
    expect(JSON.parse(f.remoteFile('ledger/entry-000004.json')).marker).toBe('edit'); expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(['confirmation', 'actor', 'fingerprint'])('invalid %s refuses without writing journal or connecting to release host', async (fault) => {
    const f = await fixture(); const before = f.head(); let args = [...acceptArgs];
    if (fault === 'confirmation') args = args.filter((arg) => arg !== '--confirm');
    if (fault === 'actor') args.push('--actor', 'spoofed');
    if (fault === 'fingerprint') args[args.indexOf('--fingerprint') + 1] = 'wrong-current-state';
    await expect(f.run(args)).rejects.toThrow(); expect(f.head()).toBe(before); expect(f.transport).not.toHaveBeenCalled();
  });
});

describe('installed recovery reconnects pending operation to verified served pair and immutable index', () => {
  it('positive control real served-pair verifier reaches fixture and rejects wrong pair', async () => {
    const f = await fixture(false); f.state.locked = true;
    await verifyServedPublication(f.operation, new URL(f.config.siteUrl), f.fetch);
    expect(f.events).toContain('served-pair'); f.state.servedMismatch = true;
    await expect(verifyServedPublication(f.operation, new URL(f.config.siteUrl), f.fetch)).rejects.toThrow();
  });
  it('positive control real state validator accepts original evidence and rejects incomplete pending records', async () => {
    const f = await fixture(false); await f.realState.appendPublication(f.operation);
    expect(JSON.parse(f.remoteFile('verified-pairs.json'))).toEqual([f.operation]);
    await expect(f.realState.appendPublication({ ...f.operation, publicationId: 'invalid', localChecks: { ...f.operation.localChecks, groups: [] } })).rejects.toThrow(/evidence/);
  });
  it('checks real served pair under lock before durable append, clears pending and preserves journal', async () => {
    const f = await fixture(); const ledger = f.remoteFile('ledger/entry-000003.json'); await f.run(['recover']);
    expect(f.appended).toEqual([f.operation]); expect(JSON.parse(f.remoteFile('verified-pairs.json'))).toEqual([f.operation]);
    expect(f.events.indexOf('served-pair')).toBeGreaterThan(-1); expect(f.events.indexOf('served-pair')).toBeLessThan(f.events.indexOf('append')); expect(f.events.indexOf('append')).toBeLessThan(f.events.indexOf('unlock'));
    expect(f.state.pending).toBe(false); expect(f.remoteFile('ledger/entry-000003.json')).toBe(ledger); expect(f.remoteFile('ledger/high-water-mark')).toBe('3');
    expect(f.forbidden).not.toHaveBeenCalled(); expect(f.transport).toHaveBeenCalledWith(expect.objectContaining({ destinationId: 'prod', root: f.config.webRoot, authorize: expect.any(Function) }));
  });
  it.each(['served-mismatch', 'invalid-evidence', 'index-failure', 'committing-old', 'substituted-record'])('%s retains unresolved pending state and cannot record success', async (fault) => {
    const f = await fixture(); const before = f.head();
    if (fault === 'served-mismatch') f.state.servedMismatch = true;
    if (fault === 'invalid-evidence') f.operation.localChecks.groups = [];
    if (fault === 'index-failure') f.state.appendFailure = true;
    if (fault === 'committing-old') f.state.committingOld = true;
    if (fault === 'substituted-record') f.state.substituteRecord = true;
    await expect(f.run(['recover'])).rejects.toThrow(); expect(f.state.pending).toBe(true); expect(f.head()).toBe(before); expect(f.appended).toEqual([]);
    if (fault === 'served-mismatch' || fault === 'committing-old') expect(f.events).not.toContain('append');
  });
  it.each(['noop', 'prepared'])('%s never appends a publication or fabricates served-pair checks', async (kind) => {
    const f = await fixture(); if (kind === 'noop') f.state.pending = false; else f.state.prepared = true;
    const before = f.head(); await f.run(['recover']); expect(f.head()).toBe(before); expect(f.appended).toEqual([]); expect(f.fetch).not.toHaveBeenCalled(); expect(f.state.pending).toBe(false);
  });
  it('recovery authorization excludes ordinary mutations and expires after use', async () => {
    const f = await fixture(); f.state.probeAuthorization = true; await f.run(['recover']); expect(f.auth).toHaveLength(1);
    for (const action of ['connect', 'recover', 'stage', 'activate', 'rollback']) await expect(f.auth[0]({ action, destinationId: 'prod', operation: f.operation })).rejects.toThrow();
    await expect(f.auth[0]({ action: 'recover', destinationId: 'foreign', operation: f.operation })).rejects.toThrow();
  });
});
