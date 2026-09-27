import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  publishTree,
  redact,
  reuseDerivatives,
  runRefresh,
  switchCurrent,
  unlock,
  verifyRelease,
  workspaceReady,
} from './site-refresh-operation.js';

function statePath() {
  return process.env.IKPK_REFRESH_STATE || join(process.env.IKPK_WEB_ROOT || '/var/www/ikpk', 'shared', 'site-refresh.json');
}

function writeState(record) {
  const path = statePath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

function runStep(command, args, cwd, extraEnv) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 50 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, detail: redact(result.stderr || result.stdout || result.error?.message || 'сбой') };
  }
  return { ok: true };
}

export async function executeRefresh() {
  const workspace = process.env.IKPK_BUILD_WORKSPACE;
  const webRoot = process.env.IKPK_WEB_ROOT;
  const lock = `${statePath()}.lock`;
  try {
    return await runRefresh({
      pid: process.pid,
      now: () => new Date().toISOString(),
      write: writeState,
      workspaceReady: () => workspaceReady(workspace),
      capture: () => {
        const snapshotDir = join(workspace, 'web', '.snapshot');
        mkdirSync(snapshotDir, { recursive: true });
        return runStep(
          process.execPath,
          [join(workspace, 'web', 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/capture-content-snapshot.ts'],
          join(workspace, 'web'),
          { CONTENT_SNAPSHOT_DIR: snapshotDir, CMS_URL: process.env.CMS_URL || 'http://127.0.0.1:1337' },
        );
      },
      reuseDerivatives: () => reuseDerivatives(workspace, process.env.IKPK_MEDIA_CACHE),
      build: () => {
        const built = runStep('npm', ['run', 'build'], join(workspace, 'web'), {
          CONTENT_SNAPSHOT_DIR: join(workspace, 'web', '.snapshot'),
          NODE_OPTIONS: '--max-old-space-size=480',
        });
        if (!built.ok) return built;
        const releaseId = `content-${Date.now()}`;
        publishTree(join(workspace, 'web', 'dist'), webRoot, releaseId);
        return { ok: true, releaseId };
      },
      canVerify: () => Boolean(process.env.IKPK_VERIFY_URL),
      switchRelease: (releaseId) => switchCurrent(webRoot, releaseId),
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
