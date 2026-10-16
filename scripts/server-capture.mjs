#!/usr/bin/env node
/** Installed root helper; the publisher receives only a fixed systemd start permission. */
import { readFileSync, readdirSync, lstatSync, openSync, closeSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertCaptureId, assertConfig, assertProtected, captureBundle, recoverWriters, recoverLeases, serviceControl } from './lib/server-capture-bundle.mjs';

const CONFIG_PATH = '/etc/ikpk/demo-capture.json';
function protectedTree(path) {
  assertProtected(path);
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) protectedTree(join(path, name));
}
function parseArguments(input) {
  const args = [...input];
  const underLock = args[0] === '--under-lock';
  if (underLock) args.shift();
  const [action, id] = args;
  if (action === 'recover-leases' && args.length === 1) return { underLock, action, id: undefined };
  if (args.length !== 2 || !['capture', 'resume'].includes(action)) throw new Error('usage: server-capture.mjs capture|resume PUBLICATION_ID | recover-leases');
  assertCaptureId(id);
  return { underLock, action, id };
}

/** Fixed invocation shared with the Linux mutex regression; no caller-supplied executable. */
export function captureLockInvocation(config, args) {
  const parsed = parseArguments(args);
  if (parsed.underLock) throw new Error('cannot nest the root capture mutex');
  return { command: '/usr/bin/flock', args: ['--exclusive', '--wait', '300', '--no-fork', join(config.leaseRoot, '.operation.lock'), process.execPath, fileURLToPath(import.meta.url), '--under-lock', ...args] };
}

/** Root CLI enters here only while holding the separate capture/recovery OS mutex. */
export async function runCaptureOperation(config, action, id, { services = serviceControl, beforeCapture = () => {} } = {}) {
  if (action === 'recover-leases') { if (id !== undefined) throw new Error('recover-leases takes no ID'); recoverLeases(config, { services }); return; }
  assertCaptureId(id);
  if (action === 'resume') { recoverWriters(config, id, { services }); return; }
  if (action !== 'capture') throw new Error('unsupported capture action');
  // A disabled writer stopped before a reboot must be restored before taking the next
  // active-unit inventory. Failure retains its lease and prohibits any new capture.
  recoverLeases(config, { services });
  beforeCapture();
  return captureBundle(config, id, { services });
}

export async function main(args = process.argv.slice(2)) {
  const { underLock, action, id } = parseArguments(args);
  if (process.getuid?.() !== 0) throw new Error('server capture requires the installed root helper');
  const script = fileURLToPath(import.meta.url);
  assertProtected(process.execPath);
  assertProtected(script);
  for (const file of ['server-capture-bundle.mjs', 'server-capture-sqlite.mjs']) assertProtected(join(dirname(script), 'lib', file));
  assertProtected(CONFIG_PATH);
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  // Recovery must work even if the source database or installed CMS files are unavailable.
  assertConfig(config, { checkPaths: false });
  assertProtected(config.leaseRoot);
  const lockPath = join(config.leaseRoot, '.operation.lock');
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  assertProtected(lockPath);
  const lockStat = lstatSync(lockPath);
  if (!lockStat.isFile() || lockStat.nlink !== 1 || (lockStat.mode & 0o077) !== 0) throw new Error('root capture lock must be a regular private file');
  if (!underLock) {
    const invocation = captureLockInvocation(config, args);
    assertProtected(invocation.command);
    // --no-fork keeps the kernel lock FD in the operation process through resume/seal.
    // Killing only this launcher does not release the surviving operation's mutex.
    execFileSync(invocation.command, invocation.args, { stdio: 'inherit' });
    return;
  }
  // --under-lock is an internal root-only stage, behind the same fixed-installation checks.
  // Publisher authorization exposes only the systemd request wrapper, never this argument.
  const result = await runCaptureOperation(config, action, id, { beforeCapture: () => {
    assertProtected(config.bundleRoot);
    protectedTree(config.schemaRoot);
    if (!Number.isSafeInteger(config.publisherGid) || config.publisherGid <= 0) throw new Error('dedicated publisher group required');
  } });
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`server-capture: ${error.message}`); process.exitCode = 1; });
}
