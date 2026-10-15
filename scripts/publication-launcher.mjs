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
// Installed policy: never read source/CI policy from the candidate checkout.
export function publicationSourceRef(config) {
  const ref = config.sourceRef ?? 'main';
  if (ref === 'main' && config.sourceProfile === undefined) return ref;
  if (ref === 'dev' && config.sourceProfile === 'demo-dev' && config.deployMode === 'stand' &&
      config.paymentRole === 'ci' && /^(?!root@)[a-z_][a-z0-9_-]*@193\.124\.115\.99$/.test(config.sshTarget) &&
      config.siteUrl === 'https://staging.ikpk.su') return ref;
  refuse('untrusted-ref');
}
export const SOURCE_CI_JOBS = Object.freeze(['Capture content snapshot', 'Unit and build tests',
  'Dependency update invariants', 'Scripts unit tests', 'Playwright smoke (desktop + mobile)']);
/** Read only, before the credential broker or any candidate executable. */
export async function verifySourceCi({ commit, sourceRef, token, fetch: fetcher = globalThis.fetch }) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !['main', 'dev'].includes(sourceRef)) refuse('source-ci-failed');
  const api = 'https://api.github.com/repos/pgorbachev/ikpk';
  async function request(url) {
    if (!url.startsWith(`${api}/`)) refuse('source-ci-failed');
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!response.ok || !response.body) refuse('source-ci-failed');
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 16 * 1024 * 1024) refuse('source-ci-failed'); chunks.push(value); }
    } finally { await reader.cancel(); }
    return { response, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  }
  async function list(initial, key) {
    let url = initial; const seen = new Set(); const items = [];
    while (url) {
      if (seen.has(url) || seen.size >= 100) refuse('source-ci-failed'); seen.add(url);
      const { response, data } = await request(url);
      if (!Array.isArray(data?.[key]) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) refuse('source-ci-failed');
      items.push(...data[key]);
      const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (next && (new URL(next).origin !== new URL(initial).origin || new URL(next).pathname !== new URL(initial).pathname)) refuse('source-ci-failed');
      if (!next && items.length !== data.total_count) refuse('source-ci-failed'); url = next;
    }
    return items;
  }
  try {
    const { data: head } = await request(`${api}/git/ref/heads/${sourceRef}`);
    if (head.ref !== `refs/heads/${sourceRef}` || head.object?.sha !== commit) refuse('source-ci-failed');
    const runs = await list(`${api}/actions/workflows/test.yml/runs?branch=${sourceRef}&head_sha=${commit}&per_page=100`, 'workflow_runs');
    const run = runs.filter(candidate => candidate.head_sha === commit && candidate.head_branch === sourceRef &&
      candidate.path === '.github/workflows/test.yml' && candidate.repository?.full_name === 'pgorbachev/ikpk' &&
      candidate.head_repository?.full_name === 'pgorbachev/ikpk' &&
      (candidate.event === 'push' || (sourceRef === 'main' && candidate.event === 'schedule'))).sort((a, b) => b.id - a.id)[0];
    if (!run || !Number.isSafeInteger(run.id) || run.id <= 0 || run.status !== 'completed' || run.conclusion !== 'success') refuse('source-ci-failed');
    const jobs = await list(`${api}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, 'jobs');
    for (const name of SOURCE_CI_JOBS) {
      const matches = jobs.filter(job => job.name === name);
      if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') refuse('source-ci-failed');
    }
    return { runId: run.id, commit, sourceRef };
  } catch { refuse('source-ci-failed'); }
}
function cleanEnvironment() {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  // No ambient Git/Node/Bash startup options or deployment credentials reach source validation.
  return env;
}
// The canonical clone moves the whole pack (323 MiB on 2026-09-20) over the operator's link;
// two minutes refused a healthy source as `source-unavailable`. Local Git commands keep the
// short limit, the network clone gets its own.
export const GIT_TIMEOUT_MS = 120_000, CLONE_TIMEOUT_MS = 1_800_000;
export const gitTimeoutFor = (args) => (args[0] === 'clone' ? CLONE_TIMEOUT_MS : GIT_TIMEOUT_MS);
function git(cwd, ...args) {
  const timeout = gitTimeoutFor(args);
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd, env: cleanEnvironment(), encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function protectedFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) refuse('untrusted-config');
  return realpathSync(path);
}
function insideRepository(path) { try { git(path, 'rev-parse', '--absolute-git-dir'); return true; } catch { return false; } }

function brokerCredentials(config, configPath) {
  const broker = spawnSync(config.credentialBroker[0], config.credentialBroker.slice(1), {
    cwd: dirname(configPath), env: cleanEnvironment(), encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  if (broker.error || broker.status !== 0) refuse('credential-broker-failed');
  let credentials;
  try { credentials = JSON.parse(broker.stdout).env; } catch { refuse('credential-broker-failed'); }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
      Object.entries(credentials).some(([name, value]) => !/^(IKPK_[A-Z0-9_]+|SSH_KEY|SSH_AUTH_SOCK|GH_TOKEN|CMS_[A-Z0-9_]+)$/.test(name) || typeof value !== 'string')) refuse('credential-broker-failed');
  return credentials;
}

// Kept in the installed, dependency-free launcher: repository code cannot extend this schema.
function workerAudit(bytes, commit, exitStatus, releaseId, operatorInput) {
  const rollback = releaseId !== undefined;
  if (typeof bytes !== 'string' || !bytes.length || Buffer.byteLength(bytes) > 16 * 1024) refuse('invalid-worker-audit');
  let audit;
  try { audit = JSON.parse(bytes); } catch { refuse('invalid-worker-audit'); }
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  if (operatorInput) {
    const accepting = operatorInput.command === 'accept-state';
    const fields = { version: (value) => value === 1, status: (value) => value === (exitStatus === 0 ? 'success' : 'refused'),
      code: (value) => exitStatus === 0 ? (accepting ? ['state-accepted'] : ['recovered', 'recovery-noop', 'recovery-cancelled']).includes(value) :
        value === (accepting ? 'accept-state-failed' : 'recovery-failed') };
    if (exitStatus === 0 && accepting) Object.assign(fields, {
      observedEntry: (value) => value === operatorInput.observedEntry,
      revision: (value) => value === operatorInput.observedEntry + 1,
    });
    if (exitStatus === 0 && !accepting && audit?.code === 'recovered') Object.assign(fields, {
      commit: (value) => matches(value, /^[a-f0-9]{40}$/), snapshotId: (value) => matches(value, /^snap:[a-f0-9]{64}$/),
      releaseId: (value) => matches(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      treeDigest: (value) => matches(value, /^[a-f0-9]{64}$/), publicationId: (value) => matches(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      revision: (value) => integer(value) && value > 0, localExecutedTests: (value) => integer(value) && value > 0,
      ciExecutedTests: (value) => integer(value) && value > 0,
    });
    if (!object(audit) || Object.keys(fields).some((key) => !Object.hasOwn(audit, key)) ||
        Object.entries(audit).some(([key, value]) => !Object.hasOwn(fields, key) || !fields[key](value))) refuse('invalid-worker-audit');
    return audit;
  }
  const fields = {
    version: (value) => value === 1,
    status: (value) => value === (exitStatus === 0 ? 'success' : 'refused'),
    code: (value) => exitStatus === 0 ? value === (rollback ? 'rolled-back' : 'published') :
      (rollback ? ['rollback-failed', 'checks-failed', 'active-unindexed'] : ['publication-failed', 'checks-failed', 'ci-failed', 'provenance-changed', 'active-unindexed', 'main-changed']).includes(value),
    commit: (value) => rollback ? matches(value, /^[a-f0-9]{40}$/) : value === commit,
    ...(rollback ? { releaseId: (value) => value === releaseId } : {}),
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
  if (!object(audit) || !['version', 'status', 'code', ...(!rollback || exitStatus === 0 ? ['commit'] : [])].every((key) => Object.hasOwn(audit, key)) ||
      Object.entries(audit).some(([key, value]) => !Object.hasOwn(fields, key) || !fields[key](value))) refuse('invalid-worker-audit');
  if (exitStatus === 0 && (!['snapshotId', 'treeDigest', 'publicationId', ...(rollback ? ['releaseId'] : [])].every((key) => Object.hasOwn(audit, key)) ||
      !['revision', 'localExecutedTests', 'ciExecutedTests', ...(!rollback ? ['observedEntry', 'highWaterMark'] : [])].every((key) => audit[key] > 0))) refuse('invalid-worker-audit');
  if ((audit.code === 'active-unindexed') !== Object.hasOwn(audit, 'activePair') ||
      (Object.hasOwn(audit, 'check') && audit.code !== 'checks-failed') ||
      (rollback && audit.activePair && (audit.activePair.releaseId !== releaseId || audit.activePair.commit !== audit.commit || audit.activePair.snapshotId !== audit.snapshotId))) refuse('invalid-worker-audit');
  return audit;
}

export async function launch(args, { fetch = globalThis.fetch } = {}) {
  const checks = [];
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true') refuse('hosted-publication-forbidden');
  if (!['publish', 'rollback', 'recover', 'accept-state'].includes(args[0])) refuse('untrusted-ref');
  const command = args[0], rollback = command === 'rollback', accepting = command === 'accept-state';
  const options = new Map();
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    const allowed = rollback ? ['--config', '--release-id', '--confirm', '--reason'] :
      accepting ? ['--config', '--observed-entry', '--fingerprint', '--confirm'] : command === 'recover' ? ['--config'] :
        ['--config', '--source-url', '--source-ref', '--source-dir', '--expected-sha'];
    if (!allowed.includes(key) || options.has(key)) refuse('invalid-arguments');
    if (key === '--confirm') options.set(key, true);
    else {
      if (typeof args[i + 1] !== 'string' || !args[i + 1] || args[i + 1].startsWith('--')) refuse('invalid-arguments');
      options.set(key, args[++i]);
    }
  }
  if (rollback && (!options.has('--config') || !options.has('--confirm') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.get('--release-id') ?? '') ||
      !options.get('--reason')?.trim())) refuse('invalid-arguments');
  if (command === 'recover' && !options.has('--config')) refuse('invalid-arguments');
  const observedEntry = Number(options.get('--observed-entry'));
  if (accepting && (!options.has('--config') || !options.has('--confirm') ||
      !/^[1-9][0-9]*$/.test(options.get('--observed-entry') ?? '') || !Number.isSafeInteger(observedEntry) ||
      observedEntry >= Number.MAX_SAFE_INTEGER || !options.get('--fingerprint')?.trim())) refuse('invalid-arguments');
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
  if (!['stand', 'prod'].includes(config.deployMode) || typeof config.destinationId !== 'string' || !config.destinationId ||
      typeof config.sshTarget !== 'string' || !/^[a-zA-Z0-9_.@:-]+$/.test(config.sshTarget) || config.sshTarget.startsWith('-') ||
      !Array.isArray(config.credentialBroker) || !config.credentialBroker.length ||
      config.credentialBroker.some((arg) => typeof arg !== 'string') || !isAbsolute(config.credentialBroker[0])) refuse('untrusted-config');
  checks.push('destination-config');
  const sourceRef = publicationSourceRef(config);
  if (command !== 'publish') {
    const runtime = join(dirname(installed), 'runtime');
    const entry = join(runtime, 'web/scripts/publication-operator.ts');
    let manifest;
    try {
      // Check each installed component before realpath can erase a symlink.
      for (const path of [runtime, join(runtime, 'web'), join(runtime, 'web/scripts')]) {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) refuse('untrusted-runtime');
      }
      protectedFile(entry);
      manifest = JSON.parse(readFileSync(protectedFile(join(runtime, 'runtime.json')), 'utf8'));
      if (manifest.version !== 1 || typeof manifest.commit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.commit) || insideRepository(runtime)) refuse('untrusted-runtime');
    } catch { refuse('untrusted-runtime'); }
    checks.push('protected-runtime');
    const credentials = brokerCredentials(config, configPath);
    checks.push('credential-delivery');
    const releaseId = options.get('--release-id');
    const workerArgs = rollback ? ['rollback', '--release-id', releaseId, '--confirm', '--reason', options.get('--reason')] :
      accepting ? ['accept-state', '--observed-entry', options.get('--observed-entry'), '--fingerprint', options.get('--fingerprint'), '--confirm'] : ['recover'];
    const result = spawnSync(process.execPath, [entry, ...workerArgs], {
      cwd: runtime, env: { ...cleanEnvironment(), ...credentials, DEPLOY_MODE: config.deployMode,
        PUBLICATION_DESTINATION_ID: config.destinationId, PUBLICATION_CONFIG: configPath,
        PUBLICATION_RUNTIME_SHA: manifest.commit, PUBLICATION_LAUNCHER: installed },
      encoding: 'utf8', timeout: 3_600_000, maxBuffer: 16 * 1024, stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    if (result.error || result.status === null) refuse('publication-worker-failed');
    const audit = workerAudit(result.output[3], undefined, result.status, releaseId, rollback ? undefined : { command, observedEntry });
    if (result.status !== 0) throw Object.assign(new Error('publication-worker-failed'), { audit });
    checks.push('publication-worker');
    return { status: 'success', executedChecks: checks.length, checks, commit: audit.commit, destinationId: config.destinationId, audit };
  }
  const source = options.get('--source-url');
  if (typeof config.canonicalRepository !== 'string' || !source || source !== config.canonicalRepository || source.startsWith('-')) refuse('untrusted-source');
  checks.push('canonical-repository');
  if (options.get('--source-ref') !== sourceRef) refuse('untrusted-ref');
  if (options.has('--expected-sha') && !/^[a-f0-9]{40}$/.test(options.get('--expected-sha'))) refuse('invalid-arguments');
  checks.push(`${sourceRef}-ref`);
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
      git(scratch, 'clone', '--template=', '--no-local', '--single-branch', '--branch', sourceRef, '--', source, checkout);
      head = git(checkout, 'rev-parse', 'HEAD');
      if (!/^[a-f0-9]{40}$/.test(head) ||
          git(checkout, 'symbolic-ref', 'HEAD') !== `refs/heads/${sourceRef}` ||
          git(checkout, 'rev-parse', '--verify', `refs/remotes/origin/${sourceRef}`) !== head ||
          git(checkout, 'status', '--porcelain')) refuse('source-unavailable');
    } catch { refuse('source-unavailable'); }
    if (options.has('--expected-sha') && options.get('--expected-sha') !== head) refuse('source-sha-mismatch');
    if (sourceDir && (git(sourceDir, 'rev-parse', 'HEAD') !== head || git(sourceDir, 'remote', 'get-url', 'origin') !== source)) refuse('untrusted-source');
    if (sourceDir) {
      // Read the operator files using the trusted clone's index/config. The operator's
      // .git/config may define executable clean filters, hooks or fsmonitor commands.
      if (git(checkout, '--work-tree', realpathSync(sourceDir), 'status', '--porcelain', '--untracked-files=all')) refuse('dirty-source');
      checks.push('operator-source-clean');
    }
    checks.push(`fresh-canonical-${sourceRef}`);
    const worker = join(checkout, 'scripts/deploy-web.sh');
    if (lstatSync(join(checkout, 'scripts')).isSymbolicLink() || lstatSync(worker).isSymbolicLink() ||
        !lstatSync(worker).isFile() || !inside(realpathSync(checkout), realpathSync(worker))) refuse('untrusted-source');
    checks.push('contained-worker');
    let ciToken;
    if (config.ciTokenFile !== undefined) {
      try {
        if (typeof config.ciTokenFile !== 'string' || !isAbsolute(config.ciTokenFile)) refuse('untrusted-config');
        const path = protectedFile(config.ciTokenFile), stat = lstatSync(path);
        if ((stat.mode & 0o077) || stat.uid !== process.getuid() || insideRepository(dirname(path))) refuse('untrusted-config');
        ciToken = readFileSync(path, 'utf8').trim();
        if (!ciToken || /\s/.test(ciToken)) refuse('untrusted-config');
      } catch { refuse('untrusted-config'); }
    }
    await verifySourceCi({ commit: head, sourceRef, token: ciToken, fetch });
    checks.push('trusted-source-ci');
    // CI reads may take time: bind credential delivery to the same canonical head again.
    try {
      const remoteHead = git(scratch, 'ls-remote', '--exit-code', '--refs', '--', source, `refs/heads/${sourceRef}`);
      if (remoteHead.split(/\s+/).join(' ') !== `${head} refs/heads/${sourceRef}`) refuse('source-sha-mismatch');
    } catch { refuse('source-sha-mismatch'); }
    const credentials = brokerCredentials(config, configPath);
    checks.push('credential-delivery');
    const result = spawnSync('/bin/bash', [worker, config.sshTarget], { cwd: checkout,
      env: { ...cleanEnvironment(), ...credentials, DEPLOY_MODE: config.deployMode,
        PUBLICATION_DESTINATION_ID: config.destinationId, PUBLICATION_CONFIG: configPath,
        PUBLICATION_SOURCE_SHA: head, PUBLICATION_SOURCE_REF: sourceRef, PUBLICATION_LAUNCHER: installed },
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
      'source-unavailable', 'source-sha-mismatch', 'source-ci-failed', 'untrusted-config', 'untrusted-runtime', 'invalid-arguments', 'credential-broker-failed', 'publication-worker-failed', 'invalid-worker-audit']);
    process.stderr.write(`${JSON.stringify({ status: 'refused', reason: reasons.has(error.message) ? error.message : 'publication-failed',
      ...(error.audit ? { audit: error.audit } : {}) })}\n`);
    process.exitCode = 1;
  }
}
