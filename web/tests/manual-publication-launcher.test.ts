import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Integration RED for manual-publication-only: tasks 2.3b, 2.4, 2.5, 2.8.
// Bare remotes and the fake credential broker are entirely local; no SSH or VPS.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LAUNCHER = join(REPO, 'scripts/publication-launcher.mjs');
const CANARY = 'IKPK_TEST_SECRET_7f842b_do_not_log';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'ikpk-launcher-red-')); dirs.push(dir); return dir; };
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Publication fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Publication fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function write(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }

type Fixture = ReturnType<typeof fixture>;
function fixture() {
  const root = temp();
  const repo = join(root, 'author'); const remote = join(root, 'canonical.git');
  const installed = join(root, 'protected', 'publication-launcher.mjs');
  const config = join(root, 'protected', 'config.json'); const broker = join(root, 'protected', 'broker.mjs');
  const trace = join(root, 'broker-trace.json'); const marker = join(root, 'trusted-marker.json');
  const malicious = join(root, 'untrusted-executed');
  mkdirSync(repo); mkdirSync(dirname(installed));
  copyFileSync(LAUNCHER, installed); chmodSync(installed, 0o700);
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(repo, 'init', '--initial-branch=main');
  write(join(repo, 'scripts/deploy-web.sh'), '#!/usr/bin/env bash\nset -eu\nexec "' + process.execPath + '" scripts/fixture-worker.mjs "$@"\n');
  chmodSync(join(repo, 'scripts/deploy-web.sh'), 0o755);
  write(join(repo, 'scripts/fixture-worker.mjs'), `
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  cwd: process.cwd(), commit: git('rev-parse', 'HEAD'), clean: git('status', '--porcelain') === '',
  credentialReceived: process.env.IKPK_DEPLOY_CREDENTIAL === ${JSON.stringify(CANARY)},
  destinationId: process.env.PUBLICATION_DESTINATION_ID, mode: process.env.DEPLOY_MODE,
  argv: process.argv, brokerAlreadyCalled: ${JSON.stringify(trace)} && (await import('node:fs')).existsSync(${JSON.stringify(trace)})
}));
console.log(JSON.stringify({ status: 'success', executedChecks: 1 }));
`);
  write(broker, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(trace)}, JSON.stringify({
  called: true, inheritedCredential: Object.hasOwn(process.env, 'IKPK_DEPLOY_CREDENTIAL'), argv: process.argv
}));
process.stdout.write(JSON.stringify({ env: { IKPK_DEPLOY_CREDENTIAL: ${JSON.stringify(CANARY)} } }));
`);
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'trusted fixture');
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', 'origin', 'main');
  const sha = git(repo, 'rev-parse', 'HEAD');
  write(config, JSON.stringify({ canonicalRepository: remote, destinationId: 'isolated-stand',
    deployMode: 'stand', sshTarget: 'deployer@no-network.invalid', credentialBroker: [process.execPath, broker] }));
  chmodSync(config, 0o600);
  return { root, repo, remote, installed, config, broker, trace, marker, malicious, sha };
}
function launch(f: Fixture, options: { url?: string; ref?: string; sourceDir?: string; config?: string; cwd?: string } = {}) {
  const args = [f.installed, 'publish', '--config', options.config ?? f.config,
    '--source-url', options.url ?? f.remote, '--source-ref', options.ref ?? 'main'];
  if (options.sourceDir) args.push('--source-dir', options.sourceDir);
  return spawnSync(process.execPath, args, { cwd: options.cwd ?? f.root, env: cleanEnv(), encoding: 'utf8', timeout: 15_000 });
}
function assertRefused(f: Fixture, result: ReturnType<typeof launch>, reason: string) {
  expect(result.error, 'the launcher must actually execute').toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain(reason);
  expect(existsSync(f.trace), 'credentials released before source authorization').toBe(false);
  expect(existsSync(f.marker), 'a build or deploy executed after refusal').toBe(false);
  expect(existsSync(f.malicious), 'untrusted code executed before refusal').toBe(false);
}
function assertSuccessful(f: Fixture, result: ReturnType<typeof launch>) {
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
  expect(report.status).toBe('success');
  expect(report.executedChecks, 'zero executed checks cannot establish launcher success').toBeGreaterThan(0);
  expect(existsSync(f.trace), 'zero broker calls cannot demonstrate safe credential delivery').toBe(true);
  expect(existsSync(f.marker), 'zero entrypoint executions cannot demonstrate source selection').toBe(true);
  const marker = JSON.parse(readFileSync(f.marker, 'utf8'));
  expect(marker).toMatchObject({ commit: f.sha, clean: true, credentialReceived: true,
    destinationId: 'isolated-stand', mode: 'stand', brokerAlreadyCalled: true });
  expect(realpathSync(dirname(f.installed))).not.toBe(marker.cwd);
  expect(marker.cwd).not.toBe(realpathSync(f.repo));
  expect(marker.cwd.startsWith(`${realpathSync(f.repo)}/`)).toBe(false);
  expect(realpathSync(f.installed).startsWith(`${marker.cwd}/`)).toBe(false);
  const trace = JSON.parse(readFileSync(f.trace, 'utf8'));
  expect(trace).toMatchObject({ called: true, inheritedCredential: false });
  return marker;
}
function maliciousEntrypoint(f: Fixture) {
  write(join(f.repo, 'scripts/deploy-web.sh'), '#!/usr/bin/env bash\ntouch "' + f.malicious + '"\nexit 0\n');
}

describe('fixture positive controls', () => {
  it('the broker delivers the canary and the trusted marker records actual execution', () => {
    const f = fixture(); const checkout = join(f.root, 'control-checkout'); git(f.root, 'clone', f.remote, checkout);
    const broker = spawnSync(process.execPath, [f.broker], { env: cleanEnv(), encoding: 'utf8' });
    expect(broker.status).toBe(0);
    const credentials = JSON.parse(broker.stdout).env as Record<string, string>;
    const result = spawnSync('bash', ['scripts/deploy-web.sh'], { cwd: checkout, encoding: 'utf8',
      env: { ...cleanEnv(), ...credentials, PUBLICATION_DESTINATION_ID: 'isolated-stand', DEPLOY_MODE: 'stand' } });
    assertSuccessful(f, result);
  });
  it('the malicious marker would exist if the untrusted entrypoint were executed', () => {
    const f = fixture(); maliciousEntrypoint(f);
    const result = spawnSync('bash', ['scripts/deploy-web.sh'], { cwd: f.repo, env: cleanEnv(), encoding: 'utf8' });
    expect(result.status).toBe(0); expect(existsSync(f.malicious)).toBe(true);
    expect(existsSync(f.trace)).toBe(false);
  });
});

describe('installed launcher confirms fresh canonical main before releasing credentials or executing repository code', () => {
  it('positive control reaches the trusted entrypoint and the credential broker in an isolated clean checkout', () => {
    const f = fixture(); assertSuccessful(f, launch(f));
  });
  it('an explicitly dirty source is refused before its modified entrypoint or the credential broker executes', () => {
    const f = fixture(); maliciousEntrypoint(f);
    assertRefused(f, launch(f, { sourceDir: f.repo }), 'dirty-source');
  });
  it('untracked files also make an explicit source dirty', () => {
    const f = fixture(); write(join(f.repo, 'untracked.txt'), 'not committed');
    assertRefused(f, launch(f, { sourceDir: f.repo }), 'dirty-source');
  });
  it('an unrelated dirty cwd has no influence on the selected main source', () => {
    const f = fixture(); maliciousEntrypoint(f);
    assertSuccessful(f, launch(f, { cwd: f.repo })); expect(existsSync(f.malicious)).toBe(false);
  });
  it('an untrusted repository URL cannot request credentials even if it offers a main branch', () => {
    const f = fixture(); const other = join(f.root, 'untrusted.git');
    git(f.root, 'clone', '--bare', f.remote, other);
    assertRefused(f, launch(f, { url: other }), 'untrusted-source');
  });
  it('a non-main ref cannot request credentials', () => {
    const f = fixture(); git(f.repo, 'checkout', '-b', 'feature'); maliciousEntrypoint(f);
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'untrusted feature'); git(f.repo, 'push', 'origin', 'feature');
    assertRefused(f, launch(f, { ref: 'feature' }), 'untrusted-ref');
  });
  it('a local-only commit is not accepted as an explicit source', () => {
    const f = fixture(); maliciousEntrypoint(f); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'local-only');
    assertRefused(f, launch(f, { sourceDir: f.repo }), 'untrusted-source');
  });
  it('a local-only commit in cwd is not executed when source-dir was not selected', () => {
    const f = fixture(); maliciousEntrypoint(f); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'local-only');
    assertSuccessful(f, launch(f, { cwd: f.repo })); expect(existsSync(f.malicious)).toBe(false);
  });
  it('uses fresh remote main even when the operator checkout is stale', () => {
    const f = fixture(); const publisher = join(f.root, 'publisher'); git(f.root, 'clone', f.remote, publisher);
    write(join(publisher, 'new-main.txt'), 'remote main moved'); git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'new main');
    git(publisher, 'push', 'origin', 'main'); f.sha = git(publisher, 'rev-parse', 'HEAD');
    assertSuccessful(f, launch(f, { cwd: f.repo }));
  });
  it('unavailable canonical source refuses before credential release', () => {
    const f = fixture(); rmSync(f.remote, { recursive: true });
    assertRefused(f, launch(f), 'source-unavailable');
  });
  it('a protected config inside the explicitly supplied source is not trusted', () => {
    const f = fixture(); const embedded = join(f.repo, 'publication-config.json');
    copyFileSync(f.config, embedded); chmodSync(embedded, 0o600);
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'embedded config'); git(f.repo, 'push', 'origin', 'main');
    assertRefused(f, launch(f, { sourceDir: f.repo, config: embedded }), 'untrusted-config');
  });
  it.each([0o620, 0o602])('a writable protected config mode %i is refused before broker access', (mode) => {
    const f = fixture(); chmodSync(f.config, mode);
    assertRefused(f, launch(f), 'untrusted-config');
  });
  it('credentials do not appear in child argv, stdout, stderr, or launcher audit artifacts', () => {
    const f = fixture(); const result = launch(f); const marker = assertSuccessful(f, result);
    const trace = readFileSync(f.trace, 'utf8');
    expect(JSON.stringify(marker.argv)).not.toContain(CANARY);
    expect(trace).not.toContain(CANARY);
    expect(result.stdout).not.toContain(CANARY); expect(result.stderr).not.toContain(CANARY);
    // Marker is an artifact produced by the checked-out worker; it retains only a boolean.
    expect(readFileSync(f.marker, 'utf8')).not.toContain(CANARY);
  });
});

async function digest(root: string, paths: string[]): Promise<string> {
  const module = await import(pathToFileURL(LAUNCHER).href) as { digestTree: (root: string, paths: string[]) => Promise<string> };
  return module.digestTree(root, paths);
}
function tree() {
  const root = temp(); write(join(root, 'index.html'), '<h1>tested</h1>');
  write(join(root, 'assets/a.txt'), 'bytes');
  return root;
}
describe('deterministic digest binds relative file paths and bytes', () => {
  it('positive control returns a nonempty SHA256 for an actual tree', async () => {
    expect(await digest(tree(), ['index.html', 'assets/a.txt'])).toMatch(/^[a-f0-9]{64}$/);
  });
  it('permuting the explicit input file list cannot change the digest', async () => {
    const root = tree(); const original = await digest(root, ['index.html', 'assets/a.txt']);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(await digest(root, ['assets/a.txt', 'index.html'])).toBe(original);
  });
  it('changed bytes invalidate a previously tested digest', async () => {
    const root = tree(); const original = await digest(root, ['index.html', 'assets/a.txt']);
    write(join(root, 'assets/a.txt'), 'tampered');
    expect(await digest(root, ['index.html', 'assets/a.txt'])).not.toBe(original);
  });
  it('renaming identical bytes changes the tree digest', async () => {
    const root = tree(); const original = await digest(root, ['index.html', 'assets/a.txt']);
    write(join(root, 'assets/b.txt'), 'bytes');
    expect(await digest(root, ['index.html', 'assets/b.txt'])).not.toBe(original);
  });
  it('absolute temporary checkout location does not enter the digest', async () => {
    expect(await digest(tree(), ['index.html', 'assets/a.txt'])).toBe(await digest(tree(), ['index.html', 'assets/a.txt']));
  });
  it('an empty file list is an unperformed integrity check', async () => {
    await expect(digest(tree(), [])).rejects.toThrow(/empty|no files|пуст/);
  });
  it('parent traversal cannot introduce files outside the release root', async () => {
    const root = tree(); write(join(root, 'release/index.html'), 'test');
    await expect(digest(join(root, 'release'), ['../index.html'])).rejects.toThrow(/path|escape|outside|пут/);
  });
  it('an absolute file path is not a relative release member', async () => {
    const root = tree(); await expect(digest(root, [join(root, 'index.html')])).rejects.toThrow(/path|relative|пут/);
  });
  it('a symlinked file cannot supply a mutable external release member', async () => {
    const root = tree(); symlinkSync(join(root, 'index.html'), join(root, 'linked.html'));
    await expect(digest(root, ['linked.html'])).rejects.toThrow(/symlink|symbolic|символ/);
  });
  it('a symlinked parent directory cannot escape the release root', async () => {
    const root = tree(); const external = temp(); write(join(external, 'injected.txt'), 'external');
    symlinkSync(external, join(root, 'outside'));
    await expect(digest(root, ['outside/injected.txt'])).rejects.toThrow(/symlink|symbolic|outside|символ/);
  });
});
