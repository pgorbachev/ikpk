import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

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

test('CMS GET revalidates the destination lock inode after acquiring the production flock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-cms-lock-inode-entry-'));
  const webRoot = join(root, 'www');
  const state = join(webRoot, 'shared/site-refresh/state.json');
  const lock = join(webRoot, '.publication.lock');
  const ready = join(root, 'holder-ready');
  const release = join(root, 'holder-release');
  mkdirSync(join(webRoot, 'releases', 'new'), { recursive: true });
  mkdirSync(join(webRoot, 'releases', 'old'), { recursive: true });
  mkdirSync(join(webRoot, 'shared/site-refresh'), { recursive: true });
  symlinkSync('releases/new', join(webRoot, 'current'));
  writeFileSync(lock, '', { mode: 0o600 });
  chmodSync(lock, 0o600);
  const holder = spawn('python3', ['-u', '-c', [
    'import fcntl, os, sys, time',
    'fd = os.open(sys.argv[1], os.O_RDWR)',
    'fcntl.flock(fd, fcntl.LOCK_EX)',
    "open(sys.argv[2], 'w').write('ready')",
    'while not os.path.exists(sys.argv[3]): time.sleep(0.005)',
  ].join('\n'), lock, ready, release], { stdio: 'ignore' });
  await waitUntil(() => existsSync(ready), 'holder did not acquire the destination flock');
  const siteModule = pathToFileURL(join(repoRoot, 'cms/src/seminar-management/site-refresh.ts')).href;
  const waiterCode = `import {writeFileSync} from 'node:fs';import(${JSON.stringify(siteModule)}).then(({registerSiteRefresh})=>{const routes=[];const app={admin:{routes:{admin:{routes}}},db:{query:()=>({findOne:async()=>({roles:[{code:'content-admin'}]})})}};registerSiteRefresh(app);const get=routes.find(r=>r.method==='GET').handler;writeFileSync(process.env.IKPK_REFRESH_STATE,JSON.stringify({status:'running',phase:'switching',pid:process.pid,releaseId:'new',previousReleaseId:'releases/old',switched:false}));console.log(process.pid);const ctx={state:{user:{id:1}}};return get(ctx).then(()=>ctx);}).then(ctx=>{console.log(JSON.stringify(ctx.body));},error=>{process.stderr.write(String(error));process.exitCode=1});`;
  const waiter = spawn(process.execPath, ['--input-type=module', '-e', waiterCode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, IKPK_WEB_ROOT: webRoot, IKPK_REFRESH_STATE: state },
  });
  let stdout = '';
  let stderr = '';
  waiter.stdout.on('data', (chunk) => { stdout += chunk; });
  waiter.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await waitUntil(() => /^\d+\n/.test(stdout), 'production GET did not start');
    const pid = stdout.split('\n', 1)[0];
    await waitUntil(() => spawnSync('lsof', ['-a', '-p', pid, '-Fn'], { encoding: 'utf8' }).stdout.includes(lock),
      'production GET did not open the destination lock before blocking on flock');
    unlinkSync(lock);
    writeFileSync(lock, 'replacement', { mode: 0o600 });
    chmodSync(lock, 0o600);
    writeFileSync(release, 'continue');
    const [code] = await once(waiter, 'exit');
    assert.equal(code, 0, stderr);
    const body = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(body.status, 'running', 'replaced inode must not authorize GET reconciliation');
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).status, 'running');
  } finally {
    writeFileSync(release, 'continue');
    if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill('SIGKILL');
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
