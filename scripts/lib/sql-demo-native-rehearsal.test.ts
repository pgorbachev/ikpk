import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { loadSqlDemoAssets } from './sql-demo-assets.js';
import type { SqlDemoStrapi5Readback } from './sql-demo-native-conservation.js';
import type { SqlPublicReaderOptions } from './sql-public-reader.js';
import type { SqlDemoRelease } from './sql-demo-release.js';
import type { SqlMaterializerOptions } from './sql-public-materializer.js';

const DUMP_BYTES = Buffer.from('synthetic immutable SQL dump');
const SOURCE_SHA = createHash('sha256').update(DUMP_BYTES).digest('hex');
const STORED_SHA = 'b'.repeat(64);
const TARGET_URL = 'http://127.0.0.1:1337';
const TARGET_NAMESPACE = 'ikpk_sql_demo_native_red';

type TargetName = 'A' | 'B';
type OwnedTarget = {
  name: TargetName;
  baseUrl: string;
  namespace: string;
  client: unknown;
  process: { pid: number; endpoint: string; namespace: string };
};
type UploadedRaster = { id: number; url: string };

/** Test-only API contract for the thin native runner. Pure stages stay default-wired in production. */
type SqlDemoNativeRehearsalIo = {
  resolveCmsToken(): Promise<string>;
  openOwnedTarget(input: { name: TargetName; baseUrl: string; namespace: string; token: string }): Promise<OwnedTarget>;
  refreshMediaInventory(target: OwnedTarget): Promise<unknown>;
  uploadRaster(target: OwnedTarget, inventory: unknown, sourceFileId: string, sourceSha256: string): Promise<UploadedRaster>;
  readStoredMediaBytes(target: OwnedTarget, mediaId: number): Promise<Uint8Array>;
  readPdfBytes(path: string): Promise<Uint8Array>;
  writeStaticDocument(target: OwnedTarget, publicPath: string, bytes: Uint8Array): Promise<void>;
  createFreshClient(target: OwnedTarget): Promise<OwnedTarget>;
  readPublished(target: OwnedTarget): Promise<SqlDemoStrapi5Readback>;
  capture(targets: readonly OwnedTarget[]): Promise<void>;
  stopOwnedSqlSource(): Promise<void>;
};

type RehearsalInput = {
  reader: SqlPublicReaderOptions;
  privateInputConfig: unknown;
  target: { baseUrl: string; namespace: string };
  io: SqlDemoNativeRehearsalIo;
};

async function run(input: RehearsalInput): Promise<unknown> {
  const { runSqlDemoNativeRehearsal } = await import('./sql-demo-native-rehearsal.js');
  return runSqlDemoNativeRehearsal(input as never);
}

const emptyNativeSource = Object.fromEntries([
  'Articles', 'Cities', 'Events', 'EventsAndTeachers', 'FileBindingOrganizationInfo', 'Files',
  'InstituteAdditionalInfo', 'Institutes', 'News', 'OrganizationInfo', 'Programs', 'Promotions',
  'Seminars', 'SeminarsTeacher', 'Teachers', 'TeachersAndInstitutes', 'Videos',
].map((name) => [name, []]));

const emptyMapped = {
  entities: {
    institutes: [], programs: [], seminars: [], teachers: [], events: [], articles: [], news: [],
    promotions: [], videos: [], organizationInfo: [], documents: [], instituteAdditionalInfo: [],
  },
  provenance: {
    sourceHash: `sha256:${SOURCE_SHA}`, sourceIdentity: [], videoMetadata: [], exclusions: [],
    rejectedRelations: [], classificationCandidates: [], sourceMetadata: [],
  },
};

const emptyRelease = {
  entities: {
    institutes: [], programs: [], seminars: [], teachers: [], events: [], articles: [], news: [],
    promotions: [], videos: [], organizationInfo: [], documents: [], instituteAdditionalInfo: [],
    pages: [],
  },
  provenance: {
    sourceHash: `sha256:${SOURCE_SHA}`, sourceIdentity: [], videoMetadata: [], exclusions: [],
    rejectedRelations: [], classificationCandidates: [], sourceMetadata: [], assetMappings: [],
    supplements: [], targetLocations: [], videoSupplements: [],
    ownerDecisions: { approvedUnlinkedArticleImages: [], videoReferences: [] },
  },
} as unknown as SqlDemoRelease;

const emptyClassification: SqlMaterializerOptions['classification'] = {
  status: 'pending-confirmation', teachers: [], articles: [],
};

const emptyReadback = (): SqlDemoStrapi5Readback => ({
  collections: {
    institutes: [], 'course-groups': [], teachers: [], seminars: [], 'schedule-entries': [],
    articles: [], 'news-items': [], promotions: [], 'video-playlists': [], pages: [],
  },
  media: [],
});

function options(overrides: Partial<RehearsalInput> = {}): RehearsalInput {
  const io: SqlDemoNativeRehearsalIo = {
    resolveCmsToken: vi.fn(async () => 'SYNTHETIC-TOKEN'),
    openOwnedTarget: vi.fn(async ({ name, baseUrl, namespace }) => ({
      name, baseUrl, namespace, client: { name },
      process: { pid: name === 'A' ? 4101 : 4102, endpoint: baseUrl, namespace },
    })),
    refreshMediaInventory: vi.fn(async () => []),
    uploadRaster: vi.fn(async () => ({ id: 71, url: '/uploads/actual-upload-71.webp' })),
    readStoredMediaBytes: vi.fn(async () => Buffer.from('synthetic stored bytes')),
    readPdfBytes: vi.fn(async () => Buffer.from('%PDF-1.7\nsynthetic document\n%%EOF\n')),
    writeStaticDocument: vi.fn(async () => undefined),
    createFreshClient: vi.fn(async (target) => ({ ...target, client: { name: target.name, fresh: true } })),
    readPublished: vi.fn(async () => emptyReadback()),
    capture: vi.fn(async () => undefined),
    stopOwnedSqlSource: vi.fn(async () => undefined),
  };
  const reader: SqlPublicReaderOptions = {
    dumpPath: '/synthetic/baseline.sql',
    expectedDumpHash: SOURCE_SHA,
    connection: { unixSocketPath: '/synthetic/postgres', port: 55432, database: 'ikpk_native_baseline', user: 'readonly' },
    runPsql: vi.fn(async () => JSON.stringify(emptyNativeSource)),
  };
  return {
    reader,
    privateInputConfig: {} as never,
    target: { baseUrl: TARGET_URL, namespace: TARGET_NAMESPACE },
    io,
    ...overrides,
  };
}

describe('native SQL DEMO193 rehearsal orchestration', () => {
  let dumpDirectory: string;
  let dumpPath: string;
  let originalVips: string;

  beforeEach(async () => {
    originalVips = sharp.versions.vips;
    dumpDirectory = await mkdtemp(join(tmpdir(), 'ikpk-native-rehearsal-'));
    dumpPath = join(dumpDirectory, 'baseline.sql');
    await writeFile(dumpPath, DUMP_BYTES);
    vi.spyOn(await import('./sql-public-content.js'), 'mapSqlPublicContent').mockReturnValue(emptyMapped as never);
    vi.spyOn(await import('./sql-demo-private-inputs.js'), 'normalizeSqlDemoPrivateInputs').mockReturnValue({
      mapperOptions: { expectedSourceHash: `sha256:${SOURCE_SHA}`, acceptedLegacyIds: {} },
      loader: {} as never, composer: {} as never, materializer: emptyClassification,
    } as never);
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValue({
      offlineMedia: [], offlineDocuments: [], supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.spyOn(await import('./sql-demo-release.js'), 'composeSqlDemoRelease').mockReturnValue(emptyRelease);
    vi.spyOn(await import('./sql-public-materializer.js'), 'materializeSqlPublicContent').mockResolvedValue(undefined as never);
    sharp.versions.vips = '8.18.2';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    sharp.versions.vips = originalVips;
    await rm(dumpDirectory, { recursive: true, force: true });
  });

  it('refuses a non-loopback or non-owned target before credentials, SQL access, or CMS writes', async () => {
    const input = options({ target: { baseUrl: 'http://193.124.115.99/api', namespace: 'production' } });
    await expect(run(input)).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(input.io.resolveCmsToken).not.toHaveBeenCalled();
    expect(input.reader.runPsql).not.toHaveBeenCalled();
    expect(input.io.openOwnedTarget).not.toHaveBeenCalled();
    expect(input.io.stopOwnedSqlSource).not.toHaveBeenCalled();
  });

  it('uses the native hashed read-only SQL reader and always stops the owned source', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const runPsql = vi.fn(async (invocation: { args: readonly string[] }) => {
      expect(invocation.args.join(' ')).toContain('BEGIN READ ONLY');
      return JSON.stringify(emptyNativeSource);
    });
    input.reader = { ...input.reader, dumpPath, runPsql };
    await run(input);
    expect(runPsql).toHaveBeenCalledTimes(1);
    expect(await readFile(dumpPath)).toEqual(DUMP_BYTES);
    expect(input.io.stopOwnedSqlSource).toHaveBeenCalledTimes(1);
  });

  it('stops the owned source in finally when mapping fails and preserves the pinned dump', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    vi.spyOn(await import('./sql-public-content.js'), 'mapSqlPublicContent').mockImplementationOnce(() => {
      throw new Error('synthetic mapper failure');
    });
    await expect(run(input)).rejects.toMatchObject({ code: 'MAPPING_FAILED' });
    expect(input.io.stopOwnedSqlSource).toHaveBeenCalledTimes(1);
    expect(await readFile(dumpPath)).toEqual(DUMP_BYTES);
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('checks the loaded Sharp/libvips floor before loading or decoding any raster', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    sharp.versions.vips = '8.18.1';
    await expect(run(input)).rejects.toMatchObject({ code: 'RASTER_RUNTIME_UNSAFE' });
    expect(loadSqlDemoAssets).not.toHaveBeenCalled();
    expect(input.io.uploadRaster).not.toHaveBeenCalled();
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('refreshes inventory and binds only the upload response ID, public URL, and independently hashed stored bytes', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const expectedSource = 'c'.repeat(64);
    const storedBytes = Buffer.from('synthetic transformed stored bytes');
    const storedHash = createHash('sha256').update(storedBytes).digest('hex');
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [{ sourceFileId: 'source-9', sourceUrl: '/sql/source-9.png', sourceSha256: expectedSource }],
      offlineDocuments: [], supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.refreshMediaInventory).mockResolvedValueOnce({ files: [] });
    vi.mocked(input.io.uploadRaster).mockResolvedValueOnce({ id: 91, url: '/uploads/normalized-91.webp' });
    vi.mocked(input.io.readStoredMediaBytes).mockResolvedValueOnce(storedBytes);
    await run(input);
    expect(input.io.refreshMediaInventory).toHaveBeenCalled();
    expect(input.io.uploadRaster).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'source-9', expectedSource);
    expect(input.io.readStoredMediaBytes).toHaveBeenCalledWith(expect.anything(), 91);
    expect(input.io.uploadRaster).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'source-9', storedHash);
  });

  it('does not guess a media URL from a source ID or accept an upload with no actual URL', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [{ sourceFileId: 'source-9', sourceUrl: '/sql/source-9.png', sourceSha256: 'c'.repeat(64) }],
      offlineDocuments: [], supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.uploadRaster).mockResolvedValueOnce({ id: 92, url: '' });
    await expect(run(input)).rejects.toMatchObject({ code: 'MEDIA_BINDING_FAILED', identity: 'Files#source-9' });
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('ships approved PDFs as verified static bytes with their pinned public path and never through raster upload', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const pdfBytes = Buffer.from('%PDF-1.7\nsynthetic approved PDF\n%%EOF\n');
    const pdfPath = 'web/public/static-files/source-501.pdf';
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [],
      offlineDocuments: [{ sourceFileId: 'pdf-501', resolvedLocalPath: pdfPath, targetPublicPath: '/static-files/source-501.pdf', sourceSha256: createHash('sha256').update(pdfBytes).digest('hex') }],
      supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.readPdfBytes).mockResolvedValueOnce(pdfBytes);
    await run(input);
    expect(input.io.writeStaticDocument).toHaveBeenCalledWith(expect.anything(), '/static-files/source-501.pdf', pdfBytes);
    expect(input.io.uploadRaster).not.toHaveBeenCalled();
  });

  it.each(['missing', 'changed'] as const)('refuses a %s approved PDF byte payload before publish or capture', async (mode) => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const bytes = Buffer.from('%PDF-1.7\nsynthetic expected\n%%EOF\n');
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [], offlineDocuments: [{ sourceFileId: 'pdf-88', resolvedLocalPath: 'supplements/88.pdf', sourceSha256: createHash('sha256').update(bytes).digest('hex') }],
      supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    if (mode === 'missing') vi.mocked(input.io.readPdfBytes).mockRejectedValueOnce(new Error('missing synthetic PDF'));
    else vi.mocked(input.io.readPdfBytes).mockResolvedValueOnce(Buffer.from('%PDF-1.7\nchanged\n%%EOF\n'));
    await expect(run(input)).rejects.toMatchObject({ code: 'DOCUMENT_BYTES_INVALID', identity: 'Files#pdf-88' });
    expect(input.io.writeStaticDocument).not.toHaveBeenCalled();
    expect(input.io.uploadRaster).not.toHaveBeenCalled();
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('reads each target as published Strapi 5 content and conserves A and B against the composed release before comparing them', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const events: string[] = [];
    vi.mocked(input.io.openOwnedTarget).mockImplementation(async ({ name, baseUrl, namespace }) => {
      events.push(`open-${name}`);
      return { name, baseUrl, namespace, client: { name }, process: { pid: name === 'A' ? 4101 : 4102, endpoint: baseUrl, namespace } };
    });
    vi.mocked(input.io.readPublished).mockImplementation(async (target) => {
      events.push(`published-${target.name}`);
      return emptyReadback();
    });
    const conservation = vi.spyOn(await import('./sql-demo-native-conservation.js'), 'assertSqlDemoNativeConservation');
    await run(input);
    expect(events).toEqual(['open-A', 'published-A', 'open-B', 'published-B']);
    expect(conservation).toHaveBeenCalledTimes(3);
    expect(input.io.readPublished).toHaveBeenCalledTimes(2);
    expect(input.io.readPublished.mock.calls[0]?.[0].process.pid).not.toEqual(input.io.readPublished.mock.calls[1]?.[0].process.pid);
    expect(input.io.capture).toHaveBeenCalledTimes(1);
  });

  it('repeats A through a fresh CMS client and freshly fetched inventory without reusing the first run cache', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    vi.mocked(input.io.refreshMediaInventory).mockResolvedValue({ runNonce: 'inventory-refetched' });
    await run(input);
    expect(input.io.createFreshClient).toHaveBeenCalledWith(expect.objectContaining({ name: 'A' }));
    expect(input.io.refreshMediaInventory.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(input.io.createFreshClient).toHaveBeenCalledTimes(1);
  });

  it('does not capture when a published GET omits rows or returns draft-only state', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    vi.mocked(input.io.readPublished).mockRejectedValueOnce(Object.assign(new Error('draft only'), { code: 'PUBLISHED_READBACK_FAILED' }));
    await expect(run(input)).rejects.toMatchObject({ code: 'PUBLISHED_READBACK_FAILED' });
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('rejects a process handle whose endpoint or namespace does not prove the requested owned target', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    vi.mocked(input.io.openOwnedTarget).mockImplementationOnce(async ({ name, baseUrl, namespace }) => ({
      name, baseUrl, namespace, client: { name },
      process: { pid: 4101, endpoint: 'http://193.124.115.99', namespace: 'production' },
    }));
    await expect(run(input)).rejects.toMatchObject({ code: 'TARGET_OWNERSHIP_UNPROVEN' });
    expect(input.io.readPublished).not.toHaveBeenCalled();
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('reports a safe structured source identity without tokens, private URLs, or transport details', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const privateFailure = new Error('https://private.example.invalid/api?token=SYNTHETIC-TOKEN rejected source row');
    vi.spyOn(await import('./sql-public-content.js'), 'mapSqlPublicContent').mockImplementationOnce(() => {
      throw Object.assign(privateFailure, { identity: 'Articles#77' });
    });
    const error = await run(input).catch((cause: unknown) => cause as Record<string, unknown>);
    expect(error).toMatchObject({ code: 'MAPPING_FAILED', identity: 'Articles#77' });
    const safeError = JSON.stringify({ ...error, message: (error as Error).message });
    expect(safeError).not.toContain('SYNTHETIC-TOKEN');
    expect(safeError).not.toContain('private.example.invalid');
  });
});
