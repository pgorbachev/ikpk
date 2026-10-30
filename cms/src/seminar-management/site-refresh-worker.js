import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  childEnvironment,
  installedCommit,
  publishTree,
  redact,
  refreshStatePath,
  releaseIdentity,
  reuseDerivatives,
  runRefresh,
  siteBuildEnv,
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
  // Keep the detached worker identity in terminal records too: an operator may
  // observe the terminal write just before this process exits and releases its lock.
  writeJsonAtomic(statePath(), { ...record, workerPid: process.pid });
}

function runStep(command, args, cwd, extraEnv, restrictedEnv = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...(restrictedEnv ? childEnvironment(process.env, { includeCmsCredentials: false }) : process.env), ...extraEnv },
    encoding: 'utf8',
    timeout: 50 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, detail: redact(result.stderr || result.stdout || result.error?.message || 'сбой') };
  }
  return { ok: true };
}

function removeCaptureBundle(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) removeCaptureBundle(join(path, name));
    } else if (!stat.isSymbolicLink()) chmodSync(path, 0o600);
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
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
        if (process.env.IKPK_CAPTURE_PROFILE === 'staging194') {
          if (process.env.IKPK_VERIFY_URL !== 'https://194.226.99.10/release.json'
              || !process.env.IKPK_CAPTURE_DATABASE || !process.env.IKPK_CAPTURE_MEDIA
              || process.env.IKPK_MEDIA_CACHE !== '/var/www/ikpk/current/media'
              || !process.env.IKPK_CAPTURE_ROOT || !/^[0-9a-f]{40}$/.test(process.env.IKPK_INSTALLED_COMMIT || '')) {
            return { ok: false, detail: 'staging194 server capture is not safely configured' };
          }
          const operationId = `content-${Date.now()}-${process.pid}`;
          const bundle = join(process.env.IKPK_CAPTURE_ROOT, operationId);
          const helper = join(process.env.IKPK_BUILD_WORKSPACE, 'cms', 'scripts', 'capture-staging194.py');
          const sealer = join(process.env.IKPK_BUILD_WORKSPACE, 'scripts', 'lib', 'seal-staging193-capture.mjs');
          const captureEnv = {
            IKPK_CAPTURE_PROFILE: 'staging194',
            IKPK_VERIFY_URL: 'https://194.226.99.10/release.json',
            IKPK_CAPTURE_DATABASE: process.env.IKPK_CAPTURE_DATABASE,
            IKPK_CAPTURE_MEDIA: process.env.IKPK_CAPTURE_MEDIA,
            IKPK_CAPTURE_ROOT: process.env.IKPK_CAPTURE_ROOT,
            IKPK_MEDIA_CACHE: process.env.IKPK_MEDIA_CACHE,
          };
          let result;
          try {
            result = runStep('python3', [helper, operationId], workspace, captureEnv, true);
            if (!result.ok) return result;
            result = runStep(process.execPath, [sealer, bundle, operationId, process.env.IKPK_INSTALLED_COMMIT,
              join(workspace, 'cms', 'src'), 'staging194'], workspace, {}, true);
            if (!result.ok) return result;
            return runStep(
              process.execPath,
              [join(workspace, 'web', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
                'scripts/capture-content-snapshot.ts', '--server-capture', bundle],
              join(workspace, 'web'),
              { CONTENT_SNAPSHOT_DIR: snapshotDir, CMS_URL: '', CMS_TOKEN: '', STRAPI_URL: '', STRAPI_API_TOKEN: '' },
              true,
            );
          } finally {
            removeCaptureBundle(bundle);
          }
        }
        if (process.env.IKPK_CAPTURE_PROFILE) return { ok: false, detail: 'unsupported server capture profile' };
        return runStep(
          process.execPath,
          [join(workspace, 'web', 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/capture-content-snapshot.ts'],
          join(workspace, 'web'),
          {
            CONTENT_SNAPSHOT_DIR: snapshotDir,
            CMS_URL: process.env.CMS_URL || 'http://127.0.0.1:1337',
            CMS_TOKEN: process.env.CMS_TOKEN || '',
          },
        );
      },
      reuseDerivatives: () => reuseDerivatives(workspace, process.env.IKPK_MEDIA_CACHE),
      build: () => {
        const staging194 = process.env.IKPK_CAPTURE_PROFILE === 'staging194';
        const built = runStep('npm', [ 'run', ...(staging194 ? ['build:demo193'] : ['build']) ],
          join(workspace, 'web'), siteBuildEnv(workspace, staging194), staging194);
        if (!built.ok) return built;
        const commit = installedCommit(webRoot, process.env.IKPK_INSTALLED_COMMIT);
        let snapshotId;
        try {
          snapshotId = JSON.parse(readFileSync(join(workspace, 'web', '.snapshot', 'snapshot.json'), 'utf8')).snapshotId;
        } catch {
          snapshotId = null;
        }
        const identity = releaseIdentity({ commit, snapshotId });
        if (!identity) return { ok: false, detail: 'снимок без snapshotId или нет commit установленного кода' };
        const releaseId = `content-${Date.now()}`;
        const output = staging194 ? 'dist-demo193' : 'dist';
        publishTree(join(workspace, 'web', output), webRoot, releaseId, identity);
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
