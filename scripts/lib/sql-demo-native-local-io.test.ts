import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { privateCmsNpmEnvironment } from './sql-demo-native-local-io.js';
import type { SqlDemoNativeRehearsalIo, SqlDemoNativeOwnedTarget } from './sql-demo-native-rehearsal.js';
import type { SqlDemoNativeCollection } from './sql-demo-native-conservation.js';
import type { SqlDemoOfflineAssetProof } from './sql-demo-assets.js';
import type { SqlPublicReaderOptions } from './sql-public-reader.js';

const SOURCE_BYTES = Buffer.from('synthetic immutable public SQL baseline');
const SOURCE_SHA256 = createHash('sha256').update(SOURCE_BYTES).digest('hex');
const SECRET = 'synthetic-cms-token-must-never-be-captured';
const collections: readonly SqlDemoNativeCollection[] = [
  'institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries',
  'articles', 'news-items', 'promotions', 'video-playlists', 'pages',
];

type ChildLike = {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
};

let scratch: string;
let nextPid = 8100;
const listeners = new Map<number, number>();
type TestConfig = Awaited<ReturnType<typeof makeConfiguration>>['config'];
const configurations = new WeakMap<object, TestConfig>();

async function makeConfiguration(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ikpk-native-local-io-'));
  scratch = root;
  const sourceRoot = join(root, 'pinned-cms');
  const candidateRoot = join(root, 'private-candidates');
  const artifactsRoot = join(root, 'private-artifacts');
  const sourceCluster = join(root, 'stopped-postgres-cluster');
  const sqlPath = join(root, 'baseline.sql');
  const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }));
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });
  await mkdir(sourceCluster, { recursive: true });
  await chmod(sourceCluster, 0o700);
  await writeFile(join(sourceCluster, 'PG_VERSION'), '16\n');
  await writeFile(sqlPath, SOURCE_BYTES);
  await writeFile(join(sourceRoot, 'package.json'), '{"name":"synthetic-pinned-cms","version":"1.0.0","private":true}');
  await writeFile(join(sourceRoot, 'package-lock.json'), '{"name":"synthetic-pinned-cms","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"synthetic-pinned-cms","version":"1.0.0"}}}');
  await writeFile(join(sourceRoot, '.gitignore'), 'node_modules/\n.env\n');
  await mkdir(join(sourceRoot, 'src'), { recursive: true });
  await writeFile(join(sourceRoot, 'src', 'index.js'), 'export default {};\n');
  await mkdir(join(sourceRoot, 'node_modules', '@strapi', 'strapi', 'bin'), { recursive: true });
  await writeFile(join(sourceRoot, 'node_modules', '@strapi', 'strapi', 'bin', 'strapi.js'), 'ignored source install\n');
  await writeFile(join(sourceRoot, '.env'), 'APP_KEYS=must-not-copy\nJWT_SECRET=must-not-copy\n');
  execFileSync('git', ['init', '--quiet', sourceRoot]);
  execFileSync('git', ['-C', sourceRoot, 'add', '.gitignore', 'package.json', 'package-lock.json', 'src/index.js']);
  execFileSync('git', ['-C', sourceRoot, '-c', 'user.name=synthetic fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'synthetic tracked CMS source']);
  const expectedCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const reader: SqlPublicReaderOptions = {
    dumpPath: sqlPath,
    expectedDumpHash: SOURCE_SHA256,
    connection: { unixSocketPath: join(root, 'pg-socket'), port: 55438, database: 'synthetic_public', user: 'readonly' },
  };
  const defaultTargets = {
    A: { baseUrl: 'http://127.0.0.1:19331', namespace: 'ikpk_sql_demo_native_a', dataDirectory: join(root, 'a-db'), uploadDirectory: join(root, 'a-uploads'), staticFilesDirectory: join(root, 'a-static') },
    B: { baseUrl: 'http://127.0.0.1:19332', namespace: 'ikpk_sql_demo_native_b', dataDirectory: join(root, 'b-db'), uploadDirectory: join(root, 'b-uploads'), staticFilesDirectory: join(root, 'b-static') },
  };
  const execCalls: { command: string; args: readonly string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }[] = [];
  const execFile = vi.fn(async (command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    execCalls.push({ command, args, options });
    if (command === 'git') return { stdout: execFileSync(command, [...args], { encoding: 'utf8' }) };
    if (command.endsWith('/psql')) return { stdout: JSON.stringify(Object.fromEntries(['Articles', 'Cities', 'Events', 'EventsAndTeachers', 'FileBindingOrganizationInfo', 'Files', 'InstituteAdditionalInfo', 'Institutes', 'News', 'OrganizationInfo', 'Programs', 'Promotions', 'Seminars', 'SeminarsTeacher', 'Teachers', 'TeachersAndInstitutes', 'Videos'].map((table) => [table, []]))) };
    if (command.endsWith('/pg_ctl') && args[0] === 'stop') unlinkSync(join(sourceCluster, 'postmaster.pid'));
    if (command === 'npm' && args[0] === 'ci' && options.cwd) {
      const cli = join(options.cwd, 'node_modules', '@strapi', 'strapi', 'bin', 'strapi.js');
      await mkdir(join(options.cwd, 'node_modules', '@strapi', 'strapi', 'bin'), { recursive: true });
      await writeFile(cli, 'synthetic isolated install\n');
    }
    return { stdout: '' };
  });
  const config = {
    ...overrides,
    source: { reader, clusterDataDirectory: sourceCluster, postgresBinDirectory: join(root, 'postgres-bin'), socketDirectory: join(root, 'pg-socket'), port: 55438, database: 'synthetic_public', user: 'readonly', ...(overrides.source as object ?? {}) },
    cms: { sourceDirectory: sourceRoot, expectedCommit, candidateRoot, nodeExecutable: process.execPath, cmsStartScript: 'develop', ...(overrides.cms as object ?? {}) },
    targets: { ...defaultTargets, ...(overrides.targets as object ?? {}) },
    privateArtifactsRoot: overrides.privateArtifactsRoot ?? artifactsRoot,
    privateInputsRoot: overrides.privateInputsRoot ?? join(root, 'private-inputs'),
    resolveToken: overrides.resolveToken ?? vi.fn(async () => SECRET),
    runtime: {
      spawn: vi.fn((command: string, args: readonly string[], options: Record<string, unknown> = {}) => {
        const pid = ++nextPid;
        if (args[0] === 'start') writeFileSync(join(sourceCluster, 'postmaster.pid'), '8401\n');
        const env = options.env as NodeJS.ProcessEnv | undefined;
        if (command === process.execPath && env?.PORT) {
          listeners.set(Number(env.PORT), pid);
          const tokenFile = env.IKPK_NATIVE_API_TOKEN_FILE;
          if (tokenFile) writeFileSync(tokenFile, `minted-strapi-token-${env.PORT}`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        }
        const child: ChildLike = {
          pid, exitCode: command.endsWith('/pg_ctl') ? 0 : null, signalCode: null,
          once: vi.fn(), on: vi.fn(), kill: vi.fn(),
          stdout: { on: vi.fn() }, stderr: { on: vi.fn() },
        };
        child.kill.mockImplementation(() => { child.exitCode = 0; });
        return child;
      }),
      fetch,
      execFile,
      processInspector: {
        isAlive: () => true,
        startTime: async (pid: number) => `synthetic-start-${pid}`,
        listenerPid: async (port: number) => listeners.get(port),
      },
      ...(overrides.runtime as object ?? {}),
    },
  };
  return { config, root, execCalls };
}

async function makeAdapter(overrides: Record<string, unknown> = {}): Promise<SqlDemoNativeRehearsalIo> {
  const { config } = await makeConfiguration(overrides);
  const { createSqlDemoNativeLocalIo } = await import('./sql-demo-native-local-io.js');
  const io = createSqlDemoNativeLocalIo(config) as SqlDemoNativeRehearsalIo;
  configurations.set(io as object, config);
  return io;
}

async function target(io: SqlDemoNativeRehearsalIo, name: 'A' | 'B' = 'A', token = `synthetic-api-token-${name}`): Promise<SqlDemoNativeOwnedTarget> {
  const config = configurations.get(io as object)!;
  return io.openOwnedTarget({ ...config.targets[name], name, token });
}

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('concrete native local rehearsal adapter', () => {
  it('retains only a safe CMS status and allowlisted validation field for a failed request', async () => {
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/_health') return new Response('{}', { status: 200 });
      if (url.pathname === '/api/pages') return new Response(JSON.stringify({ error: { status: 422, details: { errors: [{ path: ['slug'], message: 'private body must not be logged' }] } } }), { status: 422 });
      return new Response('{}', { status: 200 });
    });
    const io = await makeAdapter({ runtime: { fetch } });
    const owned = await target(io);
    const client = owned.client as { request(method: string, path: string, body?: unknown): Promise<unknown> };

    await expect(client.request('POST', '/api/pages?status=draft', { data: { slug: 'synthetic' } }))
      .rejects.toMatchObject({ safeHttpStatus: 422, safeField: 'slug' });
  }, 30_000);

  it('uses distinct private npm user/global config paths without inheriting host credentials', () => {
    const environment = privateCmsNpmEnvironment('/private/tmp/cms-candidate', '/usr/bin:/bin');

    expect(environment.npm_config_userconfig).toBe('/private/tmp/cms-candidate/.home/.npmrc');
    expect(environment.npm_config_globalconfig).toBe('/dev/null');
    expect(environment.npm_config_userconfig).not.toBe(environment.npm_config_globalconfig);
    expect(Object.keys(environment).sort()).toEqual([
      'CI', 'HOME', 'PATH', 'TMPDIR', 'npm_config_audit', 'npm_config_fund',
      'npm_config_globalconfig', 'npm_config_update_notifier', 'npm_config_userconfig',
    ]);
  });

  it('is a real runner IO adapter and fences invalid endpoints before token, process, or network access', async () => {
    const spawn = vi.fn<(...args: [string, readonly string[], Record<string, unknown>?]) => ChildLike>();
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    const resolveToken = vi.fn(async () => SECRET);
    const { config } = await makeConfiguration({
      targets: {
        A: { baseUrl: 'https://ikpk.su', namespace: 'production', dataDirectory: 'a', uploadDirectory: 'ua' },
      },
      runtime: { spawn, fetch },
      resolveToken,
    });
    const { createSqlDemoNativeLocalIo } = await import('./sql-demo-native-local-io.js');
    expect(() => createSqlDemoNativeLocalIo(config)).toThrow();
    expect(resolveToken).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const valid = await makeAdapter();
    expect(valid).toMatchObject({
      resolveCmsToken: expect.any(Function), acquireOwnedSqlSource: expect.any(Function),
      openOwnedTarget: expect.any(Function), uploadRaster: expect.any(Function), readPublished: expect.any(Function),
    });
  }, 15_000);

  it('refuses a running or unowned PostgreSQL cluster without spawning, and only cleans up a returned lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ikpk-native-local-io-owner-'));
    scratch = root;
    const cluster = join(root, 'cluster');
    await mkdir(cluster);
    await writeFile(join(cluster, 'postmaster.pid'), '424242\n');
    const spawn = vi.fn();
    const io = await makeAdapter({ source: { clusterDataDirectory: cluster }, runtime: { spawn, fetch: vi.fn() } });

    await expect(io.acquireOwnedSqlSource({
      dumpPath: join(root, 'baseline.sql'), expectedDumpHash: SOURCE_SHA256,
      connection: { unixSocketPath: join(root, 'socket'), port: 55438, database: 'synthetic_public', user: 'readonly' },
    })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();

    const lease = { id: 'lease-returned-by-adapter', pid: 8401 };
    await expect(io.stopOwnedSqlSource(lease)).rejects.toThrow();
  });

  it('stops only the owned PostgreSQL cluster when startup fails after pg_ctl has started it but before a lease is returned', async () => {
    const { config, execCalls } = await makeConfiguration();
    const baseInspector = config.runtime.processInspector as { isAlive(pid: number): boolean; startTime(pid: number): Promise<string>; listenerPid(port: number): Promise<number | undefined> };
    const startTime = vi.fn(async (pid: number) => {
      if (pid === 8401) throw new Error('synthetic post-start ownership probe failure');
      return baseInspector.startTime(pid);
    });
    (config.runtime as { processInspector: typeof baseInspector }).processInspector = { ...baseInspector, startTime };
    const { createSqlDemoNativeLocalIo } = await import('./sql-demo-native-local-io.js');
    const io = createSqlDemoNativeLocalIo(config) as SqlDemoNativeRehearsalIo;
    const reader = config.source.reader as SqlPublicReaderOptions;

    await expect(io.acquireOwnedSqlSource(reader)).rejects.toThrow();
    expect(startTime).toHaveBeenCalledWith(8401);
    const stops = execCalls.filter(({ command, args }) => command.endsWith('/pg_ctl') && args[0] === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.args).toEqual(['stop', '-D', config.source.clusterDataDirectory, '-m', 'fast', '-w']);
  });

  it('uses a read-only psql invocation and releases the exact source process handle in reverse order', async () => {
    const io = await makeAdapter();
    const acquired = await io.acquireOwnedSqlSource({
      dumpPath: join(scratch, 'baseline.sql'), expectedDumpHash: SOURCE_SHA256,
      connection: { unixSocketPath: join(scratch, 'pg-socket'), port: 55438, database: 'synthetic_public', user: 'readonly' },
    });
    const { readSqlPublicSource } = await import('./sql-public-reader.js');
    const source = await readSqlPublicSource(acquired.reader);
    expect(source.sourceHash).toBe(`sha256:${SOURCE_SHA256}`);
    expect(acquired.lease).toMatchObject({ pid: expect.any(Number), id: expect.any(String) });
    await expect(io.stopOwnedSqlSource(acquired.lease)).resolves.toBeUndefined();
  });

  it('runs the final psql witness with a sanitized environment rather than inheriting the caller environment', async () => {
    const io = await makeAdapter();
    const config = configurations.get(io as object)!;
    const acquired = await io.acquireOwnedSqlSource(config.source.reader);
    const { readSqlPublicSource } = await import('./sql-public-reader.js');
    await readSqlPublicSource(acquired.reader);
    const key = 'IKPK_NATIVE_PRIVATE_SENTINEL';
    const prior = process.env[key];
    process.env[key] = 'must-not-reach-psql';
    try {
      await io.stopOwnedSqlSource(acquired.lease);
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    const psqlCalls = (config.runtime.execFile as ReturnType<typeof vi.fn>).mock.calls.filter((call) => String(call[0]).endsWith('/psql'));
    expect(psqlCalls).toHaveLength(2);
    const finalEnv = (psqlCalls[1]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    expect(finalEnv).toMatchObject({ LANG: process.env.LANG ?? 'C', LC_ALL: process.env.LC_ALL || process.env.LANG || 'C' });
    expect(finalEnv).not.toHaveProperty(key);
    expect(finalEnv).not.toHaveProperty('PGOPTIONS');
    expect(Object.keys(finalEnv ?? {}).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH']);
  });

  it('boots A and B with distinct required Strapi secrets and executes a fresh lockfile install from tracked source', async () => {
    const io = await makeAdapter();
    const config = configurations.get(io as object)!;
    const a = await target(io, 'A');
    const b = await target(io, 'B');
    const starts = (config.runtime.spawn as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === config.cms.nodeExecutable);
    expect(starts).toHaveLength(2);
    const environments = starts.map((call) => (call[2] as { env?: NodeJS.ProcessEnv }).env ?? {});
    for (const key of ['APP_KEYS', 'JWT_SECRET', 'ADMIN_JWT_SECRET', 'API_TOKEN_SALT', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY']) {
      expect(environments.map((env) => env[key])).toEqual(expect.arrayContaining([expect.any(String), expect.any(String)]));
      expect(environments[0]?.[key]).not.toBe(environments[1]?.[key]);
    }
    const installs = (config.runtime.execFile as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'npm' && (call[1] as readonly string[])[0] === 'ci');
    expect(installs).toHaveLength(2);
    const candidateCli = (owned: SqlDemoNativeOwnedTarget) => join(
      (starts.find((call) => (call[2] as { cwd?: string }).cwd?.includes(`target-${owned.name.toLowerCase()}-`))?.[2] as { cwd: string }).cwd,
      'node_modules', '@strapi', 'strapi', 'bin', 'strapi.js',
    );
    await expect(readFile(candidateCli(a), 'utf8')).resolves.toBe('synthetic isolated install\n');
    await expect(readFile(candidateCli(b), 'utf8')).resolves.toBe('synthetic isolated install\n');
    await (a.client as { request(method: string, path: string): Promise<unknown> }).request('GET', '/api/articles');
    await (b.client as { request(method: string, path: string): Promise<unknown> }).request('GET', '/api/articles');
    const authorizations = (config.runtime.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => new URL(String(call[0])).pathname === '/api/articles')
      .map((call) => (call[1] as RequestInit).headers as Record<string, string>);
    expect(authorizations.map((headers) => headers.authorization)).toEqual([
      'Bearer minted-strapi-token-19331', 'Bearer minted-strapi-token-19332',
    ]);
    expect(authorizations.map((headers) => headers.authorization)).not.toContain('Bearer synthetic-api-token-A');
    expect(authorizations.map((headers) => headers.authorization)).not.toContain('Bearer synthetic-api-token-B');
    for (const [, , options] of starts as [string, readonly string[], { cwd?: string } ][]) {
      await expect(readFile(join(options.cwd!, '.env'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('builds the patched candidate without secrets before using single-process Strapi start', async () => {
    const io = await makeAdapter({ cms: { cmsStartScript: 'start' } });
    const config = configurations.get(io as object)!;
    const owned = await target(io, 'A');
    const calls = (config.runtime.execFile as ReturnType<typeof vi.fn>).mock.calls;
    const installIndex = calls.findIndex((call) => call[0] === 'npm' && (call[1] as readonly string[])[0] === 'ci');
    const buildIndex = calls.findIndex((call) => call[0] === 'npm' && (call[1] as readonly string[]).join(' ') === 'run build');
    expect(buildIndex).toBeGreaterThan(installIndex);
    const build = calls[buildIndex];
    const buildEnv = (build?.[2] as { env?: NodeJS.ProcessEnv }).env ?? {};
    expect(buildEnv).toMatchObject({ NODE_ENV: 'production', STRAPI_TELEMETRY_DISABLED: 'true' });
    for (const key of ['APP_KEYS', 'JWT_SECRET', 'ADMIN_JWT_SECRET', 'API_TOKEN_SALT', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY', 'IKPK_NATIVE_API_TOKEN_FILE', 'DATABASE_FILENAME']) {
      expect(buildEnv).not.toHaveProperty(key);
    }
    const spawn = (config.runtime.spawn as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === config.cms.nodeExecutable);
    expect(spawn?.[1]).toEqual([expect.stringContaining('/node_modules/@strapi/strapi/bin/strapi.js'), 'start']);
    const startEnv = (spawn?.[2] as { env?: NodeJS.ProcessEnv }).env ?? {};
    expect(startEnv).toMatchObject({ NODE_ENV: 'production', CI: 'true', STRAPI_TELEMETRY_DISABLED: 'true' });
    expect(startEnv.IKPK_NATIVE_API_TOKEN_NAME).toMatch(/^sql-demo-native-[a-f0-9]{24}$/);
    const candidate = (spawn?.[2] as { cwd: string }).cwd;
    const bootstrap = await readFile(join(candidate, 'src', 'index.ts'), 'utf8');
    expect(bootstrap).toContain('IKPK_NATIVE_API_TOKEN_NAME');
    expect(bootstrap).not.toContain("name: 'sql-demo-native-rehearsal'");
    expect(owned.process.pid).toBeGreaterThan(0);
  });

  it('executes tracked CMS source with a verified isolated install and excludes ignored dependency and secret files', async () => {
    const io = await makeAdapter();
    const config = configurations.get(io as object)!;
    const owned = await target(io, 'A');
    const spawnCall = (config.runtime.spawn as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => call[0] === config.cms.nodeExecutable)!;
    const candidate = (spawnCall[2] as { cwd: string }).cwd;
    const install = (config.runtime.execFile as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => call[0] === 'npm' && (call[1] as readonly string[])[0] === 'ci');

    expect(install?.[2]).toMatchObject({ cwd: candidate });
    await expect(readFile(join(candidate, 'src', 'index.js'), 'utf8')).resolves.toBe('export default {};\n');
    await expect(readFile(join(candidate, 'package-lock.json'), 'utf8')).resolves.toContain('lockfileVersion');
    await expect(readFile(join(candidate, '.env'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(candidate, 'node_modules', '@strapi', 'strapi', 'bin', 'strapi.js'), 'utf8'))
      .resolves.toBe('synthetic isolated install\n');
    expect(owned.process.pid).toBeGreaterThan(0);
  });

  it('rejects traversal and symlink escapes when reading approved raster and PDF bytes', async () => {
    const io = await makeAdapter();
    const root = join(scratch, 'private-inputs');
    const allowed = join(root, 'assets');
    const outside = join(scratch, 'outside.bin');
    await mkdir(allowed, { recursive: true });
    await writeFile(outside, 'must-not-be-read');
    await symlink(outside, join(allowed, 'escape.pdf'));
    await writeFile(join(allowed, 'ok.png'), Buffer.from('approved raster bytes'));

    await expect(io.readRasterBytes(join(allowed, '..', 'outside.bin'))).rejects.toThrow();
    await expect(io.readPdfBytes(join(allowed, 'escape.pdf'))).rejects.toThrow();
    await expect(io.readRasterBytes(join(allowed, 'ok.png'))).resolves.toEqual(Buffer.from('approved raster bytes'));
  });

  it('uploads exact verified bytes with the standard multipart body, manual redirects, and durable source identity', async () => {
    const payload = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(payload);
    payload.writeUInt32BE(13, 8);
    payload.write('IHDR', 12, 'ascii');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const storedPayload = Buffer.from('CMS-optimized stored image bytes');
    const storedSha256 = createHash('sha256').update(storedPayload).digest('hex');
    const media: { id: number; url: string; name: string; mime: string; provider_metadata?: unknown }[] = [];
    const identities: { sourceUrl: string; sourceSha256?: string; expectedStoredSha256?: string }[] = [];
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (_input, init) => {
      const url = new URL(String(_input));
      if (url.pathname === '/_health') return new Response('{}', { status: 200 });
      if (url.pathname === '/api/upload/files/page') return new Response(JSON.stringify({ data: media, meta: { pagination: { page: 1, pageCount: media.length ? 1 : 0, total: media.length } } }), { status: 200 });
      const mediaIdMatch = /^\/api\/upload\/files\/(\d+)$/.exec(url.pathname);
      if (mediaIdMatch) return new Response(JSON.stringify(media.find((candidate) => candidate.id === Number(mediaIdMatch[1]))), { status: 200 });
      if (url.pathname === '/api/upload' && init?.method === 'POST') {
        const row = { id: 71 + media.length, url: `/uploads/actual-${71 + media.length}.png`, name: `actual-${71 + media.length}.png`, mime: 'image/png' };
        media.push(row);
        return new Response(JSON.stringify([row]), { status: 200 });
      }
      const identityMatch = /^\/api\/media-import-identities\/(\d+)$/.exec(url.pathname);
      if (identityMatch) {
        const body = JSON.parse(String(init?.body)) as { sourceUrl: string; sourceSha256: string; expectedStoredSha256: string };
        const row = media.find((candidate) => candidate.id === Number(identityMatch[1]))!;
        identities.push({ sourceUrl: body.sourceUrl, sourceSha256: body.sourceSha256, expectedStoredSha256: body.expectedStoredSha256 });
        const prior = (row.provider_metadata as { ikpk_media_import?: { sources?: Record<string, unknown> } } | undefined)?.ikpk_media_import?.sources ?? {};
        row.provider_metadata = { ikpk_media_import: { sources: { ...prior, [body.sourceUrl]: { version: 1, sha256: body.sourceSha256, storedSha256: body.expectedStoredSha256 } } } };
        return new Response(JSON.stringify({ data: { id: row.id, storedSha256: body.expectedStoredSha256 } }), { status: 200 });
      }
      return new Response(url.pathname.startsWith('/uploads/') ? storedPayload : payload, { status: 200 });
    });
    const io = await makeAdapter({ runtime: { fetch } });
    const owned = await target(io);
    const proof = (sourceFileId: string, sourceUrl: string) => ({
      sourceFileId, sourceUrl, archiveRelativePath: `${sourceFileId}.png`,
      resolvedLocalPath: join(scratch, 'private-inputs', 'assets', `${sourceFileId}.png`), sourceSha256: sha256,
      reachability: { kind: 'sql-header' as const },
      verification: { status: 'verified' as const, loader: 'sql-demo-asset-loader', attestationId: 'synthetic' },
      sourceFileType: 'image' as const, detectedMimeType: 'image/png' as const, detectedExtension: 'png' as const,
    } satisfies SqlDemoOfflineAssetProof);
    const firstProof = proof('f-71', '/media/legacy/logo-v2.png');
    const secondProof = proof('f-72', 'https://legacy.example/second.png');
    const inventory = await io.refreshMediaInventory(owned);
    const first = await io.uploadRaster(owned, inventory, firstProof, payload);
    const second = await io.uploadRaster(owned, inventory, secondProof, payload);
    expect(first).toMatchObject({ id: 71, url: '/uploads/actual-71.png' });
    expect(second).toMatchObject({ id: 72, url: '/uploads/actual-72.png' });
    const uploadCall = fetch.mock.calls.find(([url]) => String(url).endsWith('/api/upload'));
    expect(uploadCall).toBeDefined();
    const init = uploadCall?.[1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(Buffer.from(init.body as ArrayBuffer).includes(payload)).toBe(true);
    expect(identities).toEqual([
      { sourceUrl: firstProof.sourceUrl, sourceSha256: sha256, expectedStoredSha256: storedSha256 },
      { sourceUrl: secondProof.sourceUrl, sourceSha256: sha256, expectedStoredSha256: storedSha256 },
    ]);
    expect(fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/upload/files/page')).toHaveLength(1);
    const repeatedInventory = await io.refreshMediaInventory(owned);
    expect(fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/upload/files/page')).toHaveLength(2);
    expect(await io.uploadRaster(owned, repeatedInventory, firstProof, payload)).toEqual(first);
    expect(await io.uploadRaster(owned, repeatedInventory, secondProof, payload)).toEqual(second);
  });

  it('independently reads stored bytes without following cross-origin redirects', async () => {
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) =>
      new URL(String(input)).pathname === '/_health'
        ? new Response('{}', { status: 200 })
        : new URL(String(input)).pathname === '/api/upload/files/71'
          ? new Response(JSON.stringify({ id: 71, url: '/uploads/secret.png' }), { status: 200 })
          : new Response(null, { status: 302, headers: { location: 'https://outside.example/secret' } }));
    const io = await makeAdapter({ runtime: { fetch } });
    await expect(io.readStoredMediaBytes(await target(io), 71)).rejects.toThrow();
    const mediaRead = fetch.mock.calls.find(([input]) => new URL(String(input)).pathname === '/uploads/secret.png');
    expect(mediaRead?.[1]).toMatchObject({ redirect: 'manual' });
    expect(String(mediaRead?.[0])).toContain('127.0.0.1');
  });

  it('reads every populated published collection page and fails instead of treating empty fixtures as proof', async () => {
    const rows = Object.fromEntries(collections.map((name) => [name, [{ id: 1, documentId: `doc-${name}`, legacy_id: `${name}-1`, publishedAt: '2026-01-01T00:00:00.000Z' }]]));
    rows.articles.push({ id: 2, documentId: 'doc-articles-2', legacy_id: 'articles-2', publishedAt: '2026-01-02T00:00:00.000Z' });
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/upload/files/page')) {
        return new Response(JSON.stringify({ data: [], meta: { pagination: { page: 1, pageCount: 0, total: 0 } } }), { status: 200 });
      }
      const collection = url.pathname.replace('/api/', '') as SqlDemoNativeCollection;
      const allRows = rows[collection] ?? [];
      const pageCount = collection === 'articles' ? 2 : 1;
      const page = Number(url.searchParams.get('pagination[page]') ?? 1);
      const pageRows = collection === 'articles' ? allRows.slice(page - 1, page) : allRows;
      return new Response(JSON.stringify({ data: pageRows, meta: { pagination: { page, pageCount, total: allRows.length } } }), { status: 200 });
    });
    const io = await makeAdapter({ runtime: { fetch } });
    const readback = await io.readPublished(await target(io));
    expect(Object.keys(readback.collections).sort()).toEqual([...collections].sort());
    expect(Object.values(readback.collections).every((records) => records?.length >= 1)).toBe(true);
    expect(readback.collections.articles).toHaveLength(2);
    expect(readback.collections.articles?.every(({ publishedAt }) => publishedAt)).toBe(true);
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(collections.length);
    for (const [input] of fetch.mock.calls) {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/api/') && !url.pathname.endsWith('/api/upload/files/page')) expect(url.search).toContain('populate');
    }
  });

  it('reads every draft collection page separately so a media-only resume cannot hide draft rows', async () => {
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/_health') return new Response('{}', { status: 200 });
      if (url.pathname.endsWith('/api/upload/files/page')) {
        return new Response(JSON.stringify({ data: [], meta: { pagination: { page: 1, pageCount: 0, total: 0 } } }), { status: 200 });
      }
      const collection = url.pathname.replace('/api/', '');
      const rows = url.searchParams.get('status') === 'draft' && collection === 'articles'
        ? [{ id: 9, documentId: 'draft-article', legacy_id: 'articles-1', slug: 'article-1' }]
        : [];
      return new Response(JSON.stringify({ data: rows, meta: { pagination: { page: 1, pageCount: rows.length ? 1 : 0, total: rows.length } } }), { status: 200 });
    });
    const io = await makeAdapter({ runtime: { fetch } });
    const identities = await io.readDraftContentIdentities(await target(io));
    expect(identities.articles).toEqual([{ legacyId: 'articles-1', documentId: 'draft-article', slug: 'article-1' }]);
    expect(Object.entries(identities).filter(([, rows]) => rows.length > 0)).toEqual([['articles', [{ legacyId: 'articles-1', documentId: 'draft-article', slug: 'article-1' }]]]);
    const requests = fetch.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname.startsWith('/api/'));
    expect(requests).toHaveLength(collections.length);
    expect(requests.every((url) => url.searchParams.get('status') === 'draft')).toBe(true);
  });

  it('accepts only the exact persisted raster source set and verifies source and stored hashes independently', async () => {
    const sourceUrl = 'media/2024/03/08/approved-source.png';
    const storedBytes = Buffer.from('CMS-reencoded raster bytes');
    const sourceSha256 = createHash('sha256').update('approved source bytes').digest('hex');
    const storedSha256 = createHash('sha256').update(storedBytes).digest('hex');
    const file = {
      id: 71, url: '/uploads/actual-71.png', mime: 'image/png',
      formats: { thumbnail: { url: '/uploads/thumbnail-71.png' } },
      provider_metadata: { ikpk_media_import: { sources: { [sourceUrl]: { version: 1, sha256: sourceSha256, storedSha256 } } } },
    };
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/_health') return new Response('{}', { status: 200 });
      if (url.pathname.endsWith('/api/upload/files/page')) return new Response(JSON.stringify({ data: [file], meta: { pagination: { page: 1, pageCount: 1, total: 1 } } }), { status: 200 });
      return new Response(storedBytes, { status: 200 });
    });
    const { config } = await makeConfiguration({ runtime: { fetch } });
    (config.targets.A as typeof config.targets.A & { resumeExistingMediaOnly?: boolean }).resumeExistingMediaOnly = true;
    delete (config.targets as { B?: unknown }).B;
    for (const directory of [config.targets.A.dataDirectory, config.targets.A.uploadDirectory, config.targets.A.staticFilesDirectory]) await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(config.targets.A.dataDirectory, 'data.db'), 'synthetic preserved prototype database', { mode: 0o600 });
    await writeFile(join(config.targets.A.uploadDirectory, 'actual-71.png'), storedBytes, { mode: 0o600 });
    await writeFile(join(config.targets.A.uploadDirectory, 'thumbnail-71.png'), 'approved CMS-generated thumbnail', { mode: 0o600 });
    const { createSqlDemoNativeLocalIo } = await import('./sql-demo-native-local-io.js');
    const io = createSqlDemoNativeLocalIo(config) as SqlDemoNativeRehearsalIo;
    configurations.set(io as object, config);
    const owned = await target(io);
    const proof = {
      sourceFileId: '71', sourceUrl, archiveRelativePath: '71.png', resolvedLocalPath: join(scratch, 'private-inputs', '71.png'),
      sourceSha256, reachability: { kind: 'sql-header' as const },
      verification: { status: 'verified' as const, loader: 'sql-demo-asset-loader', attestationId: 'synthetic' },
      sourceFileType: 'image' as const, detectedMimeType: 'image/png' as const, detectedExtension: 'png' as const,
    } satisfies SqlDemoOfflineAssetProof;
    const inventory = await io.prepareResumeMediaInventory(owned, [proof]);
    expect(inventory).toMatchObject({ mediaById: expect.any(Map), storedHashById: expect.any(Map) });
    expect(storedSha256).not.toBe(sourceSha256);
    await expect(io.prepareResumeMediaInventory(owned, [proof, { ...proof, sourceFileId: '72', sourceUrl: 'media/2024/03/08/extra.png' }])).rejects.toThrow();
    await writeFile(join(config.targets.A.uploadDirectory, 'unexpected.png'), 'extra bytes', { mode: 0o600 });
    await expect(io.prepareResumeMediaInventory(owned, [proof])).rejects.toThrow();
    await rm(join(config.targets.A.uploadDirectory, 'unexpected.png'));

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [file], meta: { pagination: { page: 1, pageCount: 1, total: 1 } } }), { status: 200 }));
    fetch.mockRejectedValueOnce(Object.assign(new TypeError('private transport detail'), {
      cause: Object.assign(new Error('private nested detail'), { code: 'ECONNRESET' }),
    }));
    const sampleFailure = await io.prepareResumeMediaInventory(owned, [proof]).catch((error: unknown) => error);
    expect(sampleFailure).toMatchObject({ name: 'NativeCmsStoredMediaSampleFetchError', safeNetworkCode: 'ECONNRESET' });
    expect(JSON.stringify(sampleFailure)).not.toContain('private');

    await writeFile(join(config.targets.A.uploadDirectory, 'actual-71.png'), 'unapproved stored bytes', { mode: 0o600 });
    await expect(io.prepareResumeMediaInventory(owned, [proof])).rejects.toThrow();
    await rm(join(config.targets.A.uploadDirectory, 'actual-71.png'));
    await symlink(join(scratch, 'private-inputs', '71.png'), join(config.targets.A.uploadDirectory, 'actual-71.png'));
    await expect(io.prepareResumeMediaInventory(owned, [proof])).rejects.toThrow();
    await rm(join(config.targets.A.uploadDirectory, 'actual-71.png'));
    file.url = '/uploads/%2e%2e%2foutside.png';
    await expect(io.prepareResumeMediaInventory(owned, [proof])).rejects.toThrow();
  });

  it('resumes static documents only when the complete path set and bytes match approved proofs', async () => {
    const { config } = await makeConfiguration();
    (config.targets.A as typeof config.targets.A & { resumeExistingMediaOnly?: boolean }).resumeExistingMediaOnly = true;
    delete (config.targets as { B?: unknown }).B;
    await mkdir(config.targets.A.staticFilesDirectory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from('%PDF-1.7\napproved document\n%%EOF\n');
    const relativePath = 'documents/approved-sha.pdf';
    await mkdir(join(config.targets.A.staticFilesDirectory, 'documents'), { recursive: true, mode: 0o700 });
    await writeFile(join(config.targets.A.staticFilesDirectory, relativePath), bytes, { mode: 0o600 });
    const { createSqlDemoNativeLocalIo } = await import('./sql-demo-native-local-io.js');
    const io = createSqlDemoNativeLocalIo(config) as SqlDemoNativeRehearsalIo;
    configurations.set(io as object, config);

    await expect(io.verifyExistingStaticDocuments([{ publicPath: `/static-files/${relativePath}`, bytes }])).resolves.toBeUndefined();
    await expect(io.verifyExistingStaticDocuments([{ publicPath: `/static-files/${relativePath}`, bytes: Buffer.from('%PDF-wrong') }])).rejects.toThrow();
    await writeFile(join(config.targets.A.staticFilesDirectory, 'unexpected.pdf'), bytes, { mode: 0o600 });
    await expect(io.verifyExistingStaticDocuments([{ publicPath: `/static-files/${relativePath}`, bytes }])).rejects.toThrow();
  });

  it('captures only private hashed release and conservation witnesses, never token or SQL row content', async () => {
    const marker = 'synthetic-private-row-must-not-escape';
    const storedBytes = Buffer.from('synthetic stored media bytes');
    const storedSha256 = createHash('sha256').update(storedBytes).digest('hex');
    const rows = Object.fromEntries(collections.map((name) => [name, [{ id: 1, documentId: `doc-${name}`, legacy_id: `${name}-1`, publishedAt: '2026-01-01T00:00:00.000Z', body: marker }]]));
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/upload/files/page')) return new Response(JSON.stringify({ data: [{ id: 71, url: '/uploads/evidence.png' }], meta: { pagination: { page: 1, pageCount: 1, total: 1 } } }), { status: 200 });
      if (url.pathname.endsWith('/uploads/evidence.png')) return new Response(storedBytes, { status: 200 });
      const collection = url.pathname.replace('/api/', '') as SqlDemoNativeCollection;
      const collectionRows = rows[collection];
      return new Response(JSON.stringify({ data: collectionRows ?? [], meta: { pagination: { page: 1, pageCount: 1, total: collectionRows?.length ?? 0 } } }), { status: 200 });
    });
    const io = await makeAdapter({ runtime: { fetch } });
    await expect(io.resolveCmsToken()).resolves.toBe(SECRET);
    const a = await target(io);
    const b = await target(io, 'B');
    const source = await io.acquireOwnedSqlSource(configurations.get(io as object)!.source.reader);
    const { readSqlPublicSource } = await import('./sql-public-reader.js');
    await readSqlPublicSource(source.reader);
    await io.readPublished(a);
    await io.readPublished(b);
    await io.stopOwnedTarget(a);
    await io.stopOwnedTarget(b);
    await io.stopOwnedSqlSource(source.lease);
    await io.capture([a, b]);
    const files = await (await import('node:fs/promises')).readdir(join(scratch, 'private-artifacts'), { recursive: true, withFileTypes: true });
    expect(files.length).toBeGreaterThan(0);
    const material = await Promise.all(files.filter((file) => file.isFile()).map(async (file) =>
      readFile(join(file.parentPath, file.name), 'utf8')));
    const artifactText = material.join('\n');
    expect(artifactText).not.toContain(SECRET);
    expect(artifactText).not.toContain(marker);
    expect(artifactText).toMatch(/[a-f0-9]{64}/);
    expect(artifactText).toContain('articles-1');
    expect(artifactText).toContain('doc-articles');
    expect(artifactText).toContain(storedSha256);
    expect(artifactText).not.toMatch(/password|token|authorization|SELECT\s+\*/i);
  });
});
