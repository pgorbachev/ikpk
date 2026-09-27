import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MESSAGES,
  beginRefresh,
  childEnvironment,
  decideLock,
  identityFromReleaseDir,
  launchPlan,
  mayRefresh,
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

export function registerSiteRefresh(strapi) {
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
          pidAlive,
        });
        if (decision.releaseLock) unlock(lock);
        if (decision.persist) writeRecord(state, decision.persist);
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
          ctx.body = await restorePrevious();
          return;
        }
        ctx.body = launch();
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
    pidAlive,
  });
  if (decision.releaseLock) unlock(lock);
  if (decision.persist) writeRecord(state, decision.persist);
  return decision.record;
}

function launch() {
  const { state, lock } = locations();
  const current = applyDecision(state, lock);
  const locked = current?.status === 'running' ? false : tryLock(lock, process.pid);
  const worker = join(__dirname, 'site-refresh-worker.js');
  const systemdRun = existsSync('/bin/systemd-run') || existsSync('/usr/bin/systemd-run');
  const entry = `require(${JSON.stringify(worker)}).executeRefresh().then(() => process.exit(0), () => process.exit(1))`;
  const plan = launchPlan({ env: process.env, systemdRun, nodePath: process.execPath, script: entry });
  const begun = beginRefresh({
    record: current,
    pidAlive,
    lockAcquired: current?.status === 'running' ? false : locked,
    ready: refreshReady(process.env),
    now: () => new Date().toISOString(),
    spawn: () => {
      const env = childEnvironment(process.env);
      if (plan.session) {
        env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
        env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
      }
      const child = spawn(plan.command, plan.args, {
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.on('error', () => {
        writeRecord(state, { status: 'failed', message: MESSAGES.failed, switched: false });
        unlock(lock);
      });
      child.unref();
      return child;
    },
  });
  if (begun.persist) {
    writeRecord(state, begun.persist);
    if (begun.persist.pid) tryLockOverwrite(lock, begun.persist.pid);
  }
  if (begun.releaseLock) unlock(lock);
  return begun.body;
}

function tryLockOverwrite(lock, pid) {
  try {
    writeFileSync(lock, `${pid}\n`);
  } catch {
    // lock остаётся с pid родителя, который жив, пока жива служба
  }
}

async function restorePrevious() {
  const { state, lock } = locations();
  const current = applyDecision(state, lock);
  if (current?.status === 'running') return publicView({ ...current, message: MESSAGES.busy });
  const webRoot = process.env.IKPK_WEB_ROOT;
  return runLockedRestore({
    lock,
    pid: process.pid,
    current,
    write: (record) => writeRecord(state, record),
    switchRelease: (releaseId) => switchCurrent(webRoot, releaseId),
    identityOf: (releaseId) => identityFromReleaseDir(join(webRoot, 'releases', releaseId)),
    verify: (expected) =>
      verifyRelease({
        url: process.env.IKPK_VERIFY_URL,
        expected,
        host: process.env.IKPK_VERIFY_HOST,
        fetchImpl: globalThis.fetch,
      }),
  });
}
