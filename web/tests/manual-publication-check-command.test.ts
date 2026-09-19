import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFixture, browserReport, STAGES, vitestReport, type Stage } from './helpers/publication-adapter-fixtures';
import { PUBLICATION_GROUPS } from '../scripts/lib/publish-gate';
import type { LocalChecks } from '../scripts/lib/publish-gate';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = join(ROOT, 'web/scripts/publication-check-command.ts');
const SECRET = 'check-command-secret-canary';
const fixtures: Awaited<ReturnType<typeof adapterFixture>>[] = [];
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
const bytes = (dir: string) => readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), 'utf8')]);

async function fixture() {
  const f = await adapterFixture(); fixtures.push(f);
  const configPath = join(f.temp, 'protected/config.json');
  const knownHostsFile = join(f.temp, 'protected/known_hosts'); write(knownHostsFile, 'fixture host key\n');
  const config = { canonicalRepository: 'https://github.com/example/site.git', sshTarget: 'deploy@stand.test.invalid',
    destinationId: 'stand', deployMode: 'stand', paymentRole: 'ci', siteUrl: 'https://stand.test.invalid',
    actor: 'operator', webRoot: '/var/www/ikpk', knownHostsFile, keepReleases: 5, chatLoaderSrc: 'none',
    payment: undefined as undefined | { endpoint: string; mode: string; shopId: string; siteOrigin: string } };
  const save = () => { write(configPath, config); chmodSync(configPath, 0o600); }; save();
  const env = { PATH: process.env.PATH, HOME: f.temp, CMS_URL: 'https://must-not-capture.invalid', CMS_TOKEN: SECRET,
    GH_TOKEN: SECRET, SSH_AUTH_SOCK: join(f.temp, SECRET), NODE_OPTIONS: '--import=evil.mjs',
    NPM_CONFIG_USERCONFIG: '/unsafe/npmrc', CONTENT_SNAPSHOT_DIR: '/unsafe/snapshot', PAYMENT_ROLE: 'prod',
    DEPLOY_MODE: 'prod', PUBLICATION_REPORT: '/unsafe/report', PUBLICATION_GROUPS: 'snapshot', CHAT_LOADER_SRC: 'https://unsafe.invalid' };
  const argv = ['--snapshot-dir', f.options.snapshotDir, '--ledger-dir', f.options.ledgerDir,
    '--config', configPath, '--commit', f.context.commit, '--report', f.context.reportPath];
  const calls: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const state = { badStage: '' as Stage | '', zero: false, fail: false, omit: false };
  const probe = vi.fn(async () => ({ status: 200, contentType: 'application/json', body: { status: 'ready', mode: config.payment?.mode, shopId: config.payment?.shopId } }));
  const authorizeCalls: { action: string; proof: unknown }[] = [];
  const transport = vi.fn((options: { authorize(request: { action: string; destinationId: string }): Promise<unknown> }) => ({
    async withLock(callback: (session: unknown) => Promise<unknown>) {
      for (const action of ['connect', 'payment-readiness']) authorizeCalls.push({ action, proof: await options.authorize({ action, destinationId: config.destinationId }) });
      for (const action of ['stage', 'activate', 'recover', 'rollback', 'download']) {
        await expect(options.authorize({ action, destinationId: config.destinationId })).rejects.toThrow();
      }
      await expect(options.authorize({ action: 'payment-readiness', destinationId: 'foreign' })).rejects.toThrow();
      return callback({ paymentReadiness: probe });
    },
  }));
  vi.doMock('../../scripts/publication-transport.mjs', () => ({ createSshTransport: transport }));
  // External process boundary only: production runner, fixed adapter selection,
  // reporter parsing, real HTTP preview and digest remain unmocked.
  vi.doMock('node:child_process', async () => ({
    ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
    spawn(file: string, args: string[], options: SpawnOptions) {
      const child = new EventEmitter(); calls.push({ file, args, options });
      queueMicrotask(async () => {
        try {
          const stage = STAGES.find((name) => args.includes(`tests/publication/${name}.test.ts`));
          if (basename(file) === 'npm' && args.join(' ') === 'run build') {
            rmSync(f.context.treeDir, { recursive: true, force: true }); write(join(f.context.treeDir, 'index.html'), '<main>fixture process artifact</main>');
          } else if (stage) {
            if (!(state.badStage === stage && state.omit)) {
              const path = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
              write(path, vitestReport(state.badStage === stage && state.zero ? 0 : 3));
            }
          } else if (args.includes('tests/publication-smoke.spec.ts')) {
            const response = await fetch(String(options.env!.PUBLICATION_BASE_URL));
            expect(response.status).toBe(200); expect(await response.text()).toContain('fixture process artifact');
            const release = await fetch(`${options.env!.PUBLICATION_BASE_URL}/release.json`);
            expect(await release.json()).toEqual({ commit: f.context.commit, snapshotId: f.snapshot.snapshotId });
            write(String(options.env!.PLAYWRIGHT_JSON_OUTPUT_NAME), browserReport());
          } else throw new Error(`unexpected subprocess: ${basename(file)} ${args.join(' ')}`);
          child.emit('close', stage === state.badStage && state.fail ? 1 : 0, null);
        } catch (error) { child.emit('error', error); }
      });
      return child;
    },
  }));
  async function load() {
    // This assertion is outside every expected rejection: absence never passes a negative test.
    expect(existsSync(ENTRY), 'check-only executable must exist before validating its refusals').toBe(true);
    const module = await import(/* @vite-ignore */ ENTRY);
    expect(module.runPublicationCheckCommand).toBeTypeOf('function');
    return module.runPublicationCheckCommand as (input: { argv: string[]; env: typeof env; cwd: string }) => Promise<LocalChecks>;
  }
  return { ...f, config, configPath, save, env, argv, calls, state, transport, authorizeCalls, probe, load,
    run: async () => (await load())({ argv, env, cwd: f.options.webRoot }) };
}
beforeEach(() => vi.resetModules());
afterEach(() => { vi.doUnmock('node:child_process'); vi.doUnmock('../../scripts/publication-transport.mjs'); vi.resetModules(); for (const f of fixtures.splice(0)) f.clean(); });

describe('test:publication standalone check-only command', () => {
  it('fixture positive control executes the existing actual fixed runner and adapters', async () => {
    const f = await fixture();
    const { createPublicationCheckPorts } = await import('../scripts/lib/publication-check-adapters');
    const { runPublicationChecks } = await import('../scripts/lib/publication-checks');
    const { readPublicationSnapshot } = await import('../scripts/lib/publication-snapshot');
    const ports = createPublicationCheckPorts(f.options);
    ports.capture = async () => ({ snapshotDir: f.options.snapshotDir, snapshotId: readPublicationSnapshot(f.options.snapshotDir).snapshotId! });
    const report = await runPublicationChecks(f.context, ports);
    expect(report.groups.map((group) => group.name)).toEqual(PUBLICATION_GROUPS);
    expect(report.groups.map((group) => group.executedTests)).toEqual([3, 3, 3, 4, 3]);
    expect(f.calls).toHaveLength(6); expect(f.transport).not.toHaveBeenCalled();
  });

  it('builds exactly once from the supplied snapshot, executes all five groups and writes external fresh evidence', async () => {
    const f = await fixture(); const snapshotBefore = bytes(f.options.snapshotDir); const ledgerBefore = bytes(f.options.ledgerDir);
    const report = await f.run();
    expect(report).toMatchObject({ commit: f.context.commit, snapshotId: f.snapshot.snapshotId, destinationId: 'stand', treeDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(report.groups.map((group) => group.name)).toEqual(PUBLICATION_GROUPS);
    expect(report.groups.map((group) => group.executedTests)).toEqual([3, 3, 3, 4, 3]);
    expect(JSON.parse(readFileSync(f.context.reportPath, 'utf8'))).toEqual(report);
    expect(f.calls.filter((call) => basename(call.file) === 'npm')).toHaveLength(1);
    expect(f.calls.map((call) => call.args.find((arg) => arg.startsWith('tests/'))).filter(Boolean)).toEqual([
      'tests/publication/snapshot.test.ts', 'tests/publication/build.test.ts', 'tests/publication/destination.test.ts',
      'tests/publication-smoke.spec.ts', 'tests/publication/payment-absence.test.ts',
    ]);
    for (const call of f.calls) {
      expect(call.options.cwd).toBe(f.options.webRoot);
      expect(call.options.env).toMatchObject({ CONTENT_SNAPSHOT_DIR: f.options.snapshotDir, PUBLICATION_LEDGER_DIR: f.options.ledgerDir, DEPLOY_MODE: 'stand', PAYMENT_ROLE: 'ci', CHAT_LOADER_SRC: 'none' });
      expect(JSON.stringify(call)).not.toContain(SECRET);
      expect(call.options.env!.NODE_OPTIONS).toBeUndefined(); expect(call.options.env!.NPM_CONFIG_USERCONFIG).toBeUndefined();
      const output = call.args.find((arg) => arg.startsWith('--outputFile='));
      if (output) expect(output).toContain(`${f.context.reportPath}.checks/`);
    }
    expect(bytes(f.options.snapshotDir)).toEqual(snapshotBefore); expect(bytes(f.options.ledgerDir)).toEqual(ledgerBefore);
    expect(f.transport).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });

  it.each(['stand', 'prod'] as const)('active payment role %s performs only destination readiness and fixed preflight', async (role) => {
    const f = await fixture(); f.config.paymentRole = role;
    f.config.payment = { endpoint: 'https://payments.test.invalid/api', mode: role === 'stand' ? 'test' : 'prod', shopId: role === 'stand' ? '1440249' : '409285', siteOrigin: f.config.siteUrl }; f.save();
    const report = await f.run(); expect(report.groups.at(-1)).toMatchObject({ name: 'payment-destination', executedTests: 6 });
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(); expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport.mock.calls[0][0]).toMatchObject({ host: 'stand.test.invalid', user: 'deploy', root: '/var/www/ikpk', knownHostsFile: f.config.knownHostsFile, destinationId: 'stand' });
    expect(f.authorizeCalls).toEqual(['connect', 'payment-readiness'].map((action) => ({ action, proof: { commit: f.context.commit, destinationId: 'stand' } })));
    const authorize = f.transport.mock.calls[0][0].authorize;
    await expect(authorize({ action: 'connect', destinationId: 'stand' })).rejects.toThrow();
    expect(f.calls.some((call) => call.args.includes('tests/publication/payment-preflight.test.ts'))).toBe(true);
    expect(f.calls.some((call) => call.args.includes('tests/publication/payment-absence.test.ts'))).toBe(false);
  });

  it.each(['zero', 'failed', 'missing'] as const)('rejects %s subprocess evidence and never writes a successful summary', async (fault) => {
    const f = await fixture(); const run = await f.load(); f.state.badStage = 'build';
    f.state.zero = fault === 'zero'; f.state.fail = fault === 'failed'; f.state.omit = fault === 'missing';
    await expect(run({ argv: f.argv, env: f.env, cwd: f.options.webRoot })).rejects.toThrow();
    expect(f.calls.some((call) => call.args.includes('tests/publication/build.test.ts'))).toBe(true);
    expect(existsSync(f.context.reportPath)).toBe(false); expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(['--groups', '--command', '--reports', '--tree-dir', '--accept-current-state', '--publish'])('rejects unsupported input %s before executing checks', async (flag) => {
    const f = await fixture(); const run = await f.load();
    await expect(run({ argv: [...f.argv, flag, 'unsafe'], env: f.env, cwd: f.options.webRoot })).rejects.toThrow();
    expect(f.calls).toHaveLength(0); expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(['pinned', 'identity', 'writable-config', 'report-in-tree', 'report-in-snapshot', 'existing-report', 'duplicate', 'relative'] as const)('refuses %s without changing source or contacting SSH', async (fault) => {
    const f = await fixture(); const run = await f.load();
    if (fault === 'pinned') { f.snapshot.origin = { kind: 'pinned' }; write(join(f.options.snapshotDir, 'snapshot.json'), f.snapshot); }
    if (fault === 'identity') { f.snapshot.snapshotId = 'forged'; write(join(f.options.snapshotDir, 'snapshot.json'), f.snapshot); }
    if (fault === 'writable-config') chmodSync(f.configPath, 0o666);
    if (fault === 'report-in-tree') f.argv[f.argv.indexOf('--report') + 1] = join(f.context.treeDir, 'report.json');
    if (fault === 'report-in-snapshot') f.argv[f.argv.indexOf('--report') + 1] = join(f.options.snapshotDir, 'report.json');
    if (fault === 'existing-report') write(f.context.reportPath, '{}');
    if (fault === 'duplicate') f.argv.push('--commit', f.context.commit);
    if (fault === 'relative') f.argv[f.argv.indexOf('--snapshot-dir') + 1] = 'captured';
    const before = bytes(f.options.snapshotDir);
    await expect(run({ argv: f.argv, env: f.env, cwd: f.options.webRoot })).rejects.toThrow();
    expect(f.calls).toHaveLength(0); expect(f.transport).not.toHaveBeenCalled(); expect(bytes(f.options.snapshotDir)).toEqual(before);
  });

  it('npm entry invokes the dedicated executable and invalid argv fails with its own safe diagnostic', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'web/package.json'), 'utf8'));
    expect(pkg.scripts['test:publication']).toBe('tsx scripts/publication-check-command.ts');
    expect(existsSync(ENTRY)).toBe(true);
    const result = spawnSync('npm', ['--prefix', join(ROOT, 'web'), 'run', 'test:publication', '--', '--unsupported'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, CMS_TOKEN: SECRET }, timeout: 15_000,
    });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('publication-check-arguments');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SECRET);
  });
});
