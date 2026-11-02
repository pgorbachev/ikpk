import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  MESSAGES,
  childEnvironment,
  decideLock,
  identityFromReleaseDir,
  hostPublicationStatus,
  isPidAlive,
  launchPlan,
  mayRefresh,
  normalizeReleaseTarget,
  ownsLock,
  refreshReady,
  runLockedRestore,
  redact,
  publicView,
  readStateFile,
  refreshStatePath,
  switchCurrent,
  tryLock,
  unlock,
  verifyRelease,
  writeJsonAtomic,
} from './site-refresh-operation.js';

function locations() {
  const state = refreshStatePath(process.env);
  return { state, lock: `${state}.lock` };
}

function writeRecord(state, record) {
  const stored = { ...record };
  if (stored.detail) stored.detail = redact(stored.detail);
  delete stored.env;
  writeJsonAtomic(state, stored);
}

async function actorMayRefresh(strapi, user) {
  if (!user?.id) return false;
  const stored = await strapi.db.query('admin::user').findOne({
    where: { id: user.id },
    populate: ['roles'],
  });
  return mayRefresh((stored?.roles || []).map((role) => role.code));
}

function deny(ctx) {
  ctx.status = 403;
  ctx.body = { message: MESSAGES.forbidden };
}

export function registerSiteRefresh(strapi, deps: { hostPublicationStatus?: typeof hostPublicationStatus } = {}) {
  const readHostPublication = deps.hostPublicationStatus || hostPublicationStatus;
  const routes = strapi.admin?.routes?.admin?.routes;
  if (!Array.isArray(routes)) return;
  routes.push(
    {
      method: 'GET',
      path: '/site-refresh',
      handler: async (ctx) => {
        if (!(await actorMayRefresh(strapi, ctx.state.user))) return deny(ctx);
        const { state, lock } = locations();
        const loaded = readStateFile(state);
        const decision = decideLock({
          readable: loaded.readable,
          record: loaded.record,
          lockPath: lock,
          pidAlive: isPidAlive,
        });
        ctx.body = publicView(decision.record);
      },
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
    {
      method: 'POST',
      path: '/site-refresh',
      handler: async (ctx) => {
        if (!(await actorMayRefresh(strapi, ctx.state.user))) return deny(ctx);
        if (ctx.request.body?.action === 'restore') {
          ctx.body = await restorePrevious({ hostPublicationStatus: readHostPublication });
          return;
        }
        ctx.body = launchRefresh({ hostPublicationStatus: readHostPublication });
      },
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
  );
}

function applyDecision(state, lock) {
  const loaded = readStateFile(state);
  const decision = decideLock({
    readable: loaded.readable,
    record: loaded.record,
    lockPath: lock,
    pidAlive: isPidAlive,
  });
  return decision.record;
}

export function launchRefresh({ write = writeRecord, spawnWorker = spawn, workerPath = null,
  report = console.error, hostPublicationStatus: readHostPublication = hostPublicationStatus } = {}) {
  if (readHostPublication()) return { status: 'running', phase: 'host-publication', message: MESSAGES.publicationBusy };
  const { state, lock } = locations();
  if (!readStateFile(state).readable) return { status: 'failed', message: MESSAGES.corrupt };
  const current = applyDecision(state, lock);
  if (current?.status === 'running' || current?.status === 'verification-failed') return publicView(current);
  const token = randomBytes(16).toString('hex');
  if (!tryLock(lock, process.pid, token)) return { status: 'running', message: MESSAGES.busy };
  const lockedState = readStateFile(state);
  if (!lockedState.readable) {
    unlock(lock, process.pid, token);
    return { status: 'failed', message: MESSAGES.corrupt };
  }
  if (lockedState.record?.status === 'running' || lockedState.record?.status === 'verification-failed') {
    unlock(lock, process.pid, token);
    return publicView(lockedState.record);
  }
  if (!refreshReady(process.env)) {
    unlock(lock, process.pid, token);
    return { status: 'failed', message: MESSAGES.notPrepared };
  }
  // Record intent before spawning. The controller never writes state again: the
  // real worker can start or finish before spawn returns, including via systemd.
  try {
    write(state, { status: 'running', phase: 'starting', pid: process.pid,
      message: 'Обновление запущено. Закрытие вкладки его не отменяет.',
      startedAt: new Date().toISOString(), switched: false });
  } catch (error) {
    unlock(lock, process.pid, token);
    throw error;
  }
  const worker = workerPath || join(__dirname, 'site-refresh-worker.js');
  const systemdRun = existsSync('/bin/systemd-run') || existsSync('/usr/bin/systemd-run');
  const entry = `require(${JSON.stringify(worker)}).executeRefresh().then(() => process.exit(0), () => process.exit(1))`;
  const plan = launchPlan({ env: process.env, systemdRun, nodePath: process.execPath, script: entry });
  const env = childEnvironment(process.env);
  env.IKPK_REFRESH_OWNER_PID = String(process.pid);
  env.IKPK_REFRESH_LOCK_TOKEN = token;
  if (plan.session) {
    env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
    env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  }
  const markSpawnFailed = () => {
    if (!ownsLock(lock, process.pid, token)) return;
    const loaded = readStateFile(state);
    if (!loaded.readable || loaded.record?.status !== 'running'
        || loaded.record?.phase !== 'starting' || loaded.record?.pid !== process.pid) return;
    try {
      writeRecord(state, { status: 'failed', message: MESSAGES.failed, switched: false });
      unlock(lock, process.pid, token);
    } catch { /* Preserve the lock if the failed result cannot be written. */ }
  };
  let child;
  try {
    child = spawnWorker(plan.command, plan.args, { detached: true, stdio: 'ignore', env });
  } catch (error) {
    markSpawnFailed();
    throw error;
  }
  // pid is undefined only when no child was started; other errors are ambiguous.
  child.on('error', () => { if (child.pid === undefined) markSpawnFailed(); });
  child.on('exit', () => {
    if (ownsLock(lock, process.pid, token)) report('Запуск worker не подтверждён; состояние неизвестно, блокировка сохранена.');
  });
  child.unref();
  return { status: 'running', message: MESSAGES.busy };
}

async function restorePrevious({ hostPublicationStatus: readHostPublication = hostPublicationStatus } = {}) {
  if (readHostPublication()) return { status: 'failed', message: MESSAGES.publicationBusy, switched: false };
  const { state, lock } = locations();
  const current = applyDecision(state, lock);
  if (current?.status === 'running') return publicView({ ...current, message: MESSAGES.busy });
  const webRoot = process.env.IKPK_WEB_ROOT;
  return runLockedRestore({
    lock,
    pid: process.pid,
    current,
    readCurrent: () => {
      const loaded = readStateFile(state);
      if (!loaded.readable) throw new Error(MESSAGES.corrupt);
      return loaded.record;
    },
    write: (record) => writeRecord(state, record),
    webRoot,
    readCurrentTarget: () => readlinkSync(join(webRoot, 'current')),
    switchRelease: (releaseId, expected) => switchCurrent(webRoot, releaseId, expected),
    identityOf: (releaseId) => {
      try {
        const target = normalizeReleaseTarget(`releases/${releaseId}`, webRoot, true);
        return identityFromReleaseDir(join(webRoot, target));
      } catch { return null; }
    },
    installedCommit: process.env.IKPK_INSTALLED_COMMIT,
    verify: (expected) =>
      verifyRelease({
        url: process.env.IKPK_VERIFY_URL,
        expected,
        host: process.env.IKPK_VERIFY_HOST,
        fetchImpl: globalThis.fetch,
      }),
  });
}
