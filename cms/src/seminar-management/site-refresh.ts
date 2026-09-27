import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MESSAGES,
  beginRefresh,
  childEnvironment,
  commandFor,
  mayRefresh,
  redact,
  publicView,
  reconcile,
  runRestore,
  switchCurrent,
  tryLock,
  unlock,
  verifyRelease,
  workspaceReady,
} from './site-refresh-operation.js';

function locations() {
  const state =
    process.env.IKPK_REFRESH_STATE || join(process.env.IKPK_WEB_ROOT || '/var/www/ikpk', 'shared', 'site-refresh.json');
  return { state, lock: `${state}.lock` };
}

function readRecord(state) {
  try {
    return JSON.parse(readFileSync(state, 'utf8'));
  } catch {
    return null;
  }
}

function writeRecord(state, record) {
  mkdirSync(dirname(state), { recursive: true });
  const stored = { ...record };
  if (stored.detail) stored.detail = redact(stored.detail);
  delete stored.env;
  writeFileSync(state, `${JSON.stringify(stored)}\n`);
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
        const { state } = locations();
        const record = reconcile(readRecord(state), pidAlive);
        if (record && record.status !== 'running') unlock(locations().lock);
        if (record) writeRecord(state, record);
        ctx.body = publicView(record);
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

function launch() {
  const { state, lock } = locations();
  const current = reconcile(readRecord(state), pidAlive);
  if (current && current.status !== 'running') unlock(lock);
  const locked = current?.status === 'running' ? false : tryLock(lock);
  const worker = join(__dirname, 'site-refresh-worker.js');
  const hasSystemd = existsSync('/bin/systemd-run') || existsSync('/usr/bin/systemd-run');
  const plan = commandFor(hasSystemd, process.execPath, '-e');
  const entry = `require(${JSON.stringify(worker)}).executeRefresh().then(() => process.exit(0), () => process.exit(1))`;
  const begun = beginRefresh({
    record: current,
    pidAlive,
    lockAcquired: current?.status === 'running' ? false : locked,
    ready: workspaceReady(process.env.IKPK_BUILD_WORKSPACE),
    now: () => new Date().toISOString(),
    spawn: () => {
      const child = spawn(plan.command, [...plan.args, entry], {
        detached: true,
        stdio: 'ignore',
        env: childEnvironment(process.env),
      });
      child.on('error', () => {
        writeRecord(state, { status: 'failed', message: MESSAGES.failed, switched: false });
        unlock(lock);
      });
      child.unref();
      return child;
    },
  });
  if (begun.persist) writeRecord(state, begun.persist);
  if (begun.releaseLock) unlock(lock);
  return begun.body;
}

async function restorePrevious() {
  const { state, lock } = locations();
  const current = reconcile(readRecord(state), pidAlive);
  if (current?.status === 'running') return publicView({ ...current, message: MESSAGES.busy });
  if (!tryLock(lock)) return { status: 'running', message: MESSAGES.busy };
  try {
    return await runRestore({
      read: () => current,
      write: (record) => writeRecord(state, record),
      switchRelease: (releaseId) => switchCurrent(process.env.IKPK_WEB_ROOT, releaseId),
      verify: (releaseId) =>
        verifyRelease({
          url: process.env.IKPK_VERIFY_URL,
          releaseId,
          host: process.env.IKPK_VERIFY_HOST,
          fetchImpl: globalThis.fetch,
        }),
    });
  } finally {
    unlock(lock);
  }
}
