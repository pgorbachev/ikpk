import { cpSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readlinkSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MESSAGES = {
  failed: 'Сборка не удалась. Действующий сайт не менялся.',
  interrupted: 'Сборка прервана. Действующий сайт не менялся.',
  notPrepared:
    'Обновление сайта на этом стенде ещё не подготовлено: нет уже установленной сборки. Зависимости заново не ставятся.',
  verificationFailed:
    'Новый релиз не прошёл проверку после переключения. Это не успех и не автоматический откат.',
  switchIncomplete:
    'Переключение началось, проверка не завершилась. Это не успех и не автоматический откат.',
  succeeded: 'Сайт обновлён. Опубликован весь снимок CMS, не только открытый семинар.',
  restored: 'Возвращён предыдущий релиз. Автоматического отката при ошибке сборки нет: это отдельное действие.',
  restoreMissing: 'Предыдущий релиз не записан, возвращать нечего.',
  restoreVerifyFailed:
    'Возврат переключил релиз, проверка после этого не прошла. Это не автоматический откат.',
  busy: 'Обновление уже выполняется.',
  forbidden: 'Недостаточно прав для обновления сайта.',
  idle: 'Сайт ещё не обновлялся этой кнопкой.',
};

const SECRET = /(Bearer\s+)\S+|((?:CMS_TOKEN|STRAPI_API_TOKEN|CONTENT_ADMIN_PASSWORD|JWT_SECRET)=)([^\s]+)/gi;

export function redact(value) {
  return String(value ?? '').replace(SECRET, (match, bearer, named) => (bearer ? 'Bearer [скрыто]' : `${named}[скрыто]`));
}

export function mayRefresh(roleCodes) {
  return (roleCodes || []).some((code) => code === 'content-admin' || code === 'strapi-super-admin');
}

export function publicView(record) {
  if (!record) return { status: 'idle', message: MESSAGES.idle };
  return {
    status: record.status,
    message: record.message,
    phase: record.phase || null,
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
    releaseId: record.releaseId || null,
    previousReleaseId: record.previousReleaseId || null,
    siteUrl: record.siteUrl || null,
    detail: record.detail ? redact(record.detail) : null,
  };
}

export function reconcile(record, pidAlive) {
  if (!record || record.status !== 'running') return record || null;
  if (record.pid && pidAlive(record.pid)) return record;
  const switched = record.phase === 'switching' || record.phase === 'verifying' || record.switched === true;
  return {
    ...record,
    status: switched ? 'verification-failed' : 'interrupted',
    message: switched ? MESSAGES.switchIncomplete : MESSAGES.interrupted,
    finishedAt: new Date().toISOString(),
  };
}

export function tryLock(lockPath) {
  try {
    closeSync(openSync(lockPath, 'wx'));
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

export function unlock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

export function workspaceReady(workspace) {
  if (!workspace) return false;
  return existsSync(join(workspace, 'web', 'node_modules', 'astro', 'package.json'));
}

export function reuseDerivatives(workspace, cacheDir) {
  const dest = join(workspace, 'web', 'public', 'media');
  if (!cacheDir || !existsSync(cacheDir)) return 'missing-cache';
  if (existsSync(dest) && readdirSync(dest).some((name) => name !== '.gitkeep')) return 'kept';
  mkdirSync(dest, { recursive: true });
  cpSync(cacheDir, dest, { recursive: true });
  return 'copied';
}

export function containedCommand(nodePath, workerPath) {
  return {
    command: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '-p',
      'MemoryMax=550M',
      '-p',
      'MemorySwapMax=800M',
      '-p',
      'CPUWeight=20',
      '--',
      'nice',
      '-n',
      '15',
      nodePath,
      workerPath,
    ],
  };
}

export function plainCommand(nodePath, workerPath) {
  return { command: 'nice', args: ['-n', '15', nodePath, workerPath] };
}

export function commandFor(hasSystemd, nodePath, workerPath) {
  return hasSystemd ? containedCommand(nodePath, workerPath) : plainCommand(nodePath, workerPath);
}

const CHILD_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'CMS_URL',
  'CMS_TOKEN',
  'STRAPI_URL',
  'STRAPI_API_TOKEN',
  'IKPK_BUILD_WORKSPACE',
  'IKPK_WEB_ROOT',
  'IKPK_MEDIA_CACHE',
  'IKPK_VERIFY_URL',
  'IKPK_VERIFY_HOST',
  'IKPK_REFRESH_STATE',
  'PAYMENT_ROLE',
  'DEMO_FORMS',
  'CHAT_LOADER_SRC',
];

export function childEnvironment(source) {
  const env = { NODE_OPTIONS: '--max-old-space-size=480' };
  for (const key of CHILD_KEYS) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export function switchCurrent(webRoot, releaseId) {
  if (!releaseId || releaseId.includes('/') || releaseId.includes('..')) {
    throw new Error('release-id');
  }
  const target = join(webRoot, 'releases', releaseId);
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('release-not-directory');
  const link = join(webRoot, 'current');
  let previous = null;
  try {
    previous = readlinkSync(link);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const temp = join(webRoot, `.current-next-${releaseId}`);
  symlinkSync(join('releases', releaseId), temp);
  renameSync(temp, link);
  return { previous };
}

export function publishTree(distDir, webRoot, releaseId) {
  if (!releaseId || releaseId.includes('/') || releaseId.includes('..')) throw new Error('release-id');
  const releaseDir = join(webRoot, 'releases', releaseId);
  mkdirSync(join(webRoot, 'releases'), { recursive: true });
  cpSync(distDir, releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, 'release.json'), `${JSON.stringify({ releaseId })}\n`);
  return releaseDir;
}

export async function verifyRelease({ url, releaseId, fetchImpl, host }) {
  const headers = host ? { Host: host } : {};
  const response = await fetchImpl(url, { headers, redirect: 'manual' });
  if (response.status !== 200) return { ok: false, detail: `HTTP ${response.status}` };
  const body = await response.json();
  if (!body || body.releaseId !== releaseId) return { ok: false, detail: 'идентификатор релиза не совпал' };
  return { ok: true, siteUrl: url };
}

function finish(deps, record) {
  deps.write(record);
  return record;
}

export function beginRefresh({ record, pidAlive, lockAcquired, ready, spawn, now }) {
  const current = reconcile(record, pidAlive);
  if (current?.status === 'running') return { body: publicView(current), persist: current, releaseLock: false };
  if (!lockAcquired) return { body: { status: 'running', message: MESSAGES.busy }, releaseLock: false };
  if (!ready) {
    const failed = { status: 'failed', message: MESSAGES.notPrepared, switched: false };
    return { body: failed, persist: failed, releaseLock: true };
  }
  const child = spawn();
  const running = {
    status: 'running',
    phase: 'capture',
    pid: child.pid,
    message: 'Обновление запущено. Закрытие вкладки его не отменяет.',
    startedAt: now(),
    switched: false,
  };
  return { body: publicView(running), persist: running, releaseLock: false };
}

export async function runRefresh(deps) {
  const startedAt = deps.now();
  if (!deps.workspaceReady()) {
    return finish(deps, {
      status: 'failed',
      phase: 'prepare',
      message: MESSAGES.notPrepared,
      startedAt,
      finishedAt: deps.now(),
      switched: false,
    });
  }
  deps.write({
    status: 'running',
    phase: 'capture',
    message: 'Снимается опубликованный снимок. Черновики в него не входят.',
    startedAt,
    pid: deps.pid,
    switched: false,
  });
  const captured = await deps.capture();
  if (!captured.ok) {
    return finish(deps, {
      status: 'failed',
      phase: 'capture',
      message: MESSAGES.failed,
      detail: redact(captured.detail),
      startedAt,
      finishedAt: deps.now(),
      switched: false,
    });
  }
  const derivatives = deps.reuseDerivatives();
  deps.write({
    status: 'running',
    phase: 'build',
    message: 'Собирается сайт. Зависимости заново не ставятся.',
    startedAt,
    pid: deps.pid,
    derivatives,
    switched: false,
  });
  const built = await deps.build();
  if (!built.ok) {
    return finish(deps, {
      status: 'failed',
      phase: 'build',
      message: MESSAGES.failed,
      detail: redact(built.detail),
      startedAt,
      finishedAt: deps.now(),
      switched: false,
    });
  }
  if (!deps.canVerify()) {
    return finish(deps, {
      status: 'failed',
      phase: 'build',
      message: MESSAGES.failed,
      detail: 'проверка выложенного релиза не настроена',
      startedAt,
      finishedAt: deps.now(),
      switched: false,
    });
  }
  deps.write({
    status: 'running',
    phase: 'switching',
    message: 'Сайт переключается.',
    startedAt,
    pid: deps.pid,
    releaseId: built.releaseId,
    switched: false,
  });
  let previous = null;
  try {
    previous = deps.switchRelease(built.releaseId).previous;
  } catch (error) {
    return finish(deps, {
      status: 'failed',
      phase: 'switching',
      message: MESSAGES.failed,
      detail: redact(error.message),
      startedAt,
      finishedAt: deps.now(),
      switched: false,
    });
  }
  deps.write({
    status: 'running',
    phase: 'verifying',
    releaseId: built.releaseId,
    previousReleaseId: previous,
    startedAt,
    pid: deps.pid,
    switched: true,
    message: 'Проверяется выложенный релиз.',
  });
  const verified = await deps.verify(built.releaseId);
  if (!verified.ok) {
    return finish(deps, {
      status: 'verification-failed',
      phase: 'verifying',
      message: MESSAGES.verificationFailed,
      detail: redact(verified.detail),
      releaseId: built.releaseId,
      previousReleaseId: previous,
      startedAt,
      finishedAt: deps.now(),
      switched: true,
      siteUrl: verified.siteUrl || null,
    });
  }
  return finish(deps, {
    status: 'succeeded',
    phase: 'done',
    message: MESSAGES.succeeded,
    releaseId: built.releaseId,
    previousReleaseId: previous,
    siteUrl: verified.siteUrl || null,
    startedAt,
    finishedAt: deps.now(),
    switched: true,
  });
}

export async function runRestore(deps) {
  const current = deps.read();
  if (current?.status === 'running') {
    return { ...publicView(current), message: MESSAGES.busy };
  }
  const previous = current?.previousReleaseId;
  if (!previous || !previous.startsWith('releases/')) {
    return finish(deps, { status: 'failed', message: MESSAGES.restoreMissing, switched: false });
  }
  const releaseId = previous.slice('releases/'.length);
  deps.switchRelease(releaseId);
  const verified = await deps.verify(releaseId);
  if (!verified.ok) {
    return finish(deps, {
      status: 'verification-failed',
      message: MESSAGES.restoreVerifyFailed,
      detail: redact(verified.detail),
      releaseId,
      switched: true,
    });
  }
  return finish(deps, {
    status: 'succeeded',
    message: MESSAGES.restored,
    releaseId,
    siteUrl: verified.siteUrl || null,
    switched: true,
  });
}
