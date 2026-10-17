#!/usr/bin/env node
/** Installed outside checkouts. One durable receipt per request; systemd + flock own execution. */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, openSync, fsyncSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EXCLUDED_HISTORICAL, PENDING_SCOPE, RELEASE_TEST_POLICY_VERSION, RELEASE_TEST_WORKFLOW, SOURCE_SUITES } from './release-test-policy.mjs';
import { NON_TEST_CHECKS, REPORT_POLICY_VERSION, SOURCE_REPORT_PROFILE, validateReportSummaries } from './release-test-reports.mjs';

export const validId = (id) => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const fail = (message) => { throw new Error(message); };
const plain = (x) => x && typeof x === 'object' && !Array.isArray(x);
function validateManifest(zip, evidence, sha) {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-source-proof-'));
  try {
    const archive = join(dir, 'proof.zip'); writeFileSync(archive, zip, { mode: 0o600, flag: 'wx' });
    const names = execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 16384, timeout: 10000 }).trim().split('\n');
    if (names.length !== 1 || names[0] !== 'release-source-tests.json') fail('invalid-source-manifest');
    const manifest = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', archive, names[0]], { encoding: 'utf8', maxBuffer: 65536, timeout: 10000 }));
    const ref = evidence.sourceRef;
    if (manifest.schemaVersion !== RELEASE_TEST_POLICY_VERSION || manifest.workflow !== RELEASE_TEST_WORKFLOW ||
        manifest.commit !== sha || manifest.runId !== evidence.runId || manifest.runAttempt !== evidence.runAttempt ||
        manifest.subject !== 'source-code' || !['push', 'workflow_dispatch'].includes(manifest.event) ||
        (manifest.event === 'push' && !['main', 'dev'].includes(ref)) || manifest.suites?.join('\0') !== SOURCE_SUITES.join('\0') ||
        manifest.reportPolicyVersion !== REPORT_POLICY_VERSION || manifest.sourceProfile !== SOURCE_REPORT_PROFILE ||
        manifest.pendingScope?.length !== 0 || JSON.stringify(manifest.nonTestChecks) !== JSON.stringify(NON_TEST_CHECKS) ||
        JSON.stringify(manifest.excludedHistorical) !== JSON.stringify(EXCLUDED_HISTORICAL) ||
        !plain(manifest.results) || Object.keys(manifest.results).sort().join('\0') !== ['identity', 'source-tests', 'supplemental', 'visual', 'provision'].sort().join('\0') ||
        ['identity', 'source-tests', 'supplemental', 'visual', 'provision'].some((name) => manifest.results[name] !== 'success')) {
      fail('invalid-source-manifest');
    }
    validateReportSummaries(manifest.reports, { profile: SOURCE_REPORT_PROFILE });
  } catch (error) {
    if (error.code === 'invalid-source-manifest') throw error;
    fail('invalid-source-manifest');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
export function protectedPath(path, directory = false, privateFile = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('untrusted-installation');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & (privateFile ? 0o077 : 0o022)) || ![0, process.getuid()].includes(stat.uid)) fail('untrusted-installation');
  return realpathSync(path);
}
function outsideRepository(path) {
  for (let p = path;; p = dirname(p)) {
    if (existsSync(join(p, '.git'))) fail('installation-inside-repository');
    if (p === dirname(p)) return;
  }
}
export function readServerConfig(installed) {
  protectedPath(installed); const root = protectedPath(dirname(installed), true); outsideRepository(root);
  const path = protectedPath(join(root, 'server.json'));
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (!plain(c) || c.version !== 1 || !['demo', 'prod'].includes(c.destination) ||
      Object.hasOwn(c, 'releaseCiTokenFile') ||
      !['main', 'dev'].includes(c.sourceRef) || (c.destination === 'prod' && c.sourceRef !== 'main') ||
      c.repository !== 'pgorbachev/ikpk' || !Number.isSafeInteger(c.timeoutSeconds) || c.timeoutSeconds < 60 || c.timeoutSeconds > 14400) fail('untrusted-server-config');
  c.launcher = protectedPath(c.launcher); c.launcherConfig = protectedPath(join(dirname(c.launcher), 'config.json'));
  outsideRepository(dirname(c.launcher));
  const publisher = JSON.parse(readFileSync(c.launcherConfig, 'utf8'));
  if (Object.hasOwn(publisher, 'ciTokenFile')) fail('untrusted-server-config');
  if (publisher.sourceRef !== undefined && publisher.sourceRef !== c.sourceRef) fail('source-policy-mismatch');
  if ((publisher.sourceRef ?? 'main') !== c.sourceRef || publisher.canonicalRepository !== 'https://github.com/pgorbachev/ikpk.git' ||
      (c.destination === 'prod' ? publisher.deployMode !== 'prod' : publisher.deployMode !== 'stand')) fail('source-policy-mismatch');
  // Shared regular lock across demo/prod users on the VPS; group read is enough for flock.
  if (typeof c.buildLockFile !== 'string' || !isAbsolute(c.buildLockFile)) fail('untrusted-build-lock');
  const lock = lstatSync(c.buildLockFile);
  if (!lock.isFile() || lock.isSymbolicLink() || (lock.mode & 0o002)) fail('untrusted-build-lock');
  const state = join(root, 'operations');
  if (!existsSync(state)) mkdirSync(state, { mode: 0o700 });
  protectedPath(state, true, true);
  return { ...c, installed, root, state, canonicalRepository: publisher.canonicalRepository };
}
export function validateRequest(input, destination) {
  if (!plain(input) || !validId(input.id) || input.destination !== destination || !['publish', 'recover', 'rollback'].includes(input.action)) fail('invalid-request');
  const allowed = ['id', 'destination', 'action', ...(input.action === 'publish' ? ['sourceSha', 'sourceCiEvidence', ...(destination === 'prod' ? ['sourceTag'] : [])] : []), ...(input.action === 'rollback' ? ['releaseId', 'reason'] : [])];
  if (Object.keys(input).some((k) => !allowed.includes(k))) fail('invalid-request');
  if (input.action === 'publish') {
    if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) fail('request-too-large');
    const evidence = input.sourceCiEvidence, ref = destination === 'prod' ? 'main' : 'dev';
    if (!/^[0-9a-f]{40}$/.test(input.sourceSha ?? '') || !plain(evidence) || evidence.commit !== input.sourceSha || evidence.sourceRef !== ref) fail('source-evidence-identity-mismatch');
    if (Object.keys(evidence).sort().join(',') !== 'artifactDigest,artifactZipBase64,commit,repository,runAttempt,runId,sourceRef,workflow' ||
        evidence.repository !== 'pgorbachev/ikpk' || evidence.workflow !== '.github/workflows/release-tests.yml' ||
        !Number.isSafeInteger(evidence.runId) || evidence.runId < 1 || !Number.isSafeInteger(evidence.runAttempt) || evidence.runAttempt < 1 ||
        typeof evidence.artifactDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evidence.artifactDigest) ||
        typeof evidence.artifactZipBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(evidence.artifactZipBase64)) fail('invalid-source-evidence');
    const zip = Buffer.from(evidence.artifactZipBase64, 'base64');
    if (zip.length > 4 * 1024 * 1024) fail('request-too-large');
    if (zip.toString('base64') !== evidence.artifactZipBase64 || `sha256:${createHash('sha256').update(zip).digest('hex')}` !== evidence.artifactDigest) fail('invalid-source-evidence-digest');
    validateManifest(zip, evidence, input.sourceSha);
    if (destination === 'prod' && input.sourceTag !== `prod-src-${input.sourceSha}`) fail('invalid-source-tag');
    if (destination === 'demo' && Object.hasOwn(input, 'sourceTag')) fail('invalid-source-tag');
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) fail('request-too-large');
  if (input.action === 'rollback' && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.releaseId ?? '') ||
      typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500)) fail('invalid-request');
  const request = Object.fromEntries(allowed.map((key) => [key, input[key]]));
  if (input.action === 'publish') request.sourceCiEvidence = Object.fromEntries(
    ['repository', 'workflow', 'sourceRef', 'commit', 'runId', 'runAttempt', 'artifactDigest', 'artifactZipBase64'].map((key) => [key, input.sourceCiEvidence[key]]));
  return request;
}
function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.new`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
function json(path) { protectedPath(path, false, true); return JSON.parse(readFileSync(path, 'utf8')); }
function folder(config, id) { if (!validId(id)) fail('invalid-request-id'); return join(config.state, id); }
export const unitName = (c, id) => `ikpk-release-${c.destination}-${id}.service`;
const safeEnv = () => ({ PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS });
/** The installed launcher emits refusal and post-switch audit to stderr, success to stdout. */
export function publisherResult(run) {
  if (run.error || run.status === null) fail('publisher-interrupted');
  let result;
  try { result = JSON.parse(run.status === 0 ? run.stdout : run.stderr); }
  catch { fail('publisher-result-unavailable'); }
  if (!plain(result) || !['success', 'refused'].includes(result.status) ||
      (run.status === 0) !== (result.status === 'success')) fail('publisher-result-unavailable');
  return result;
}
const defaultPorts = {
  now: () => new Date().toISOString(),
  start(c, id) {
    const run = spawnSync('/usr/bin/systemd-run', ['--user', '--quiet', `--unit=${unitName(c, id)}`,
      '--property=Type=exec', '--property=UMask=0077', '--property=KillMode=control-group', `--property=RuntimeMaxSec=${c.timeoutSeconds}`,
      '--', '/usr/bin/flock', '--exclusive', '--nonblock', '--conflict-exit-code', '75', c.buildLockFile,
      process.execPath, c.installed, 'execute', id], { env: safeEnv(), encoding: 'utf8', stdio: 'ignore', timeout: 30000 });
    if (run.error || run.status !== 0) fail('service-start-unconfirmed');
  },
  service(c, id) {
    const result = spawnSync('/usr/bin/systemctl', ['--user', 'show', unitName(c, id), '--property=LoadState', '--property=ActiveState', '--property=ExecMainStatus'],
      { env: safeEnv(), encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.error) return { state: 'unknown' };
    const values = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split('=')));
    if (values.LoadState === 'not-found') return { state: 'absent' };
    if (result.status !== 0 || !values.ActiveState) return { state: 'unknown' };
    return { state: values.ActiveState, exitCode: Number(values.ExecMainStatus) };
  },
  publisher(c, receipt) {
    const request = receipt.request;
    const args = [c.launcher, request.action, '--config', c.launcherConfig];
    if (request.action === 'publish') args.push('--source-url', c.canonicalRepository, '--source-ref', c.sourceRef,
      '--expected-sha', receipt.commit, '--source-proof-file', join(c.state, request.id, 'tests.json'));
    if (request.action === 'rollback') args.push('--release-id', request.releaseId, '--reason', request.reason, '--confirm');
    const run = spawnSync(process.execPath, args, { env: safeEnv(), encoding: 'utf8', maxBuffer: 64 * 1024,
      timeout: c.timeoutSeconds * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
    return publisherResult(run);
  },
};
export function createServer(config, overrides = {}) {
  const ports = { ...defaultPorts, ...overrides };
  function status(id) {
    const dir = folder(config, id);
    if (!existsSync(dir)) return { id, destination: config.destination, status: 'not-found', code: 'request-not-found' };
    protectedPath(dir, true, true);
    if (!existsSync(join(dir, 'request.json'))) return { id, destination: config.destination, status: 'unknown', code: 'request-acceptance-incomplete' };
    const receipt = json(join(dir, 'request.json'));
    if (existsSync(join(dir, 'result.json'))) return json(join(dir, 'result.json'));
    const service = ports.service(config, id);
    let state = ['active', 'deactivating'].includes(service.state) ? 'running' : service.state === 'activating' ? 'accepted' : service.state === 'unknown' ? 'unknown' : 'interrupted';
    let code = state === 'unknown' ? 'service-state-unavailable' : 'inspect-pending-before-retry';
    if (service.state === 'failed' && service.exitCode === 75) { state = 'busy'; code = 'another-release-running'; }
    return { id, destination: receipt.request.destination, status: state, code };
  }
  async function submit(input) {
    if (plain(input) && validId(input.id) && input.destination === config.destination) {
      const existingDir = folder(config, input.id);
      if (existsSync(existingDir)) {
        protectedPath(existingDir, true, true);
        if (!existsSync(join(existingDir, 'request.json'))) return { id: input.id, destination: config.destination, status: 'unknown', code: 'request-acceptance-incomplete' };
        let request;
        try { request = validateRequest(input, config.destination); } catch { fail('request-id-conflict'); }
        const old = json(join(existingDir, 'request.json'));
        if (JSON.stringify(old.request) !== JSON.stringify(request)) fail('request-id-conflict');
        return status(request.id);
      }
    }
    const request = validateRequest(input, config.destination); const dir = folder(config, request.id);
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      protectedPath(dir, true, true);
      if (!existsSync(join(dir, 'request.json'))) return { id: request.id, destination: config.destination, status: 'unknown', code: 'request-acceptance-incomplete' };
      const old = json(join(dir, 'request.json'));
      if (JSON.stringify(old.request) !== JSON.stringify(request)) fail('request-id-conflict');
      return status(request.id);
    }
    const counterPath = join(config.state, 'sequence.json');
    const sequence = existsSync(counterPath) ? json(counterPath).sequence + 1 : 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail('request-sequence-invalid');
    atomicJson(counterPath, { sequence });
    const receipt = { request, sequence, createdAt: ports.now(), ...(request.action === 'publish' ? { commit: request.sourceSha } : {}) };
    atomicJson(join(dir, 'request.json'), receipt);
    // Do not retry a start automatically if acknowledgement is lost.
    try { ports.start(config, request.id); }
    catch { return { id: request.id, destination: config.destination, status: 'interrupted', code: 'service-start-unconfirmed' }; }
    return { id: request.id, destination: config.destination, status: 'accepted' };
  }
  async function execute(id) {
    const dir = folder(config, id); protectedPath(dir, true, true); const receipt = json(join(dir, 'request.json'));
    validateRequest(receipt.request, config.destination);
    if (receipt.request.id !== id || existsSync(join(dir, 'result.json'))) fail('invalid-execution');
    // The same receipt can never be executed twice, even after an uncertain failure.
    writeFileSync(join(dir, 'execution.json'), JSON.stringify({ startedAt: ports.now() }), { mode: 0o600, flag: 'wx' });
    // flock owned by this systemd service serializes all expensive work, including CI wait.
    let result;
    try {
      const latestPath = join(config.state, 'last-started.json');
      const latest = existsSync(latestPath) ? json(latestPath).sequence : 0;
      if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence <= latest) fail('stale-server-request');
      atomicJson(latestPath, { sequence: receipt.sequence, id });
      if (receipt.request.action === 'publish') {
        if (!/^[a-f0-9]{40}$/.test(receipt.commit ?? '')) fail('invalid-source-sha');
        if (receipt.commit !== receipt.request.sourceSha) fail('source-tip-changed');
        atomicJson(join(dir, 'tests.json'), receipt.request.sourceCiEvidence);
      }
      result = { id, destination: config.destination, ...await ports.publisher(config, receipt) };
    } catch (error) {
      const code = typeof error.code === 'string' && /^release-(?:ci|test)-[a-z-]+$/.test(error.code) ? error.code : 'operation-failed-inspect-pending';
      result = { id, destination: config.destination, status: 'refused', code };
    }
    atomicJson(join(dir, 'result.json'), { ...result, completedAt: ports.now() });
    return result;
  }
  return { submit, status, execute };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const c = readServerConfig(realpathSync(process.argv[1])); const server = createServer(c);
    let [command, id, ...extra] = process.argv.slice(2); if (extra.length) fail('invalid-arguments');
    if (command === 'gateway' && id === undefined) {
      const original = process.env.SSH_ORIGINAL_COMMAND;
      const prefix = `${process.execPath} ${c.installed} `;
      if (typeof original !== 'string' || !original.startsWith(prefix)) fail('invalid-remote-command');
      const parts = original.slice(prefix.length).split(' ');
      if (parts[0] === 'submit' && parts.length === 1) command = 'submit';
      else if (parts[0] === 'status' && parts.length === 2 && validId(parts[1])) [command, id] = parts;
      else fail('invalid-remote-command');
    }
    if (command === 'execute' && !/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID ?? '')) fail('untrusted-execution-context');
    let result;
    if (command === 'execute' && validId(id)) result = await server.execute(id);
    else if (command === 'status' && validId(id)) result = server.status(id);
    else if (['submit', 'accept'].includes(command) && id === undefined) {
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; if (size > 8 * 1024 * 1024) fail('request-too-large'); chunks.push(chunk); }
      const input = Buffer.concat(chunks).toString('utf8');
      if (command === 'submit') {
        // Serialize only receipt allocation. Heavy work uses the shared VPS lock.
        const admission = spawnSync('/usr/bin/flock', ['--exclusive', join(c.state, 'admission.lock'), process.execPath, c.installed, 'accept'],
          { input, env: safeEnv(), encoding: 'utf8', maxBuffer: 65536, timeout: 150000, stdio: ['pipe', 'pipe', 'ignore'] });
        if (admission.error || !admission.stdout) fail('request-acceptance-unconfirmed');
        result = JSON.parse(admission.stdout);
      } else result = await server.submit(JSON.parse(input));
    } else fail('invalid-arguments');
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (['refused', 'busy', 'interrupted', 'unknown', 'not-found'].includes(result.status)) process.exitCode = 1;
  } catch { process.stderr.write('{"status":"refused","code":"server-request-failed"}\n'); process.exitCode = 1; }
}
