import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { classifyMediaSourceUrls } from './sql-demo-native-rehearsal.js';
import { loadSqlDemoAssets } from './sql-demo-assets.js';
import type { SqlDemoOfflineAssetProof, SqlDemoOfflineDocumentProof } from './sql-demo-assets.js';
import type { SqlDemoStrapi5Readback } from './sql-demo-native-conservation.js';
import { prepareSqlDemoPrivateInputs } from './sql-demo-private-inputs.js';
import type { SqlPublicReaderOptions } from './sql-public-reader.js';
import type { SqlDemoRelease } from './sql-demo-release.js';
import type { SqlMaterializerOptions } from './sql-public-materializer.js';

const DUMP_BYTES = Buffer.from('synthetic immutable SQL dump');
const SOURCE_SHA = createHash('sha256').update(DUMP_BYTES).digest('hex');
const STORED_SHA = 'b'.repeat(64);
const TARGET_URL = 'http://127.0.0.1:1337';
const TARGET_NAMESPACE = 'ikpk_sql_demo_native_red';
const TARGETS: Record<TargetName, TargetConfig> = {
  A: {
    baseUrl: 'http://127.0.0.1:1337', namespace: 'ikpk_sql_demo_native_a',
    dataDirectory: '/synthetic/targets/a/data', uploadDirectory: '/synthetic/targets/a/uploads',
  },
  B: {
    baseUrl: 'http://127.0.0.1:1338', namespace: 'ikpk_sql_demo_native_b',
    dataDirectory: '/synthetic/targets/b/data', uploadDirectory: '/synthetic/targets/b/uploads',
  },
};
const prepareSqlDemoPrivateInputsActual = prepareSqlDemoPrivateInputs;

type TargetName = 'A' | 'B';
type TargetConfig = {
  baseUrl: string;
  namespace: string;
  dataDirectory: string;
  uploadDirectory: string;
};
type OwnedSqlSource = {
  id: string;
  pid: number;
  socketPath: string;
  database: string;
};
type OwnedTarget = {
  name: TargetName;
  baseUrl: string;
  namespace: string;
  dataDirectory: string;
  uploadDirectory: string;
  client: unknown;
  process: { pid: number; endpoint: string; namespace: string; dataDirectory: string; uploadDirectory: string };
};
type UploadedRaster = { id: number; url: string; redirected?: boolean };

/** Test-only API contract for the thin native runner. Pure stages stay default-wired in production. */
type SqlDemoNativeRehearsalIo = {
  resolveCmsToken(): Promise<string>;
  acquireOwnedSqlSource(reader: SqlPublicReaderOptions): Promise<{ lease: OwnedSqlSource; reader: SqlPublicReaderOptions }>;
  openOwnedTarget(input: TargetConfig & { name: TargetName; token: string }): Promise<OwnedTarget>;
  stopOwnedTarget(target: OwnedTarget): Promise<void>;
  refreshMediaInventory(target: OwnedTarget): Promise<unknown>;
  readRasterBytes(path: string): Promise<Uint8Array>;
  uploadRaster(target: OwnedTarget, inventory: unknown, proof: SqlDemoOfflineAssetProof, bytes: Uint8Array): Promise<UploadedRaster>;
  readStoredMediaBytes(target: OwnedTarget, mediaId: number): Promise<Uint8Array>;
  readPdfBytes(path: string): Promise<Uint8Array>;
  writeStaticDocument(target: OwnedTarget, publicPath: string, bytes: Uint8Array): Promise<void>;
  readStaticDocument(target: OwnedTarget, publicPath: string): Promise<Uint8Array>;
  createFreshClient(target: OwnedTarget): Promise<OwnedTarget>;
  readPublished(target: OwnedTarget): Promise<SqlDemoStrapi5Readback>;
  capture(targets: readonly OwnedTarget[]): Promise<void>;
  stopOwnedSqlSource(lease: OwnedSqlSource): Promise<void>;
};

type RehearsalInput = {
  reader: SqlPublicReaderOptions;
  privateInputConfig: unknown;
  targets: Record<TargetName, TargetConfig>;
  /** Compatibility input for the current runner; operational tests require per-target configs. */
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

function pdfProof(sourceFileId: string, sourceUrl: string, sourceSha256: string, resolvedLocalPath: string): SqlDemoOfflineDocumentProof {
  return {
    sourceFileId,
    sourceUrl,
    archiveRelativePath: resolvedLocalPath,
    resolvedLocalPath,
    sourceSha256,
    reachability: { kind: 'document-binding', bindingSourceId: 501 },
    verification: { status: 'verified', loader: 'sql-demo-asset-loader', attestationId: `synthetic-${sourceFileId}` },
    sourceFileType: 'document',
    detectedMimeType: 'application/pdf',
    detectedExtension: 'pdf',
  };
}

function rasterProof(sourceFileId: string, sourceUrl: string, sourceSha256: string, resolvedLocalPath: string): SqlDemoOfflineAssetProof {
  return {
    sourceFileId, sourceUrl, archiveRelativePath: resolvedLocalPath, resolvedLocalPath, sourceSha256,
    reachability: { kind: 'sql-header' },
    verification: { status: 'verified', loader: 'sql-demo-asset-loader', attestationId: `synthetic-${sourceFileId}` },
    sourceFileType: 'image', detectedMimeType: 'image/png', detectedExtension: 'png',
  };
}

function replacementRasterProof(sourceFileId: string, sourceUrl: string, replacementSha256: string, replacementPath: string): SqlDemoOfflineAssetProof {
  return {
    sourceFileId, sourceUrl, archiveRelativePath: replacementPath, resolvedLocalPath: replacementPath,
    reachability: { kind: 'sql-header' },
    verification: { status: 'verified', loader: 'sql-demo-asset-loader', attestationId: `synthetic-${sourceFileId}` },
    sourceFileType: 'image', detectedMimeType: 'image/png', detectedExtension: 'png',
    sourceBytesAvailable: false,
    substitution: { replacementSha256, replacementPath, replacementRevision: 'synthetic-replacement-revision' },
  };
}

function ownedTarget(name: TargetName, config: TargetConfig, pid = name === 'A' ? 4101 : 4102): OwnedTarget {
  return {
    name, ...config, client: { name, request: vi.fn(async () => undefined) },
    process: {
      pid, endpoint: config.baseUrl, namespace: config.namespace,
      dataDirectory: config.dataDirectory, uploadDirectory: config.uploadDirectory,
    },
  };
}

function targetConfig(input: TargetConfig & { name: TargetName; token: string }): TargetConfig {
  return {
    baseUrl: input.baseUrl, namespace: input.namespace,
    dataDirectory: input.dataDirectory, uploadDirectory: input.uploadDirectory,
  };
}

function options(overrides: Partial<RehearsalInput> = {}): RehearsalInput {
  const io: SqlDemoNativeRehearsalIo = {
    resolveCmsToken: vi.fn(async () => 'SYNTHETIC-TOKEN'),
    acquireOwnedSqlSource: vi.fn(async (reader) => ({
      lease: { id: 'synthetic-sql-lease', pid: 4100, socketPath: reader.connection.unixSocketPath, database: reader.connection.database },
      reader,
    })),
    openOwnedTarget: vi.fn(async (input) => ownedTarget(input.name, targetConfig(input))),
    stopOwnedTarget: vi.fn(async () => undefined),
    refreshMediaInventory: vi.fn(async () => []),
    readRasterBytes: vi.fn(async () => Buffer.from('synthetic raster bytes')),
    uploadRaster: vi.fn(async () => ({ id: 71, url: '/uploads/actual-upload-71.webp' })),
    readStoredMediaBytes: vi.fn(async () => Buffer.from('synthetic stored bytes')),
    readPdfBytes: vi.fn(async () => Buffer.from('%PDF-1.7\nsynthetic document\n%%EOF\n')),
    writeStaticDocument: vi.fn(async () => undefined),
    readStaticDocument: vi.fn(async () => Buffer.from('%PDF-1.7\nsynthetic document\n%%EOF\n')),
    createFreshClient: vi.fn(async (target) => ({
      ...target,
      client: { name: target.name, fresh: true, request: vi.fn(async () => undefined) },
    })),
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
    privateInputConfig: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, privateJson: {} } as never,
    targets: TARGETS,
    target: { baseUrl: TARGET_URL, namespace: TARGET_NAMESPACE },
    io,
    ...overrides,
  };
}

describe('native SQL DEMO193 rehearsal orchestration (unit-mocked contract)', () => {
  it('classifies only aggregate-safe approved media URL shapes', () => {
    expect(classifyMediaSourceUrls([
      '/media/legacy/logo-v2.png',
      'https://legacy.example/image.png',
      'javascript:alert(1)',
    ])).toEqual({ approvedRelativeCount: 1, validAbsoluteCount: 1, invalidCount: 1, invalidRelativeCount: 0, invalidAbsoluteCount: 1, otherInvalidCount: 0, firstClass: 'approved-relative', firstInvalidShape: 'absolute' });
  });

  let dumpDirectory: string;
  let dumpPath: string;
  let originalVips: string;

  beforeEach(async () => {
    originalVips = sharp.versions.vips;
    dumpDirectory = await mkdtemp(join(tmpdir(), 'ikpk-native-rehearsal-'));
    dumpPath = join(dumpDirectory, 'baseline.sql');
    await writeFile(dumpPath, DUMP_BYTES);
    vi.spyOn(await import('./sql-public-content.js'), 'mapSqlPublicContent').mockReturnValue(emptyMapped as never);
    vi.spyOn(await import('./sql-demo-private-inputs.js'), 'prepareSqlDemoPrivateInputs').mockReturnValue({
      expectedSourceHash: `sha256:${SOURCE_SHA}`, acceptedLegacyIds: {},
      classificationCandidates: { teachers: [], articles: [] },
    } as never);
    vi.spyOn(await import('./sql-demo-private-inputs.js'), 'normalizeSqlDemoPrivateInputs').mockReturnValue({
      mapperOptions: { expectedSourceHash: `sha256:${SOURCE_SHA}`, acceptedLegacyIds: {} },
      loader: {} as never, composer: {} as never, materializer: emptyClassification,
    } as never);
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValue({
      offlineMedia: [], offlineDocuments: [], supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.spyOn(await import('./sql-demo-release.js'), 'composeSqlDemoRelease').mockReturnValue(emptyRelease);
    vi.spyOn(await import('./sql-public-materializer.js'), 'materializeSqlPublicContent').mockResolvedValue(undefined as never);
    sharp.versions.vips = '8.18.7';
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
    expect(input.io.acquireOwnedSqlSource).not.toHaveBeenCalled();
    expect(input.io.openOwnedTarget).not.toHaveBeenCalled();
    expect(input.io.stopOwnedSqlSource).not.toHaveBeenCalled();
  });

  it('requires two distinct owned loopback endpoint, namespace, database, and upload locations', async () => {
    const input = options({ reader: { ...options().reader, dumpPath }, target: { baseUrl: TARGETS.A.baseUrl, namespace: TARGETS.A.namespace } });
    await run(input);
    const opened = vi.mocked(input.io.openOwnedTarget).mock.calls.map(([target]) => ({
      name: target.name, baseUrl: target.baseUrl, namespace: target.namespace,
      dataDirectory: target.dataDirectory, uploadDirectory: target.uploadDirectory,
    }));
    const processOwnership = (await Promise.all(vi.mocked(input.io.openOwnedTarget).mock.results.map(({ value }) => value))).map((target) => {
      return {
        endpoint: target.process.endpoint, namespace: target.process.namespace,
        dataDirectory: target.process.dataDirectory, uploadDirectory: target.process.uploadDirectory,
      };
    });
    expect(opened).toEqual([
      { name: 'A', ...TARGETS.A },
      { name: 'B', ...TARGETS.B },
    ]);
    expect(new Set(opened.map(({ baseUrl }) => baseUrl)).size).toBe(2);
    expect(new Set(opened.map(({ namespace }) => namespace)).size).toBe(2);
    expect(new Set(opened.map(({ dataDirectory }) => dataDirectory)).size).toBe(2);
    expect(new Set(opened.map(({ uploadDirectory }) => uploadDirectory)).size).toBe(2);
    expect(processOwnership).toEqual([
      { endpoint: TARGETS.A.baseUrl, namespace: TARGETS.A.namespace, dataDirectory: TARGETS.A.dataDirectory, uploadDirectory: TARGETS.A.uploadDirectory },
      { endpoint: TARGETS.B.baseUrl, namespace: TARGETS.B.namespace, dataDirectory: TARGETS.B.dataDirectory, uploadDirectory: TARGETS.B.uploadDirectory },
    ]);
  });

  it('rejects overlapping A and B target storage before acquiring credentials or a SQL source', async () => {
    const input = options({
      reader: { ...options().reader, dumpPath },
      target: { baseUrl: TARGETS.A.baseUrl, namespace: TARGETS.A.namespace },
      targets: { A: TARGETS.A, B: { ...TARGETS.A } },
    });
    await expect(run(input)).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(input.io.resolveCmsToken).not.toHaveBeenCalled();
    expect(input.io.acquireOwnedSqlSource).not.toHaveBeenCalled();
    expect(input.reader.runPsql).not.toHaveBeenCalled();
    expect(input.io.openOwnedTarget).not.toHaveBeenCalled();
  });

  it('uses the native hashed read-only SQL reader and always stops the owned source', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const runPsql = vi.fn(async (invocation: { args: readonly string[] }) => {
      expect(invocation.args.join(' ')).toContain('BEGIN READ ONLY');
      return JSON.stringify(emptyNativeSource);
    });
    input.reader = { ...input.reader, dumpPath, runPsql };
    await run(input);
    const prepare = vi.mocked(prepareSqlDemoPrivateInputs);
    const resolveToken = vi.mocked(input.io.resolveCmsToken);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(resolveToken).toHaveBeenCalledTimes(1);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(resolveToken.mock.invocationCallOrder[0]!);
    expect(runPsql).toHaveBeenCalledTimes(1);
    expect(await readFile(dumpPath)).toEqual(DUMP_BYTES);
    expect(input.io.stopOwnedSqlSource).toHaveBeenCalledTimes(1);
  });

  it('does not publish a sourceWitnessVerified capture when final source verification fails during cleanup', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    vi.mocked(input.io.stopOwnedSqlSource).mockRejectedValueOnce(new Error('synthetic final SQL witness mismatch'));

    await expect(run(input)).rejects.toMatchObject({ code: 'SQL_SOURCE_CLEANUP_FAILED' });
    expect(input.io.stopOwnedSqlSource).toHaveBeenCalledTimes(1);
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('acquires a SQL source lease only after pin preflight and stops that exact acquired lease', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const events: string[] = [];
    const lease: OwnedSqlSource = { id: 'only-acquired-lease', pid: 4200, socketPath: '/tmp/owned-sql.sock', database: 'synthetic' };
    vi.mocked(prepareSqlDemoPrivateInputs).mockImplementationOnce(() => {
      events.push('pin-preflight');
      return {
        expectedSourceHash: `sha256:${SOURCE_SHA}`, acceptedLegacyIds: {},
        classificationCandidates: { teachers: [], articles: [] },
      };
    });
    vi.mocked(input.io.acquireOwnedSqlSource).mockImplementationOnce(async (reader) => {
      events.push('acquire-sql');
      return { lease, reader };
    });
    vi.mocked(input.io.stopOwnedSqlSource).mockImplementationOnce(async (stoppedLease) => {
      events.push(`stop-sql-${stoppedLease?.id ?? 'missing-lease'}`);
    });
    await run(input);
    expect(events).toEqual(['pin-preflight', 'acquire-sql', 'stop-sql-only-acquired-lease']);
    expect(input.io.acquireOwnedSqlSource).toHaveBeenCalledTimes(1);
    expect(events.indexOf('acquire-sql')).toBeGreaterThan(events.indexOf('pin-preflight'));
    expect(input.io.stopOwnedSqlSource).toHaveBeenCalledWith(lease);
  });

  it('does not stop or open a SQL source lease when acquisition fails before returning ownership', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    vi.mocked(input.io.acquireOwnedSqlSource).mockRejectedValueOnce(new Error('synthetic owned source startup failure'));
    await expect(run(input)).rejects.toThrow();
    expect(input.io.acquireOwnedSqlSource).toHaveBeenCalledTimes(1);
    expect(input.io.stopOwnedSqlSource).not.toHaveBeenCalled();
    expect(input.io.openOwnedTarget).not.toHaveBeenCalled();
  });

  it('stops the exact SQL lease when the leased read fails and never attempts target startup', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const lease: OwnedSqlSource = { id: 'failed-read-sql-lease', pid: 4225, socketPath: '/tmp/failed-read.sock', database: 'synthetic' };
    vi.mocked(input.io.acquireOwnedSqlSource).mockImplementationOnce(async (reader) => ({
      lease,
      reader: { ...reader, runPsql: vi.fn(async () => { throw new Error('synthetic leased SQL read failure'); }) },
    }));
    await expect(run(input)).rejects.toMatchObject({ code: 'SQL_SOURCE_INVALID' });
    expect(input.io.stopOwnedSqlSource).toHaveBeenCalledWith(lease);
    expect(input.io.openOwnedTarget).not.toHaveBeenCalled();
  });

  it('releases acquired B, A, and SQL source handles in reverse acquisition order after success', async () => {
    const input = options({ reader: { ...options().reader, dumpPath }, target: { baseUrl: TARGETS.A.baseUrl, namespace: TARGETS.A.namespace } });
    const events: string[] = [];
    const lease: OwnedSqlSource = { id: 'complete-sql-lease', pid: 4250, socketPath: '/tmp/complete-sql.sock', database: 'synthetic' };
    vi.mocked(input.io.acquireOwnedSqlSource).mockImplementationOnce(async (reader) => {
      events.push('acquire-sql');
      return { lease, reader };
    });
    vi.mocked(input.io.openOwnedTarget).mockImplementation(async (targetInput) => {
      events.push(`open-${targetInput.name}`);
      return ownedTarget(targetInput.name, targetConfig(targetInput));
    });
    vi.mocked(input.io.stopOwnedTarget).mockImplementation(async (target) => {
      events.push(`stop-${target.name}`);
    });
    vi.mocked(input.io.stopOwnedSqlSource).mockImplementationOnce(async (stoppedLease) => {
      events.push(`stop-sql-${stoppedLease?.id ?? 'missing-lease'}`);
    });

    await run(input);
    expect(events).toEqual(['acquire-sql', 'open-A', 'open-B', 'stop-B', 'stop-A', 'stop-sql-complete-sql-lease']);
    expect(input.io.stopOwnedTarget).toHaveBeenCalledTimes(2);
    expect(input.io.stopOwnedSqlSource).toHaveBeenCalledWith(lease);
  });

  it('stops only acquired target and SQL leases in reverse order after target B startup fails', async () => {
    const input = options({ reader: { ...options().reader, dumpPath }, target: { baseUrl: TARGETS.A.baseUrl, namespace: TARGETS.A.namespace } });
    const events: string[] = [];
    const lease: OwnedSqlSource = { id: 'partial-sql-lease', pid: 4300, socketPath: '/tmp/partial-sql.sock', database: 'synthetic' };
    vi.mocked(input.io.acquireOwnedSqlSource).mockImplementationOnce(async (reader) => {
      events.push('acquire-sql');
      return { lease, reader };
    });
    vi.mocked(input.io.openOwnedTarget).mockImplementation(async (targetInput) => {
      events.push(`open-${targetInput.name}`);
      if (targetInput.name === 'B') throw new Error('synthetic B startup failure');
      return ownedTarget(targetInput.name, targetConfig(targetInput));
    });
    vi.mocked(input.io.stopOwnedTarget).mockImplementation(async (target) => {
      events.push(`stop-target-${target.name}`);
    });
    vi.mocked(input.io.stopOwnedSqlSource).mockImplementationOnce(async (stoppedLease) => {
      events.push(`stop-sql-${stoppedLease?.id ?? 'missing-lease'}`);
    });

    await expect(run(input)).rejects.toMatchObject({ code: 'TARGET_OWNERSHIP_UNPROVEN' });
    expect(events).toEqual(['acquire-sql', 'open-A', 'open-B', 'stop-target-A', 'stop-sql-partial-sql-lease']);
    expect(input.io.stopOwnedTarget).toHaveBeenCalledTimes(1);
    expect(input.io.stopOwnedTarget).toHaveBeenCalledWith(expect.objectContaining({ name: 'A' }));
  });

  it('rejects missing raw private-input pins before resolving credentials', async () => {
    const input = options();
    vi.mocked(prepareSqlDemoPrivateInputs).mockImplementationOnce(prepareSqlDemoPrivateInputsActual);
    await expect(run(input)).rejects.toThrow('approved-supplements.json raw bytes are missing');
    expect(prepareSqlDemoPrivateInputs).toHaveBeenCalledTimes(1);
    expect(input.io.resolveCmsToken).not.toHaveBeenCalled();
    expect(input.reader.runPsql).not.toHaveBeenCalled();
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
    const sourceBytes = Buffer.from('synthetic source raster bytes');
    const expectedSource = createHash('sha256').update(sourceBytes).digest('hex');
    const storedBytes = Buffer.from('synthetic transformed stored bytes');
    const storedHash = createHash('sha256').update(storedBytes).digest('hex');
    const proof = rasterProof('source-9', '/sql/source-9.png', expectedSource, 'fixtures/sql-assets/source-9.png');
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [proof],
      offlineDocuments: [], supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.readRasterBytes).mockResolvedValue(sourceBytes);
    vi.mocked(input.io.refreshMediaInventory).mockResolvedValueOnce({ files: [] });
    vi.mocked(input.io.uploadRaster).mockResolvedValue({ id: 91, url: '/uploads/normalized-91.webp' });
    vi.mocked(input.io.readStoredMediaBytes).mockResolvedValue(storedBytes);
    await run(input);
    expect(input.io.refreshMediaInventory).toHaveBeenCalled();
    expect(input.io.readRasterBytes).toHaveBeenCalledWith(proof.resolvedLocalPath);
    expect(input.io.uploadRaster).toHaveBeenCalledWith(expect.anything(), expect.anything(), proof, sourceBytes);
    expect(input.io.readStoredMediaBytes).toHaveBeenCalledWith(expect.anything(), 91);
    expect(storedHash).not.toBe(expectedSource);
  });

  it.each(['source SHA', 'replacement SHA'] as const)('rejects raster bytes that do not match the loader proof %s before upload', async (pinKind) => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const claimedBytes = Buffer.from('loader-verified raster bytes');
    const wrongBytes = Buffer.from('different raster bytes');
    const claimedHash = createHash('sha256').update(claimedBytes).digest('hex');
    const proof = pinKind === 'source SHA'
      ? rasterProof('source-10', '/sql/source-10.png', claimedHash, 'fixtures/sql-assets/source-10.png')
      : replacementRasterProof('source-10', '/sql/source-10.png', claimedHash, 'fixtures/replacements/source-10.png');
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [proof],
      offlineDocuments: [], supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.readRasterBytes).mockResolvedValue(wrongBytes);
    await expect(run(input)).rejects.toMatchObject({ code: 'MEDIA_SOURCE_BYTES_INVALID', identity: 'Files#source-10' });
    expect(input.io.readRasterBytes).toHaveBeenCalledWith(proof.resolvedLocalPath);
    expect(input.io.uploadRaster).not.toHaveBeenCalled();
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('does not guess a media URL from a source ID or accept an upload with no actual URL', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const sourceBytes = Buffer.from('synthetic URL validation source');
    const proof = rasterProof('source-9', '/sql/source-9.png', createHash('sha256').update(sourceBytes).digest('hex'), 'fixtures/sql-assets/source-9.png');
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [proof],
      offlineDocuments: [], supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.readRasterBytes).mockResolvedValue(sourceBytes);
    vi.mocked(input.io.uploadRaster).mockResolvedValueOnce({ id: 92, url: '' });
    await expect(run(input)).rejects.toMatchObject({ code: 'MEDIA_BINDING_FAILED', identity: 'Files#source-9' });
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('rejects an absolute raster upload URL outside the owned target origin before fetching stored bytes', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const sourceBytes = Buffer.from('synthetic off-target URL source');
    const proof = rasterProof('source-77', '/sql/source-77.png', createHash('sha256').update(sourceBytes).digest('hex'), 'fixtures/sql-assets/source-77.png');
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [proof],
      offlineDocuments: [], supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.readRasterBytes).mockResolvedValue(sourceBytes);
    vi.mocked(input.io.uploadRaster).mockResolvedValue({ id: 77, url: 'https://cdn.example.invalid/uploads/77.webp' });

    await expect(run(input)).rejects.toMatchObject({ code: 'MEDIA_BINDING_FAILED', identity: 'Files#source-77' });
    expect(input.io.readStoredMediaBytes).not.toHaveBeenCalled();
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('rejects a raster upload response that followed a redirect even when its final URL is same-origin', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const sourceBytes = Buffer.from('synthetic redirected upload source');
    const proof = rasterProof('source-78', '/sql/source-78.png', createHash('sha256').update(sourceBytes).digest('hex'), 'fixtures/sql-assets/source-78.png');
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [proof],
      offlineDocuments: [], supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.readRasterBytes).mockResolvedValue(sourceBytes);
    vi.mocked(input.io.uploadRaster).mockResolvedValue({ id: 78, url: '/uploads/78.webp', redirected: true });

    await expect(run(input)).rejects.toMatchObject({ code: 'MEDIA_BINDING_FAILED', identity: 'Files#source-78' });
    expect(input.io.readStoredMediaBytes).not.toHaveBeenCalled();
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('ships approved PDFs as verified static bytes with their pinned public path and never through raster upload', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const pdfBytes = Buffer.from('%PDF-1.7\nsynthetic approved PDF\n%%EOF\n');
    const pdfPath = 'web/public/static-files/source-501.pdf';
    const sourceUrl = '/sql/source-501.pdf';
    vi.spyOn(await import('./sql-public-content.js'), 'mapSqlPublicContent').mockReturnValueOnce({
      ...emptyMapped,
      entities: { ...emptyMapped.entities, documents: [{
        fileId: 'pdf-501', bindingSourceId: 501, url: sourceUrl,
      }] },
    } as never);
    vi.spyOn(await import('./sql-demo-private-inputs.js'), 'normalizeSqlDemoPrivateInputs').mockReturnValueOnce({
      mapperOptions: { expectedSourceHash: `sha256:${SOURCE_SHA}`, acceptedLegacyIds: {} },
      loader: {} as never,
      composer: { acceptedSupplements: { targetLocations: [{
        sourceTable: 'FileBindingOrganizationInfo', sourceId: 501, publicDocumentPath: '/static-files/source-501.pdf',
      }] } } as never,
      materializer: emptyClassification,
    } as never);
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [],
      offlineDocuments: [pdfProof('pdf-501', sourceUrl, createHash('sha256').update(pdfBytes).digest('hex'), pdfPath)],
      supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.readPdfBytes).mockResolvedValueOnce(pdfBytes);
    vi.mocked(input.io.readStaticDocument).mockResolvedValue(pdfBytes);
    await run(input);
    expect(input.io.writeStaticDocument).toHaveBeenCalledWith(expect.anything(), '/static-files/source-501.pdf', pdfBytes);
    expect(input.io.readStaticDocument).toHaveBeenCalledTimes(3);
    expect(input.io.readStaticDocument).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'A' }), '/static-files/source-501.pdf');
    expect(input.io.readStaticDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'B' }), '/static-files/source-501.pdf');
    expect(input.io.readStaticDocument).toHaveBeenNthCalledWith(3, expect.objectContaining({ name: 'A' }), '/static-files/source-501.pdf');
    expect(input.io.uploadRaster).not.toHaveBeenCalled();
  });

  it('refuses a PDF whose independently served bytes drift on repeated target A before capture', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const expectedBytes = Buffer.from('%PDF-1.7\nsynthetic approved PDF\n%%EOF\n');
    const driftedBytes = Buffer.from('%PDF-1.7\nchanged after repeat\n%%EOF\n');
    const pdfPath = 'web/public/static-files/source-501.pdf';
    const sourceUrl = '/sql/source-501.pdf';
    vi.spyOn(await import('./sql-public-content.js'), 'mapSqlPublicContent').mockReturnValueOnce({
      ...emptyMapped,
      entities: { ...emptyMapped.entities, documents: [{ fileId: 'pdf-501', bindingSourceId: 501, url: sourceUrl }] },
    } as never);
    vi.spyOn(await import('./sql-demo-private-inputs.js'), 'normalizeSqlDemoPrivateInputs').mockReturnValueOnce({
      mapperOptions: { expectedSourceHash: `sha256:${SOURCE_SHA}`, acceptedLegacyIds: {} },
      loader: {} as never,
      composer: { acceptedSupplements: { targetLocations: [{
        sourceTable: 'FileBindingOrganizationInfo', sourceId: 501, publicDocumentPath: '/static-files/source-501.pdf',
      }] } } as never,
      materializer: emptyClassification,
    } as never);
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [],
      offlineDocuments: [pdfProof('pdf-501', sourceUrl, createHash('sha256').update(expectedBytes).digest('hex'), pdfPath)],
      supplements: [], provenance: { baseline: { sqlSha256: SOURCE_SHA, archiveSha256: STORED_SHA }, assets: [], supplements: [] },
    } as never);
    vi.mocked(input.io.readPdfBytes).mockResolvedValue(expectedBytes);
    vi.mocked(input.io.readStaticDocument)
      .mockResolvedValueOnce(expectedBytes)
      .mockResolvedValueOnce(expectedBytes)
      .mockResolvedValueOnce(driftedBytes);

    await expect(run(input)).rejects.toMatchObject({ code: 'DOCUMENT_BYTES_INVALID', identity: 'Files#pdf-501' });
    expect(input.io.readStaticDocument).toHaveBeenCalledTimes(3);
    expect(input.io.readStaticDocument).toHaveBeenNthCalledWith(3, expect.objectContaining({ name: 'A' }), '/static-files/source-501.pdf');
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it.each(['missing', 'changed'] as const)('refuses a %s approved PDF byte payload before publish or capture', async (mode) => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    const bytes = Buffer.from('%PDF-1.7\nsynthetic expected\n%%EOF\n');
    vi.spyOn(await import('./sql-demo-assets.js'), 'loadSqlDemoAssets').mockResolvedValueOnce({
      offlineMedia: [], offlineDocuments: [pdfProof('pdf-88', '/sql/pdf-88.pdf', createHash('sha256').update(bytes).digest('hex'), 'supplements/88.pdf')],
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
    vi.mocked(input.io.openOwnedTarget).mockImplementation(async ({ name, baseUrl, namespace, ...config }) => {
      events.push(`open-${name}`);
      return ownedTarget(name, { ...config, baseUrl, namespace });
    });
    vi.mocked(input.io.readPublished).mockImplementation(async (target) => {
      events.push(`published-${target.name}`);
      return emptyReadback();
    });
    const conservation = vi.spyOn(await import('./sql-demo-native-conservation.js'), 'assertSqlDemoNativeConservation');
    await run(input);
    expect(events).toEqual(['open-A', 'published-A', 'open-B', 'published-B', 'published-A']);
    expect(conservation).toHaveBeenCalledTimes(4);
    expect(input.io.readPublished).toHaveBeenCalledTimes(3);
    const readTargets = vi.mocked(input.io.readPublished).mock.calls.map(([target]) => target.process.pid);
    expect(readTargets[0]).not.toEqual(readTargets[1]);
    expect(input.io.capture).toHaveBeenCalledTimes(1);
  });

  it('repeats A through a fresh CMS client and freshly fetched inventory without reusing the first run cache', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    vi.mocked(input.io.refreshMediaInventory).mockResolvedValue({ runNonce: 'inventory-refetched' });
    await run(input);
    expect(input.io.createFreshClient).toHaveBeenCalledWith(expect.objectContaining({ name: 'A' }));
    expect(input.io.refreshMediaInventory).toHaveBeenCalledTimes(3);
    expect(input.io.createFreshClient).toHaveBeenCalledTimes(1);
  });

  it('does not capture when a published GET omits rows or returns draft-only state', async () => {
    const input = options({ reader: { ...options().reader, dumpPath } });
    vi.mocked(input.io.readPublished).mockRejectedValueOnce(Object.assign(new Error('draft only'), { code: 'PUBLISHED_READBACK_FAILED' }));
    await expect(run(input)).rejects.toMatchObject({ code: 'PUBLISHED_READBACK_FAILED' });
    expect(input.io.capture).not.toHaveBeenCalled();
  });

  it('rejects a process handle whose endpoint, namespace, or isolated upload directory does not prove its owned target', async () => {
    const input = options({ reader: { ...options().reader, dumpPath }, target: TARGETS.A });
    vi.mocked(input.io.openOwnedTarget).mockImplementationOnce(async (targetInput) => {
      const target = ownedTarget(targetInput.name, targetConfig(targetInput));
      return { ...target, process: { ...target.process, endpoint: 'http://193.124.115.99', namespace: 'production', uploadDirectory: TARGETS.B.uploadDirectory } };
    });
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
    const caught = await run(input).catch((cause: unknown) => cause);
    const error = caught as Error & { code?: string; identity?: string };
    expect(error).toMatchObject({ code: 'MAPPING_FAILED', identity: 'Articles#77' });
    const safeError = JSON.stringify({ code: error.code, identity: error.identity, message: error.message });
    expect(safeError).not.toContain('SYNTHETIC-TOKEN');
    expect(safeError).not.toContain('private.example.invalid');
  });
});
