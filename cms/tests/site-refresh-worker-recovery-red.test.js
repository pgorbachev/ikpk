import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { registerSiteRefresh } from '../src/seminar-management/site-refresh.ts';
import { writeJsonAtomic } from '../src/seminar-management/site-refresh-operation.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workerUrl = pathToFileURL(join(repoRoot, 'cms/src/seminar-management/site-refresh-worker.js')).href;

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-cms-cancel-starting-'));
  const webRoot = join(root, 'www');
  const workspace = join(root, 'workspace');
  const state = join(webRoot, 'shared/site-refresh/state.json');
  const lock = join(webRoot, '.publication.lock');
  const capture = join(root, 'capture-ran');
  mkdirSync(dirname(state), { recursive: true });
  mkdirSync(join(workspace, 'web/node_modules/astro'), { recursive: true });
  mkdirSync(join(workspace, 'web/node_modules/tsx/dist'), { recursive: true });
  writeFileSync(join(workspace, 'web/node_modules/astro/package.json'), '{}');
  writeFileSync(join(workspace, 'web/node_modules/tsx/package.json'), '{}');
  writeFileSync(join(workspace, 'web/node_modules/tsx/dist/cli.mjs'),
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(capture)},'capture ran');`);
  writeFileSync(lock, '', { mode: 0o600 });
  chmodSync(lock, 0o600);
  const previous = { ...process.env };
  Object.assign(process.env, {
    IKPK_WEB_ROOT: webRoot,
    IKPK_REFRESH_STATE: state,
    IKPK_BUILD_WORKSPACE: workspace,
    IKPK_VERIFY_URL: 'http://127.0.0.1/unused',
    IKPK_INSTALLED_COMMIT: 'a'.repeat(40),
  });
  writeFileSync(state, JSON.stringify({ status: 'succeeded', releaseId: 'current', switched: true }));
  const routes = [];
  const strapi = { admin: { routes: { admin: { routes } } },
    db: { query: () => ({ findOne: async () => ({ roles: [{ code: 'content-admin' }] }) }) } };
  registerSiteRefresh(strapi, { hostPublicationStatus: () => null });
  const post = routes.find((route) => route.method === 'POST').handler;
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, state, lock, capture, post };
}

function starting(token, pid = 2147483647) {
  return { status: 'running', phase: 'starting', pid, refreshOperationToken: token,
    startedAt: new Date().toISOString(), switched: false };
}

async function post(f, body = {}) {
  const ctx = { state: { user: { id: 1 } }, request: { body } };
  await f.post(ctx);
  return ctx.body;
}

async function startBarrierWorker(f, token, ownerPid = 2147483647) {
  const ready = join(f.root, 'worker-ready');
  const release = join(f.root, 'worker-release');
  const code = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    const {executeRefresh} = await import(${JSON.stringify(workerUrl)});
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    while (!existsSync(${JSON.stringify(release)})) await delay(5);
    executeRefresh().then(() => process.exit(0), (error) => {
      writeFileSync(${JSON.stringify(join(f.root, 'worker-error'))}, String(error.message));
      process.exit(1);
    });
  `;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: 'ignore', env: { ...process.env, IKPK_REFRESH_OWNER_PID: String(ownerPid),
      IKPK_REFRESH_OPERATION_TOKEN: token },
  });
  await waitUntil(() => existsSync(ready), 'real CMS worker did not reach the pre-lock barrier');
  return { worker, release };
}

test('dead starting worker can be cancelled and the next POST can start a fresh attempt', async (t) => {
  const f = fixture(t);
  const token = 'a'.repeat(32);
  const { worker } = await startBarrierWorker(f, token);
  writeFileSync(f.state, JSON.stringify(starting(token, worker.pid)));
  const workerExited = once(worker, 'exit');
  worker.kill('SIGKILL');
  await workerExited;

  const cancelled = await post(f, { action: 'cancel-starting', token, ownerPid: worker.pid });
  const saved = JSON.parse(readFileSync(f.state, 'utf8'));
  assert.equal(cancelled.status, 'failed');
  assert.equal(saved.status, 'failed');
  assert.equal(saved.switched, false);
  assert.equal(saved.refreshOperationToken, undefined);

  // Keep the next POST from creating a worker: reaching readiness proves the
  // cancelled record no longer blocks a new attempt as stale `interrupted`.
  rmSync(join(f.workspace, 'web/node_modules/astro'), { recursive: true, force: true });
  const next = await post(f);
  assert.equal(next.status, 'failed');
  assert.match(next.message, /подготовлено/);
});

test('live worker released after cancellation rechecks token before capture', async (t) => {
  const f = fixture(t);
  const token = 'b'.repeat(32);
  writeFileSync(f.state, JSON.stringify(starting(token)));
  const { worker, release } = await startBarrierWorker(f, token);
  try {
    const cancelled = await post(f, { action: 'cancel-starting', token, ownerPid: 2147483647 });
    if (cancelled.status !== 'failed') {
      const workerExited = worker.exitCode !== null || worker.signalCode !== null
        ? Promise.resolve() : once(worker, 'exit');
      worker.kill('SIGTERM');
      await workerExited;
    }
    assert.equal(cancelled.status, 'failed');
    const saved = JSON.parse(readFileSync(f.state, 'utf8'));
    assert.equal(saved.status, 'failed');
    assert.equal(saved.refreshOperationToken, undefined);

    const exited = once(worker, 'exit');
    writeFileSync(release, 'continue');
    const [code] = await exited;
    assert.notEqual(code, 0, 'late worker must refuse the cancelled intent');
    assert.match(readFileSync(join(f.root, 'worker-error'), 'utf8'), /intent changed/);
    assert.equal(existsSync(f.capture), false, 'late worker must stop before capture/build actions');
    assert.deepEqual(JSON.parse(readFileSync(f.state, 'utf8')), saved,
      'late worker must preserve the cancellation record');
  } finally {
    writeFileSync(release, 'continue');
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGTERM');
      await exited;
    }
  }
});

test('cancel-starting refuses a mismatched token without changing the intent', async (t) => {
  const f = fixture(t);
  const intent = starting('c'.repeat(32));
  writeFileSync(f.state, JSON.stringify(intent));
  const before = readFileSync(f.state);

  const result = await post(f, { action: 'cancel-starting', token: 'd'.repeat(32), ownerPid: intent.pid });
  assert.equal(result.status, 'failed');
  assert.deepEqual(readFileSync(f.state), before);
  const wrongOwner = await post(f, { action: 'cancel-starting', token: intent.refreshOperationToken, ownerPid: 1 });
  assert.equal(wrongOwner.status, 'failed');
  assert.deepEqual(readFileSync(f.state), before);
});

test('unknown action never starts a publication', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.state);
  const result = await post(f, { action: 'cancel-startng' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(readFileSync(f.state), before);
  const nullResult = await post(f, { action: null });
  assert.equal(nullResult.status, 'failed');
  assert.deepEqual(readFileSync(f.state), before);
});

test('cancellation refuses a held lock without changing the intent', async (t) => {
  const f = fixture(t);
  const intent = starting('e'.repeat(32));
  writeFileSync(f.state, JSON.stringify(intent));
  const holder = spawn('python3', ['-u', '-c',
    'import fcntl,sys\nf=open(sys.argv[1],"r+")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("ready",flush=True)\nsys.stdin.read()', f.lock],
  { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    await once(holder.stdout, 'data');
    const result = await post(f, { action: 'cancel-starting', token: intent.refreshOperationToken, ownerPid: intent.pid });
    assert.equal(result.status, 'running');
    assert.deepEqual(JSON.parse(readFileSync(f.state, 'utf8')), intent);
  } finally {
    const exited = once(holder, 'exit');
    holder.stdin.end();
    await exited;
  }
});

test('refresh intent is private even with a permissive umask', (t) => {
  const f = fixture(t);
  const previous = process.umask(0);
  try { writeJsonAtomic(f.state, starting('f'.repeat(32))); }
  finally { process.umask(previous); }
  assert.equal(statSync(f.state).mode & 0o777, 0o600);
});
