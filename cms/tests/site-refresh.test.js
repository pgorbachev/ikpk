import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MESSAGES,
  beginRefresh,
  childEnvironment,
  siteBuildEnv,
  decideLock,
  launchPlan,
  mayRefresh,
  publishTree,
  identityFromReleaseDir,
  refreshReady,
  installedCommit,
  releaseIdentity,
  runLockedRestore,
  tryLock,
  unlock,
  writeJsonAtomic,
  publicView,
  reconcile,
  reuseDerivatives,
  runRefresh,
  runRestore,
  switchCurrent,
  verifyRelease,
} from '../src/seminar-management/site-refresh-operation.js';

function harness(overrides = {}) {
  const calls = [];
  const deps = {
    pid: 42,
    now: () => '2026-09-27T00:00:00.000Z',
    write: (record) => calls.push(record),
    workspaceReady: () => true,
    canVerify: () => true,
    capture: async () => ({ ok: true }),
    reuseDerivatives: () => 'kept',
    build: async () => ({
      ok: true,
      releaseId: 'content-1',
      identity: { commit: 'a'.repeat(40), snapshotId: 'snap:new' },
    }),
    switchRelease: (releaseId) => {
      calls.push({ switchedTo: releaseId });
      return { previous: 'releases/old' };
    },
    verify: async () => ({ ok: true, siteUrl: 'http://127.0.0.1/release.json' }),
    ...overrides,
  };
  return { deps, calls };
}

test('чужая роль и пароль не попадают в окружение сборки', () => {
  assert.equal(mayRefresh(['content-admin']), true);
  assert.equal(mayRefresh(['strapi-super-admin']), true);
  assert.equal(mayRefresh(['strapi-author']), false);
  const env = childEnvironment({
    PATH: '/usr/bin',
    CMS_TOKEN: 'secret-token',
    CONTENT_ADMIN_PASSWORD: 'secret-password',
    AWS_SECRET_ACCESS_KEY: 'nope',
  });
  assert.equal(env.CMS_TOKEN, 'secret-token');
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=480');
  assert.equal(env.CONTENT_ADMIN_PASSWORD, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(publicView({ detail: 'Bearer secret-token', status: 'failed' }).detail, 'Bearer [скрыто]');
});

test('сборка сайта не пишет телеметрию Astro в домашний каталог службы', () => {
  const env = siteBuildEnv('/var/lib/ikpk-site-build');
  assert.equal(env.ASTRO_TELEMETRY_DISABLED, '1');
  assert.equal(env.CONTENT_SNAPSHOT_DIR, '/var/lib/ikpk-site-build/web/.snapshot');
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=480');
});

test('команда сборки ограничивает память и не ставит зависимости', () => {
  const contained = launchPlan({
    env: { XDG_RUNTIME_DIR: '/run/user/1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus' },
    systemdRun: true,
    nodePath: '/usr/bin/node',
    script: 'process.exit(0)',
  });
  assert.equal(contained.args.includes('npm'), false);
  assert.equal(contained.args.includes('ci'), false);
  assert.ok(contained.args.includes('MemoryMax=550M'));
  assert.ok(contained.args.includes('--user'));
  const plain = launchPlan({ env: {}, systemdRun: true, nodePath: process.execPath, script: 'process.exit(0)' });
  assert.equal(plain.command, 'nice');
  assert.equal(plain.args.includes('--user'), false);
  assert.equal(plain.args.includes('MemoryMax=550M'), false);
  assert.equal(plain.args.includes('ci'), false);
});

test('запуск как у system unit CMS не зовёт пользовательский systemd', () => {
  const plan = launchPlan({
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    systemdRun: true,
    nodePath: process.execPath,
    script: 'process.exit(0)',
  });
  assert.equal(plan.session, false);
  assert.equal(plan.args.includes('--user'), false);
  const result = spawnSync(plan.command, plan.args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assert.equal(result.status, 0);
});

test('неудачная сборка не переключает релиз', async () => {
  let switched = false;
  const { deps } = harness({
    build: async () => ({ ok: false, detail: 'Bearer secret-token' }),
    switchRelease: () => {
      switched = true;
      return { previous: null };
    },
  });
  const result = await runRefresh(deps);
  assert.equal(switched, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.switched, false);
  assert.equal(result.message, MESSAGES.failed);
  assert.equal(result.detail, 'Bearer [скрыто]');
});

test('без настроенной проверки релиз не переключается', async () => {
  let switched = false;
  const { deps } = harness({
    canVerify: () => false,
    switchRelease: () => {
      switched = true;
      return { previous: null };
    },
  });
  const result = await runRefresh(deps);
  assert.equal(switched, false);
  assert.equal(result.switched, false);
});

test('ошибка проверки после переключения не называется успехом', async () => {
  const { deps } = harness({ verify: async () => ({ ok: false, detail: 'HTTP 500' }) });
  const result = await runRefresh(deps);
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.switched, true);
  assert.equal(result.message, MESSAGES.verificationFailed);
  assert.match(result.message, /не автоматический откат/);
});

test('повторное нажатие показывает уже идущую сборку', () => {
  let spawned = 0;
  const running = { status: 'running', phase: 'build', pid: 7, message: 'идёт' };
  const again = beginRefresh({
    record: running,
    pidAlive: () => true,
    lockAcquired: false,
    ready: true,
    now: () => '2026-09-27T00:00:00.000Z',
    spawn: () => {
      spawned += 1;
      return { pid: 8 };
    },
  });
  assert.equal(spawned, 0);
  assert.equal(again.body.status, 'running');
});

test('прерванная сборка до переключения не считается успехом', () => {
  const stopped = reconcile({ status: 'running', phase: 'build', pid: 9, switched: false }, () => false);
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.message, MESSAGES.interrupted);
  const midSwitch = reconcile({ status: 'running', phase: 'verifying', pid: 9, switched: true }, () => false);
  assert.equal(midSwitch.status, 'verification-failed');
  assert.match(midSwitch.message, /не автоматический откат/);
});

test('готовые производные переиспользуются, пустой кэш не создаёт установку', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-refresh-'));
  try {
    const cache = join(root, 'cache');
    mkdirSync(cache);
    writeFileSync(join(cache, 'photo.webp'), 'ready');
    const workspace = join(root, 'workspace');
    assert.equal(reuseDerivatives(workspace, cache), 'copied');
    assert.equal(readFileSync(join(workspace, 'web', 'public', 'media', 'photo.webp'), 'utf8'), 'ready');
    assert.equal(reuseDerivatives(workspace, cache), 'kept');
    assert.equal(reuseDerivatives(workspace, ''), 'missing-cache');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('переключение атомарно меняет current и оставляет прежний каталог', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-switch-'));
  try {
    mkdirSync(join(root, 'releases', 'old'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), 'new');
    writeFileSync(join(root, 'releases', 'old', 'index.html'), 'old');
    const identity = { commit: 'b'.repeat(40), snapshotId: 'snap:new' };
    publishTree(join(root, 'dist'), root, 'content-1', identity);
    symlinkSync('releases/old', join(root, 'current'));
    const switched = switchCurrent(root, 'content-1');
    assert.equal(switched.previous, 'releases/old');
    assert.equal(readlinkSync(join(root, 'current')), 'releases/content-1');
    assert.equal(existsSync(join(root, 'releases', 'old', 'index.html')), true);
    assert.deepEqual(releaseIdentity(JSON.parse(readFileSync(join(root, 'releases', 'content-1', 'release.json'), 'utf8'))), identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('возврат предыдущего релиза сверяет commit и snapshotId, не поле releaseId', async () => {
  let target = null;
  let checked = null;
  const previous = { commit: 'c'.repeat(40), snapshotId: 'snap:old' };
  const result = await runRestore({
    read: () => ({ status: 'succeeded', previousReleaseId: 'releases/old' }),
    write: () => {},
    identityOf: () => previous,
    switchRelease: (releaseId) => {
      target = releaseId;
      return { previous: 'releases/content-1' };
    },
    verify: async (expected) => {
      checked = expected;
      return { ok: true, siteUrl: 'http://127.0.0.1/release.json' };
    },
  });
  assert.equal(target, 'old');
  assert.deepEqual(checked, previous);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.message, MESSAGES.restored);
});

test('проверка релиза принимает штатную пару и новый снимок', async () => {
  const official = { commit: 'd'.repeat(40), snapshotId: 'snap:official' };
  const fresh = { commit: 'd'.repeat(40), snapshotId: 'snap:fresh' };
  const ok = await verifyRelease({
    url: 'http://127.0.0.1/release.json',
    expected: official,
    host: 'staging.ikpk.su',
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Host, 'staging.ikpk.su');
      return { status: 200, json: async () => official };
    },
  });
  assert.equal(ok.ok, true);
  const restored = await verifyRelease({
    url: 'http://127.0.0.1/release.json',
    expected: official,
    fetchImpl: async () => ({ status: 200, json: async () => ({ ...official }) }),
  });
  assert.equal(restored.ok, true);
  const missed = await verifyRelease({
    url: 'http://127.0.0.1/release.json',
    expected: fresh,
    fetchImpl: async () => ({ status: 200, json: async () => official }),
  });
  assert.equal(missed.ok, false);
  assert.equal(releaseIdentity({ releaseId: 'content-1' }), null);
});

test('живой lock возврата не снимается, битый файл со мёртвым pid снимается', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-lock-'));
  try {
    const state = join(root, 'state.json');
    const lock = `${state}.lock`;
    tryLock(lock, 77);
    const held = decideLock({
      readable: true,
      record: { status: 'succeeded', previousReleaseId: 'releases/old' },
      lockPath: lock,
      pidAlive: (pid) => pid === 77,
    });
    assert.equal(held.releaseLock, false);
    writeFileSync(state, '{');
    const stale = decideLock({
      readable: false,
      record: null,
      lockPath: lock,
      pidAlive: () => false,
    });
    assert.equal(stale.releaseLock, true);
    assert.equal(stale.persist.message.includes('повреждена'), true);
    writeJsonAtomic(state, { status: 'idle', message: 'целое' });
    assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), { status: 'idle', message: 'целое' });
    assert.equal(existsSync(state), true);
    tryLock(lock, 77);
    const deadWorker = decideLock({
      readable: true,
      record: { status: 'running', phase: 'build', pid: 55, switched: false },
      lockPath: lock,
      pidAlive: (pid) => pid === 77,
    });
    assert.equal(deadWorker.releaseLock, true);
    assert.equal(deadWorker.persist.status, 'interrupted');
    const restoreHolds = decideLock({
      readable: true,
      record: { status: 'running', phase: 'switching', pid: 77, switched: false },
      lockPath: lock,
      pidAlive: (pid) => pid === 77,
    });
    assert.equal(restoreHolds.releaseLock, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('возврат без пары commit и snapshotId не переключает релиз', async () => {
  let switched = false;
  const result = await runRestore({
    read: () => ({ status: 'succeeded', previousReleaseId: 'releases/old' }),
    write: () => {},
    identityOf: () => null,
    switchRelease: () => {
      switched = true;
      return { previous: null };
    },
    verify: async () => ({ ok: true }),
  });
  assert.equal(switched, false);
  assert.equal(result.switched, false);
  assert.match(result.message, /commit и snapshotId/);
});

test('новый релиз и штатный релиз без releaseId читаются одной парой', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-identity-'));
  try {
    const official = { commit: 'e'.repeat(40), snapshotId: 'snap:official' };
    const fresh = { commit: 'f'.repeat(40), snapshotId: 'snap:fresh' };
    mkdirSync(join(root, 'releases', 'official'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), 'new');
    writeFileSync(join(root, 'releases', 'official', 'release.json'), `${JSON.stringify(official, null, 2)}\n`);
    symlinkSync('releases/official', join(root, 'current'));
    publishTree(join(root, 'dist'), root, 'content-1', fresh);
    switchCurrent(root, 'content-1');
    assert.deepEqual(releaseIdentity(JSON.parse(readFileSync(join(root, 'releases', 'content-1', 'release.json'), 'utf8'))), fresh);
    assert.equal(JSON.parse(readFileSync(join(root, 'releases', 'official', 'release.json'), 'utf8')).releaseId, undefined);
    const result = await runRestore({
      read: () => ({ status: 'succeeded', previousReleaseId: 'releases/official' }),
      write: () => {},
      identityOf: (releaseId) => identityFromReleaseDir(join(root, 'releases', releaseId)),
      switchRelease: (releaseId) => switchCurrent(root, releaseId),
      verify: async (expected) => {
        const served = JSON.parse(readFileSync(join(root, 'current', 'release.json'), 'utf8'));
        const observed = releaseIdentity(served);
        return {
          ok: observed?.commit === expected.commit && observed?.snapshotId === expected.snapshotId,
          siteUrl: 'http://127.0.0.1/release.json',
        };
      },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(readlinkSync(join(root, 'current')), 'releases/official');
    assert.deepEqual(identityFromReleaseDir(join(root, 'releases', 'official')), official);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('первый клик content-admin без дерева не стартует сборку и снимает lock', () => {
  assert.equal(mayRefresh(['content-admin']), true);
  assert.equal(refreshReady({}), false);
  assert.equal(refreshReady({ IKPK_BUILD_WORKSPACE: '/missing', IKPK_VERIFY_URL: 'http://127.0.0.1/release.json' }), false);
  const root = mkdtempSync(join(tmpdir(), 'ikpk-first-'));
  try {
    const lock = join(root, 'state.json.lock');
    let spawned = 0;
    const begun = beginRefresh({
      record: null,
      pidAlive: () => true,
      lockAcquired: tryLock(lock, 77),
      ready: refreshReady({}),
      now: () => '2026-09-27T00:00:00.000Z',
      spawn: () => {
        spawned += 1;
        return { pid: 9 };
      },
    });
    assert.equal(spawned, 0);
    assert.equal(begun.releaseLock, true);
    assert.equal(begun.body.message, MESSAGES.notPrepared);
    assert.equal(begun.body.switched, false);
    unlock(lock);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('первый клик content-admin по дереву с astro, tsx и адресом проверки стартует одну сборку', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-ready-'));
  try {
    mkdirSync(join(root, 'web', 'node_modules', 'astro'), { recursive: true });
    writeFileSync(join(root, 'web', 'node_modules', 'astro', 'package.json'), '{}');
    assert.equal(refreshReady({ IKPK_BUILD_WORKSPACE: root, IKPK_VERIFY_URL: 'http://127.0.0.1/release.json' }), false);
    mkdirSync(join(root, 'web', 'node_modules', 'tsx'), { recursive: true });
    writeFileSync(join(root, 'web', 'node_modules', 'tsx', 'package.json'), '{}');
    const env = { IKPK_BUILD_WORKSPACE: root, IKPK_VERIFY_URL: 'http://127.0.0.1/release.json' };
    assert.equal(refreshReady(env), true);
    const lock = join(root, 'state.json.lock');
    let spawned = 0;
    const begun = beginRefresh({
      record: null,
      pidAlive: () => true,
      lockAcquired: tryLock(lock, 77),
      ready: refreshReady(env),
      now: () => '2026-09-27T00:00:00.000Z',
      spawn: () => {
        spawned += 1;
        return { pid: 9 };
      },
    });
    assert.equal(spawned, 1);
    assert.equal(begun.body.status, 'running');
    assert.equal(begun.releaseLock, false);
    assert.equal(existsSync(lock), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('исключение проверки после возврата не называется «сайт не менялся»', async () => {
  let switched = false;
  const result = await runRestore({
    read: () => ({ status: 'succeeded', previousReleaseId: 'releases/old' }),
    write: () => {},
    identityOf: () => ({ commit: 'a'.repeat(40), snapshotId: 'snap:old' }),
    switchRelease: () => {
      switched = true;
      return { previous: 'releases/content-1' };
    },
    verify: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.equal(switched, true);
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.switched, true);
  assert.equal(result.message, MESSAGES.restoreVerifyFailed);
  assert.notEqual(result.message, MESSAGES.failed);
});

test('commit нового релиза — SHA дерева сборки, не commit текущего сайта', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-commit-'));
  try {
    const served = '380bee2627e9c197d72e97dd00365671075689f8';
    const delivered = 'c'.repeat(40);
    mkdirSync(join(root, 'releases', 'old'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), 'new');
    writeFileSync(
      join(root, 'releases', 'old', 'release.json'),
      `${JSON.stringify({ commit: served, snapshotId: 'snap:served' })}\n`,
    );
    symlinkSync('releases/old', join(root, 'current'));
    assert.equal(installedCommit(root, ''), null);
    assert.equal(installedCommit(root, undefined), null);
    assert.equal(installedCommit(root, delivered), delivered);
    assert.notEqual(installedCommit(root, delivered), served);
    publishTree(join(root, 'dist'), root, 'content-1', {
      commit: installedCommit(root, delivered),
      snapshotId: 'snap:new',
    });
    const declared = releaseIdentity(JSON.parse(readFileSync(join(root, 'releases', 'content-1', 'release.json'), 'utf8')));
    assert.equal(declared.commit, delivered);
    assert.notEqual(declared.commit, served);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('отказ записи running снимает lock возврата', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-lock-write-'));
  try {
    const lock = join(root, 'state.json.lock');
    let writes = 0;
    const result = await runLockedRestore({
      lock,
      pid: 77,
      current: { status: 'succeeded', previousReleaseId: 'releases/old' },
      write: () => {
        writes += 1;
        throw new Error('ENOSPC');
      },
      identityOf: () => ({ commit: 'a'.repeat(40), snapshotId: 'snap:old' }),
      switchRelease: () => {
        throw new Error('не должны переключать');
      },
      verify: async () => ({ ok: true }),
    });
    assert.equal(writes >= 1, true);
    assert.equal(result.switched, false);
    assert.equal(result.status, 'failed');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
