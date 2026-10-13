import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
};

let scratch: string;

async function makeConfiguration(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ikpk-native-local-io-'));
  scratch = root;
  const sourceRoot = join(root, 'pinned-cms');
  const candidateRoot = join(root, 'private-candidates');
  const artifactsRoot = join(root, 'private-artifacts');
  const sourceCluster = join(root, 'stopped-postgres-cluster');
  const sqlPath = join(root, 'baseline.sql');
  const spawn = vi.fn<(...args: [string, readonly string[], Record<string, unknown>?]) => ChildLike>(() => ({
    pid: 8101,
    once: vi.fn(), on: vi.fn(), kill: vi.fn(),
    stdout: { on: vi.fn() }, stderr: { on: vi.fn() },
  } satisfies ChildLike));
  const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }));
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });
  await mkdir(sourceCluster, { recursive: true });
  await writeFile(sqlPath, SOURCE_BYTES);
  await writeFile(join(sourceRoot, 'package.json'), '{"name":"synthetic-pinned-cms"}');

  const reader: SqlPublicReaderOptions = {
    dumpPath: sqlPath,
    expectedDumpHash: SOURCE_SHA256,
    connection: { unixSocketPath: join(root, 'pg-socket'), port: 55438, database: 'synthetic_public', user: 'readonly' },
  };
  const defaultTargets = {
    A: { baseUrl: 'http://127.0.0.1:19331', namespace: 'ikpk_sql_demo_native_a', dataDirectory: join(root, 'a-db'), uploadDirectory: join(root, 'a-uploads'), staticFilesDirectory: join(root, 'a-static') },
    B: { baseUrl: 'http://127.0.0.1:19332', namespace: 'ikpk_sql_demo_native_b', dataDirectory: join(root, 'b-db'), uploadDirectory: join(root, 'b-uploads'), staticFilesDirectory: join(root, 'b-static') },
  };
  const config = {
    ...overrides,
    source: { reader, clusterDataDirectory: sourceCluster, postgresBinDirectory: join(root, 'postgres-bin'), socketDirectory: join(root, 'pg-socket'), port: 55438, database: 'synthetic_public', user: 'readonly', ...(overrides.source as object ?? {}) },
    cms: { sourceDirectory: sourceRoot, expectedCommit: 'a'.repeat(40), candidateRoot, nodeExecutable: process.execPath, cmsStartScript: 'develop', ...(overrides.cms as object ?? {}) },
    targets: { ...defaultTargets, ...(overrides.targets as object ?? {}) },
    privateArtifactsRoot: overrides.privateArtifactsRoot ?? artifactsRoot,
    privateInputsRoot: overrides.privateInputsRoot ?? join(root, 'private-inputs'),
    resolveToken: overrides.resolveToken ?? vi.fn(async () => SECRET),
    runtime: { spawn, fetch, ...(overrides.runtime as object ?? {}) },
  };
  return { config, root };
}

async function makeAdapter(overrides: Record<string, unknown> = {}): Promise<SqlDemoNativeRehearsalIo> {
  const { config } = await makeConfiguration(overrides);
  const { createSqlDemoNativeLocalIo } = await import('./sql-demo-native-local-io.js');
  return createSqlDemoNativeLocalIo(config) as SqlDemoNativeRehearsalIo;
}

function target(name: 'A' | 'B' = 'A', overrides: Partial<SqlDemoNativeOwnedTarget> = {}): SqlDemoNativeOwnedTarget {
  const isA = name === 'A';
  const endpoint = isA ? 'http://127.0.0.1:19331' : 'http://127.0.0.1:19332';
  const namespace = isA ? 'ikpk_sql_demo_native_a' : 'ikpk_sql_demo_native_b';
  const directory = isA ? 'a' : 'b';
  return {
    name,
    baseUrl: endpoint,
    namespace,
    dataDirectory: join(scratch, `${directory}-db`),
    uploadDirectory: join(scratch, `${directory}-uploads`),
    client: { request: vi.fn() },
    process: {
      pid: isA ? 8301 : 8302,
      endpoint,
      namespace,
      dataDirectory: join(scratch, `${directory}-db`),
      uploadDirectory: join(scratch, `${directory}-uploads`),
    },
    ...overrides,
  };
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
  });

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

  it('uses a read-only psql invocation and releases the exact source process handle in reverse order', async () => {
    const io = await makeAdapter();
    const acquired = await io.acquireOwnedSqlSource({
      dumpPath: join(scratch, 'baseline.sql'), expectedDumpHash: SOURCE_SHA256,
      connection: { unixSocketPath: join(scratch, 'pg-socket'), port: 55438, database: 'synthetic_public', user: 'readonly' },
    });
    const output = await acquired.reader.runPsql?.({
      command: 'psql', args: ['-X', '-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY; SELECT 1; COMMIT;'],
      connection: acquired.reader.connection,
    });
    expect(output).toEqual(expect.any(String));
    expect(acquired.lease).toMatchObject({ pid: expect.any(Number), id: expect.any(String) });
    await expect(io.stopOwnedSqlSource(acquired.lease)).resolves.toBeUndefined();
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
    const payload = Buffer.from([0, 1, 2, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (_input, init) => {
      if (String(_input).endsWith('/api/upload')) return new Response(JSON.stringify([{ id: 71, url: '/uploads/actual-71.png' }]), { status: 200 });
      if (String(_input).endsWith('/api/media-import-identities/71')) {
        const body = JSON.parse(String(init?.body)) as { sourceSha256?: string };
        return new Response(JSON.stringify({ data: { id: 71, storedSha256: body.sourceSha256 ?? sha256 } }), { status: 200 });
      }
      return new Response(payload, { status: 200 });
    });
    const io = await makeAdapter({ runtime: { spawn: vi.fn(), fetch } });
    const owned = target();
    const proof = {
      sourceFileId: 'f-71', sourceUrl: 'https://legacy.example/public.png', archiveRelativePath: 'f-71.png',
      resolvedLocalPath: join(scratch, 'private-inputs', 'assets', 'f-71.png'), sourceSha256: sha256,
      reachability: { kind: 'sql-header' as const },
      verification: { status: 'verified' as const, loader: 'sql-demo-asset-loader', attestationId: 'synthetic' },
      sourceFileType: 'image' as const, detectedMimeType: 'image/png' as const, detectedExtension: 'png' as const,
    } satisfies SqlDemoOfflineAssetProof;
    const inventory = await io.refreshMediaInventory(owned);
    const uploaded = await io.uploadRaster(owned, inventory, proof, payload);
    expect(uploaded).toMatchObject({ id: 71, url: '/uploads/actual-71.png' });
    const uploadCall = fetch.mock.calls.find(([url]) => String(url).endsWith('/api/upload'));
    expect(uploadCall).toBeDefined();
    const init = uploadCall?.[1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(Buffer.from(init.body as ArrayBuffer).includes(payload)).toBe(true);
    const identityCall = fetch.mock.calls.find(([url]) => String(url).endsWith('/api/media-import-identities/71'));
    expect(identityCall).toBeDefined();
    expect(JSON.parse(String(identityCall?.[1]?.body))).toMatchObject({ sourceUrl: proof.sourceUrl, sourceSha256: sha256 });
  });

  it('independently reads stored bytes without following cross-origin redirects', async () => {
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 302, headers: { location: 'https://outside.example/secret' } }));
    const io = await makeAdapter({ runtime: { spawn: vi.fn(), fetch } });
    await expect(io.readStoredMediaBytes(target(), 71)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(String(fetch.mock.calls[0]?.[0])).toContain('127.0.0.1');
  });

  it('reads every populated published collection page and fails instead of treating empty fixtures as proof', async () => {
    const rows = Object.fromEntries(collections.map((name) => [name, [{ id: 1, documentId: `doc-${name}`, legacy_id: `${name}-1`, publishedAt: '2026-01-01T00:00:00.000Z' }]]));
    rows.articles.push({ id: 2, documentId: 'doc-articles-2', legacy_id: 'articles-2', publishedAt: '2026-01-02T00:00:00.000Z' });
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/upload/files')) {
        return new Response(JSON.stringify({ data: [], meta: { pagination: { page: 1, pageCount: 0, total: 0 } } }), { status: 200 });
      }
      const collection = url.pathname.replace('/api/', '') as SqlDemoNativeCollection;
      const allRows = rows[collection] ?? [];
      const pageCount = collection === 'articles' ? 2 : 1;
      const page = Number(url.searchParams.get('pagination[page]') ?? 1);
      const pageRows = collection === 'articles' ? allRows.slice(page - 1, page) : allRows;
      return new Response(JSON.stringify({ data: pageRows, meta: { pagination: { page, pageCount, total: allRows.length } } }), { status: 200 });
    });
    const io = await makeAdapter({ runtime: { spawn: vi.fn(), fetch } });
    const readback = await io.readPublished(target());
    expect(Object.keys(readback.collections).sort()).toEqual([...collections].sort());
    expect(Object.values(readback.collections).every((records) => records?.length >= 1)).toBe(true);
    expect(readback.collections.articles).toHaveLength(2);
    expect(readback.collections.articles?.every(({ publishedAt }) => publishedAt)).toBe(true);
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(collections.length);
    for (const [input] of fetch.mock.calls) {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/api/') && !url.pathname.endsWith('/api/upload/files')) expect(url.search).toContain('populate');
    }
  });

  it('captures only private hashed release and conservation witnesses, never token or SQL row content', async () => {
    const marker = 'synthetic-private-row-must-not-escape';
    const storedBytes = Buffer.from('synthetic stored media bytes');
    const storedSha256 = createHash('sha256').update(storedBytes).digest('hex');
    const rows = Object.fromEntries(collections.map((name) => [name, [{ id: 1, documentId: `doc-${name}`, legacy_id: `${name}-1`, publishedAt: '2026-01-01T00:00:00.000Z', body: marker }]]));
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/upload/files')) return new Response(JSON.stringify({ data: [{ id: 71, url: '/uploads/evidence.png' }], meta: { pagination: { page: 1, pageCount: 1, total: 1 } } }), { status: 200 });
      if (url.pathname.endsWith('/uploads/evidence.png')) return new Response(storedBytes, { status: 200 });
      const collection = url.pathname.replace('/api/', '') as SqlDemoNativeCollection;
      const collectionRows = rows[collection];
      return new Response(JSON.stringify({ data: collectionRows ?? [], meta: { pagination: { page: 1, pageCount: 1, total: collectionRows?.length ?? 0 } } }), { status: 200 });
    });
    const io = await makeAdapter({ runtime: { fetch } });
    await expect(io.resolveCmsToken()).resolves.toBe(SECRET);
    const a = target();
    const b = target('B');
    await io.readPublished(a);
    await io.readPublished(b);
    await io.capture([a, b]);
    const files = await (await import('node:fs/promises')).readdir(join(scratch, 'private-artifacts'), { recursive: true });
    expect(files.length).toBeGreaterThan(0);
    const material = await Promise.all(files.filter((file) => typeof file === 'string').map(async (file) =>
      readFile(join(scratch, 'private-artifacts', file), 'utf8')));
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
