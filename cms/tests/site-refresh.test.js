import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MESSAGES,
  beginRefresh,
  childEnvironment,
  commandFor,
  mayRefresh,
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
    build: async () => ({ ok: true, releaseId: 'content-1' }),
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

test('команда сборки ограничивает память и не ставит зависимости', () => {
  const contained = commandFor(true, '/usr/bin/node', '-e');
  assert.equal(contained.args.includes('npm'), false);
  assert.equal(contained.args.includes('ci'), false);
  assert.ok(contained.args.includes('MemoryMax=550M'));
  assert.ok(contained.args.includes('CPUWeight=20'));
  assert.ok(contained.args.includes('nice'));
  const plain = commandFor(false, '/usr/bin/node', '-e');
  assert.equal(plain.command, 'nice');
  assert.equal(plain.args.includes('ci'), false);
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
    mkdirSync(join(root, 'releases', 'content-1'), { recursive: true });
    writeFileSync(join(root, 'releases', 'old', 'index.html'), 'old');
    writeFileSync(join(root, 'releases', 'content-1', 'release.json'), '{"releaseId":"content-1"}\n');
    symlinkSync('releases/old', join(root, 'current'));
    const switched = switchCurrent(root, 'content-1');
    assert.equal(switched.previous, 'releases/old');
    assert.equal(readlinkSync(join(root, 'current')), 'releases/content-1');
    assert.equal(existsSync(join(root, 'releases', 'old', 'index.html')), true);
    assert.equal(readFileSync(join(root, 'releases', 'content-1', 'release.json'), 'utf8').includes('content-1'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('возврат предыдущего релиза — отдельное действие', async () => {
  let target = null;
  const result = await runRestore({
    read: () => ({ status: 'succeeded', previousReleaseId: 'releases/old' }),
    write: () => {},
    switchRelease: (releaseId) => {
      target = releaseId;
      return { previous: 'releases/content-1' };
    },
    verify: async (releaseId) => ({ ok: releaseId === 'old', siteUrl: 'http://127.0.0.1/release.json' }),
  });
  assert.equal(target, 'old');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.message, MESSAGES.restored);
});

test('проверка релиза требует ожидаемый идентификатор и код 200', async () => {
  const ok = await verifyRelease({
    url: 'http://127.0.0.1/release.json',
    releaseId: 'content-1',
    host: 'staging.ikpk.su',
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Host, 'staging.ikpk.su');
      return { status: 200, json: async () => ({ releaseId: 'content-1' }) };
    },
  });
  assert.equal(ok.ok, true);
  const missed = await verifyRelease({
    url: 'http://127.0.0.1/release.json',
    releaseId: 'content-1',
    fetchImpl: async () => ({ status: 200, json: async () => ({ releaseId: 'other' }) }),
  });
  assert.equal(missed.ok, false);
});
