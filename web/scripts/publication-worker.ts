#!/usr/bin/env node
// Native Node 24 bootstrap: no repository/dependency imports before validation and npm ci.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorkerAudit } from './publication-audit.ts';
import type { WorkerAudit } from './publication-audit.ts';
export { createWorkerAudit } from './publication-audit.ts';
export type { WorkerAudit } from './publication-audit.ts';
interface WorkerInput { argv: string[]; env: Record<string, string | undefined>; cwd: string }
import { artifactFiles, inside, protectedFile, readConfig } from './publication-context.ts';
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
