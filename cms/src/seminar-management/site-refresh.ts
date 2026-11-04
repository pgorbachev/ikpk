import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  MESSAGES,
  childEnvironment,
  identityFromReleaseDir,
  hostPublicationStatus,
  isPidAlive,
  launchPlan,
  mayRefresh,
  normalizeReleaseTarget,
  refreshReady,
  reconcile,
  runRestoreTransaction,
  redact,
  publicView,
  readStateFile,
  refreshStatePath,
  switchCurrent,
  acquirePublicationLock,
  openPublicationLock,
  publicationLockPath,
  withPublicationLock,
  verifyRelease,
  writeJsonAtomic,
} from './site-refresh-operation.js';

function locations() {
  const state = refreshStatePath(process.env);
  return { state };
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
        const { state } = locations();
        ctx.body = publicView(applyDecision(state));
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
        ctx.body = await launchRefresh({ hostPublicationStatus: readHostPublication });
      },
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
  );
}

function applyDecision(state, lock) {
  const loaded = readStateFile(state);
  if (!loaded.readable) return { status: 'failed', message: MESSAGES.corrupt, switched: false };
  if (legacyRefreshLockExists(state)) return { status: 'running', message: MESSAGES.busy };
  const record = loaded.record;
  if (record?.status === 'running' && record.phase === 'switching' && record.switched === false
      && record.pid === process.pid && record.workerPid == null && record.refreshOperationToken == null
      && typeof record.releaseId === 'string' && typeof record.previousReleaseId === 'string') {
    let fd;
    try {
      fd = openPublicationLock(publicationLockPath(process.env));
      if (!acquirePublicationLock(fd, { path: publicationLockPath(process.env) })) return publicView({ ...record, message: MESSAGES.busy });
      const latest = readStateFile(state);
      if (!latest.readable || latest.record?.status !== 'running'
          || latest.record.phase !== 'switching' || latest.record.pid !== record.pid
          || latest.record.releaseId !== record.releaseId
          || latest.record.previousReleaseId !== record.previousReleaseId
          || latest.record.refreshOperationToken != null || latest.record.workerPid != null) {
        return publicView(latest.record);
      }
      const webRoot = process.env.IKPK_WEB_ROOT;
      const source = normalizeReleaseTarget(`releases/${record.releaseId}`, webRoot, true);
      const target = normalizeReleaseTarget(record.previousReleaseId, webRoot, true);
      const currentTarget = normalizeReleaseTarget(readlinkSync(join(webRoot, 'current')), webRoot, true);
      if (source !== target && (currentTarget === source || currentTarget === target)) {
        return publicView({ ...record, status: 'interrupted', message: MESSAGES.interrupted });
      }
    } catch {
      return publicView(record);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return publicView(record);
  }
  return reconcile(loaded.record, isPidAlive);
}

function legacyRefreshLockExists(state) {
  try {
    lstatSync(`${state}.lock`);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return true;
  }
}

function publicationTransportUnresolved(webRoot) {
  for (const name of ['.publication-pending.json', '.publication-preparation.json']) {
    try { lstatSync(join(webRoot, name)); return true; }
    catch (error) { if (error?.code !== 'ENOENT') return true; }
  }
  return false;
}

export async function launchRefresh({ write = writeRecord, spawnWorker = spawn, workerPath = null,
  report = console.error, hostPublicationStatus: readHostPublication = hostPublicationStatus } = {}) {
  const { state } = locations();
  let publicationFd;
  try {
    publicationFd = openPublicationLock(publicationLockPath(process.env));
    if (!acquirePublicationLock(publicationFd, { path: publicationLockPath(process.env) })) return { status: 'running', message: MESSAGES.busy };
    if (readHostPublication()) return { status: 'running', phase: 'host-publication', message: MESSAGES.publicationBusy };
    if (publicationTransportUnresolved(process.env.IKPK_WEB_ROOT || '/var/www/ikpk')) {
      return { status: 'running', phase: 'host-publication', message: MESSAGES.publicationBusy };
    }
    const loaded = readStateFile(state);
    if (!loaded.readable) return { status: 'failed', message: MESSAGES.corrupt };
    if (legacyRefreshLockExists(state)) return { status: 'running', message: MESSAGES.busy };
    const current = reconcile(loaded.record, isPidAlive);
    if (['running', 'interrupted', 'verification-failed'].includes(current?.status)) return publicView(current);
    if (current?.workerPid && isPidAlive(current.workerPid)) return publicView({ ...current, status: 'running', message: MESSAGES.busy });
    if (!refreshReady(process.env)) return { status: 'failed', message: MESSAGES.notPrepared };

    const token = randomBytes(16).toString('hex');
    write(state, { status: 'running', phase: 'starting', pid: process.pid,
      refreshOperationToken: token,
      message: 'Обновление запущено. Закрытие вкладки его не отменяет.',
      startedAt: new Date().toISOString(), switched: false });
    const worker = workerPath || join(__dirname, 'site-refresh-worker.js');
    const systemdRun = existsSync('/bin/systemd-run') || existsSync('/usr/bin/systemd-run');
    const entry = `require(${JSON.stringify(worker)}).executeRefresh().then(() => process.exit(0), () => process.exit(1))`;
    const plan = launchPlan({ env: process.env, systemdRun, nodePath: process.execPath, script: entry });
    const env = childEnvironment(process.env);
    env.IKPK_REFRESH_OWNER_PID = String(process.pid);
    env.IKPK_REFRESH_OPERATION_TOKEN = token;
    if (plan.session) {
      env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
      env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
    }
    let child;
    try { child = spawnWorker(plan.command, plan.args, { detached: true, stdio: 'ignore', env }); }
    catch (error) {
      const latest = readStateFile(state);
      try {
        if (latest.readable && latest.record?.status === 'running'
            && latest.record?.phase === 'starting' && latest.record?.pid === process.pid
            && latest.record?.refreshOperationToken === token) {
          write(state, { status: 'failed', message: MESSAGES.failed,
            detail: error?.message, switched: false, finishedAt: new Date().toISOString() });
        }
      }
      catch { /* Durable starting evidence is retained when terminal state cannot be written. */ }
      return { status: 'failed', message: MESSAGES.failed, switched: false };
    }
    let confirmedNoChild = false;
    child.unref();
    return await new Promise((resolve) => {
      let settled = false;
      const finishLaunch = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.once('spawn', () => finishLaunch({ status: 'running', message: MESSAGES.busy }));
      child.on('error', (error) => {
        if (settled) return;
        // A pre-spawn error with no assigned pid proves no child exists. The
        // controller still owns publicationFd, so terminalize only our intent.
        if (child.pid === undefined) {
          confirmedNoChild = true;
          const latest = readStateFile(state);
          try {
            if (latest.readable && latest.record?.status === 'running'
                && latest.record?.phase === 'starting' && latest.record?.pid === process.pid
                && latest.record?.refreshOperationToken === token) {
              write(state, { status: 'failed', message: MESSAGES.failed,
                detail: error.message, switched: false, finishedAt: new Date().toISOString() });
              finishLaunch({ status: 'failed', message: MESSAGES.failed, switched: false });
              return;
            }
          } catch { /* Preserve starting if terminal persistence failed. */ }
          report('Запуск worker не подтверждён; состояние starting сохранено для безопасного восстановления.');
          finishLaunch({ status: 'running', message: MESSAGES.busy });
          return;
        }
        if (child.pid === undefined) report('Запуск worker не подтверждён; состояние неизвестно, запись сохранена.');
        finishLaunch({ status: 'running', message: MESSAGES.busy });
      });
      child.once('exit', () => {
        if (!settled) {
          if (!confirmedNoChild) report('Запуск worker не подтверждён; состояние неизвестно, запись сохранена.');
          finishLaunch({ status: 'running', message: MESSAGES.busy });
          return;
        }
        if (confirmedNoChild) return;
        const latest = readStateFile(state);
        if (latest.readable && latest.record?.phase === 'starting'
            && latest.record?.refreshOperationToken === token) {
          report('Запуск worker не подтверждён; состояние неизвестно, запись сохранена.');
        }
      });
    });
  } catch (error) {
    if (error?.code === 'ENOENT' || String(error?.message || '').includes('shared publication lock')) {
      return { status: 'failed', message: MESSAGES.publicationBusy, switched: false };
    }
    throw error;
  } finally {
    if (publicationFd !== undefined) closeSync(publicationFd);
  }
}

async function restorePrevious({ hostPublicationStatus: readHostPublication = hostPublicationStatus } = {}) {
  const webRoot = process.env.IKPK_WEB_ROOT;
  const { state } = locations();
  try {
    return await withPublicationLock(publicationLockPath(process.env), async () => {
      if (readHostPublication()) return { status: 'failed', message: MESSAGES.publicationBusy, switched: false };
      if (publicationTransportUnresolved(webRoot)) {
        return { status: 'failed', message: MESSAGES.publicationBusy, switched: false };
      }
      if (legacyRefreshLockExists(state)) return { status: 'running', message: MESSAGES.busy };
      const loaded = readStateFile(state);
      if (!loaded.readable) return { status: 'failed', message: MESSAGES.corrupt };
      let effectiveRecord = loaded.record;
      const restoreIntent = loaded.record?.status === 'running'
        && loaded.record.phase === 'switching' && loaded.record.switched === false
        && loaded.record.workerPid == null && loaded.record.refreshOperationToken == null
        && Number.isSafeInteger(loaded.record.pid) && loaded.record.pid > 0
        && typeof loaded.record.releaseId === 'string'
        && typeof loaded.record.previousReleaseId === 'string';
      const interruptedRefreshIntent = loaded.record?.status === 'running'
        && ((loaded.record.phase === 'switching' && loaded.record.switched === false)
          || (loaded.record.phase === 'verifying' && loaded.record.switched === true))
        && Number.isSafeInteger(loaded.record.pid) && loaded.record.pid > 0
        && Number.isSafeInteger(loaded.record.workerPid) && loaded.record.workerPid > 0
        && loaded.record.pid === loaded.record.workerPid
        && loaded.record.refreshOperationToken == null
        && typeof loaded.record.releaseId === 'string'
        && typeof loaded.record.previousReleaseId === 'string'
        && !isPidAlive(loaded.record.pid) && !isPidAlive(loaded.record.workerPid);
      if (restoreIntent) {
        // The already-held flock proves that this same-process intent is no longer active.
        if (loaded.record.pid !== process.pid && isPidAlive(loaded.record.pid)) {
          return publicView({ ...loaded.record, message: MESSAGES.busy });
        }
        let source;
        let target;
        let currentTarget;
        try {
          source = normalizeReleaseTarget(`releases/${loaded.record.releaseId}`, webRoot, true);
          target = normalizeReleaseTarget(loaded.record.previousReleaseId, webRoot, true);
          currentTarget = normalizeReleaseTarget(readlinkSync(join(webRoot, 'current')), webRoot, true);
        } catch { return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false }; }
        if (source === target || (currentTarget !== source && currentTarget !== target)) {
          return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false };
        }
        const targetId = target.slice('releases/'.length);
        const identity = identityFromReleaseDir(join(webRoot, target));
        if (!identity || (process.env.IKPK_INSTALLED_COMMIT && identity.commit !== process.env.IKPK_INSTALLED_COMMIT)) {
          return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false };
        }
        if (currentTarget === target) {
          let checked;
          try {
            checked = await verifyRelease({ url: process.env.IKPK_VERIFY_URL, expected: identity,
              host: process.env.IKPK_VERIFY_HOST, fetchImpl: globalThis.fetch });
          } catch (error) { checked = { ok: false, detail: error?.message || MESSAGES.restoreVerifyFailed }; }
          if (!checked.ok) {
            return { status: 'verification-failed', phase: 'verifying', message: MESSAGES.restoreVerifyFailed,
              detail: redact(checked.detail), releaseId: targetId,
              previousReleaseId: source, switched: true };
          }
          effectiveRecord = {
            status: 'succeeded', phase: 'done', message: MESSAGES.restored,
            releaseId: targetId, switched: true,
            startedAt: loaded.record.startedAt, finishedAt: new Date().toISOString(),
            siteUrl: checked.siteUrl || null,
          };
          const latest = readStateFile(state);
          if (!latest.readable || latest.record?.status !== 'running' || latest.record.phase !== 'switching'
              || latest.record.pid !== loaded.record.pid || latest.record.releaseId !== loaded.record.releaseId
              || latest.record.previousReleaseId !== loaded.record.previousReleaseId || latest.record.switched !== false) {
            return { status: 'failed', message: MESSAGES.corrupt, switched: false };
          }
          writeRecord(state, effectiveRecord);
          return publicView(effectiveRecord);
        }
        effectiveRecord = { ...loaded.record, status: 'verification-failed', phase: 'verifying', switched: true };
      } else if (interruptedRefreshIntent) {
        let currentTarget;
        let previousTarget;
        try {
          currentTarget = normalizeReleaseTarget(readlinkSync(join(webRoot, 'current')), webRoot, true);
          previousTarget = normalizeReleaseTarget(loaded.record.previousReleaseId, webRoot, true);
        } catch { return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false }; }
        if (loaded.record.phase === 'switching' && loaded.record.switched === false
            && currentTarget === previousTarget) {
          const identity = identityFromReleaseDir(join(webRoot, previousTarget));
          if (!identity || (process.env.IKPK_INSTALLED_COMMIT && identity.commit !== process.env.IKPK_INSTALLED_COMMIT)) {
            return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false };
          }
          let checked;
          try {
            checked = await verifyRelease({ url: process.env.IKPK_VERIFY_URL, expected: identity,
              host: process.env.IKPK_VERIFY_HOST, fetchImpl: globalThis.fetch });
          } catch (error) { checked = { ok: false, detail: error?.message || MESSAGES.restoreVerifyFailed }; }
          if (!checked.ok) {
            return { status: 'failed', message: MESSAGES.restoreVerifyFailed,
              detail: redact(checked.detail), releaseId: loaded.record.releaseId,
              previousReleaseId: previousTarget, switched: false };
          }
          const latest = readStateFile(state);
          let latestCurrent;
          try { latestCurrent = normalizeReleaseTarget(readlinkSync(join(webRoot, 'current')), webRoot, true); }
          catch { return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false }; }
          if (!latest.readable || latest.record?.status !== 'running'
              || latest.record.phase !== 'switching' || latest.record.switched !== false
              || latest.record.pid !== loaded.record.pid || latest.record.workerPid !== loaded.record.workerPid
              || latest.record.releaseId !== loaded.record.releaseId
              || latest.record.previousReleaseId !== loaded.record.previousReleaseId
              || latestCurrent !== previousTarget) {
            return { status: 'failed', message: MESSAGES.corrupt, switched: false };
          }
          const failed = { status: 'failed', phase: 'switching', message: MESSAGES.failed,
            releaseId: loaded.record.releaseId, previousReleaseId: previousTarget,
            startedAt: loaded.record.startedAt, finishedAt: new Date().toISOString(), switched: false };
          writeRecord(state, failed);
          return publicView(failed);
        }
        if (currentTarget !== `releases/${loaded.record.releaseId}`) {
          return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false };
        }
        effectiveRecord = reconcile(loaded.record, isPidAlive);
      }
      const current = reconcile(effectiveRecord, isPidAlive);
      if (current?.status === 'running') return publicView({ ...current, message: MESSAGES.busy });
      return runRestoreTransaction({
        pid: process.pid,
        current,
        readCurrent: () => {
          const refreshed = readStateFile(state);
          if (!refreshed.readable) throw new Error(MESSAGES.corrupt);
          if (restoreIntent || interruptedRefreshIntent) {
            if (refreshed.record?.status !== 'running' || refreshed.record.phase !== loaded.record.phase
                || refreshed.record.pid !== loaded.record.pid || refreshed.record.releaseId !== loaded.record.releaseId
                || refreshed.record.previousReleaseId !== loaded.record.previousReleaseId
                || refreshed.record.switched !== loaded.record.switched
                || (restoreIntent && (refreshed.record.workerPid != null
                    || refreshed.record.refreshOperationToken != null))
                || (interruptedRefreshIntent && (refreshed.record.workerPid !== loaded.record.workerPid
                    || refreshed.record.refreshOperationToken != null))) {
              throw new Error(MESSAGES.corrupt);
            }
            return effectiveRecord;
          }
          return refreshed.record;
        },
        write: (record) => {
          if (record?.status === 'verification-failed' && !record.previousReleaseId
              && current?.releaseId) {
            record = { ...record, previousReleaseId: `releases/${current.releaseId}` };
          }
          writeRecord(state, record);
        },
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
        verify: (expected) => verifyRelease({
          url: process.env.IKPK_VERIFY_URL,
          expected,
          host: process.env.IKPK_VERIFY_HOST,
          fetchImpl: globalThis.fetch,
        }),
      });
    });
  } catch (error) {
    return error?.code === 'LOCK_BUSY'
      ? { status: 'running', message: MESSAGES.busy }
      : { status: 'failed', message: MESSAGES.publicationBusy, switched: false };
  }
}
