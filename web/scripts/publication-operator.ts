#!/usr/bin/env node
// Native Node bootstrap: validate the protected installation before dependency imports.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerAudit } from './publication-audit.ts';
import { artifactFiles, protectedFile, readConfig } from './publication-context.ts';

interface OperatorInput { argv: string[]; env: Record<string, string | undefined>; cwd: string }
function rollbackArguments(argv: string[]) {
  if (argv[0] !== 'rollback') throw new Error('invalid-arguments');
  const options = new Map<string, string | boolean>();
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (!['--release-id', '--confirm', '--reason'].includes(key) || options.has(key)) throw new Error('invalid-arguments');
    if (key === '--confirm') options.set(key, true);
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid-arguments');
      options.set(key, argv[++i]);
    }
  }
  const releaseId = options.get('--release-id'), reason = options.get('--reason');
  if (options.get('--confirm') !== true || typeof releaseId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId) || typeof reason !== 'string' || !reason.trim()) throw new Error('invalid-arguments');
  return { releaseId, reason, confirmed: true };
}

export async function runPublicationOperator({ argv, env, cwd }: OperatorInput) {
  if (env.GITHUB_ACTIONS === 'true' || env.CI === 'true') throw new Error('hosted-publication-forbidden');
  const input = rollbackArguments(argv);
  if (!env.PUBLICATION_CONFIG || !env.PUBLICATION_LAUNCHER ||
      !env.PUBLICATION_RUNTIME_SHA || !/^[a-f0-9]{40}$/.test(env.PUBLICATION_RUNTIME_SHA)) throw new Error('missing protected publication context');
  const launcher = protectedFile(env.PUBLICATION_LAUNCHER);
  const configPath = protectedFile(env.PUBLICATION_CONFIG);
  const runtime = join(dirname(launcher), 'runtime');
  if (configPath !== join(dirname(launcher), 'config.json') || realpathSync(cwd) !== runtime) throw new Error('untrusted-config');
  for (const path of [runtime, join(runtime, 'web'), join(runtime, 'web/scripts')]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error('untrusted-runtime');
  }
  protectedFile(join(runtime, 'web/scripts/publication-operator.ts'));
  const manifest = JSON.parse(readFileSync(protectedFile(join(runtime, 'runtime.json')), 'utf8'));
  if (manifest.version !== 1 || manifest.commit !== env.PUBLICATION_RUNTIME_SHA) throw new Error('untrusted-runtime');
  const config = readConfig(configPath);
  if (env.PUBLICATION_DESTINATION_ID !== config.destinationId || env.DEPLOY_MODE !== config.deployMode) throw new Error('publication destination mismatch');
  const scratch = mkdtempSync(join(tmpdir(), 'ikpk-publication-operator-'));
  try {
    const home = join(scratch, 'home'); mkdirSync(home);
    const safeEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: scratch };
    const gitEnv: Record<string, string> = { ...safeEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    let repository = false;
    try {
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--absolute-git-dir'],
        { cwd: runtime, env: gitEnv, encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
      repository = true;
    } catch { /* A protected installation must be outside every repository. */ }
    if (repository) throw new Error('untrusted-runtime');
    if (env.SSH_AUTH_SOCK) gitEnv.SSH_AUTH_SOCK = env.SSH_AUTH_SOCK;
    if (env.GH_TOKEN && config.canonicalRepository.startsWith('https://')) {
      Object.assign(gitEnv, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${config.canonicalRepository}.extraheader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64')}` });
    }
    const { register } = await import('tsx/esm/api');
    const unregister = register();
    try {
      const { runPublicationRollback } = await import('./lib/publication-rollback.ts');
      const { createPublicationStateStore } = await import('./lib/publication-state-store.ts');
      const { createSshTransport } = await import('../../scripts/publication-transport.mjs');
      const { createRollbackCheckPorts } = await import('./lib/publication-check-adapters.ts');
      const { runRollbackChecks } = await import('./lib/publication-rollback-checks.ts');
      const { digestTree } = await import('../../scripts/publication-launcher.mjs');
      const state = createPublicationStateStore({ remote: config.canonicalRepository, workDir: join(scratch, 'state'), gitEnv });
      const [user, host] = config.sshTarget.split('@');
      const transportConfig = { host, user, root: config.webRoot, destinationId: config.destinationId,
        knownHostsFile: config.knownHostsFile, keepReleases: config.keepReleases };
      const reportsDir = join(scratch, 'reports');
      const publicationId = `${new Date().toISOString().replaceAll(/[^0-9]/g, '')}-${randomUUID()}`;
      return await runPublicationRollback({ ...input, publicationId, destinationId: config.destinationId, actor: config.actor, origin: config.siteUrl }, {
        state, digest: (treeDir) => digestTree(treeDir, artifactFiles(treeDir)),
        createTransport: ({ authorize }) => createSshTransport({ ...transportConfig, authorize }),
        async runChecks(checkInput, readiness) {
          if (checkInput.paymentRole !== 'ci' && checkInput.paymentRole !== config.paymentRole) throw new Error('retained payment role has no matching protected configuration');
          const adapters = createRollbackCheckPorts({ webRoot: join(runtime, 'web'), treeDir: checkInput.treeDir, reportsDir,
            ...(checkInput.paymentRole !== 'ci' ? { payment: config.payment } : {}) }, readiness);
          return runRollbackChecks({ ...checkInput, reportPath: join(reportsDir, 'rollback.json'), env: { PATH: safeEnv.PATH,
            CHAT_LOADER_SRC: config.chatLoaderSrc, ...(checkInput.deployMode === 'stand' ? { DEMO_FORMS: config.demoForms ?? 'stub' } : {}) } }, adapters);
        },
        fetch: globalThis.fetch, now: () => new Date().toISOString(),
      });
    } finally { unregister(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let audit;
  try { audit = createWorkerAudit({ operation: await runPublicationOperator({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }) }); }
  catch (error) {
    audit = createWorkerAudit({ error });
    if (audit.code === 'publication-failed') audit.code = 'rollback-failed';
    process.exitCode = 1;
  }
  try { writeFileSync(3, JSON.stringify(audit)); }
  catch { process.exitCode = 1; }
}
