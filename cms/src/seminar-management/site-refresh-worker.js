import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  installedCommit,
  publishTree,
  redact,
  refreshStatePath,
  releaseIdentity,
  reuseDerivatives,
  runRefresh,
  switchCurrent,
  unlock,
  verifyRelease,
  workspaceReady,
  writeJsonAtomic,
} from './site-refresh-operation.js';

function statePath() {
  return refreshStatePath(process.env);
}

function writeState(record) {
  writeJsonAtomic(statePath(), record);
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
        const commit = installedCommit(webRoot, process.env.IKPK_INSTALLED_COMMIT);
        let snapshotId = null;
        try {
          snapshotId = JSON.parse(readFileSync(join(workspace, 'web', '.snapshot', 'snapshot.json'), 'utf8')).snapshotId;
        } catch {
          snapshotId = null;
        }
        const identity = releaseIdentity({ commit, snapshotId });
        if (!identity) return { ok: false, detail: 'снимок без snapshotId или нет commit установленного кода' };
        const releaseId = `content-${Date.now()}`;
        publishTree(join(workspace, 'web', 'dist'), webRoot, releaseId, identity);
        return { ok: true, releaseId, identity };
      },
      canVerify: () => Boolean(process.env.IKPK_VERIFY_URL),
      switchRelease: (releaseId) => switchCurrent(webRoot, releaseId),
      verify: (expected) =>
        verifyRelease({
          url: process.env.IKPK_VERIFY_URL,
          expected,
          host: process.env.IKPK_VERIFY_HOST,
          fetchImpl: globalThis.fetch,
        }),
    });
  } finally {
    unlock(lock);
  }
}
