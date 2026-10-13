import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(finalEnv).toMatchObject({ PGOPTIONS: '-c default_transaction_read_only=on' });
    expect(finalEnv).not.toHaveProperty(key);
    expect(Object.keys(finalEnv ?? {}).sort()).toEqual(['HOME', 'PATH', 'PGOPTIONS']);
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
    const media: { id: number; url: string; name: string; mime: string; provider_metadata?: unknown }[] = [];
    const identities: { sourceUrl: string; sourceSha256?: string }[] = [];
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (_input, init) => {
      const url = new URL(String(_input));
      if (url.pathname === '/_health') return new Response('{}', { status: 200 });
      if (url.pathname === '/api/upload/files/page') return new Response(JSON.stringify({ data: media, meta: { pagination: { page: 1, pageCount: media.length ? 1 : 0, total: media.length } } }), { status: 200 });
      if (url.pathname === '/api/upload' && init?.method === 'POST') {
        const row = { id: 71 + media.length, url: `/uploads/actual-${71 + media.length}.png`, name: `actual-${71 + media.length}.png`, mime: 'image/png' };
        media.push(row);
        return new Response(JSON.stringify([row]), { status: 200 });
      }
      const identityMatch = /^\/api\/media-import-identities\/(\d+)$/.exec(url.pathname);
      if (identityMatch) {
        const body = JSON.parse(String(init?.body)) as { sourceUrl: string; sourceSha256: string };
        const row = media.find((candidate) => candidate.id === Number(identityMatch[1]))!;
        identities.push({ sourceUrl: body.sourceUrl, sourceSha256: body.sourceSha256 });
        const prior = (row.provider_metadata as { ikpk_media_import?: { sources?: Record<string, unknown> } } | undefined)?.ikpk_media_import?.sources ?? {};
        row.provider_metadata = { ikpk_media_import: { sources: { ...prior, [body.sourceUrl]: { version: 1, sha256: body.sourceSha256, storedSha256: sha256 } } } };
        return new Response(JSON.stringify({ data: { id: row.id, storedSha256: sha256 } }), { status: 200 });
      }
      return new Response(payload, { status: 200 });
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
    const firstProof = proof('f-71', 'https://legacy.example/first.png');
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
      { sourceUrl: firstProof.sourceUrl, sourceSha256: sha256 },
      { sourceUrl: secondProof.sourceUrl, sourceSha256: sha256 },
    ]);
    const repeatedInventory = await io.refreshMediaInventory(owned);
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
