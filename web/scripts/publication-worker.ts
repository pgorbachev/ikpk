#!/usr/bin/env node
// Native Node 24 bootstrap: no repository/dependency imports before validation and npm ci.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WorkerAudit {
  version: 1; status: 'success' | 'refused';
  code: 'published' | 'publication-failed' | 'checks-failed' | 'ci-failed' | 'provenance-changed' | 'active-unindexed' | 'main-changed';
  commit?: string; snapshotId?: string; treeDigest?: string; publicationId?: string;
  observedEntry?: number; revision?: number; latestEntry?: number; highWaterMark?: number;
  localExecutedTests?: number; ciExecutedTests?: number; check?: string;
  activePair?: { commit: string; snapshotId: string; releaseId: string };
}
const auditCodes = ['publication-failed', 'checks-failed', 'ci-failed', 'provenance-changed', 'active-unindexed', 'main-changed'];
const auditChecks = ['snapshot-provenance', 'build-content', 'destination-mode', 'browser-smoke', 'payment-destination', 'payment-readiness', 'payment-preflight', 'capture', 'build'];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Builtin-only, pure curator. No exception messages, causes, log strings or sinks. */
export function createWorkerAudit({ operation, error }: { operation?: unknown; error?: unknown }): WorkerAudit {
  const source = operation === undefined ? object(object(error).audit) : object(operation);
  const audit: WorkerAudit = { version: 1, status: operation === undefined ? 'refused' : 'success',
    code: operation === undefined ? (typeof source.code === 'string' && auditCodes.includes(source.code) ? source.code as WorkerAudit['code'] : 'publication-failed') : 'published' };
  for (const [field, pattern] of Object.entries({ commit: /^[a-f0-9]{40}$/, snapshotId: /^snap:[a-f0-9]{64}$/,
    treeDigest: /^[a-f0-9]{64}$/, publicationId: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ })) {
    if (typeof source[field] === 'string' && pattern.test(source[field])) Object.assign(audit, { [field]: source[field] });
  }
  for (const field of ['observedEntry', 'revision', 'latestEntry', 'highWaterMark', 'localExecutedTests', 'ciExecutedTests']) {
    if (count(source[field])) Object.assign(audit, { [field]: source[field] });
  }
  if (operation !== undefined) {
    const groups = object(source.localChecks).groups;
    if (Array.isArray(groups) && groups.length && groups.every((group) => count(object(group).executedTests))) {
      const total = groups.reduce((sum, group) => sum + Number(object(group).executedTests), 0);
      if (count(total)) audit.localExecutedTests = total;
    }
    if (count(object(source.ciEvidence).executedTests)) audit.ciExecutedTests = object(source.ciEvidence).executedTests as number;
  }
  if (typeof source.check === 'string' && auditChecks.includes(source.check)) audit.check = source.check as string;
  const pair = object(source.activePair);
  if (audit.code === 'active-unindexed' && typeof pair.commit === 'string' && /^[a-f0-9]{40}$/.test(pair.commit) &&
      typeof pair.snapshotId === 'string' && /^snap:[a-f0-9]{64}$/.test(pair.snapshotId) &&
      typeof pair.releaseId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pair.releaseId)) {
    audit.activePair = { commit: pair.commit, snapshotId: pair.snapshotId, releaseId: pair.releaseId };
  }
  return audit;
}

interface WorkerInput { argv: string[]; env: Record<string, string | undefined>; cwd: string }
interface DestinationConfig {
  canonicalRepository: string; sshTarget: string; destinationId: string; deployMode: 'stand' | 'prod';
  paymentRole: 'ci' | 'stand' | 'prod'; siteUrl: string; actor: string; webRoot: string;
  knownHostsFile: string; keepReleases: number; chatLoaderSrc: string; demoForms?: string;
  payment?: { endpoint: string; mode: 'test' | 'prod'; shopId: string; siteOrigin: string };
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
    const expected = config.paymentRole === 'stand' ? { mode: 'test', shopId: '1440249' } : { mode: 'prod', shopId: '409285' };
    if (!payment || payment.mode !== expected.mode || payment.shopId !== expected.shopId) throw new Error('untrusted-config');
    publicUrl(payment.endpoint); publicUrl(payment.siteOrigin, true);
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
    {
      const directory = dirname(launcher);
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
      const transportConfig = { host, user, root: config.webRoot, destinationId: config.destinationId,
        knownHostsFile: config.knownHostsFile, keepReleases: config.keepReleases };
      async function paymentReadiness() {
        if (config.paymentRole === 'ci') throw new Error('ci must not contact payment API');
        let usable = true;
        try {
          const transport = createSshTransport({ ...transportConfig, async authorize(request: { action: string; destinationId: string }) {
            if (!usable || request.destinationId !== config.destinationId || !['connect', 'payment-readiness'].includes(request.action)) {
              throw new Error('readiness action not authorized');
            }
            return { commit, destinationId: config.destinationId };
          } });
          return await transport.withLock((session: { paymentReadiness(): Promise<{ status: number; contentType: string; body: unknown }> }) => session.paymentReadiness());
        } finally { usable = false; }
      }
      return await runNewPublication({ commit, destinationId: config.destinationId, deployMode: config.deployMode,
        paymentRole: config.paymentRole, actor: config.actor, origin: config.siteUrl, publicationId: id, releaseId: id,
        treeDir: join(webRoot, 'dist'), reportPath: join(reportsDir, 'publication.json'), env: checkEnv }, {
        readCiEvidence: (sha) => readCiEvidence({ commit: sha, token: env.GH_TOKEN }),
        async runChecks(input) {
          await state.readHistory();
          const ports = createPublicationCheckPorts({ webRoot, snapshotDir, reportsDir, ledgerDir: join(workDir, 'ledger'), captureEnv, payment: config.payment }, { paymentReadiness });
          const report = await runPublicationChecks(input, ports);
          return { report, snapshot: readPublicationSnapshot(snapshotDir) };
        },
        readMain: async () => readMain(), state,
        digest: (treeDir) => digestTree(treeDir, artifactFiles(treeDir)),
        createTransport: ({ authorize }) => createSshTransport({ ...transportConfig, authorize }),
        fetch: globalThis.fetch, now: () => new Date().toISOString(),
      });
    } finally { unregister(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let audit: WorkerAudit;
  try {
    const operation = await runPublicationWorker({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() });
    audit = createWorkerAudit({ operation });
  } catch (error) {
    audit = createWorkerAudit({ error });
    process.exitCode = 1;
  }
  if (/^[a-f0-9]{40}$/.test(process.env.PUBLICATION_SOURCE_SHA ?? '')) audit.commit = process.env.PUBLICATION_SOURCE_SHA;
  // FD 3 is the sole operator channel; subprocess stdout/stderr are never audit input.
  try { writeFileSync(3, JSON.stringify(audit)); }
  catch { process.exitCode = 1; }
}
