/** The trusted worker supplies policy; every transport effect requires its bound proof. */
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
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
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  let broken = false;
  let busy = false;
  let closed = false;
  async function response() {
    const line = await lines.next();
    if (line.done) throw new Error('SSH publication session closed unexpectedly');
    let reply;
    try { reply = JSON.parse(line.value); } catch { throw new Error('invalid publication protocol response'); }
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
    reader.close();
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
      typeof proof.snapshotId !== 'string' || !proof.snapshotId.trim() ||
      proof.destinationId !== request.destinationId) throw new Error('invalid publication authorization proof');
  checksum(proof.treeDigest);
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
    finally { open = false; await connection.close(); }
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
