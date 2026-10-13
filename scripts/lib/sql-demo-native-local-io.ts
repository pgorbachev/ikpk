import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, rm, symlink, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { allowedSourceIdentity, buildStrapiMediaInventory, type StrapiMediaInventory } from './strapi-media-inventory.js';
import { buildUploadBody } from './upload-body.js';
import type { SqlDemoNativeRehearsalIo, SqlDemoNativeOwnedTarget, SqlDemoNativeSqlSourceLease, SqlDemoNativeTargetConfig, SqlDemoNativeUpload } from './sql-demo-native-rehearsal.js';
import type { SqlDemoOfflineAssetProof } from './sql-demo-assets.js';
import type { SqlDemoStrapi5MediaReadback, SqlDemoStrapi5PublishedRecord, SqlDemoNativeCollection } from './sql-demo-native-conservation.js';
import type { SqlPublicReaderOptions, SqlPublicPsqlInvocation } from './sql-public-reader.js';

const HASH = /^[a-f0-9]{64}$/;
const COLLECTIONS: readonly SqlDemoNativeCollection[] = [
  'institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries', 'articles',
  'news-items', 'promotions', 'video-playlists', 'pages',
];

export interface SqlDemoNativeLocalIoOptions {
  source: {
    reader: SqlPublicReaderOptions;
    clusterDataDirectory: string;
    postgresBinDirectory: string;
    socketDirectory: string;
    port: number;
    database: string;
    user: string;
  };
  cms: {
    sourceDirectory: string;
    expectedCommit: string;
    candidateRoot: string;
    nodeExecutable: string;
    cmsStartScript: string;
  };
  targets: { A: SqlDemoNativeTargetConfig & { staticFilesDirectory: string }; B?: SqlDemoNativeTargetConfig & { staticFilesDirectory: string } };
  privateArtifactsRoot: string;
  privateInputsRoot: string;
  resolveToken: () => Promise<string>;
  /** Process and fetch overrides are intended for isolated adapter tests. */
  runtime?: {
    spawn?: typeof nodeSpawn;
    fetch?: typeof globalThis.fetch;
    execFile?: (command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }) => Promise<{ stdout: string }>;
    processInspector?: { isAlive(pid: number): boolean; startTime(pid: number): Promise<string>; listenerPid(port: number): Promise<number | undefined> };
  };
}

type Child = ChildProcess & { pid: number };
type SourceLease = SqlDemoNativeSqlSourceLease & { readonly id: string; readonly pid: number };
type TargetState = {
  child: Child;
  candidateDirectory: string;
  stdoutLog: FileHandle;
  stderrLog: FileHandle;
  startTime: string;
  token: string;
  documents: Map<string, { sha256: string; bytes: number }>;
  lastSummary?: Record<string, unknown>;
};
type SourceTableWitness = { scope: 'reviewed-read-only-projection'; hash: string; tables: readonly { table: string; count: number; sha256: string }[] };
type LeaseState = { child: Child; pid: number; startTime: string; cluster: string; pgCtl: string; psql: string; invocation?: SqlPublicPsqlInvocation; sourceWitness?: SourceTableWitness };

const targetOwners = new WeakMap<object, TargetState>();
const sourceOwners = new WeakMap<object, LeaseState>();
type ExecOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number };

function fail(message: string): Error { return new Error(message); }
function failStage(stage: 'SourceUrlIdentity' | 'UploadHttpStatus' | 'UploadIdentityHttpStatus' | 'StoredMediaBytes' | 'PersistentMediaIdentity', status?: number): Error {
  const error = new Error(`Native CMS ${stage} validation failed`);
  error.name = `NativeCms${stage}Error`;
  if (status !== undefined) Object.assign(error, { safeHttpStatus: status });
  return error;
}
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function sourceWitness(stdout: string): SourceTableWitness {
  const parsed: unknown = JSON.parse(stdout.trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('Source witness response is malformed');
  const tables = Object.entries(parsed as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([table, rows]) => {
    if (!Array.isArray(rows)) throw fail('Source witness omitted a projected table');
    return { table, count: rows.length, sha256: sha256(Buffer.from(JSON.stringify(rows))) };
  });
  return { scope: 'reviewed-read-only-projection', hash: sha256(Buffer.from(JSON.stringify(tables))), tables };
}
function sourceClaims(file: { provider_metadata?: unknown } | undefined): Record<string, unknown> {
  const metadata = file?.provider_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const imported = (metadata as Record<string, unknown>).ikpk_media_import;
  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) return {};
  const sources = (imported as Record<string, unknown>).sources;
  return sources && typeof sources === 'object' && !Array.isArray(sources) ? sources as Record<string, unknown> : {};
}
function secret(): string { return randomBytes(32).toString('base64url'); }
function isReviewedReadOnlyProjection(sql: string): boolean {
  const statements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
  return statements.length === 4 && statements[0] === 'BEGIN READ ONLY'
    && statements[1] === 'SET LOCAL default_transaction_read_only = on'
    && statements[2]?.startsWith('SELECT json_build_object(') === true
    && statements[3] === 'ROLLBACK';
}
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function requireAbs(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw fail(`${label} must be an absolute path`);
}
function loopback(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw fail('Native CMS endpoint must be a loopback URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw fail('Native CMS endpoint must be a plain HTTP loopback URL');
  }
  return url;
}
function validateOptions(options: SqlDemoNativeLocalIoOptions): void {
  if (!options || typeof options.resolveToken !== 'function') throw fail('Native rehearsal configuration is incomplete');
  requireAbs('SQL dump', options.source?.reader?.dumpPath);
  requireAbs('PostgreSQL cluster', options.source?.clusterDataDirectory);
  requireAbs('PostgreSQL binaries', options.source?.postgresBinDirectory);
  requireAbs('PostgreSQL socket directory', options.source?.socketDirectory);
  requireAbs('Pinned CMS source', options.cms?.sourceDirectory);
  requireAbs('CMS candidate root', options.cms?.candidateRoot);
  requireAbs('Node executable', options.cms?.nodeExecutable);
  requireAbs('Private artifacts root', options.privateArtifactsRoot);
  requireAbs('Private inputs root', options.privateInputsRoot);
  if (!HASH.test(options.source.reader.expectedDumpHash) || !/^[a-f0-9]{40}$/.test(options.cms.expectedCommit)) throw fail('Pinned source hashes are invalid');
  if (!Number.isSafeInteger(options.source.port) || options.source.port < 1024 || options.source.port > 65535
    || options.source.reader.connection.port !== options.source.port
    || options.source.reader.connection.database !== options.source.database
    || options.source.reader.connection.user !== options.source.user
    || options.source.reader.connection.unixSocketPath !== options.source.socketDirectory) throw fail('SQL source configuration does not match the pinned reader');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.source.database) || !/^[a-z_][a-z0-9_]{0,62}$/.test(options.source.user)) throw fail('SQL role and database names are invalid');
  const targets = Object.values(options.targets ?? {});
  if (!options.targets?.A) throw fail('Native CMS target A is required');
  const urls = targets.map((target) => loopback(target.baseUrl));
  const paths = targets.flatMap((target) => [target.dataDirectory, target.uploadDirectory, target.staticFilesDirectory]);
  for (const [index, path] of paths.entries()) requireAbs(`Target storage ${index + 1}`, path);
  if (targets.some((target) => !/^ikpk_sql_demo_native_[a-z0-9]+$/.test(target.namespace))
    || urls.some((url, index) => urls.slice(index + 1).some((other) => url.origin === other.origin))
    || targets.some((target, index) => targets.slice(index + 1).some((other) => target.namespace === other.namespace))
    || paths.some((path, index) => paths.slice(index + 1).some((other) => inside(path, other) || inside(other, path)))) throw fail('Native CMS targets must have distinct loopback endpoints and isolated storage');
  if (!['develop', 'start'].includes(options.cms.cmsStartScript)) throw fail('CMS start command must be develop or start');
  const protectedPaths = [options.cms.sourceDirectory, options.cms.candidateRoot, options.privateArtifactsRoot, options.privateInputsRoot, options.source.clusterDataDirectory];
  const allPaths = [...protectedPaths, ...paths];
  if (allPaths.some((path, index) => allPaths.slice(index + 1).some((other) => inside(path, other) || inside(other, path)))) throw fail('Private roots and target storage must not overlap');
}

async function checkPrivateDirectory(path: string, create = false, secure = true): Promise<string> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('Private rehearsal directory is not a real directory');
  const canonical = await realpath(path);
  if (secure) await chmod(path, 0o700);
  else if ((stat.mode & 0o077) !== 0) throw fail('Pinned source cluster permissions are broader than owner-only');
  return canonical;
}

async function pinnedCode(options: SqlDemoNativeLocalIoOptions, exec: (command: string, args: readonly string[], options?: ExecOptions) => Promise<{ stdout: string }>): Promise<void> {
  const source = options.cms.sourceDirectory;
  const { stdout: head } = await exec('git', ['-C', source, 'rev-parse', '--verify', 'HEAD^{commit}']);
  const { stdout: expected } = await exec('git', ['-C', source, 'rev-parse', '--verify', `${options.cms.expectedCommit}^{commit}`]);
  const { stdout: status } = await exec('git', ['-C', source, 'status', '--porcelain', '--untracked-files=all']);
  if (head.trim() !== options.cms.expectedCommit || expected.trim() !== options.cms.expectedCommit || status.trim()) throw fail('Pinned CMS source does not match the clean expected commit');
  const pkg = await readFile(join(source, 'package.json'));
  if (!pkg.length) throw fail('Pinned CMS package manifest is empty');
  const dump = await readFile(options.source.reader.dumpPath);
  if (sha256(dump) !== options.source.reader.expectedDumpHash) throw fail('Pinned SQL dump does not match its SHA-256');
  await checkPrivateDirectory(options.source.clusterDataDirectory, false, false);
}

async function assertEmptyTargetDirectories(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (await readdir(path)).length !== 0) throw fail('Native target storage already exists and is not an empty private directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
async function assertFreshTargetDirectories(options: SqlDemoNativeLocalIoOptions): Promise<void> {
  await assertEmptyTargetDirectories(Object.values(options.targets).flatMap((target) =>
    [target.dataDirectory, target.uploadDirectory, target.staticFilesDirectory]));
}

async function assertResumableMediaTarget(target: SqlDemoNativeLocalIoOptions['targets']['A']): Promise<void> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const path of [target.dataDirectory, target.uploadDirectory, target.staticFilesDirectory]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
      throw fail('Existing prototype target storage is not a private owner-owned directory');
    }
  }
  const databasePath = join(target.dataDirectory, 'data.db');
  const database = await lstat(databasePath);
  if (!database.isFile() || database.isSymbolicLink() || (uid !== undefined && database.uid !== uid)) {
    throw fail('Existing prototype target database is not an owner-owned regular file');
  }
  const checkTree = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) throw fail('Existing prototype upload tree contains an unsafe entry');
      if (stat.isDirectory()) await checkTree(path);
      else if (!stat.isFile()) throw fail('Existing prototype upload tree contains an unsupported entry');
    }
  };
  await checkTree(target.uploadDirectory);
  await checkTree(target.staticFilesDirectory);
}

async function assertPortFree(endpoint: string): Promise<void> {
  const url = loopback(endpoint);
  await new Promise<void>((resolveFree, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) });
    const timer = setTimeout(() => { socket.destroy(); reject(fail('Native target port availability could not be verified')); }, 500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(fail('Native target port is already owned by another process')); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') resolveFree();
      else reject(fail('Native target port availability could not be verified'));
    });
  });
}

async function nativeProcessStartTime(pid: number, exec: (command: string, args: readonly string[], options?: ExecOptions) => Promise<{ stdout: string }>): Promise<string> {
  const { stdout } = await exec('ps', ['-o', 'lstart=', '-p', String(pid)]);
  const value = stdout.trim();
  if (!value) throw fail('Owned process is no longer running');
  return value;
}
async function pidFromCluster(cluster: string): Promise<number | undefined> {
  try {
    const raw = await readFile(join(cluster, 'postmaster.pid'), 'utf8');
    const first = raw.split(/\r?\n/, 1)[0] ?? '';
    if (!/^\d+$/.test(first)) throw fail('PostgreSQL PID file is malformed');
    return Number(first);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
async function assertStoppedCluster(cluster: string, isAlive: (pid: number) => boolean): Promise<void> {
  const pid = await pidFromCluster(cluster);
  if (pid !== undefined) {
    if (isAlive(pid)) throw fail('PostgreSQL cluster already has a live postmaster');
    throw fail('PostgreSQL cluster has an unowned stale PID file');
  }
  try { await readFile(join(cluster, 'PG_VERSION'), 'utf8'); }
  catch { throw fail('PostgreSQL source cluster is not initialized; refusing initdb or restore'); }
}

function childProcess(spawn: typeof nodeSpawn, command: string, args: string[], options: SpawnOptions): Child {
  const child = spawn(command, args, options) as Child;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw fail('Could not acquire an owned local process');
  return child;
}
async function waitForExit(child: Child, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => reject(fail('Owned local process did not stop')), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    child.once('error', () => { clearTimeout(timer); reject(fail('Owned local process failed')); });
  });
}
function safeUrlPath(value: string, baseUrl: string, prefix: string): URL {
  let url: URL;
  try { url = new URL(value, baseUrl); } catch { throw fail('CMS returned an invalid local path'); }
  const base = new URL(baseUrl);
  const segments = url.pathname.split('/').map((segment) => { try { return decodeURIComponent(segment); } catch { return '\0'; } });
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)
    || segments.some((part) => part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0'))) throw fail('CMS returned a path outside the owned local endpoint');
  return url;
}

function bearer(token: string): Record<string, string> { return { authorization: `Bearer ${token}` }; }
function clientFor(target: SqlDemoNativeOwnedTarget, state: TargetState, fetcher: typeof globalThis.fetch, verify: () => Promise<void>) {
  return {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      const url = new URL(path, target.baseUrl);
      if (url.origin !== new URL(target.baseUrl).origin || !path.startsWith('/api/')) throw fail('CMS client rejected an untrusted API path');
      await verify();
      const response = await fetcher(url, { method, redirect: 'manual', headers: { ...bearer(state.token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      await verify();
      if (response.status < 200 || response.status >= 300) throw fail('Owned CMS API request failed');
      return response.json();
    },
  };
}

function pngMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(b.toString('ascii', 12, 16))) return 'image/webp';
  return undefined;
}

async function safePrivateRead(root: string, path: string): Promise<Buffer> {
  const realRoot = await realpath(root);
  const lexicalRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (!inside(lexicalRoot, resolvedPath) || resolvedPath === lexicalRoot) throw fail('Private input path escapes its configured root');
  const expectedPath = resolve(realRoot, relative(lexicalRoot, resolvedPath));
  const realPath = await realpath(resolvedPath);
  if (realPath !== expectedPath || !inside(realRoot, realPath)) throw fail('Private input path contains a symbolic link');
  const handle = await open(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw fail('Private input is not a regular file');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function copyTrackedCmsSource(
  source: string,
  destination: string,
  exec: (command: string, args: readonly string[], options?: ExecOptions) => Promise<{ stdout: string }>,
): Promise<void> {
  const { stdout } = await exec('git', ['-C', source, 'ls-files', '-z']);
  const paths = stdout.split('\0').filter(Boolean);
  if (!paths.length) throw fail('Pinned CMS source has no tracked files');
  for (const path of paths) {
    const parts = path.split('/');
    const top = parts[0] ?? '';
    if (['.git', '.tmp', '.cache', '.strapi', 'dist', 'build', 'public'].includes(top)
      || parts.some((part) => part === '.env' || part.startsWith('.env.'))) continue;
    const sourcePath = resolve(source, ...parts);
    const destinationPath = resolve(destination, ...parts);
    if (!inside(source, sourcePath) || !inside(destination, destinationPath)) throw fail('Pinned CMS source contains an unsafe tracked path');
    const stat = await lstat(sourcePath);
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    if (stat.isSymbolicLink()) {
      const link = await readlink(sourcePath);
      const linkedPath = resolve(dirname(sourcePath), link);
      const linkedRelative = relative(source, linkedPath).split(sep).join('/');
      if (isAbsolute(link) || !inside(source, linkedPath)
        || !paths.some((candidate) => candidate === linkedRelative || candidate.startsWith(`${linkedRelative}/`))) {
        throw fail('Pinned CMS source contains an untracked or escaping symbolic link');
      }
      await symlink(link, destinationPath);
      continue;
    }
    if (!stat.isFile()) throw fail('Pinned CMS source contains a non-file tracked entry');
    const mode = (stat.mode & 0o111) === 0 ? 0o600 : 0o700;
    await writeFile(destinationPath, await readFile(sourcePath), { mode, flag: 'wx' });
  }
}

async function installPinnedCmsDependencies(
  candidateDirectory: string,
  exec: (command: string, args: readonly string[], options?: ExecOptions) => Promise<{ stdout: string }>,
  pathValue: string,
): Promise<void> {
  const packageLock = join(candidateDirectory, 'package-lock.json');
  const lockHash = sha256(await readFile(packageLock));
  try {
    const npmrc = await readFile(join(candidateDirectory, '.npmrc'), 'utf8');
    if (/(?:_auth|password|token)\s*=/i.test(npmrc)) throw fail('Pinned CMS npm configuration contains credentials');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const home = join(candidateDirectory, '.home');
  const temp = join(candidateDirectory, '.tmp');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const userConfig = join(home, '.npmrc');
  await writeFile(userConfig, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await exec('npm', ['ci', '--no-audit', '--no-fund'], {
    cwd: candidateDirectory,
    env: privateCmsNpmEnvironment(candidateDirectory, pathValue),
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (sha256(await readFile(packageLock)) !== lockHash) throw fail('Pinned CMS lockfile changed during the isolated install');
}

export function privateCmsNpmEnvironment(candidateDirectory: string, pathValue: string): NodeJS.ProcessEnv {
  const home = join(candidateDirectory, '.home');
  return {
    PATH: pathValue,
    HOME: home,
    TMPDIR: join(candidateDirectory, '.tmp'),
    CI: 'true',
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_globalconfig: '/dev/null',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

async function installNativeTokenBootstrap(candidateDirectory: string, tokenPath: string): Promise<void> {
  if (!inside(candidateDirectory, tokenPath)) throw fail('Native API token handoff path is unsafe');
  const typescriptEntry = join(candidateDirectory, 'src', 'index.ts');
  const javascriptEntry = join(candidateDirectory, 'src', 'index.js');
  let entry: string;
  let importPath: string;
  try {
    await lstat(typescriptEntry);
    entry = typescriptEntry;
    const originalEntry = join(candidateDirectory, 'src', 'index.native-adapter-original.ts');
    await rename(entry, originalEntry);
    importPath = './index.native-adapter-original';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await lstat(javascriptEntry); }
    catch (javascriptError) {
      if ((javascriptError as NodeJS.ErrnoException).code !== 'ENOENT') throw javascriptError;
      throw fail('Pinned CMS has no application bootstrap entrypoint');
    }
    entry = typescriptEntry;
    importPath = './index.js';
  }
  const typeImport = "import type { Core } from '@strapi/strapi';\n";
  const contextType = ': { strapi: Core.Strapi }';
  const serviceType = " as { create(input: Record<string, unknown>): Promise<{ accessKey?: unknown }> }";
  const wrapper = `${typeImport}import { writeFile } from 'node:fs/promises';\nimport nativeOriginal from '${importPath}';\n\nexport default {\n  ...nativeOriginal,\n  async bootstrap({ strapi }${contextType}) {\n    if (nativeOriginal.bootstrap) await nativeOriginal.bootstrap({ strapi });\n    const tokenFile = process.env.IKPK_NATIVE_API_TOKEN_FILE;\n    const tokenName = process.env.IKPK_NATIVE_API_TOKEN_NAME;\n    if (!tokenFile || !tokenName) throw new Error('Native API token handoff configuration is missing');\n    const tokenService = strapi.service('admin::api-token')${serviceType};\n    const created = await tokenService.create({ name: tokenName, description: 'Private ephemeral native rehearsal target', type: 'full-access', kind: 'content-api', lifespan: null });\n    if (typeof created.accessKey !== 'string' || !created.accessKey) throw new Error('Native API token creation failed');\n    await writeFile(tokenFile, created.accessKey, { encoding: 'utf8', flag: 'wx', mode: 0o600 });\n  },\n};\n`;
  await writeFile(entry, wrapper, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function takeNativeApiToken(path: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw fail('Native API token handoff is not owner-only');
    const token = (await handle.readFile('utf8')).trim();
    if (!token || token.length > 4096 || /\s/.test(token)) throw fail('Native API token handoff is malformed');
    await unlink(path);
    return token;
  } finally { await handle.close(); }
}

export function createSqlDemoNativeLocalIo(options: SqlDemoNativeLocalIoOptions | Record<string, unknown>): SqlDemoNativeRehearsalIo {
  const config = options as SqlDemoNativeLocalIoOptions;
  validateOptions(config);
  const spawn = config.runtime?.spawn ?? nodeSpawn;
  const fetcher = config.runtime?.fetch ?? globalThis.fetch;
  const safeEnvironment = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: config.privateArtifactsRoot };
  const runFile = config.runtime?.execFile ?? (async (command, args, execOptions = {}) => ({
    stdout: execFileSync(command, [...args], { encoding: 'utf8', maxBuffer: execOptions.maxBuffer ?? 8 * 1024 * 1024, ...execOptions, env: { ...safeEnvironment, ...execOptions.env } }),
  }));
  const processInspector = config.runtime?.processInspector ?? {
    isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } },
    startTime(pid: number): Promise<string> { return nativeProcessStartTime(pid, runFile); },
    async listenerPid(port: number): Promise<number | undefined> {
      const { stdout } = await runFile('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN']);
      const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
      if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0) || pids.length > 1) throw fail('Native target listener ownership is ambiguous');
      return pids[0];
    },
  };
  async function preflightBeforeToken(): Promise<void> {
    await pinnedCode(config, runFile);
    await assertStoppedCluster(config.source.clusterDataDirectory, processInspector.isAlive);
    if (config.targets.A.resumeExistingMediaOnly) {
      if (config.targets.B) throw fail('Media-only resume is limited to the single A target');
      await assertResumableMediaTarget(config.targets.A);
    } else {
      await assertFreshTargetDirectories(config);
    }
    for (const target of Object.values(config.targets)) await assertPortFree(target.baseUrl);
    await checkPrivateDirectory(config.cms.candidateRoot, true);
    await checkPrivateDirectory(config.privateArtifactsRoot, true);
    await checkPrivateDirectory(config.privateInputsRoot, true);
    await checkPrivateDirectory(join(config.privateArtifactsRoot, '.psql-home'), true);
  }
  const sourceEnvironment = {
    PATH: safeEnvironment.PATH,
    HOME: join(config.privateArtifactsRoot, '.psql-home'),
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'C',
  };
  let verifiedSourceWitness: SourceTableWitness | undefined;
  let sourceWitnessVerified = false;

  function owned(target: SqlDemoNativeOwnedTarget): TargetState {
    const state = targetOwners.get(target as object);
    if (!state) throw fail('Target handle was not acquired by this adapter');
    return state;
  }

  async function verifyTargetProcess(target: SqlDemoNativeOwnedTarget, state: TargetState): Promise<void> {
    const port = Number(new URL(target.baseUrl).port);
    if (target.process.pid !== state.child.pid || !processInspector.isAlive(state.child.pid)
      || await processInspector.startTime(state.child.pid) !== state.startTime
      || await processInspector.listenerPid(port) !== state.child.pid) throw fail('Owned CMS process identity changed');
  }

  async function fetchTargetBytes(target: SqlDemoNativeOwnedTarget, value: string): Promise<Buffer> {
    const state = owned(target);
    await verifyTargetProcess(target, state);
    const url = safeUrlPath(value, target.baseUrl, '/uploads/');
    const response = await fetcher(url, { redirect: 'manual', headers: bearer(state.token) });
    await verifyTargetProcess(target, state);
    if (response.status !== 200 || response.redirected) throw fail('CMS media readback failed without following redirects');
    return Buffer.from(await response.arrayBuffer());
  }

  async function readPage(target: SqlDemoNativeOwnedTarget, path: string): Promise<{ data: unknown[]; meta: { pagination: { page: number; pageCount: number; total: number } } }> {
    const value = await (target.client as { request: (method: string, path: string) => Promise<unknown> }).request('GET', path);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('CMS pagination response is malformed');
    const response = value as { data?: unknown; meta?: { pagination?: { page?: number; pageCount?: number; total?: number } } };
    const p = response.meta?.pagination;
    if (!Array.isArray(response.data) || !p || !Number.isSafeInteger(p.page) || !Number.isSafeInteger(p.pageCount) || !Number.isSafeInteger(p.total)) throw fail('CMS pagination response is incomplete');
    return value as { data: unknown[]; meta: { pagination: { page: number; pageCount: number; total: number } } };
  }

  async function inventory(target: SqlDemoNativeOwnedTarget): Promise<StrapiMediaInventory> {
    const base = new URL(target.baseUrl);
    return buildStrapiMediaInventory({
      baseUrl: target.baseUrl,
      getPage: async (page, pageSize) => (target.client as { request: (method: string, path: string) => Promise<unknown> }).request('GET', `/api/upload/files/page?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate=*`),
      getBytes: async (url) => {
        const state = owned(target);
        await verifyTargetProcess(target, state);
        const parsed = safeUrlPath(url, target.baseUrl, '/uploads/');
        if (parsed.origin !== base.origin) throw fail('Media inventory attempted a cross-origin read');
        const response = await fetcher(parsed, { redirect: 'manual', headers: bearer(state.token) });
        await verifyTargetProcess(target, state);
        if (response.status !== 200 || response.redirected) throw fail('Stored media read failed');
        return new Uint8Array(await response.arrayBuffer());
      },
    });
  }

  async function openTarget(input: SqlDemoNativeTargetConfig & { name: 'A' | 'B'; token: string }): Promise<SqlDemoNativeOwnedTarget> {
    await pinnedCode(config, runFile);
    const targetConfig = config.targets[input.name];
    if (!targetConfig) throw fail(`CMS target ${input.name} is not configured`);
    await assertPortFree(targetConfig.baseUrl);
    if (input.baseUrl !== targetConfig.baseUrl || input.namespace !== targetConfig.namespace
      || input.dataDirectory !== targetConfig.dataDirectory || input.uploadDirectory !== targetConfig.uploadDirectory) throw fail('CMS target differs from the validated local target configuration');
    if (targetConfig.resumeExistingMediaOnly) {
      if (input.name !== 'A' || config.targets.B) throw fail('Media-only resume is limited to the single A target');
      await assertResumableMediaTarget(targetConfig);
    } else {
      await assertEmptyTargetDirectories([targetConfig.dataDirectory, targetConfig.uploadDirectory, targetConfig.staticFilesDirectory]);
    }
    const base = await checkPrivateDirectory(config.cms.candidateRoot, true);
    const candidateDirectory = join(base, `target-${input.name.toLowerCase()}-${process.pid}-${Date.now()}`);
    await mkdir(candidateDirectory, { recursive: false, mode: 0o700 });
    const cmsRoot = config.cms.sourceDirectory;
    const [dataDirectory, uploadDirectory, staticFilesDirectory] = [targetConfig.dataDirectory, targetConfig.uploadDirectory, targetConfig.staticFilesDirectory];
    const targetSecrets = {
      APP_KEYS: `${secret()},${secret()}`,
      JWT_SECRET: secret(),
      ADMIN_JWT_SECRET: secret(),
      API_TOKEN_SALT: secret(),
      TRANSFER_TOKEN_SALT: secret(),
      ENCRYPTION_KEY: secret(),
    };
    try {
      await copyTrackedCmsSource(cmsRoot, candidateDirectory, runFile);
      await installPinnedCmsDependencies(candidateDirectory, runFile, safeEnvironment.PATH);
      await mkdir(join(candidateDirectory, 'public'), { recursive: true, mode: 0o700 });
      await mkdir(join(candidateDirectory, '.tmp'), { recursive: true, mode: 0o700 });
      await mkdir(join(candidateDirectory, '.home'), { recursive: true, mode: 0o700 });
      await installNativeTokenBootstrap(candidateDirectory, join(candidateDirectory, '.tmp', 'native-api-token'));
      for (const path of [dataDirectory, uploadDirectory, staticFilesDirectory]) await checkPrivateDirectory(path, true);
      await symlink(uploadDirectory, join(candidateDirectory, 'public', 'uploads'));
      await symlink(staticFilesDirectory, join(candidateDirectory, 'public', 'static-files'));
      if (config.cms.cmsStartScript === 'start') {
        await runFile('npm', ['run', 'build'], {
          cwd: candidateDirectory,
          env: {
            ...privateCmsNpmEnvironment(candidateDirectory, safeEnvironment.PATH),
            NODE_ENV: 'production',
            STRAPI_TELEMETRY_DISABLED: 'true',
          },
          timeout: 10 * 60 * 1000,
          maxBuffer: 32 * 1024 * 1024,
        });
      }
    } catch (error) {
      await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const baseUrl = new URL(targetConfig.baseUrl);
    const strapiCli = join(candidateDirectory, 'node_modules', '@strapi', 'strapi', 'bin', 'strapi.js');
    const logStem = join(config.privateArtifactsRoot, `cms-${input.name.toLowerCase()}-${process.pid}-${Date.now()}`);
    const stdoutLog = await open(`${logStem}.stdout.log`, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    let stderrLog: FileHandle | undefined;
    let child: Child;
    try {
      stderrLog = await open(`${logStem}.stderr.log`, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      if (!inside(candidateDirectory, await realpath(strapiCli))) throw fail('Pinned Strapi CLI dependency escapes the private candidate');
      child = childProcess(spawn, config.cms.nodeExecutable, [strapiCli, config.cms.cmsStartScript], {
        cwd: candidateDirectory,
        env: {
          PATH: safeEnvironment.PATH,
          HOME: join(candidateDirectory, '.home'),
          TMPDIR: join(candidateDirectory, '.tmp'),
          NODE_ENV: 'production',
          CI: 'true',
          HOST: '127.0.0.1', PORT: baseUrl.port,
          DATABASE_CLIENT: 'sqlite', DATABASE_FILENAME: join(dataDirectory, 'data.db'),
          STRAPI_TELEMETRY_DISABLED: 'true',
          IKPK_NATIVE_API_TOKEN_FILE: join(candidateDirectory, '.tmp', 'native-api-token'),
          IKPK_NATIVE_API_TOKEN_NAME: `sql-demo-native-${randomBytes(12).toString('hex')}`,
          ...targetSecrets,
        },
        stdio: ['ignore', stdoutLog.fd, stderrLog.fd],
      });
    } catch (error) {
      await stdoutLog.close().catch(() => undefined);
      await stderrLog?.close().catch(() => undefined);
      await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const target: SqlDemoNativeOwnedTarget = {
      name: input.name, baseUrl: targetConfig.baseUrl, namespace: targetConfig.namespace,
      dataDirectory, uploadDirectory, client: undefined,
      process: { pid: child.pid, endpoint: targetConfig.baseUrl, namespace: targetConfig.namespace, dataDirectory, uploadDirectory },
    } as SqlDemoNativeOwnedTarget;
    const state: TargetState = { child, candidateDirectory, stdoutLog, stderrLog: stderrLog!, startTime: '', token: '', documents: new Map() };
    targetOwners.set(target, state);
    target.client = clientFor(target, state, fetcher, () => verifyTargetProcess(target, state));
    try {
      state.startTime = await processInspector.startTime(child.pid);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw fail('Owned CMS process exited before readiness');
        try {
          await verifyTargetProcess(target, state);
          const response = await fetcher(new URL('/_health', target.baseUrl), { redirect: 'manual' });
          if (response.status >= 200 && response.status < 300 && !response.redirected
            && await processInspector.listenerPid(Number(baseUrl.port)) === child.pid) {
            const token = await takeNativeApiToken(join(candidateDirectory, '.tmp', 'native-api-token'));
            if (token) { state.token = token; return target; }
          }
        } catch { /* Retry only the owned local readiness probe. */ }
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
      throw fail('Owned CMS process did not become ready');
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await waitForExit(child).catch(() => undefined);
      }
      targetOwners.delete(target);
      await state.stdoutLog.close().catch(() => undefined);
      await state.stderrLog.close().catch(() => undefined);
      await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function stopTarget(target: SqlDemoNativeOwnedTarget): Promise<void> {
    const state = owned(target);
    await verifyTargetProcess(target, state);
    state.child.kill('SIGTERM');
    await waitForExit(state.child);
    state.token = '';
    await state.stdoutLog.close();
    await state.stderrLog.close();
    await rm(state.candidateDirectory, { recursive: true, force: true });
  }

  return {
    async resolveCmsToken(): Promise<string> {
      await preflightBeforeToken();
      const token = await config.resolveToken();
      if (typeof token !== 'string' || !token.trim()) throw fail('Native CMS API token is unavailable');
      return token;
    },

    async acquireOwnedSqlSource(reader: SqlPublicReaderOptions) {
      await pinnedCode(config, runFile);
      if (reader.dumpPath !== config.source.reader.dumpPath || reader.expectedDumpHash !== config.source.reader.expectedDumpHash) throw fail('SQL reader differs from the pinned source');
      await assertStoppedCluster(config.source.clusterDataDirectory, processInspector.isAlive);
      await checkPrivateDirectory(config.source.socketDirectory, true);
      const pgCtl = join(config.source.postgresBinDirectory, 'pg_ctl');
      const psql = join(config.source.postgresBinDirectory, 'psql');
      const cluster = config.source.clusterDataDirectory;
      const lock = await pidFromCluster(cluster);
      if (lock !== undefined) throw fail('PostgreSQL source cluster is already owned or has a stale PID');
      const startStdout = await open(join(config.privateArtifactsRoot, 'postgresql-start.stdout.log'), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
      const startStderr = await open(join(config.privateArtifactsRoot, 'postgresql-start.stderr.log'), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
      let child: Child;
      let pid: number | undefined;
      let startTime: string | undefined;
      try {
        child = childProcess(spawn, pgCtl, ['start', '-D', cluster, '-o', `-c listen_addresses='' -c unix_socket_directories='${config.source.socketDirectory}' -c port=${config.source.port} -c default_transaction_read_only=on`, '-w'], { env: sourceEnvironment, stdio: ['ignore', startStdout.fd, startStderr.fd] });
        await waitForExit(child, 120_000);
        pid = await pidFromCluster(cluster);
        if (pid !== undefined && processInspector.isAlive(pid)) startTime = await processInspector.startTime(pid);
        if (child.exitCode !== 0) throw fail('Owned PostgreSQL cluster failed to start');
        if (pid === undefined || startTime === undefined) throw fail('PostgreSQL source process ownership could not be established');
      } catch (error) {
        let cleanupFailed = false;
        if (pid !== undefined) {
          try {
            if (await pidFromCluster(cluster) === pid && processInspector.isAlive(pid)
              && (startTime === undefined || await processInspector.startTime(pid) === startTime)) {
              await runFile(pgCtl, ['stop', '-D', cluster, '-m', 'fast', '-w'], { env: sourceEnvironment, timeout: 30_000 });
            }
          } catch { cleanupFailed = true; }
        }
        if (cleanupFailed) throw fail('Owned PostgreSQL cluster could not be stopped after startup failed');
        throw error;
      } finally {
        await startStdout.sync().catch(() => undefined);
        await startStderr.sync().catch(() => undefined);
        await startStdout.close();
        await startStderr.close();
      }
      if (pid === undefined || startTime === undefined) throw fail('PostgreSQL source process ownership could not be established');
      const lease = Object.freeze({ id: `${pid}:${startTime}`, pid }) as SourceLease;
      const leaseState: LeaseState = { child, pid, startTime, cluster, pgCtl, psql };
      sourceOwners.set(lease, leaseState);
      const leasedReader: SqlPublicReaderOptions = {
        ...reader,
        connection: { ...reader.connection, unixSocketPath: config.source.socketDirectory, port: config.source.port, database: config.source.database, user: config.source.user },
        runPsql: async (invocation: SqlPublicPsqlInvocation) => {
          const sql = invocation.args[invocation.args.indexOf('-c') + 1] ?? '';
          if (!isReviewedReadOnlyProjection(sql)) throw fail('SQL reader attempted a query outside the reviewed read-only projection');
          const { stdout } = await runFile(psql, [...invocation.args], { env: sourceEnvironment, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
          if (await pidFromCluster(cluster) !== pid || await processInspector.startTime(pid) !== startTime) throw fail('PostgreSQL source process identity changed during read');
          leaseState.invocation = invocation;
          leaseState.sourceWitness = sourceWitness(stdout);
          return stdout;
        },
      };
      return { lease, reader: leasedReader };
    },

    async stopOwnedSqlSource(lease: SqlDemoNativeSqlSourceLease): Promise<void> {
      const state = sourceOwners.get(lease as object);
      if (!state || !lease || (lease as SourceLease).pid !== state.pid) throw fail('PostgreSQL source lease was not acquired by this adapter');
      if (await pidFromCluster(state.cluster) !== state.pid || !processInspector.isAlive(state.pid) || await processInspector.startTime(state.pid) !== state.startTime) throw fail('Refusing to stop an unowned PostgreSQL process');
      let verificationFailure: unknown;
      try {
        if (!state.invocation || !state.sourceWitness) throw fail('Source readback witness was not captured');
        const { stdout } = await runFile(state.psql, [...state.invocation.args], { env: sourceEnvironment, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
        if (await pidFromCluster(state.cluster) !== state.pid || await processInspector.startTime(state.pid) !== state.startTime) throw fail('PostgreSQL source process identity changed during verification');
        if (sourceWitness(stdout).hash !== state.sourceWitness.hash) throw fail('Pinned SQL source projection changed during the rehearsal');
      } catch (error) { verificationFailure = error; }
      let cleanupFailure: unknown;
      try {
        if (await pidFromCluster(state.cluster) !== state.pid || !processInspector.isAlive(state.pid)
          || await processInspector.startTime(state.pid) !== state.startTime) throw fail('Refusing to stop an unowned PostgreSQL process');
        await runFile(state.pgCtl, ['stop', '-D', state.cluster, '-m', 'fast', '-w'], { env: sourceEnvironment });
      } catch (error) { cleanupFailure = error; }
      finally {
        sourceOwners.delete(lease as object);
      }
      if (cleanupFailure) throw fail('Owned PostgreSQL source could not be stopped');
      if (verificationFailure) throw fail('Source pre/post table witness verification failed');
      verifiedSourceWitness = state.sourceWitness;
      sourceWitnessVerified = true;
    },

    openOwnedTarget: openTarget,
    async stopOwnedTarget(target) { await stopTarget(target); },
    async refreshMediaInventory(target) { owned(target); return inventory(target); },
    async prepareResumeMediaInventory(target, proofs) {
      const state = owned(target); await verifyTargetProcess(target, state);
      const targetConfig = config.targets[target.name];
      if (target.name !== 'A' || !targetConfig?.resumeExistingMediaOnly || config.targets.B) throw fail('Exact media inventory validation is limited to the configured single-A resume');
      const expected = new Map<string, string>();
      for (const proof of proofs) {
        const digest = 'sourceBytesAvailable' in proof ? proof.substitution.replacementSha256 : proof.sourceSha256;
        if (!HASH.test(digest) || expected.has(proof.sourceUrl)) throw fail('Approved media source identities are invalid or duplicated');
        expected.set(proof.sourceUrl, digest.toLowerCase());
      }
      const current = await inventory(target);
      if (current.mediaById.size !== expected.size) throw fail('Persisted media count differs from the exact approved source set');
      const seen = new Set<string>();
      for (const file of current.mediaById.values()) {
        const claims = sourceClaims(file);
        const entries = Object.entries(claims);
        if (entries.length !== 1) throw fail('Persisted media has missing or extra source claims');
        const [sourceUrl, rawClaim] = entries[0]!;
        const sourceSha256 = expected.get(sourceUrl);
        const storedSha256 = current.storedHashById.get(file.id);
        if (!sourceSha256 || seen.has(sourceUrl) || !storedSha256 || !HASH.test(storedSha256)
          || !rawClaim || typeof rawClaim !== 'object' || Array.isArray(rawClaim)) throw fail('Persisted media identity is not in the approved source set');
        const claim = rawClaim as { version?: unknown; sha256?: unknown; storedSha256?: unknown };
        if (claim.version !== 1 || claim.sha256 !== sourceSha256 || claim.storedSha256 !== storedSha256) throw fail('Persisted media claim does not match approved source and independently hashed stored bytes');
        seen.add(sourceUrl);
      }
      if (seen.size !== expected.size) throw fail('Persisted media source identity set is incomplete');
      return current;
    },
    async readRasterBytes(path) { return safePrivateRead(config.privateInputsRoot, path); },
    async uploadRaster(target, currentInventory, proof: SqlDemoOfflineAssetProof, bytes): Promise<SqlDemoNativeUpload> {
      const state = owned(target); await verifyTargetProcess(target, state);
      const expected = 'sourceBytesAvailable' in proof ? proof.substitution.replacementSha256 : proof.sourceSha256;
      const mime = pngMime(bytes);
      if (!mime || mime !== proof.detectedMimeType || !HASH.test(expected) || sha256(bytes) !== expected.toLowerCase()) throw fail('Raster bytes do not match their reviewed source hash and MIME');
      if (!allowedSourceIdentity(proof.sourceUrl)) throw failStage('SourceUrlIdentity');
      const prior = currentInventory as StrapiMediaInventory;
      const sourceUrl = proof.sourceUrl;
      const sourceHash = expected.toLowerCase();
      const exact = [...prior.mediaById.values()].find((file) => Object.hasOwn(sourceClaims(file), sourceUrl));
      if (exact) {
        const claim = sourceClaims(exact)[sourceUrl] as { version?: unknown; sha256?: unknown; storedSha256?: unknown } | undefined;
        const actualStoredHash = prior.storedHashById.get(exact.id);
        if (claim?.version !== 1 || claim.sha256 !== sourceHash || !actualStoredHash
          || claim.storedSha256 !== actualStoredHash) throw fail('Existing source URL identity does not match its verified stored bytes');
        return { id: exact.id, url: exact.url };
      }
      if (config.targets[target.name]?.resumeExistingMediaOnly) {
        throw fail('Media-only resume target is missing an exact persisted source identity');
      }
      const unbound = [...prior.mediaById.values()].sort((left, right) => left.id - right.id).find((file) =>
        prior.storedHashById.get(file.id) === sourceHash && Object.keys(sourceClaims(file)).length === 0);
      if (unbound) {
        const identityResponse = await fetcher(new URL(`/api/media-import-identities/${unbound.id}`, target.baseUrl), {
          method: 'PUT', redirect: 'manual', headers: { ...bearer(state.token), 'content-type': 'application/json' },
          body: JSON.stringify({ sourceUrl, sourceSha256: sourceHash, expectedStoredSha256: sourceHash }),
        });
        await verifyTargetProcess(target, state);
        if (identityResponse.status < 200 || identityResponse.status >= 300 || identityResponse.redirected) throw fail('CMS did not persist the media source identity');
        const identityBody = await identityResponse.json() as { data?: { storedSha256?: unknown } };
        if (identityBody.data?.storedSha256 !== sourceHash) throw fail('CMS source identity endpoint returned a different stored byte hash');
        const stored = await fetchTargetBytes(target, unbound.url);
        if (sha256(stored) !== sourceHash) throw fail('Reused media bytes differ from the source bytes');
        const metadata = unbound.provider_metadata && typeof unbound.provider_metadata === 'object' && !Array.isArray(unbound.provider_metadata)
          ? unbound.provider_metadata as Record<string, unknown> : {};
        const imported = metadata.ikpk_media_import && typeof metadata.ikpk_media_import === 'object' && !Array.isArray(metadata.ikpk_media_import)
          ? metadata.ikpk_media_import as Record<string, unknown> : {};
        unbound.provider_metadata = { ...metadata, ikpk_media_import: { ...imported, sources: { ...sourceClaims(unbound), [sourceUrl]: { version: 1, sha256: sourceHash, storedSha256: sourceHash } } } };
        return { id: unbound.id, url: unbound.url };
      }
      const filename = `source-${proof.sourceFileId.replace(/[^A-Za-z0-9._-]/g, '_')}.${mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp'}`;
      const body = buildUploadBody(Buffer.from(bytes), filename, mime);
      await verifyTargetProcess(target, state);
      const uploadedResponse = await fetcher(new URL('/api/upload', target.baseUrl), { method: 'POST', redirect: 'manual', headers: { ...bearer(state.token), 'content-type': body.contentType }, body: body.body });
      await verifyTargetProcess(target, state);
      if (uploadedResponse.status < 200 || uploadedResponse.status >= 300 || uploadedResponse.redirected) throw failStage('UploadHttpStatus', uploadedResponse.status);
      const uploaded = await uploadedResponse.json() as unknown;
      const result = Array.isArray(uploaded) ? uploaded[0] as { id?: unknown; url?: unknown } : undefined;
      if (!Number.isSafeInteger(result?.id) || (result?.id as number) <= 0 || typeof result?.url !== 'string') throw fail('CMS upload response has no media identity');
      const uploadUrl = safeUrlPath(result.url, target.baseUrl, '/uploads/');
      let storedBytes: Buffer;
      try { storedBytes = await fetchTargetBytes(target, uploadUrl.toString()); }
      catch { throw failStage('StoredMediaBytes'); }
      const storedHash = sha256(storedBytes);
      const identityResponse = await fetcher(new URL(`/api/media-import-identities/${result.id}`, target.baseUrl), {
        method: 'PUT', redirect: 'manual', headers: { ...bearer(state.token), 'content-type': 'application/json' },
        body: JSON.stringify({ sourceUrl, sourceSha256: sourceHash, expectedStoredSha256: storedHash }),
      });
      await verifyTargetProcess(target, state);
      if (identityResponse.status < 200 || identityResponse.status >= 300 || identityResponse.redirected) throw failStage('UploadIdentityHttpStatus', identityResponse.status);
      const identityBody = await identityResponse.json() as { data?: { storedSha256?: unknown } };
      if (identityBody.data?.storedSha256 !== storedHash) throw failStage('PersistentMediaIdentity');
      const persisted = await (target.client as { request: (method: string, path: string) => Promise<unknown> }).request('GET', `/api/upload/files/${result.id}?populate=*`) as {
        id?: unknown; url?: unknown; name?: unknown; mime?: unknown; provider_metadata?: unknown;
      };
      const persistedClaim = sourceClaims(persisted as { provider_metadata?: unknown })[sourceUrl] as
        { version?: unknown; sha256?: unknown; storedSha256?: unknown } | undefined;
      if (persisted.id !== result.id || typeof persisted.url !== 'string'
        || safeUrlPath(persisted.url, target.baseUrl, '/uploads/').pathname !== uploadUrl.pathname
        || persistedClaim?.version !== 1 || persistedClaim.sha256 !== sourceHash || persistedClaim.storedSha256 !== storedHash) {
        throw failStage('PersistentMediaIdentity');
      }
      prior.mediaById.set(result.id as number, {
        id: result.id as number, url: uploadUrl.pathname,
        ...(typeof persisted.name === 'string' ? { name: persisted.name } : {}),
        ...(typeof persisted.mime === 'string' ? { mime: persisted.mime } : {}),
        provider_metadata: persisted.provider_metadata,
      });
      prior.storedHashById.set(result.id as number, storedHash);
      const existingStoredId = prior.byStoredHash.get(storedHash);
      if (existingStoredId === undefined || (result.id as number) < existingStoredId) prior.byStoredHash.set(storedHash, result.id as number);
      const existingSourceId = prior.bySourceHash.get(sourceHash);
      if (existingSourceId === undefined || (result.id as number) < existingSourceId) prior.bySourceHash.set(sourceHash, result.id as number);
      return { id: result.id as number, url: uploadUrl.pathname };
    },
    async readStoredMediaBytes(target, mediaId) {
      const state = owned(target); await verifyTargetProcess(target, state);
      if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw fail('Stored media ID is invalid');
      const value = await (target.client as { request: (method: string, path: string) => Promise<unknown> }).request('GET', `/api/upload/files/${mediaId}?populate=*`) as { id?: unknown; url?: unknown };
      if (value.id !== mediaId || typeof value.url !== 'string') throw fail('Stored media identity does not match the requested ID');
      return fetchTargetBytes(target, value.url);
    },
    async readPdfBytes(path) { return safePrivateRead(config.privateInputsRoot, path); },
    async verifyExistingStaticDocuments(documents) {
      const targetConfig = config.targets.A;
      if (!targetConfig?.resumeExistingMediaOnly) throw fail('Static document resume verification is limited to the configured A continuation');
      const expected = new Map<string, Uint8Array>();
      for (const document of documents) {
        const relativePath = document.publicPath.replace(/^\/static-files\//, '');
        const decoded = relativePath.split('/').map((part) => { try { return decodeURIComponent(part); } catch { return '\0'; } });
        if (relativePath === document.publicPath || relativePath.includes('\\') || decoded.some((part) => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0')) || expected.has(relativePath)) {
          throw fail('Approved static document paths are invalid or duplicated');
        }
        expected.set(relativePath, document.bytes);
      }
      const actual = new Set<string>();
      const walk = async (directory: string, prefix = ''): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          const stat = await lstat(path);
          if (stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw fail('Static document tree contains an unsafe entry');
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (stat.isDirectory()) await walk(path, relativePath);
          else if (stat.isFile()) actual.add(relativePath);
          else throw fail('Static document tree contains an unsupported entry');
        }
      };
      await walk(targetConfig.staticFilesDirectory);
      if (actual.size !== expected.size || [...expected.keys()].some((path) => !actual.has(path))) throw fail('Static document inventory does not match the approved source set');
      for (const [relativePath, expectedBytes] of expected) {
        const bytes = await safePrivateRead(targetConfig.staticFilesDirectory, join(targetConfig.staticFilesDirectory, ...relativePath.split('/')));
        if (bytes.byteLength !== expectedBytes.byteLength || sha256(bytes) !== sha256(expectedBytes)) throw fail('Static document bytes do not match the approved source proof');
      }
    },
    async writeStaticDocument(target, publicPath, bytes) {
      const state = owned(target); await verifyTargetProcess(target, state);
      const targetConfig = config.targets[target.name];
      if (!targetConfig) throw fail(`CMS target ${target.name} is not configured`);
      const relativePath = publicPath.replace(/^\/static-files\//, '');
      const decoded = relativePath.split('/').map((part) => { try { return decodeURIComponent(part); } catch { return '\0'; } });
      if (relativePath === publicPath || relativePath.includes('\\') || decoded.some((part) => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0'))) throw fail('Static PDF path is invalid');
      if (!Buffer.from(bytes).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw fail('Static document is not a PDF');
      const root = await realpath(targetConfig.staticFilesDirectory);
      const destination = resolve(root, ...relativePath.split('/'));
      if (!inside(root, destination)) throw fail('Static PDF path escapes its target root');
      const parent = dirname(destination);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const realParent = await realpath(parent);
      if (!inside(root, realParent) || realParent !== resolve(root, relative(root, parent))) throw fail('Static PDF parent escaped its target root');
      try { const stat = await lstat(destination); if (!stat.isFile() || stat.isSymbolicLink()) throw fail('Static PDF destination is not a regular file'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const handle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      state.documents.set(publicPath, { sha256: sha256(bytes), bytes: bytes.byteLength });
    },
    async readStaticDocument(target, publicPath) {
      owned(target);
      const targetConfig = config.targets[target.name];
      if (!targetConfig) throw fail(`CMS target ${target.name} is not configured`);
      const relativePath = publicPath.replace(/^\/static-files\//, '');
      const decoded = relativePath.split('/').map((part) => { try { return decodeURIComponent(part); } catch { return '\0'; } });
      if (relativePath === publicPath || relativePath.includes('\\') || decoded.some((part) => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0'))) throw fail('Static PDF path is invalid');
      const bytes = await safePrivateRead(targetConfig.staticFilesDirectory, join(targetConfig.staticFilesDirectory, ...relativePath.split('/')));
      const expected = owned(target).documents.get(publicPath);
      if (expected && (expected.sha256 !== sha256(bytes) || expected.bytes !== bytes.byteLength)) throw fail('Published static document bytes do not match the owned write witness');
      if (!expected && !config.targets[target.name]?.resumeExistingMediaOnly) throw fail('Published static document bytes have no owned write witness');
      return bytes;
    },
    async createFreshClient(target) {
      const state = owned(target); await verifyTargetProcess(target, state);
      const fresh = { ...target, client: clientFor(target, state, fetcher, () => verifyTargetProcess(target, state)) };
      targetOwners.set(fresh, state);
      return fresh;
    },
    async readPublished(target) {
      const state = owned(target); await verifyTargetProcess(target, state);
      const collections: Partial<Record<SqlDemoNativeCollection, readonly SqlDemoNativePublishedRecord[]>> = {};
      const counts: Record<string, number> = {};
      const entityIds: Record<string, Array<{ id: number; documentId: string; legacyId: string }>> = {};
      for (const collection of COLLECTIONS) {
        const records: SqlDemoNativePublishedRecord[] = [];
        let page = 1; let pageCount = 1; let total = -1;
        while (page <= pageCount) {
          const response = await readPage(target, `/api/${collection}?status=published&pagination[page]=${page}&pagination[pageSize]=100&populate=*`);
          const p = response.meta.pagination;
          if (p.page !== page || (total >= 0 && p.total !== total)) throw fail(`CMS ${collection} pagination changed during readback`);
          total = p.total; pageCount = p.pageCount;
          for (const raw of response.data) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(`CMS ${collection} contains an invalid record`);
            const row = raw as Record<string, unknown>;
            if (!Number.isSafeInteger(row.id) || typeof row.documentId !== 'string' || !row.documentId || typeof row.legacy_id !== 'string' || !row.legacy_id || typeof row.publishedAt !== 'string' || !row.publishedAt) throw fail(`CMS ${collection} record is missing a published identity`);
            records.push(row as SqlDemoNativePublishedRecord);
          }
          page += 1;
        }
        if (records.length !== total) throw fail(`CMS ${collection} pagination omitted published records`);
        collections[collection] = records;
        counts[collection] = records.length;
        entityIds[collection] = records.map(({ id, documentId, legacy_id }) => ({ id, documentId, legacyId: legacy_id }));
      }
      const mediaInventory = await inventory(target);
      const media: SqlDemoStrapi5MediaReadback[] = [...mediaInventory.mediaById.values()].map((file) => {
        const stored = mediaInventory.storedHashById.get(file.id);
        if (!stored || !HASH.test(stored)) throw fail('CMS media is missing its independently read byte hash');
        return { id: file.id, url: file.url, ...(file.provider_metadata === undefined ? {} : { provider_metadata: file.provider_metadata }), verifiedStoredSha256: stored };
      });
      state.lastSummary = { capturedAt: new Date().toISOString(), target: target.name, codeCommit: config.cms.expectedCommit, counts, entityIds, media: media.map(({ id, url, verifiedStoredSha256, provider_metadata }) => ({ id, url, verifiedStoredSha256, sourceIdentitySha256: sha256(Buffer.from(JSON.stringify(provider_metadata ?? null))) })), documents: [...state.documents.entries()].map(([path, witness]) => ({ path, ...witness })) };
      return { collections, media };
    },
    async readDraftContentCounts(target) {
      const state = owned(target); await verifyTargetProcess(target, state);
      const counts: Record<string, number> = {};
      for (const collection of COLLECTIONS) {
        let page = 1; let pageCount = 1; let total = -1;
        let seen = 0;
        while (page <= pageCount) {
          const response = await readPage(target, `/api/${collection}?status=draft&pagination[page]=${page}&pagination[pageSize]=100&populate=*`);
          const p = response.meta.pagination;
          if (p.page !== page || (total >= 0 && p.total !== total)) throw fail(`CMS ${collection} draft pagination changed during readback`);
          total = p.total; pageCount = p.pageCount;
          for (const raw of response.data) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(`CMS ${collection} contains an invalid draft record`);
            const row = raw as Record<string, unknown>;
            if (!Number.isSafeInteger(row.id) || typeof row.documentId !== 'string' || !row.documentId) throw fail(`CMS ${collection} draft record is missing its identity`);
            seen += 1;
          }
          page += 1;
        }
        if (seen !== total) throw fail(`CMS ${collection} draft pagination omitted records`);
        counts[collection] = seen;
      }
      return counts;
    },
    async capture(targets) {
      if (!sourceWitnessVerified || !verifiedSourceWitness) throw fail('Cannot capture before the pinned SQL source is verified and stopped');
      const rows: Record<string, unknown> = {};
      for (const target of targets) {
        const state = owned(target);
        if (!state.lastSummary) throw fail('Cannot capture a target without a completed published readback');
        rows[target.name] = state.lastSummary;
      }
      const root = await checkPrivateDirectory(config.privateArtifactsRoot, true);
      const path = join(root, `native-sql-rehearsal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      const pendingPath = `${path}.${randomBytes(8).toString('hex')}.pending`;
      const file = await open(pendingPath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify({
          sourceHash: config.source.reader.expectedDumpHash,
          sourceWitnessScope: verifiedSourceWitness.scope,
          sourceTableCount: verifiedSourceWitness.tables.length,
          sourceTableWitnesses: verifiedSourceWitness.tables,
          sourceWitnessVerified,
          codeCommit: config.cms.expectedCommit,
          targets: rows,
        }, null, 2)}\n`);
        await file.sync();
      } finally { await file.close(); }
      try { await rename(pendingPath, path); }
      catch (error) { await unlink(pendingPath).catch(() => undefined); throw error; }
    },
    async captureLiveSnapshot(target, destination) {
      const state = owned(target);
      await verifyTargetProcess(target, state);
      if (target.name !== 'A' || !state.token) throw fail('Live snapshot requires the active owned prototype target');
      const targetConfig = config.targets.A;
      const output = resolve(destination);
      await checkPrivateDirectory(output, true);
      const webRoot = resolve(config.cms.sourceDirectory, '..', 'web');
      const captureScript = join(webRoot, 'scripts', 'capture-content-snapshot.ts');
      const stdoutPath = join(config.privateArtifactsRoot, 'prototype-snapshot.stdout.log');
      const stderrPath = join(config.privateArtifactsRoot, 'prototype-snapshot.stderr.log');
      const stdout = await open(stdoutPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
      const stderr = await open(stderrPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
      let child: Child | undefined;
      try {
        child = childProcess(spawn, config.cms.nodeExecutable, [captureScript], {
          cwd: webRoot,
          env: {
            PATH: safeEnvironment.PATH,
            HOME: config.privateArtifactsRoot,
            CMS_URL: target.baseUrl,
            CMS_TOKEN: state.token,
            CONTENT_SNAPSHOT_DIR: output,
          },
          stdio: ['ignore', stdout.fd, stderr.fd],
        });
        await waitForExit(child, 1_800_000);
        if (child.exitCode !== 0 || child.signalCode !== null) throw fail('Live CMS snapshot process failed');
      } finally {
        await stdout.sync().catch(() => undefined);
        await stderr.sync().catch(() => undefined);
        await stdout.close();
        await stderr.close();
      }
      await verifyTargetProcess(target, state);
      const staticRoot = await realpath(targetConfig.staticFilesDirectory);
      const staticDestination = join(output, 'static-files');
      await mkdir(staticDestination, { recursive: true, mode: 0o700 });
      const copyTree = async (source: string, destinationPath: string): Promise<void> => {
        for (const name of await readdir(source)) {
          if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw fail('Static-file name is invalid');
          const sourcePath = join(source, name);
          const stat = await lstat(sourcePath);
          if (stat.isSymbolicLink()) throw fail('Static-file tree contains a symbolic link');
          const destinationFile = join(destinationPath, name);
          if (stat.isDirectory()) {
            await mkdir(destinationFile, { recursive: true, mode: 0o700 });
            await copyTree(sourcePath, destinationFile);
          } else if (stat.isFile()) {
            const bytes = await safePrivateRead(staticRoot, sourcePath);
            const file = await open(destinationFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
            try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          } else throw fail('Static-file tree contains an unsupported filesystem entry');
        }
      };
      await copyTree(staticRoot, staticDestination);
    },
  } as SqlDemoNativeRehearsalIo;
}

type SqlDemoNativePublishedRecord = SqlDemoStrapi5PublishedRecord;
