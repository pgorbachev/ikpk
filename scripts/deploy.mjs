#!/usr/bin/env node
/** Thin operator client: it never builds, reads CMS, or uploads an artifact. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const fail = (message) => { throw new Error(message); };
const validId = (id) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id ?? '');
function protectedFile(path, secret = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('untrusted-client-config');
  if (/[\r\n\0]/.test(path)) fail('untrusted-client-config');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & (secret ? 0o077 : 0o022))) fail('untrusted-client-config');
  return realpathSync(path);
}
function privateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) fail('untrusted-client-state');
  return realpathSync(path);
}
export function readClientConfig(home, destination) {
  if (!isAbsolute(home) || !['demo', 'prod'].includes(destination)) fail('invalid-destination');
  const directory = realpathSync(home);
  const stat = lstatSync(home); if (stat.isSymbolicLink() || (stat.mode & 0o022)) fail('untrusted-client-config');
  const c = JSON.parse(readFileSync(protectedFile(join(directory, `${destination}.json`)), 'utf8'));
  if (c.version !== 1 || c.destination !== destination || typeof c.sshTarget !== 'string' ||
      !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.:[\]-]*$/.test(c.sshTarget) || c.sshTarget.startsWith('root@') ||
      typeof c.serverEntry !== 'string' || !/^\/[A-Za-z0-9_./-]+\.mjs$/.test(c.serverEntry) || c.serverEntry.split('/').includes('..') ||
      typeof c.serverNode !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(c.serverNode) || c.serverNode.split('/').includes('..')) fail('untrusted-client-config');
  c.identityFile = protectedFile(c.identityFile, true); c.knownHostsFile = protectedFile(c.knownHostsFile);
  return c;
}
export function parseArguments(argv, id = randomUUID()) {
  const args = [...argv]; const destination = args.shift(); if (!['demo', 'prod'].includes(destination)) fail('usage: deploy.sh demo|prod [status ID|recover|rollback RELEASE --reason TEXT] [--request-id ID]');
  let action = 'publish', releaseId, reason;
  if (args[0] === 'status') {
    args.shift(); const requestId = args.shift(); if (!validId(requestId) || args.length) fail('invalid-status-request');
    return { destination, action: 'status', id: requestId };
  }
  if (args[0] === 'recover') { args.shift(); action = 'recover'; }
  else if (args[0] === 'rollback') { args.shift(); action = 'rollback'; releaseId = args.shift(); }
  const seen = new Set();
  while (args.length) {
    const key = args.shift(), value = args.shift();
    if (seen.has(key) || !value || !['--request-id', ...(action === 'rollback' ? ['--reason'] : [])].includes(key)) fail('invalid-arguments');
    seen.add(key); if (key === '--request-id') id = value; else reason = value;
  }
  if (!validId(id) || (action === 'rollback' && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId ?? '') || !reason?.trim() || reason.length > 500))) fail('invalid-arguments');
  return { id, destination, action, ...(action === 'rollback' ? { releaseId, reason } : {}) };
}
export function sshArguments(config, action, id) {
  if (!['submit', 'status'].includes(action) || (action === 'status' && !validId(id))) fail('invalid-remote-command');
  // OpenSSH concatenates remote arguments for a shell. Paths above allow only safe characters.
  return ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=20',
    '-o', `UserKnownHostsFile="${config.knownHostsFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`, '-i', config.identityFile, config.sshTarget,
    config.serverNode, config.serverEntry, action, ...(action === 'status' ? [id] : [])];
}
export function sshCall(config, action, request) {
  const result = spawnSync('/usr/bin/ssh', sshArguments(config, action, request.id), {
    input: action === 'submit' ? JSON.stringify(request) : undefined,
    env: { PATH: '/usr/bin:/bin', HOME: homedir() }, encoding: 'utf8', timeout: 150000, maxBuffer: 64 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'] });
  let value; try { value = JSON.parse(result.stdout); } catch { fail(`connection-or-reply-lost; check status ${request.id}`); }
  if (!value || value.id !== request.id || value.destination !== config.destination ||
      !['accepted', 'running', 'success', 'refused', 'busy', 'interrupted', 'unknown', 'not-found'].includes(value.status)) fail(`untrusted-reply; check status ${request.id}`);
  return value;
}
export async function runClient(argv, { configHome = process.env.IKPK_DEPLOY_HOME ?? join(homedir(), '.config/ikpk-deploy'),
  stateHome = join(homedir(), '.local/state/ikpk-deploy'), call = sshCall,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), announce = (r) => process.stderr.write(`${JSON.stringify(r)}\n`),
  attempts = 2880 } = {}) {
  const request = parseArguments(argv); const config = readClientConfig(configHome, request.destination);
  if (request.action === 'status') return call(config, 'status', request);
  const dir = privateDirectory(join(stateHome, request.destination)); const path = join(dir, `${request.id}.json`);
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(protectedFile(path, true), 'utf8'));
    if (JSON.stringify(old) !== JSON.stringify(request)) fail('request-id-conflict');
  } else {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(request)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(dir, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  // ID is durable and displayed BEFORE sending the request.
  announce({ id: request.id, destination: request.destination, status: 'request-saved', receipt: path });
  let result = await call(config, 'submit', request);
  for (let i = 0; ['accepted', 'running'].includes(result.status); i++) {
    if (i >= attempts) fail(`wait-limit; check status ${request.id}`);
    await sleep(5000); result = await call(config, 'status', request);
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runClient(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'success') process.exitCode = 1;
  } catch (error) { process.stderr.write(`${JSON.stringify({ status: 'refused', reason: error.message })}\n`); process.exitCode = 1; }
}
