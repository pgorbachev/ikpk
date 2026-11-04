import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { acquirePublicationLock, openPublicationLock } from '../src/seminar-management/site-refresh-operation.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workerUrl = pathToFileURL(join(repoRoot, 'cms/src/seminar-management/site-refresh-worker.js')).href;

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail(message);
}

function hostFlock(path) {
  return spawnSync('python3', ['-c', [
    'import fcntl, os, sys',
    'fd = os.open(sys.argv[1], os.O_RDWR)',
    'try:',
    ' fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    'except BlockingIOError:',
    ' sys.exit(73)',
    'fcntl.flock(fd, fcntl.LOCK_UN)',
  ].join('\n'), path], { encoding: 'utf8' });
}

test('live CMS refresh worker excludes the host flock on destination .publication.lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-cms-shared-flock-'));
  const webRoot = join(root, 'www');
  const workspace = join(root, 'workspace');
  const state = join(webRoot, 'shared/site-refresh/state.json');
  const destinationLock = join(webRoot, '.publication.lock');
  const barrier = join(root, 'capture-entered');
  const release = join(root, 'capture-release');
  mkdirSync(join(webRoot, 'releases', 'current'), { recursive: true });
  mkdirSync(dirname(state), { recursive: true });
  mkdirSync(join(workspace, 'web/node_modules/astro'), { recursive: true });
  mkdirSync(join(workspace, 'web/node_modules/tsx/dist'), { recursive: true });
  writeFileSync(join(workspace, 'web/node_modules/astro/package.json'), '{}');
  writeFileSync(join(workspace, 'web/node_modules/tsx/package.json'), '{}');
  writeFileSync(destinationLock, '', { mode: 0o600 });
  chmodSync(destinationLock, 0o600);
  writeFileSync(join(workspace, 'web/node_modules/tsx/dist/cli.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { setTimeout as delay } from 'node:timers/promises';",
    'writeFileSync(process.env.IKPK_TEST_CAPTURE_BARRIER, String(process.pid));',
    'while (!existsSync(process.env.IKPK_TEST_CAPTURE_RELEASE)) await delay(5);',
  ].join('\n'));
  const token = randomBytes(16).toString('hex');
  writeFileSync(state, JSON.stringify({ status: 'running', phase: 'starting', pid: process.pid,
    refreshOperationToken: token, startedAt: new Date().toISOString(), switched: false }));
  const childCode = `import(${JSON.stringify(workerUrl)}).then(({executeRefresh}) => executeRefresh()).then(() => process.exit(0), () => process.exit(1))`;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    stdio: 'ignore',
    env: {
      ...process.env,
      IKPK_REFRESH_STATE: state,
      IKPK_REFRESH_OWNER_PID: String(process.pid),
      IKPK_REFRESH_OPERATION_TOKEN: token,
      IKPK_WEB_ROOT: webRoot,
      IKPK_BUILD_WORKSPACE: workspace,
      IKPK_INSTALLED_COMMIT: 'a'.repeat(40),
      IKPK_VERIFY_URL: 'http://127.0.0.1/unused',
      IKPK_TEST_CAPTURE_BARRIER: barrier,
      IKPK_TEST_CAPTURE_RELEASE: release,
    },
  });
  const exited = once(worker, 'exit');
  let failure;
  try {
    await waitUntil(() => {
      try {
        const record = JSON.parse(readFileSync(state, 'utf8'));
        return record.status === 'running' && record.phase === 'capture' && record.pid === worker.pid
          && readFileSync(barrier, 'utf8').length > 0 && !existsSync(`${state}.lock`);
      } catch { return false; }
    }, 'real CMS worker never acquired destination lock and reached active capture barrier');
    assert.equal(existsSync(`${state}.lock`), false, 'CMS must not create the legacy state lock');

    const attempt = hostFlock(destinationLock);
    assert.equal(attempt.stderr, '', `host flock helper failed: ${attempt.stderr}`);
    assert.equal(attempt.status, 73,
      `host flock must contend with active CMS worker on destination inode; status=${attempt.status}`);
  } catch (error) {
    failure = error;
  } finally {
    writeFileSync(release, 'continue');
    if (worker.exitCode === null && worker.signalCode === null) {
      let timeout;
      const result = await Promise.race([
        exited.then(() => 'exited'),
        new Promise((resolve) => { timeout = setTimeout(() => resolve('timeout'), 5000); timeout.unref(); }),
      ]);
      clearTimeout(timeout);
      if (result === 'timeout') {
        worker.kill('SIGKILL');
        await exited;
      }
    }
    const released = hostFlock(destinationLock);
    assert.equal(released.stderr, '', `host flock helper failed after worker exit: ${released.stderr}`);
    assert.equal(released.status, 0, 'destination flock must be released after the CMS worker exits');
    assert.equal(existsSync(`${state}.lock`), false, 'CMS must not leave the legacy state lock');
    rmSync(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
});

test('publication lock acquisition rejects an inode replaced after open', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-cms-lock-inode-entry-'));
  const lock = join(root, '.publication.lock');
  writeFileSync(lock, '', { mode: 0o600 });
  chmodSync(lock, 0o600);
  const fd = openPublicationLock(lock);
  try {
    unlinkSync(lock);
    writeFileSync(lock, 'replacement', { mode: 0o600 });
    chmodSync(lock, 0o600);
    assert.throws(() => acquirePublicationLock(fd, { path: lock }), /shared publication lock changed/);
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});
