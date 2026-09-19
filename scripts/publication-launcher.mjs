#!/usr/bin/env node
/** Install outside every checkout, together with a protected destination config. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SHA256 of sorted [path length, path, byte length, bytes] tuples. No symlinks. */
export async function digestTree(rootDir, filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) throw new Error('empty file list');
  const root = realpathSync(rootDir);
  const hash = createHash('sha256');
  if (new Set(filePaths).size !== filePaths.length) throw new Error('duplicate file path');
  for (const name of [...filePaths].sort()) {
    if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.includes('\0') ||
        name.split('/').some((part) => !part || part === '..' || part === '.')) throw new Error('invalid relative path');
    let path = root;
    for (const part of name.split('/')) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink()) throw new Error('symlink in release path');
    }
    if (!lstatSync(path).isFile()) throw new Error('release path is not a regular file');
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(name)}:`).update(name).update(`${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
const refuse = (reason) => { throw new Error(reason); };
function cleanEnvironment() {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  // No ambient Git/Node/Bash startup options or deployment credentials reach source validation.
  return env;
}
function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd, env: cleanEnvironment(), encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function protectedFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) refuse('untrusted-config');
  return realpathSync(path);
}
function insideRepository(path) { try { git(path, 'rev-parse', '--absolute-git-dir'); return true; } catch { return false; } }

// Kept in the installed, dependency-free launcher: repository code cannot extend this schema.
function workerAudit(bytes, commit, exitStatus) {
  if (typeof bytes !== 'string' || !bytes.length || Buffer.byteLength(bytes) > 16 * 1024) refuse('invalid-worker-audit');
  let audit;
  try { audit = JSON.parse(bytes); } catch { refuse('invalid-worker-audit'); }
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const fields = {
    version: (value) => value === 1,
    status: (value) => value === (exitStatus === 0 ? 'success' : 'refused'),
    code: (value) => exitStatus === 0 ? value === 'published' :
      ['publication-failed', 'checks-failed', 'ci-failed', 'provenance-changed', 'active-unindexed', 'main-changed'].includes(value),
    commit: (value) => value === commit,
    snapshotId: (value) => matches(value, /^snap:[a-f0-9]{64}$/),
    treeDigest: (value) => matches(value, /^[a-f0-9]{64}$/),
    publicationId: (value) => matches(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    observedEntry: integer, revision: integer, latestEntry: integer, highWaterMark: integer,
    localExecutedTests: integer, ciExecutedTests: integer,
    check: (value) => ['snapshot-provenance', 'build-content', 'destination-mode', 'browser-smoke',
      'payment-destination', 'payment-readiness', 'payment-preflight', 'capture', 'build'].includes(value),
    activePair: (value) => object(value) && Object.keys(value).length === 3 &&
      matches(value.commit, /^[a-f0-9]{40}$/) && matches(value.snapshotId, /^snap:[a-f0-9]{64}$/) &&
      matches(value.releaseId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  };
  if (!object(audit) || !['version', 'status', 'code', 'commit'].every((key) => Object.hasOwn(audit, key)) ||
      Object.entries(audit).some(([key, value]) => !Object.hasOwn(fields, key) || !fields[key](value))) refuse('invalid-worker-audit');
  if (exitStatus === 0 && (!['snapshotId', 'treeDigest', 'publicationId'].every((key) => Object.hasOwn(audit, key)) ||
      !['observedEntry', 'revision', 'highWaterMark', 'localExecutedTests', 'ciExecutedTests'].every((key) => audit[key] > 0))) refuse('invalid-worker-audit');
  if ((audit.code === 'active-unindexed') !== Object.hasOwn(audit, 'activePair') ||
      (Object.hasOwn(audit, 'check') && audit.code !== 'checks-failed')) refuse('invalid-worker-audit');
  return audit;
}

export async function launch(args) {
  const checks = [];
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true') refuse('hosted-publication-forbidden');
  if (args[0] !== 'publish') refuse('untrusted-ref');
  const options = new Map();
  for (let i = 1; i < args.length; i += 2) {
    if (!['--config', '--source-url', '--source-ref', '--source-dir'].includes(args[i]) ||
        !args[i + 1] || options.has(args[i])) refuse('invalid-arguments');
    options.set(args[i], args[i + 1]);
  }
  const installed = realpathSync(fileURLToPath(import.meta.url));
  let configPath, config;
  try {
    configPath = protectedFile(resolve(options.get('--config') ?? ''));
    protectedFile(installed);
    if (configPath !== join(dirname(installed), 'config.json') ||
        insideRepository(dirname(configPath)) || insideRepository(dirname(installed))) refuse('untrusted-config');
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { refuse('untrusted-config'); }
  checks.push('protected-config');
  const source = options.get('--source-url');
  if (typeof config.canonicalRepository !== 'string' || !source || source !== config.canonicalRepository || source.startsWith('-')) refuse('untrusted-source');
  checks.push('canonical-repository');
  if (options.get('--source-ref') !== 'main') refuse('untrusted-ref');
  checks.push('main-ref');
  if (!['stand', 'prod'].includes(config.deployMode) || typeof config.destinationId !== 'string' || !config.destinationId ||
      typeof config.sshTarget !== 'string' || !/^[a-zA-Z0-9_.@:-]+$/.test(config.sshTarget) || config.sshTarget.startsWith('-') ||
      !Array.isArray(config.credentialBroker) || !config.credentialBroker.length ||
      config.credentialBroker.some((arg) => typeof arg !== 'string') || !isAbsolute(config.credentialBroker[0])) refuse('untrusted-config');
  checks.push('destination-config');
  const sourceDir = options.get('--source-dir');
  if (sourceDir) {
    const root = realpathSync(sourceDir);
    if (inside(root, configPath) || inside(root, installed)) refuse('untrusted-config');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'ikpk-publication-'));
  try {
    const checkout = join(scratch, 'source');
    let head;
    try {
      // An empty template and disabled hooks prevent local Git configuration from running code.
      git(scratch, 'clone', '--template=', '--no-local', '--single-branch', '--branch', 'main', '--', source, checkout);
      head = git(checkout, 'rev-parse', 'HEAD');
      if (!/^[a-f0-9]{40}$/.test(head) ||
          git(checkout, 'symbolic-ref', 'HEAD') !== 'refs/heads/main' ||
          git(checkout, 'rev-parse', '--verify', 'refs/remotes/origin/main') !== head ||
          git(checkout, 'status', '--porcelain')) refuse('source-unavailable');
    } catch { refuse('source-unavailable'); }
    if (sourceDir && (git(sourceDir, 'rev-parse', 'HEAD') !== head || git(sourceDir, 'remote', 'get-url', 'origin') !== source)) refuse('untrusted-source');
    if (sourceDir) {
      // Read the operator files using the trusted clone's index/config. The operator's
      // .git/config may define executable clean filters, hooks or fsmonitor commands.
      if (git(checkout, '--work-tree', realpathSync(sourceDir), 'status', '--porcelain', '--untracked-files=all')) refuse('dirty-source');
      checks.push('operator-source-clean');
    }
    checks.push('fresh-canonical-main');
    const worker = join(checkout, 'scripts/deploy-web.sh');
    if (lstatSync(join(checkout, 'scripts')).isSymbolicLink() || lstatSync(worker).isSymbolicLink() ||
        !lstatSync(worker).isFile() || !inside(realpathSync(checkout), realpathSync(worker))) refuse('untrusted-source');
    checks.push('contained-worker');
    const broker = spawnSync(config.credentialBroker[0], config.credentialBroker.slice(1), {
      cwd: dirname(configPath), env: cleanEnvironment(), encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    if (broker.error || broker.status !== 0) refuse('credential-broker-failed');
    let credentials;
    try { credentials = JSON.parse(broker.stdout).env; } catch { refuse('credential-broker-failed'); }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
        Object.entries(credentials).some(([name, value]) => !/^(IKPK_[A-Z0-9_]+|SSH_KEY|SSH_AUTH_SOCK|GH_TOKEN|CMS_[A-Z0-9_]+)$/.test(name) || typeof value !== 'string')) refuse('credential-broker-failed');
    checks.push('credential-delivery');
    const result = spawnSync('/bin/bash', [worker, config.sshTarget], { cwd: checkout,
      env: { ...cleanEnvironment(), ...credentials, DEPLOY_MODE: config.deployMode,
        PUBLICATION_DESTINATION_ID: config.destinationId, PUBLICATION_CONFIG: configPath,
        PUBLICATION_SOURCE_SHA: head, PUBLICATION_LAUNCHER: installed },
      encoding: 'utf8', timeout: 3_600_000, maxBuffer: 16 * 1024,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    // Repository subprocess output is not an audit log: it may contain credentials.
    if (result.error || result.status === null) refuse('publication-worker-failed');
    const audit = workerAudit(result.output[3], head, result.status);
    if (result.status !== 0) throw Object.assign(new Error('publication-worker-failed'), { audit });
    checks.push('publication-worker');
    return { status: 'success', executedChecks: checks.length, checks, commit: head, destinationId: config.destinationId, audit };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(`${JSON.stringify(await launch(process.argv.slice(2)))}\n`); }
  catch (error) {
    const reasons = new Set(['hosted-publication-forbidden', 'untrusted-source', 'dirty-source', 'untrusted-ref',
      'source-unavailable', 'untrusted-config', 'invalid-arguments', 'credential-broker-failed', 'publication-worker-failed', 'invalid-worker-audit']);
    process.stderr.write(`${JSON.stringify({ status: 'refused', reason: reasons.has(error.message) ? error.message : 'publication-failed',
      ...(error.audit ? { audit: error.audit } : {}) })}\n`);
    process.exitCode = 1;
  }
}
