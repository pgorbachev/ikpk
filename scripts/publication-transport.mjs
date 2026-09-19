/** The trusted worker supplies policy; every transport effect requires its bound proof. */
import { spawn } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { digestTree } from './publication-launcher.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const releaseId = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('invalid release ID');
};
const checksum = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid tree digest');
};
const MAX_RETAINED_FILES = 100000;
const MAX_RETAINED_BYTES = 16 * 1024 ** 3;
const RETAINED_CHUNK_BYTES = 1024 ** 2;
const MAX_RESPONSE_BYTES = 8 * 1024 ** 2;

function retainedPath(name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.includes('\0') ||
      Buffer.byteLength(name) > 4096 || name.split('/').length > 128 ||
      name.split('/').some((part) => ['', '.', '..'].includes(part))) throw new Error('invalid retained file path');
}

function retainedManifest(value, id, destinationId) {
  if (!value || value.releaseId !== id || value.destinationId !== destinationId ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_RETAINED_FILES) throw new Error('invalid retained manifest');
  if (value.currentReleaseId !== null) releaseId(value.currentReleaseId);
  const names = new Set();
  let total = 0;
  for (const file of value.files) {
    retainedPath(file?.path);
    if (names.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('invalid retained file metadata');
    names.add(file.path);
    total += file.size;
    if (total > MAX_RETAINED_BYTES) throw new Error('retained tree exceeds transfer limit');
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (names.has(parts.slice(0, i).join('/'))) throw new Error('conflicting retained file paths');
    }
  }
  return value;
}

function filesIn(sourceDir) {
  if (lstatSync(sourceDir).isSymbolicLink()) throw new Error('symlink source directory');
  const root = realpathSync(sourceDir);
  const paths = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symlink in upload tree');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.push(relative(root, path));
      else throw new Error('upload member is not a regular file');
    }
  }
  walk(root);
  if (!paths.length) throw new Error('empty upload tree');
  return { root, paths: paths.sort() };
}

function validateConfig(config) {
  if (typeof config.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:[\]-]*$/.test(config.host) ||
      typeof config.user !== 'string' || !/^[a-z_][a-z0-9_-]*$/.test(config.user) || config.user === 'root') throw new Error('invalid nonprivileged SSH target');
  if (typeof config.root !== 'string' || !isAbsolute(config.root) || config.root === '/' || config.root.includes('\0') ||
      typeof config.destinationId !== 'string' || !config.destinationId.trim()) throw new Error('invalid publication destination');
  if (typeof config.knownHostsFile !== 'string' || !isAbsolute(config.knownHostsFile) ||
      !lstatSync(config.knownHostsFile).isFile() || lstatSync(config.knownHostsFile).isSymbolicLink()) throw new Error('pinned known hosts file required');
  const command = config.sshCommand ?? ['/usr/bin/ssh'];
  if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== 'string') || !isAbsolute(command[0])) throw new Error('invalid SSH executable');
  return command;
}

async function connect(config) {
  const command = validateConfig(config);
  const program = readFileSync(new URL('./lib/publication-remote.py', import.meta.url), 'utf8');
  const remote = `python3 -I -u -c ${quote(program)} ${quote(config.root)} ${quote(config.destinationId)}`;
  const child = spawn(command[0], [...command.slice(1), '-T', '-F', '/dev/null',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.knownHostsFile}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10',
    `${config.user}@${config.host}`, remote], {
    // Authentication comes from the SSH agent/default client key configuration, not argv.
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Neither SSH diagnostic output nor arbitrary remote output is a safe credential log.
  child.stderr.resume();
  let ended = false;
  const exited = new Promise((resolve) => {
    child.once('error', () => { ended = true; resolve(); });
    child.once('close', () => { ended = true; resolve(); });
  });
  child.stdin.on('error', () => {}); // Each write callback reports failure to its request.
  const output = child.stdout[Symbol.asyncIterator]();
  let remaining = Buffer.alloc(0);
  let broken = false;
  let busy = false;
  let closed = false;
  async function response() {
    const parts = [];
    let size = 0;
    while (true) {
      if (!remaining.length) {
        const chunk = await output.next();
        if (chunk.done) throw new Error('SSH publication session closed unexpectedly');
        remaining = chunk.value;
      }
      const newline = remaining.indexOf(10);
      const part = newline < 0 ? remaining : remaining.subarray(0, newline);
      size += part.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('publication protocol response exceeds limit');
      parts.push(part);
      remaining = newline < 0 ? Buffer.alloc(0) : remaining.subarray(newline + 1);
      if (newline >= 0) break;
    }
    let reply;
    try { reply = JSON.parse(Buffer.concat(parts, size).toString('utf8')); } catch { throw new Error('invalid publication protocol response'); }
    if (reply.ok !== true) throw new Error(typeof reply.error === 'string' ? reply.error : 'remote publication failed');
    return reply.value;
  }
  const write = (bytes) => new Promise((resolve, reject) => child.stdin.write(bytes, (error) => error ? reject(new Error('SSH upload stream failed')) : resolve()));
  async function request(header, files = []) {
    if (closed || broken || busy) throw new Error('publication session is closed or busy');
    busy = true;
    try {
      await write(`${JSON.stringify(header)}\n`);
      for (const file of files) {
        // Recheck every member immediately before reading. The remote hash detects races.
        if (!lstatSync(file.localPath).isFile() || lstatSync(file.localPath).isSymbolicLink()) throw new Error('symlink or invalid upload member');
        const bytes = readFileSync(file.localPath);
        if (bytes.length !== file.size) throw new Error('upload tree changed during transfer');
        await write(bytes);
      }
      return await response();
    } catch (error) { broken = true; throw error; }
    finally { busy = false; }
  }
  async function close() {
    if (closed) return;
    if (!broken && !ended) {
      try { await request({ command: 'close' }); } catch { /* Closing must preserve the original failure. */ }
    }
    closed = true;
    child.stdin.end();
    await Promise.race([exited, delay(1000, undefined, { ref: false })]);
    if (!ended) child.kill('SIGTERM');
    child.stdout.destroy();
  }
  try { await response(); } catch (error) { broken = true; await close(); throw error; }
  return { request, close };
}

function indexFailure(error, operation) {
  const message = error instanceof Error ? error.message : 'index recording failed';
  const failure = new Error(`${message}; active release=${operation.releaseId} commit=${operation.commit} snapshotId=${operation.snapshotId} destination=${operation.destinationId}`, { cause: error });
  failure.activeOperation = operation;
  return failure;
}

async function authorizeEffect(authorize, request) {
  if (typeof authorize !== 'function') throw new Error('trusted publication authorizer required');
  const proof = await authorize(structuredClone(request));
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) ||
      typeof proof.commit !== 'string' || !/^[a-f0-9]{40}$/.test(proof.commit) ||
      proof.destinationId !== request.destinationId) throw new Error('invalid publication authorization proof');
  // These observations supply prerequisites for the complete publication report.
  if (['connect', 'inspect-serving', 'payment-readiness'].includes(request.action)) return;
  if (typeof proof.snapshotId !== 'string' || !proof.snapshotId.trim()) throw new Error('invalid publication authorization proof');
  checksum(proof.treeDigest);
  if (request.action === 'read-retained' && proof.releaseId !== request.releaseId) throw new Error('publication authorization release mismatch');
  if (request.expectedDigest !== undefined && proof.treeDigest !== request.expectedDigest) throw new Error('publication authorization digest mismatch');
  const mismatch = request.operation && ['destinationId', 'treeDigest', 'commit', 'snapshotId'].find((field) => proof[field] !== request.operation[field]);
  if (mismatch) throw new Error(`publication authorization ${mismatch} mismatch`);
}

export function createSshTransport(config) {
  const { authorize, ...connectionConfig } = config;
  const authorizeAction = (action, details = {}) => authorizeEffect(authorize, { action, destinationId: connectionConfig.destinationId, ...details });
  async function withLock(callback) {
    await authorizeAction('connect');
    const connection = await connect(connectionConfig); // The ready reply is sent only after remote flock.
    let open = true;
    const downloads = [];
    const call = (...args) => {
      if (!open) throw new Error('publication lock is no longer held');
      return connection.request(...args);
    };
    async function record(operation, recordIndex) {
      try {
        await recordIndex(structuredClone(operation));
        await call({ command: 'finish', operation });
      } catch (error) { throw indexFailure(error, operation); }
    }
    async function activate({ releaseId: id, operation, recordIndex, expectedDigest, beforeActivate, rollback = false }) {
      releaseId(id);
      if (typeof recordIndex !== 'function') throw new Error('index callback required');
      if (beforeActivate !== undefined && typeof beforeActivate !== 'function') throw new Error('invalid final publication check');
      operation = structuredClone(operation);
      await authorizeAction(rollback ? 'rollback' : 'activate', { operation });
      // Preparation verifies retained/staged bytes and durably records the pending operation.
      await call({ command: 'prepare', releaseId: id, operation, expectedDigest, rollback });
      try { if (beforeActivate) await beforeActivate(); }
      catch (error) {
        try { await call({ command: 'cancel', operation }); }
        catch (cancelError) {
          throw new Error('final publication check refused; pending preparation could not be cleared', { cause: cancelError });
        }
        throw error;
      }
      // No transfer, build or tree checks follow the final source check.
      await call({ command: 'activate', operation });
      await record(operation, recordIndex);
    }
    const session = {
      async inspectServing() {
        if (!open) throw new Error('publication lock is no longer held');
        await authorizeAction('inspect-serving');
        return call({ command: 'inspect-serving' });
      },
      async paymentReadiness() {
        if (!open) throw new Error('publication lock is no longer held');
        await authorizeAction('payment-readiness');
        return call({ command: 'payment-readiness' });
      },
      async readRetained({ releaseId: id }) {
        if (!open) throw new Error('publication lock is no longer held');
        releaseId(id);
        await authorizeAction('read-retained', { releaseId: id });
        const manifest = retainedManifest(await call({ command: 'read-retained', releaseId: id }), id, connectionConfig.destinationId);
        const treeDir = mkdtempSync(join(tmpdir(), 'ikpk-retained-'));
        downloads.push(treeDir);
        try {
          for (const file of manifest.files) {
            const path = join(treeDir, file.path);
            if (relative(treeDir, path).startsWith('../') || isAbsolute(relative(treeDir, path))) throw new Error('retained path escapes tree');
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
              let offset = 0;
              do {
                const chunk = await call({ command: 'read-retained-file', releaseId: id, path: file.path, offset });
                if (!chunk || typeof chunk.data !== 'string' || chunk.data.length > Math.ceil(RETAINED_CHUNK_BYTES / 3) * 4 ||
                    typeof chunk.done !== 'boolean') throw new Error('invalid retained file chunk');
                const bytes = Buffer.from(chunk.data, 'base64');
                if (bytes.toString('base64') !== chunk.data || bytes.length > RETAINED_CHUNK_BYTES ||
                    offset + bytes.length > file.size || chunk.done !== (offset + bytes.length === file.size) ||
                    (!chunk.done && !bytes.length)) throw new Error('invalid retained file chunk length');
                let written = 0;
                while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
                offset += bytes.length;
                if (chunk.done) break;
              } while (offset < file.size);
            } finally { closeSync(fd); }
          }
          return { releaseId: id, destinationId: manifest.destinationId, currentReleaseId: manifest.currentReleaseId, treeDir };
        } catch (error) {
          rmSync(treeDir, { recursive: true, force: true });
          throw error;
        }
      },
      async stage({ releaseId: id, sourceDir, expectedDigest }) {
        releaseId(id); checksum(expectedDigest);
        await authorizeAction('stage', { expectedDigest });
        const { root, paths } = filesIn(sourceDir);
        if (await digestTree(root, paths) !== expectedDigest) throw new Error('local tree digest mismatch');
        const files = paths.map((path) => ({ path, localPath: join(root, path), size: lstatSync(join(root, path)).size }));
        await call({ command: 'stage', releaseId: id, expectedDigest, files: files.map(({ path, size }) => ({ path, size })) }, files);
      },
      activate,
      rollback(args) { checksum(args.expectedDigest); return activate({ ...args, rollback: true }); },
    };
    try { return await callback(session, { call, record }); }
    finally {
      open = false;
      try { await connection.close(); }
      finally { for (const treeDir of downloads) rmSync(treeDir, { recursive: true, force: true }); }
    }
  }
  return {
    withLock: (callback) => withLock((session) => callback(session)),
    recover: ({ recordIndex }) => withLock(async (_session, { call, record }) => {
      if (typeof recordIndex !== 'function') throw new Error('index callback required');
      const pending = await call({ command: 'recover' });
      if (!pending) return { recovered: false };
      const { operation, prepared } = pending;
      await authorizeAction('recover', { operation });
      if (prepared) {
        await call({ command: 'cancel-recovery', operation });
        return { recovered: false, cancelled: true, operation };
      }
      await record(operation, recordIndex);
      return { recovered: true, operation };
    }),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.stderr.write('publication transport requires the authorized local publication entrypoint\n');
  process.exitCode = 1;
}
