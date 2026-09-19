#!/usr/bin/env node
// Native Node 24 bootstrap: no repository/dependency imports before validation and npm ci.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface WorkerInput { argv: string[]; env: Record<string, string | undefined>; cwd: string }
interface DestinationConfig {
  canonicalRepository: string; sshTarget: string; destinationId: string; deployMode: 'stand' | 'prod';
  paymentRole: 'ci' | 'stand' | 'prod'; siteUrl: string; actor: string; webRoot: string;
  knownHostsFile: string; keepReleases: number; chatLoaderSrc: string; demoForms?: string;
  payment?: { endpoint: string; readinessUrl: string; mode: 'test' | 'prod'; shopId: string; siteOrigin: string };
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
function protectedFile(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('untrusted-config');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error('untrusted-config');
  return realpathSync(path);
}
function publicUrl(value: unknown, originOnly = false): string {
  if (typeof value !== 'string') throw new Error('untrusted-config');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (originOnly && (url.pathname !== '/' || url.search))) throw new Error('untrusted-config');
  return value;
}
function readConfig(path: string): DestinationConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as DestinationConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      typeof config.canonicalRepository !== 'string' || !config.canonicalRepository || config.canonicalRepository.startsWith('-') ||
      typeof config.sshTarget !== 'string' || !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.:[\]-]*$/.test(config.sshTarget) || config.sshTarget.startsWith('root@') ||
      typeof config.destinationId !== 'string' || !config.destinationId.trim() ||
      !['stand', 'prod'].includes(config.deployMode) || !['ci', 'stand', 'prod'].includes(config.paymentRole) ||
      typeof config.actor !== 'string' || !config.actor.trim() ||
      typeof config.webRoot !== 'string' || !isAbsolute(config.webRoot) || config.webRoot === '/' || config.webRoot.includes('\0') ||
      !Number.isSafeInteger(config.keepReleases) || config.keepReleases < 2 ||
      typeof config.chatLoaderSrc !== 'string' || !config.chatLoaderSrc.trim() ||
      (config.demoForms !== undefined && (typeof config.demoForms !== 'string' || !config.demoForms.trim()))) throw new Error('untrusted-config');
  if (config.canonicalRepository.includes('://')) {
    const remote = new URL(config.canonicalRepository);
    if (!['https:', 'ssh:', 'file:'].includes(remote.protocol) || remote.password ||
        (remote.protocol !== 'ssh:' && remote.username)) throw new Error('untrusted-config');
  }
  publicUrl(config.siteUrl, true);
  if (config.chatLoaderSrc !== 'none') publicUrl(config.chatLoaderSrc);
  protectedFile(config.knownHostsFile);
  if (config.paymentRole !== 'ci') {
    const payment = config.payment;
    if (!payment || !['test', 'prod'].includes(payment.mode) || typeof payment.shopId !== 'string' || !payment.shopId.trim()) throw new Error('untrusted-config');
    publicUrl(payment.endpoint); publicUrl(payment.readinessUrl); publicUrl(payment.siteOrigin, true);
  }
  return config;
}
function artifactFiles(root: string): string[] {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('invalid artifact directory');
  const result: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symlink in artifact');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) result.push(relative(root, path));
      else throw new Error('nonregular artifact member');
    }
  }
  walk(root); return result;
}

export async function runPublicationWorker({ argv, env, cwd }: WorkerInput) {
  if (env.GITHUB_ACTIONS === 'true' || env.CI === 'true') throw new Error('hosted-publication-forbidden');
  if (argv.length !== 1 || !env.PUBLICATION_CONFIG || !env.PUBLICATION_LAUNCHER ||
      !env.PUBLICATION_SOURCE_SHA || !/^[a-f0-9]{40}$/.test(env.PUBLICATION_SOURCE_SHA)) throw new Error('missing protected publication context');
  const root = realpathSync(cwd);
  const launcher = protectedFile(env.PUBLICATION_LAUNCHER);
  const configPath = protectedFile(env.PUBLICATION_CONFIG);
  if (configPath !== join(dirname(launcher), 'config.json') || inside(root, launcher) || inside(root, configPath)) throw new Error('untrusted-config');
  const config = readConfig(configPath);
  if (argv[0] !== config.sshTarget || env.PUBLICATION_DESTINATION_ID !== config.destinationId || env.DEPLOY_MODE !== config.deployMode) throw new Error('publication destination mismatch');
  const scratch = mkdtempSync(join(tmpdir(), 'ikpk-publication-worker-'));
  const home = join(scratch, 'home'); mkdirSync(home);
  // The installed Node directory supplies npm; no operator npm configuration or executable paths.
  const safeEnv: Record<string, string> = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: scratch };
  const gitEnv: Record<string, string> = { ...safeEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  if (env.SSH_AUTH_SOCK) gitEnv.SSH_AUTH_SOCK = env.SSH_AUTH_SOCK;
  if (env.GH_TOKEN && config.canonicalRepository.startsWith('https://')) {
    // Git receives auth only in its process environment, scoped to the canonical remote.
    Object.assign(gitEnv, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${config.canonicalRepository}.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64')}` });
  }
  function git(dir: string, ...args: string[]): string {
    try {
      return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
        { cwd: dir, env: gitEnv, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch { throw new Error('publication source unavailable'); }
  }
  function readMain(): string {
    const result = git(root, 'ls-remote', '--exit-code', '--refs', '--', config.canonicalRepository, 'refs/heads/main');
    const match = /^([a-f0-9]{40})\s+refs\/heads\/main$/.exec(result);
    if (!match) throw new Error('canonical main unavailable');
    return match[1];
  }
  try {
    for (const directory of [dirname(launcher), dirname(configPath)]) {
      let repository = false;
      try { git(directory, 'rev-parse', '--absolute-git-dir'); repository = true; } catch { /* Protected installation lives outside repositories. */ }
      if (repository) throw new Error('untrusted-config');
    }
    const commit = env.PUBLICATION_SOURCE_SHA;
    if (realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== root ||
        git(root, 'symbolic-ref', 'HEAD') !== 'refs/heads/main' || git(root, 'rev-parse', 'HEAD') !== commit ||
        git(root, 'remote', 'get-url', 'origin') !== config.canonicalRepository ||
        git(root, 'status', '--porcelain', '--untracked-files=all') || readMain() !== commit) throw new Error('untrusted-source');
    const webRoot = join(root, 'web');
    if (lstatSync(webRoot).isSymbolicLink() || !lstatSync(webRoot).isDirectory()) throw new Error('untrusted-source');
    try {
      execFileSync(join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm'),
        ['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'],
        { cwd: webRoot, env: safeEnv, timeout: 600_000, stdio: 'ignore' });
    } catch { throw new Error('publication dependency installation failed'); }

    const { register } = await import('tsx/esm/api');
    const unregister = register();
    try {
      const { runNewPublication } = await import('./lib/publication-runner.ts');
      const { readCiEvidence } = await import('./lib/publication-ci.ts');
      const { createPublicationStateStore } = await import('./lib/publication-state-store.ts');
      const { createPublicationCheckPorts } = await import('./lib/publication-check-adapters.ts');
      const { runPublicationChecks } = await import('./lib/publication-checks.ts');
      const { readPublicationSnapshot } = await import('./lib/publication-snapshot.ts');
      const { createSshTransport } = await import('../../scripts/publication-transport.mjs');
      const { digestTree } = await import('../../scripts/publication-launcher.mjs');
      const workDir = join(scratch, 'state');
      const state = createPublicationStateStore({ remote: config.canonicalRepository, workDir, gitEnv });
      const snapshotDir = join(scratch, 'snapshot'); mkdirSync(snapshotDir);
      const reportsDir = join(scratch, 'reports');
      const checkEnv = { PATH: safeEnv.PATH, CHAT_LOADER_SRC: config.chatLoaderSrc,
        ...(config.deployMode === 'stand' ? { DEMO_FORMS: config.demoForms ?? 'stub' } : {}) };
      const captureEnv = { ...safeEnv, ...Object.fromEntries(['CMS_URL', 'CMS_TOKEN', 'STRAPI_URL', 'STRAPI_API_TOKEN']
        .filter((name) => env[name] !== undefined).map((name) => [name, env[name]])) };
      const id = `${new Date().toISOString().replaceAll(/[^0-9]/g, '')}-${randomUUID()}`;
      const [user, host] = config.sshTarget.split('@');
      return await runNewPublication({ commit, destinationId: config.destinationId, deployMode: config.deployMode,
        paymentRole: config.paymentRole, actor: config.actor, origin: config.siteUrl, publicationId: id, releaseId: id,
        treeDir: join(webRoot, 'dist'), reportPath: join(reportsDir, 'publication.json'), env: checkEnv }, {
        readCiEvidence: (sha) => readCiEvidence({ commit: sha, token: env.GH_TOKEN }),
        async runChecks(input) {
          await state.readHistory();
          const ports = createPublicationCheckPorts({ webRoot, snapshotDir, reportsDir, ledgerDir: join(workDir, 'ledger'), captureEnv, payment: config.payment });
          const report = await runPublicationChecks(input, ports);
          return { report, snapshot: readPublicationSnapshot(snapshotDir) };
        },
        readMain: async () => readMain(), state,
        digest: (treeDir) => digestTree(treeDir, artifactFiles(treeDir)),
        createTransport: ({ authorize }) => createSshTransport({ host, user, root: config.webRoot,
          destinationId: config.destinationId, knownHostsFile: config.knownHostsFile, keepReleases: config.keepReleases, authorize }),
        fetch: globalThis.fetch, now: () => new Date().toISOString(),
      });
    } finally { unregister(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const operation = await runPublicationWorker({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() });
    process.stdout.write(`${JSON.stringify({ status: 'success', publicationId: operation.publicationId, commit: operation.commit,
      snapshotId: operation.snapshotId, destinationId: operation.destinationId })}\n`);
  } catch {
    // Effect errors may contain command output or credentials; never print the raw exception.
    process.stderr.write('{"status":"refused","reason":"publication-worker-failed"}\n');
    process.exitCode = 1;
  }
}
