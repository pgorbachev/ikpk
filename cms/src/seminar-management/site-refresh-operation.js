import { cpSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readlinkSync, realpathSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

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
  publicationBusy: 'Публикация сайта на хосте ещё не завершена. Повторите после её завершения.',
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
    cleanupPending: record.cleanupPending === true ? true : null,
    buildArtifactsCleanupPending: record.buildArtifactsCleanupPending === true ? true : null,
  };
}

export function reconcile(record, pidAlive) {
  if (!record || record.status !== 'running') return record || null;
  if (!Number.isInteger(record.pid) || record.pid <= 0 || pidAlive(record.pid)) return record;
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

/** Host publications write a root-owned marker before staging and clear it only
 * after verification and release cleanup. Any unreadable or malformed marker
 * blocks CMS publication and Restore. */
export function hostPublicationStatus(marker = '/var/lib/ikpk-rehearsal/site-publication/host-publication.json') {
  try {
    const directory = lstatSync(dirname(marker));
    const mode = directory.mode & 0o777;
    const groups = new Set([process.getgid(), ...process.getgroups()]);
    if (!directory.isDirectory() || directory.uid !== 0 || mode !== 0o750 || !groups.has(directory.gid)) {
      return { status: 'unknown' };
    }
    const info = lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0
        || (info.mode & 0o777) !== 0o640 || !groups.has(info.gid)) return { status: 'unknown' };
    const value = JSON.parse(readFileSync(marker, 'utf8'));
    if (!value || value.version !== 1 || typeof value.operationId !== 'string'
        || typeof value.profile !== 'string' || !['active', 'cleanup-pending'].includes(value.phase)) {
      return { status: 'unknown' };
    }
    return value;
  } catch (error) {
    return error?.code === 'ENOENT' && error.path === marker ? null : { status: 'unknown' };
  }
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
  const dirFd = openSync(dir, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

// Resolve only a direct child of the configured releases directory. State may
// contain the absolute pointer written by the paired deploy or a relative one.
export function normalizeReleaseTarget(target, webRoot, requireDirectory = false) {
  if (typeof target !== 'string') throw new Error('release target is invalid');
  let id;
  if (target.startsWith('releases/')) {
    id = target.slice('releases/'.length);
  } else {
    if (!webRoot || !isAbsolute(webRoot) || normalize(webRoot) !== webRoot) throw new Error('release root is invalid');
    const prefix = `${join(webRoot, 'releases')}/`;
    if (!target.startsWith(prefix)) throw new Error('release target is invalid');
    id = target.slice(prefix.length);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) throw new Error('release target is invalid');
  if (requireDirectory) {
    if (!webRoot || !isAbsolute(webRoot) || normalize(webRoot) !== webRoot) throw new Error('release root is invalid');
    const releases = join(webRoot, 'releases');
    const release = join(releases, id);
    try {
      const baseInfo = lstatSync(releases);
      const info = lstatSync(release);
      if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink()
          || realpathSync(release) !== join(realpathSync(releases), id)) throw new Error('unsafe target');
    } catch { throw new Error('release target is invalid or unsafe'); }
  }
  return `releases/${id}`;
}

function validRefreshState(record, webRoot) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (['cleanupPending', 'buildArtifactsCleanupPending'].some(key =>
    record[key] !== undefined && typeof record[key] !== 'boolean')) return false;
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes('..');
  if (record.releaseId != null && !id(record.releaseId)) return false;
  if (record.previousReleaseId != null) {
    try { normalizeReleaseTarget(record.previousReleaseId, webRoot); } catch { return false; }
  }
  const phases = {
    running: ['starting', 'capture', 'build', 'switching', 'verifying'],
    failed: [undefined, 'prepare', 'capture', 'build', 'switching'],
    interrupted: [undefined, 'starting', 'prepare', 'capture', 'build'],
    succeeded: [undefined, 'done'],
    'verification-failed': [undefined, 'verifying'],
    idle: [undefined],
  };
  if (!Object.hasOwn(phases, record.status) || !phases[record.status].includes(record.phase)) return false;
  if (record.status === 'idle') return record.switched === undefined || record.switched === false;
  if (typeof record.switched !== 'boolean') return false;
  if (record.status === 'running') {
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
    if ((record.phase === 'verifying') !== record.switched) return false;
  }
  if (['failed', 'interrupted'].includes(record.status) && record.switched) return false;
  if (['succeeded', 'verification-failed'].includes(record.status) && (!record.switched || !id(record.releaseId))) return false;
  return true;
}

export function readStateFile(path, webRoot = process.env.IKPK_WEB_ROOT) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (!validRefreshState(record, webRoot)) throw new Error('invalid state');
    const normalized = record.previousReleaseId == null ? record : { ...record, previousReleaseId: normalizeReleaseTarget(record.previousReleaseId, webRoot) };
    return { readable: true, missing: false, record: normalized };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try { lstatSync(path); }
      catch (probe) { if (probe?.code === 'ENOENT') return { readable: true, missing: true, record: null }; }
    }
    return { readable: false, missing: false, record: null };
  }
}

export function tryLock(lockPath, pid, token = null) {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, token ? `${pid}\n${token}\n` : `${pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

function parseLock(value) {
  const match = /^(\d+)\n(?:([a-f0-9]{32})\n)?$/.exec(String(value));
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, token: match[2] || null } : null;
}

function parseLockPid(value) {
  return parseLock(value)?.pid ?? null;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

export function lockPid(lockPath) {
  try {
    return parseLockPid(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export function ownsLock(lockPath, pid, token) {
  try {
    const owner = parseLock(readFileSync(lockPath, 'utf8'));
    return owner?.pid === pid && owner.token === token;
  } catch { return false; }
}

/** Permission and probe errors other than ESRCH are ambiguous, so treat the PID as busy. */
export function isPidAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/** Rewrite only the lock inode and PID still owned by the controller. */
export function transferLock(lockPath, fromPid, toPid, token = null) {
  if (!Number.isInteger(fromPid) || fromPid <= 0 || !Number.isInteger(toPid) || toPid <= 0) return false;
  let fd;
  try {
    fd = openSync(lockPath, 'r+');
    const opened = fstatSync(fd);
    const owner = parseLock(readFileSync(fd, 'utf8'));
    if (!sameFile(opened, lstatSync(lockPath)) || owner?.pid !== fromPid || owner.token !== token) return false;
    ftruncateSync(fd, 0);
    const content = Buffer.from(token ? `${toPid}\n${token}\n` : `${toPid}\n`);
    writeSync(fd, content, 0, content.length, 0);
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Release only a lock whose PID still matches the caller's ownership. */
export function unlock(lockPath, expectedPid, token = null) {
  if (!Number.isInteger(expectedPid) || expectedPid <= 0) return false;
  let fd;
  try {
    fd = openSync(lockPath, 'r');
    const opened = fstatSync(fd);
    const owner = parseLock(readFileSync(fd, 'utf8'));
    if (!sameFile(opened, lstatSync(lockPath)) || owner?.pid !== expectedPid || owner.token !== token) return false;
    if (!sameFile(opened, lstatSync(lockPath))) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Unknown, empty, or foreign lock ownership is retained for operator diagnosis. */
export function decideLock({ readable, record, lockPath, pidAlive }) {
  let exists;
  try { lstatSync(lockPath); exists = true; }
  catch (error) { if (error?.code !== 'ENOENT') return { releaseLock: false, record: { status: 'running', message: MESSAGES.busy } }; exists = false; }
  // Observation never mutates state or removes a lock. A lock whose owner died
  // is resolved explicitly by an operator, not by an asynchronous GET.
  if (exists) {
    return { releaseLock: false, record: record?.status === 'running' ? record : { status: 'running', message: MESSAGES.busy } };
  }
  if (!readable) return { releaseLock: false, record: { status: 'failed', message: MESSAGES.corrupt, switched: false } };
  // Interrupted or lost workers require explicit recovery; do not turn a stale
  // observation into permission for a new publication.
  return { releaseLock: false, record: record?.status === 'running' ? record : reconcile(record, pidAlive) };
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
  if (!workspaceReady(env?.IKPK_BUILD_WORKSPACE) || !env?.IKPK_VERIFY_URL) return false;
  if (env.IKPK_CAPTURE_PROFILE !== 'staging194') return true;
  return [
    'cms/scripts/capture-staging194.py',
    'scripts/lib/seal-staging193-capture.mjs',
    'scripts/lib/staging193-capture-bundle.mjs',
    'scripts/lib/server-capture-sqlite.mjs',
  ].every((path) => existsSync(join(env.IKPK_BUILD_WORKSPACE, path)));

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
  'INITIAL_PROD_PROFILE',
  'DEPLOY_MODE',
  'IKPK_CAPTURE_PROFILE',
  'IKPK_CAPTURE_DATABASE',
  'IKPK_CAPTURE_MEDIA',
  'IKPK_CAPTURE_ROOT',
  'PAYMENT_ROLE',
  'PAYMENT_ENDPOINT_PROD',
  'DEMO_FORMS',
  'CHAT_LOADER_SRC',
  'CHAT_OFFLINE_MESSAGE',
];

export function childEnvironment(source, { includeCmsCredentials = true } = {}) {
  const env = { NODE_OPTIONS: '--max-old-space-size=480' };
  const profileBuild = source.IKPK_CAPTURE_PROFILE === 'staging194' || source.INITIAL_PROD_PROFILE === '1';
  const profileBuildKeys = new Set(['DEPLOY_MODE', 'CHAT_OFFLINE_MESSAGE']);
  for (const key of CHILD_KEYS) {
    if (!profileBuild && profileBuildKeys.has(key)) continue;
    if (source.IKPK_CAPTURE_PROFILE !== 'staging194' &&
        ['IKPK_CAPTURE_DATABASE', 'IKPK_CAPTURE_MEDIA', 'IKPK_CAPTURE_ROOT'].includes(key)) continue;
    if (!includeCmsCredentials && ['CMS_URL', 'CMS_TOKEN', 'STRAPI_URL', 'STRAPI_API_TOKEN'].includes(key)) continue;
    if (source[key]) env[key] = source[key];
  }
  return env;
}

/** Окружение `npm run build`. Телеметрия Astro пишет в домашний каталог до проверки отключения. */
export function siteBuildEnv(workspace, staging194 = false, production = false, source = process.env) {
  const env = {
    CONTENT_SNAPSHOT_DIR: join(workspace, 'web', '.snapshot'),
    NODE_OPTIONS: '--max-old-space-size=480',
    ASTRO_TELEMETRY_DISABLED: '1',
  };
  if (staging194) Object.assign(env, {
    DEMO_PROFILE: 'demo193',
    DEMO_SITE_URL: 'https://194.226.99.10',
    DEPLOY_MODE: 'stand',
    PAYMENT_ROLE: 'ci',
    DEMO_FORMS: 'stub',
    CHAT_LOADER_SRC: 'none',
    CHAT_OFFLINE_MESSAGE: 'absent',
  });
  if (production) {
    if (staging194 || source.INITIAL_PROD_PROFILE !== '1' || source.DEPLOY_MODE !== 'prod' ||
        source.PAYMENT_ROLE !== 'prod' || !source.PAYMENT_ENDPOINT_PROD ||
        (source.DEMO_FORMS && source.DEMO_FORMS !== 'stub') ||
        (source.CHAT_OFFLINE_MESSAGE && source.CHAT_OFFLINE_MESSAGE !== 'absent') || !source.CHAT_LOADER_SRC) {
      throw new Error('production site refresh requires the validated production build environment');
    }
    Object.assign(env, {
      INITIAL_PROD_PROFILE: '1',
      DEPLOY_MODE: source.DEPLOY_MODE,
      PAYMENT_ROLE: source.PAYMENT_ROLE,
      PAYMENT_ENDPOINT_PROD: source.PAYMENT_ENDPOINT_PROD,
      DEMO_FORMS: '',
      CHAT_LOADER_SRC: source.CHAT_LOADER_SRC,
      CHAT_OFFLINE_MESSAGE: '',
    });
  }
  return env;
}

export function switchCurrent(webRoot, releaseId, expectedPrevious = undefined) {
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
  if (expectedPrevious !== undefined && previous !== expectedPrevious) throw new Error('current release changed before switch');
  const temp = join(webRoot, `.current-next-${releaseId}`);
  symlinkSync(join('releases', releaseId), temp);
  if (expectedPrevious !== undefined && readlinkSync(link) !== expectedPrevious) {
    unlinkSync(temp);
    throw new Error('current release changed before switch');
  }
  // This check and rename are not an atomic CAS; other publisher paths do not
  // all share this lock, so an operator window is still required.
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

/**
 * Commit нового релиза — SHA доставленного дерева сборки.
 * Commit действующего сайта сюда не подставляется: дерево и раздача расходятся.
 */
export function installedCommit(_webRoot, envCommit) {
  if (typeof envCommit === 'string' && /^[0-9a-f]{40}$/.test(envCommit)) return envCommit;
  return null;
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
  let captured;
  try {
    captured = await deps.capture();
  } catch (error) {
    captured = { ok: false, detail: redact(error?.message || 'ошибка съёма') };
  }
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
  // Persist the exact old pointer before any switch so an interrupted worker
  // leaves an identifiable recovery target.
  const previousRaw = deps.readCurrent();
  const previous = normalizeReleaseTarget(previousRaw, deps.webRoot, Boolean(deps.webRoot));
  deps.write({
    status: 'running',
    phase: 'switching',
    previousReleaseId: previous,
    message: 'Сайт переключается.',
    startedAt,
    pid: deps.pid,
    releaseId: built.releaseId,
    switched: false,
  });
  try {
    deps.switchRelease(built.releaseId, previousRaw);
  } catch (error) {
    // The switch outcome can be ambiguous. Retain durable intent and the lock
    // for inspection instead of overwriting the recovery target with failure.
    return { status: 'failed', message: MESSAGES.switchIncomplete,
      detail: redact(error.message), recoveryRequired: true };
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
  if (deps.installedCommit !== undefined && expected.commit !== deps.installedCommit) {
    return finish(deps, { status: 'failed', message: MESSAGES.restoreUnreadable,
      detail: 'предыдущий релиз собран другим исходным кодом CMS', switched: false });
  }
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
export async function runLockedRestore({ lock, pid, current, readCurrent, readCurrentTarget, webRoot, write, switchRelease, identityOf, verify,
  installedCommit }) {
  if (!tryLock(lock, pid)) return { status: 'running', message: MESSAGES.busy };
  let switched = false;
  let switchedReleaseId = null;
  try {
    if (readCurrent) {
      try { current = readCurrent(); }
      catch { return { status: 'failed', message: MESSAGES.corrupt, switched: false }; }
    }
    if (current?.status === 'running') return publicView({ ...current, message: MESSAGES.busy });
    let expectedCurrent;
    if (readCurrentTarget) {
      try {
        expectedCurrent = readCurrentTarget();
        if (!current?.releaseId || normalizeReleaseTarget(expectedCurrent, webRoot, true) !== `releases/${current.releaseId}`)
          return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false };
      } catch { return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false }; }
    }
    if (current?.status === 'verification-failed') {
      const previous = current.previousReleaseId;
      if (!previous || !previous.startsWith('releases/')) return { status: 'failed', message: MESSAGES.restoreMissing, switched: false };
      const identity = identityOf(previous.slice('releases/'.length));
      if (!identity || (installedCommit !== undefined && identity.commit !== installedCommit))
        return { status: 'failed', message: MESSAGES.restoreUnreadable, switched: false };
    }
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
      write: record => write(!switched && current?.status === 'verification-failed' && record?.status === 'failed' ? current : record),
      switchRelease: (releaseId) => {
        const result = switchRelease(releaseId, expectedCurrent);
        switched = true;
        switchedReleaseId = releaseId;
        return result;
      },
      identityOf,
      installedCommit,
      verify,
    });
  } catch (error) {
    const failed = switched
      ? {
          status: 'verification-failed',
          phase: 'verifying',
          message: MESSAGES.restoreVerifyFailed,
          detail: redact(error && error.message),
          releaseId: switchedReleaseId,
          switched: true,
        }
      : {
          status: 'failed',
          message: MESSAGES.failed,
          detail: redact(error && error.message),
          switched: false,
        };
    try {
      write(!switched && current?.status === 'verification-failed' ? current : failed);
    } catch {
      // Запись недоступна. Lock снимается ниже, иначе живой pid службы останется навсегда.
    }
    return failed;
  } finally {
    unlock(lock, pid);
  }
}
