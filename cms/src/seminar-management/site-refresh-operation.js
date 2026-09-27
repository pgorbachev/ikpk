import { cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readlinkSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export const MESSAGES = {
  failed: 'Сборка не удалась. Действующий сайт не менялся.',
  interrupted: 'Сборка прервана. Действующий сайт не менялся.',
  notPrepared:
    'Обновление сайта на этом стенде ещё не подготовлено: нет постоянного дерева сборки или адреса проверки. Зависимости заново не ставятся.',
  verificationFailed:
    'Новый релиз не прошёл проверку после переключения. Это не успех и не автоматический откат.',
  switchIncomplete:
    'Переключение началось, проверка не завершилась. Это не успех и не автоматический откат.',
  succeeded: 'Сайт обновлён. Опубликован весь снимок CMS, не только открытый семинар.',
  restored: 'Возвращён предыдущий релиз. Автоматического отката при ошибке сборки нет: это отдельное действие.',
  restoreMissing: 'Предыдущий релиз не записан, возвращать нечего.',
  restoreUnreadable: 'У предыдущего релиза нет объявления commit и snapshotId, возвращать его нельзя.',
  corrupt:
    'Запись состояния повреждена и не считается успехом. Проверьте, какой релиз раздаётся, прежде чем запускать обновление снова.',
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

export function refreshStatePath(env = {}) {
  if (env.IKPK_REFRESH_STATE) return env.IKPK_REFRESH_STATE;
  const root = env.IKPK_WEB_ROOT || '/var/www/ikpk';
  return join(root, 'shared', 'site-refresh', 'state.json');
}

export function writeJsonAtomic(path, record) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, path);
}

export function readStateFile(path) {
  if (!existsSync(path)) return { readable: true, missing: true, record: null };
  try {
    return { readable: true, missing: false, record: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { readable: false, missing: false, record: null };
  }
}

export function tryLock(lockPath, pid) {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

export function lockPid(lockPath) {
  try {
    const pid = Number(String(readFileSync(lockPath, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Живой pid операции не снимается. Мёртвый pid в записи снимает lock, даже если в файле lock ещё pid службы. Битый файл тоже снимается. */
export function decideLock({ readable, record, lockPath, pidAlive }) {
  const holder = lockPid(lockPath);
  const holderAlive = holder != null && pidAlive(holder);
  if (record?.status === 'running' && record.pid && pidAlive(record.pid)) {
    return { releaseLock: false, record };
  }
  if (record?.status === 'running' && record.pid && !pidAlive(record.pid)) {
    const reconciled = reconcile(record, () => false);
    return { releaseLock: existsSync(lockPath), record: reconciled, persist: reconciled };
  }
  if (holderAlive) return { releaseLock: false, record: record || { status: 'running', message: MESSAGES.busy } };
  if (!readable) {
    const persist = { status: 'failed', message: MESSAGES.corrupt, switched: false };
    return { releaseLock: true, record: persist, persist };
  }
  const reconciled = record?.status === 'running' ? reconcile(record, () => false) : record;
  return { releaseLock: existsSync(lockPath), record: reconciled, persist: reconciled !== record ? reconciled : null };
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
  const web = join(workspace, 'web');
  return (
    existsSync(join(web, 'node_modules', 'astro', 'package.json')) &&
    existsSync(join(web, 'node_modules', 'tsx', 'package.json'))
  );
}

/** Путь system unit: и дерево, и адрес проверки. Иначе сборка не стартует. */
export function refreshReady(env) {
  return workspaceReady(env && env.IKPK_BUILD_WORKSPACE) && Boolean(env && env.IKPK_VERIFY_URL);
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

export function userSessionAvailable(env) {
  return Boolean(env && env.XDG_RUNTIME_DIR && env.DBUS_SESSION_BUS_ADDRESS);
}

/**
 * systemd-run --user живёт только в пользовательской сессии. Служба CMS — system unit
 * и этих переменных не имеет: выбор по одному наличию бинарника такой worker не запускает.
 */
export function launchPlan({ env, systemdRun, nodePath, script }) {
  const session = Boolean(systemdRun) && userSessionAvailable(env);
  const base = session ? containedCommand(nodePath, '-e') : plainCommand(nodePath, '-e');
  return { command: base.command, args: [...base.args, script], session };
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
  'IKPK_INSTALLED_COMMIT',
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

export function releaseIdentity(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.commit !== 'string' || body.commit.length === 0) return null;
  if (typeof body.snapshotId !== 'string' || body.snapshotId.length === 0) return null;
  return { commit: body.commit, snapshotId: body.snapshotId };
}

export function identityFromReleaseDir(dir) {
  try {
    return releaseIdentity(JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')));
  } catch {
    return null;
  }
}

export function installedCommit(webRoot, envCommit) {
  if (typeof envCommit === 'string' && envCommit.length > 0) return envCommit;
  try {
    const link = readlinkSync(join(webRoot, 'current'));
    const dir = isAbsolute(link) ? link : join(webRoot, link);
    return identityFromReleaseDir(dir)?.commit || null;
  } catch {
    return null;
  }
}

export function publishTree(distDir, webRoot, releaseId, identity) {
  if (!releaseId || releaseId.includes('/') || releaseId.includes('..')) throw new Error('release-id');
  const declared = releaseIdentity(identity);
  if (!declared) throw new Error('release-identity');
  const releaseDir = join(webRoot, 'releases', releaseId);
  mkdirSync(join(webRoot, 'releases'), { recursive: true });
  cpSync(distDir, releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, 'release.json'), `${JSON.stringify(declared, null, 2)}\n`);
  return releaseDir;
}

export async function verifyRelease({ url, expected, fetchImpl, host }) {
  const headers = host ? { Host: host } : {};
  const response = await fetchImpl(url, { headers, redirect: 'manual' });
  if (response.status !== 200) return { ok: false, detail: `HTTP ${response.status}` };
  const body = await response.json();
  const observed = releaseIdentity(body);
  if (!observed) return { ok: false, detail: 'объявление релиза не читается' };
  if (observed.commit !== expected?.commit || observed.snapshotId !== expected?.snapshotId) {
    return { ok: false, detail: 'идентичность релиза не совпала' };
  }
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
  if (!releaseIdentity(built.identity)) {
    return finish(deps, {
      status: 'failed',
      phase: 'build',
      message: MESSAGES.failed,
      detail: 'нет commit и snapshotId',
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
  const verified = await deps.verify(built.identity);
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
  const expected = deps.identityOf(releaseId);
  if (!expected) return finish(deps, { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false });
  let switched = false;
  try {
    deps.switchRelease(releaseId);
    switched = true;
    const verified = await deps.verify(expected);
    if (!verified.ok) {
      return finish(deps, {
        status: 'verification-failed',
        phase: 'verifying',
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
  } catch (error) {
    if (!switched) throw error;
    return finish(deps, {
      status: 'verification-failed',
      phase: 'verifying',
      message: MESSAGES.restoreVerifyFailed,
      detail: redact(error && error.message),
      releaseId,
      switched: true,
    });
  }
}

/**
 * Lock и запись running живут в одном try/finally. Отказ записи снимает lock.
 * Исключение проверки после смены ссылки — ошибка проверки, не «сайт не менялся».
 */
export async function runLockedRestore({ lock, pid, current, write, switchRelease, identityOf, verify }) {
  if (!tryLock(lock, pid)) return { status: 'running', message: MESSAGES.busy };
  let switched = false;
  try {
    write({
      status: 'running',
      phase: 'switching',
      pid,
      message: 'Возвращается предыдущий релиз.',
      startedAt: new Date().toISOString(),
      switched: false,
      previousReleaseId: current?.previousReleaseId || null,
    });
    return await runRestore({
      read: () => current,
      write,
      switchRelease: (releaseId) => {
        const result = switchRelease(releaseId);
        switched = true;
        return result;
      },
      identityOf,
      verify,
    });
  } catch (error) {
    const failed = switched
      ? {
          status: 'verification-failed',
          phase: 'verifying',
          message: MESSAGES.restoreVerifyFailed,
          detail: redact(error && error.message),
          switched: true,
        }
      : {
          status: 'failed',
          message: MESSAGES.failed,
          detail: redact(error && error.message),
          switched: false,
        };
    try {
      write(failed);
    } catch {
      // Запись недоступна. Lock снимается ниже, иначе живой pid службы останется навсегда.
    }
    return failed;
  } finally {
    unlock(lock);
  }
}
