import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { SqlDemoAssetLoaderResult, SqlDemoOfflineAssetProof, SqlDemoOfflineDocumentProof } from './sql-demo-assets.js';
import { loadSqlDemoAssets } from './sql-demo-assets.js';
import type { SqlDemoStrapi5Readback } from './sql-demo-native-conservation.js';
import { assertSqlDemoNativeConservation } from './sql-demo-native-conservation.js';
import type { SqlDemoPrivateInputRootConfig, SqlDemoNormalizedPrivateInputs } from './sql-demo-private-inputs.js';
import { normalizeSqlDemoPrivateInputs, prepareSqlDemoPrivateInputs } from './sql-demo-private-inputs.js';
import type { SqlDemoRelease, SqlDemoVerifiedAssetMapping } from './sql-demo-release.js';
import { composeSqlDemoRelease } from './sql-demo-release.js';
import type { SqlPublicReaderOptions, SqlPublicReaderResult } from './sql-public-reader.js';
import { readSqlPublicSource } from './sql-public-reader.js';
import type { SqlPublicContentResult, SqlPublicSource } from './sql-public-content.js';
import { mapSqlPublicContent } from './sql-public-content.js';
import type { SqlMaterializerOptions, SqlResolvedMedia, SqlStrapiRestClient } from './sql-public-materializer.js';
import { materializeSqlPublicContent } from './sql-public-materializer.js';

type TargetName = 'A' | 'B';

export type SqlDemoNativeOwnedTarget = {
  name: TargetName;
  baseUrl: string;
  namespace: string;
  client: unknown;
  /** Concrete process evidence supplied by the owned local-process adapter. */
  process: { pid: number; endpoint: string; namespace: string };
};

export type SqlDemoNativeUpload = { id: number; url: string };

/** The only injected effects are local process, CMS, and byte-I/O boundaries. */
export interface SqlDemoNativeRehearsalIo {
  resolveCmsToken(): Promise<string>;
  openOwnedTarget(input: { name: TargetName; baseUrl: string; namespace: string; token: string }): Promise<SqlDemoNativeOwnedTarget>;
  refreshMediaInventory(target: SqlDemoNativeOwnedTarget): Promise<unknown>;
  uploadRaster(target: SqlDemoNativeOwnedTarget, inventory: unknown, sourceFileId: string, sourceSha256: string): Promise<SqlDemoNativeUpload>;
  readStoredMediaBytes(target: SqlDemoNativeOwnedTarget, mediaId: number): Promise<Uint8Array>;
  readPdfBytes(path: string): Promise<Uint8Array>;
  writeStaticDocument(target: SqlDemoNativeOwnedTarget, publicPath: string, bytes: Uint8Array): Promise<void>;
  createFreshClient(target: SqlDemoNativeOwnedTarget): Promise<SqlDemoNativeOwnedTarget>;
  readPublished(target: SqlDemoNativeOwnedTarget): Promise<SqlDemoStrapi5Readback>;
  capture(targets: readonly SqlDemoNativeOwnedTarget[]): Promise<void>;
  stopOwnedSqlSource(): Promise<void>;
}

export interface SqlDemoNativeRehearsalInput {
  reader: SqlPublicReaderOptions;
  privateInputConfig: SqlDemoPrivateInputRootConfig;
  target: { baseUrl: string; namespace: string };
  io: SqlDemoNativeRehearsalIo;
}

export interface SqlDemoNativeRehearsalResult {
  status: 'success';
  sourceHash: string;
  targetCount: 2;
  rasterCount: number;
  documentCount: number;
  repeatedTarget: 'A';
}

export class SqlDemoNativeRehearsalError extends Error {
  readonly code: string;
  readonly identity?: string;

  constructor(code: string, message: string, identity?: string) {
    super(message);
    this.name = 'SqlDemoNativeRehearsalError';
    this.code = code;
    if (identity) this.identity = identity;
  }
}

type LoadedRaster = {
  proof: SqlDemoOfflineAssetProof;
  upload: SqlDemoNativeUpload;
  sourceHash: string;
  storedHash: string;
  sourceIdentity: string;
};

type TargetRun = {
  target: SqlDemoNativeOwnedTarget;
  release: SqlDemoRelease;
  readback: SqlDemoStrapi5Readback;
  rasters: Map<string, LoadedRaster>;
};

const HASH = /^[a-f\d]{64}$/i;
const TARGET_NAMESPACE = /^ikpk_sql_demo_native(?:_[a-z0-9]+)?$/;

function safeFailure(code: string, message: string, identity?: string): SqlDemoNativeRehearsalError {
  return new SqlDemoNativeRehearsalError(code, message, identity);
}

function validateTarget(target: SqlDemoNativeRehearsalInput['target']): void {
  let url: URL;
  try {
    url = new URL(target.baseUrl);
  } catch {
    throw safeFailure('INVALID_TARGET', 'Target must be the owned loopback CMS endpoint');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '1337'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !TARGET_NAMESPACE.test(target.namespace)) {
    throw safeFailure('INVALID_TARGET', 'Target must be the owned loopback CMS endpoint');
  }
}

function assertLoadedVipsFloor(): void {
  const version = sharp.versions.vips;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const actual = match?.slice(1).map(Number);
  const belowFloor = !actual || actual[0]! < 8
    || (actual[0] === 8 && actual[1]! < 18)
    || (actual[0] === 8 && actual[1] === 18 && actual[2]! < 7);
  if (belowFloor) {
    throw safeFailure('RASTER_RUNTIME_UNSAFE', 'Loaded Sharp/libvips runtime is below the approved 8.18.7 floor');
  }
}

function assertOwnedTarget(
  target: SqlDemoNativeOwnedTarget,
  name: TargetName,
  expected: SqlDemoNativeRehearsalInput['target'],
): void {
  const process = target?.process;
  if (target?.name !== name || target.baseUrl !== expected.baseUrl || target.namespace !== expected.namespace
    || !process || !Number.isSafeInteger(process.pid) || process.pid <= 0
    || process.endpoint !== expected.baseUrl || process.namespace !== expected.namespace) {
    throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', `Owned CMS process for target ${name} could not be verified`);
  }
}

function assertDistinctTargets(a: SqlDemoNativeOwnedTarget, b: SqlDemoNativeOwnedTarget): void {
  if (a.process.pid === b.process.pid || a.client === b.client) {
    throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', 'Targets A and B do not have independent owned CMS processes and clients');
  }
}

function loadedClient(target: SqlDemoNativeOwnedTarget): SqlStrapiRestClient {
  const client = target.client as Partial<SqlStrapiRestClient> | null;
  if (!client || typeof client.request !== 'function') {
    throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', `Owned CMS client for target ${target.name} is unavailable`);
  }
  return client as SqlStrapiRestClient;
}

function sourceIdentity(error: unknown): string | undefined {
  const identity = error && typeof error === 'object' ? (error as { identity?: unknown }).identity : undefined;
  return typeof identity === 'string' && /^(?:[A-Za-z][A-Za-z0-9]*#\d+|Files#[^\s]+)$/.test(identity) ? identity : undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateUpload(upload: SqlDemoNativeUpload, sourceFileId: string): void {
  let url: URL | undefined;
  try {
    if (upload.url.startsWith('/')) url = new URL(upload.url, 'http://127.0.0.1:1337');
    else url = new URL(upload.url);
  } catch {
    // Report a bounded error without reflecting an untrusted CMS URL.
  }
  if (!Number.isSafeInteger(upload.id) || upload.id <= 0 || !url || !url.pathname.startsWith('/uploads/')
    || url.username || url.password || url.search || url.hash) {
    throw safeFailure('MEDIA_BINDING_FAILED', 'CMS upload did not return a usable media ID and actual public URL', `Files#${sourceFileId}`);
  }
}

function validatePdfBytes(proof: SqlDemoOfflineDocumentProof, bytes: Uint8Array): void {
  if (!HASH.test(proof.sourceSha256) || sha256(bytes) !== proof.sourceSha256.toLowerCase()
    || !Buffer.from(bytes).subarray(0, 5).equals(Buffer.from('%PDF-'))
    || bytes.length < 8) {
    throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved public document bytes do not match their PDF pin', `Files#${proof.sourceFileId}`);
  }
}

async function readApprovedPdfBytes(assets: SqlDemoAssetLoaderResult, io: SqlDemoNativeRehearsalIo): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  for (const proof of assets.offlineDocuments) {
    if (result.has(proof.sourceFileId)) throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved public documents contain a duplicate source identity', `Files#${proof.sourceFileId}`);
    let bytes: Uint8Array;
    try {
      bytes = await io.readPdfBytes(proof.resolvedLocalPath);
    } catch {
      throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved public document bytes are unavailable', `Files#${proof.sourceFileId}`);
    }
    validatePdfBytes(proof, bytes);
    result.set(proof.sourceFileId, bytes);
  }
  return result;
}

function verifiedMapping(
  proof: SqlDemoOfflineAssetProof,
  targetPublicUrl: string,
): SqlDemoVerifiedAssetMapping {
  const sourceHash = 'sourceBytesAvailable' in proof
    ? proof.substitution.replacementSha256
    : proof.sourceSha256;
  return {
    sourceFileId: proof.sourceFileId,
    sourceUrl: proof.sourceUrl,
    targetPublicUrl,
    ...(proof.sourceReferenceAliases ? { sourceReferenceAliases: proof.sourceReferenceAliases } : {}),
    sha256: sourceHash,
    detectedMimeType: proof.detectedMimeType,
    verification: proof.verification,
  };
}

async function uploadRasters(
  target: SqlDemoNativeOwnedTarget,
  inventory: unknown,
  proofs: readonly SqlDemoOfflineAssetProof[],
  io: SqlDemoNativeRehearsalIo,
): Promise<Map<string, LoadedRaster>> {
  const result = new Map<string, LoadedRaster>();
  for (const proof of proofs) {
    const sourceHash = 'sourceBytesAvailable' in proof
      ? proof.substitution.replacementSha256
      : proof.sourceSha256;
    if (!HASH.test(sourceHash)) {
      throw safeFailure('MEDIA_BINDING_FAILED', 'Approved raster has no valid source byte pin', `Files#${proof.sourceFileId}`);
    }
    let upload: SqlDemoNativeUpload;
    try {
      upload = await io.uploadRaster(target, inventory, proof.sourceFileId, sourceHash);
      validateUpload(upload, proof.sourceFileId);
    } catch (error) {
      if (error instanceof SqlDemoNativeRehearsalError) throw error;
      throw safeFailure('MEDIA_BINDING_FAILED', 'CMS raster upload failed', `Files#${proof.sourceFileId}`);
    }
    let storedHash: string;
    try {
      const storedBytes = await io.readStoredMediaBytes(target, upload.id);
      storedHash = sha256(storedBytes);
    } catch {
      throw safeFailure('MEDIA_BINDING_FAILED', 'Stored CMS raster bytes could not be independently verified', `Files#${proof.sourceFileId}`);
    }
    if (!storedBytesHashValid(storedHash)) {
      throw safeFailure('MEDIA_BINDING_FAILED', 'Stored CMS raster byte witness is invalid', `Files#${proof.sourceFileId}`);
    }
    result.set(proof.sourceFileId, {
      proof,
      upload,
      sourceHash: sourceHash.toLowerCase(),
      storedHash,
      sourceIdentity: `Files#${proof.sourceFileId}`,
    });
  }
  return result;
}

function storedBytesHashValid(value: string): boolean {
  return HASH.test(value);
}

function sameMediaBindings(previous: Map<string, LoadedRaster>, next: Map<string, LoadedRaster>): void {
  if (previous.size !== next.size) throw safeFailure('REPEAT_A_DUPLICATED_MEDIA', 'Repeated target A changed its raster inventory');
  for (const [sourceFileId, first] of previous) {
    const repeat = next.get(sourceFileId);
    if (!repeat || repeat.upload.id !== first.upload.id || repeat.upload.url !== first.upload.url
      || repeat.storedHash !== first.storedHash) {
      throw safeFailure('REPEAT_A_DUPLICATED_MEDIA', 'Repeated target A created or changed a source media identity', `Files#${sourceFileId}`);
    }
  }
}

function sameTargetEntityIdentity(before: SqlDemoStrapi5Readback, after: SqlDemoStrapi5Readback): void {
  const collections = Object.keys(before.collections ?? {}).sort();
  if (collections.join('\0') !== Object.keys(after.collections ?? {}).sort().join('\0')) {
    throw safeFailure('REPEAT_A_DUPLICATED_CONTENT', 'Repeated target A changed its published collection inventory');
  }
  for (const collection of collections) {
    const rowsBefore = before.collections[collection as keyof SqlDemoStrapi5Readback['collections']] ?? [];
    const rowsAfter = after.collections[collection as keyof SqlDemoStrapi5Readback['collections']] ?? [];
    if (rowsBefore.length !== rowsAfter.length) {
      throw safeFailure('REPEAT_A_DUPLICATED_CONTENT', 'Repeated target A changed a published record count');
    }
    const byLegacy = new Map(rowsAfter.map((row) => [row.legacy_id, row]));
    if (byLegacy.size !== rowsAfter.length) throw safeFailure('REPEAT_A_DUPLICATED_CONTENT', 'Repeated target A contains duplicate logical records');
    for (const row of rowsBefore) {
      const repeated = byLegacy.get(row.legacy_id);
      if (!repeated || repeated.id !== row.id || repeated.documentId !== row.documentId) {
        throw safeFailure('REPEAT_A_DUPLICATED_CONTENT', 'Repeated target A changed a published record identity');
      }
    }
  }
  const mediaBefore = [...before.media].sort((left, right) => left.id - right.id);
  const mediaAfter = [...after.media].sort((left, right) => left.id - right.id);
  if (mediaBefore.length !== mediaAfter.length) throw safeFailure('REPEAT_A_DUPLICATED_MEDIA', 'Repeated target A changed its media count');
  for (const [index, media] of mediaBefore.entries()) {
    const repeated = mediaAfter[index];
    if (!repeated || repeated.id !== media.id || repeated.url !== media.url
      || repeated.verifiedStoredSha256 !== media.verifiedStoredSha256) {
      throw safeFailure('REPEAT_A_DUPLICATED_MEDIA', 'Repeated target A changed a stored media identity');
    }
  }
}

function selectedPublicHeaders(mapped: SqlPublicContentResult, sourceHash: string) {
  const groups = [
    ['Institutes', mapped.entities.institutes], ['Programs', mapped.entities.programs],
    ['Teachers', mapped.entities.teachers], ['Events', mapped.entities.events],
    ['Articles', mapped.entities.articles], ['News', mapped.entities.news ?? []],
    ['Promotions', mapped.entities.promotions ?? []], ['Videos', mapped.entities.videos ?? []],
  ] as const;
  const references = groups.flatMap(([sourceTable, rows]) => rows.flatMap((row) => {
    const entity = row as { sourceId?: number; imageId?: string | null };
    return typeof entity.sourceId === 'number' && typeof entity.imageId === 'string' && entity.imageId
      ? [{ sourceTable, sourceId: entity.sourceId, imageId: entity.imageId }]
      : [];
  }));
  return { sourceHash, references };
}

function publicDocumentPath(
  proof: SqlDemoOfflineDocumentProof,
  mapped: SqlPublicContentResult,
  normalized: SqlDemoNormalizedPrivateInputs,
): string {
  const document = mapped.entities.documents?.find((item) => item.fileId === proof.sourceFileId);
  const location = normalized.composer.acceptedSupplements.targetLocations.find((item) =>
    item.sourceTable === 'FileBindingOrganizationInfo' && item.sourceId === document?.bindingSourceId);
  if (!document || !location?.publicDocumentPath || document.url !== proof.sourceUrl) {
    throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved PDF has no matching SQL binding and pinned public path', `Files#${proof.sourceFileId}`);
  }
  return location.publicDocumentPath;
}

async function materializeTarget(
  target: SqlDemoNativeOwnedTarget,
  release: SqlDemoRelease,
  classification: SqlDemoNormalizedPrivateInputs['materializer'],
  rasters: Map<string, LoadedRaster>,
): Promise<void> {
  const client = loadedClient(target);
  const options: SqlMaterializerOptions = {
    target: client,
    media: {
      async resolve(sourceImageId: string, requestedTarget: SqlStrapiRestClient): Promise<SqlResolvedMedia> {
        if (requestedTarget !== client) throw safeFailure('MEDIA_BINDING_FAILED', 'CMS materializer crossed target client boundaries', `Files#${sourceImageId}`);
        const media = rasters.get(sourceImageId);
        if (!media) throw safeFailure('MEDIA_BINDING_FAILED', 'Mapped raster has no actual target upload witness', `Files#${sourceImageId}`);
        return {
          id: media.upload.id,
          sourceHash: media.sourceHash,
          storedHash: media.storedHash,
          sourceIdentity: media.sourceIdentity,
        };
      },
    },
    classification,
  };
  await materializeSqlPublicContent(release as never, options);
}

async function importTarget(
  name: TargetName,
  target: SqlDemoNativeOwnedTarget,
  mapped: SqlPublicContentResult,
  normalized: SqlDemoNormalizedPrivateInputs,
  assets: SqlDemoAssetLoaderResult,
  pdfBytes: Map<string, Uint8Array>,
  io: SqlDemoNativeRehearsalIo,
): Promise<TargetRun> {
  let inventory: unknown;
  try {
    inventory = await io.refreshMediaInventory(target);
  } catch {
    throw safeFailure('MEDIA_INVENTORY_FAILED', `Fresh media inventory could not be read for target ${name}`);
  }
  const rasters = await uploadRasters(target, inventory, assets.offlineMedia, io);
  for (const document of assets.offlineDocuments) {
    const bytes = pdfBytes.get(document.sourceFileId);
    if (!bytes) throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved document bytes were not retained for publication', `Files#${document.sourceFileId}`);
    try {
      await io.writeStaticDocument(target, publicDocumentPath(document, mapped, normalized), bytes);
    } catch {
      throw safeFailure('DOCUMENT_PUBLISH_FAILED', 'Approved static document could not be published', `Files#${document.sourceFileId}`);
    }
  }
  const images = assets.offlineMedia.map((proof) => {
    const uploaded = rasters.get(proof.sourceFileId);
    if (!uploaded) throw safeFailure('MEDIA_BINDING_FAILED', 'Raster upload response is missing', `Files#${proof.sourceFileId}`);
    return verifiedMapping(proof, uploaded.upload.url);
  });
  const documents = assets.offlineDocuments.map((proof) => {
    if (!pdfBytes.has(proof.sourceFileId)) throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved document bytes are missing', `Files#${proof.sourceFileId}`);
    return {
      sourceFileId: proof.sourceFileId,
      sourceUrl: proof.sourceUrl,
      targetPublicUrl: publicDocumentPath(proof, mapped, normalized),
      sha256: proof.sourceSha256,
      detectedMimeType: proof.detectedMimeType,
      verification: proof.verification,
    };
  });
  const release = composeSqlDemoRelease(
    mapped,
    normalized.composer.acceptedSupplements,
    { images, documents },
    normalized.composer.ownerDecisions,
  );
  await materializeTarget(target, release, normalized.materializer, rasters);
  let readback: SqlDemoStrapi5Readback;
  try {
    readback = await io.readPublished(target);
  } catch (error) {
    const code = error && typeof error === 'object' && (error as { code?: unknown }).code === 'PUBLISHED_READBACK_FAILED'
      ? 'PUBLISHED_READBACK_FAILED'
      : 'PUBLISHED_READBACK_FAILED';
    throw safeFailure(code, `Published Content API readback failed for target ${name}`);
  }
  return { target, release, readback, rasters };
}

function mapFailure(error: unknown): SqlDemoNativeRehearsalError {
  if (error instanceof SqlDemoNativeRehearsalError) return error;
  return safeFailure('MAPPING_FAILED', 'SQL source mapping or private-input validation failed', sourceIdentity(error));
}

/** Run the pinned public SQL projection against two independently owned local CMS targets. */
export async function runSqlDemoNativeRehearsal(
  input: SqlDemoNativeRehearsalInput,
): Promise<SqlDemoNativeRehearsalResult> {
  // Fence destination before resolving any credential, opening SQL, or creating a CMS client.
  validateTarget(input.target);
  assertLoadedVipsFloor();

  let ownedSqlSourceMayBeRunning = false;
  let primaryError: unknown;
  let result: SqlDemoNativeRehearsalResult | undefined;
  try {
    const mapperOptions = prepareSqlDemoPrivateInputs(input.privateInputConfig);
    let token: string;
    try {
      token = await input.io.resolveCmsToken();
    } catch {
      throw safeFailure('CMS_CREDENTIALS_UNAVAILABLE', 'CMS credential could not be resolved');
    }
    if (typeof token !== 'string' || !token.trim()) throw safeFailure('CMS_CREDENTIALS_UNAVAILABLE', 'CMS credential could not be resolved');

    ownedSqlSourceMayBeRunning = true;
    let source: SqlPublicReaderResult;
    try {
      source = await readSqlPublicSource(input.reader);
    } catch {
      throw safeFailure('SQL_SOURCE_INVALID', 'Pinned read-only SQL source could not be verified');
    }

    let mapped: SqlPublicContentResult;
    let normalized: SqlDemoNormalizedPrivateInputs;
    let assets: SqlDemoAssetLoaderResult;
    try {
      mapped = mapSqlPublicContent(source as SqlPublicSource, mapperOptions);
      normalized = normalizeSqlDemoPrivateInputs({
        config: input.privateInputConfig,
        mapperOptions,
        nativeSqlPublicSource: source as SqlPublicSource,
        mapped,
      });
      assets = await loadSqlDemoAssets({
        ...normalized.loader,
        source,
        selectedPublicHeaders: selectedPublicHeaders(mapped, source.sourceHash),
      });
    } catch (error) {
      throw mapFailure(error);
    }

    const pdfBytes = await readApprovedPdfBytes(assets, input.io);
    let targetA: SqlDemoNativeOwnedTarget;
    try {
      targetA = await input.io.openOwnedTarget({ ...input.target, name: 'A', token });
    } catch {
      throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', 'Owned CMS process for target A could not be started');
    }
    assertOwnedTarget(targetA, 'A', input.target);
    const runA = await importTarget('A', targetA, mapped, normalized, assets, pdfBytes, input.io);

    let targetB: SqlDemoNativeOwnedTarget;
    try {
      targetB = await input.io.openOwnedTarget({ ...input.target, name: 'B', token });
    } catch {
      throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', 'Owned CMS process for target B could not be started');
    }
    assertOwnedTarget(targetB, 'B', input.target);
    assertDistinctTargets(targetA, targetB);
    const runB = await importTarget('B', targetB, mapped, normalized, assets, pdfBytes, input.io);

    assertSqlDemoNativeConservation(runA.release, normalized.materializer, runA.readback, runA.readback);
    assertSqlDemoNativeConservation(runB.release, normalized.materializer, runB.readback, runB.readback);
    assertSqlDemoNativeConservation(runA.release, normalized.materializer, runA.readback, runB.readback);

    let repeatA: SqlDemoNativeOwnedTarget;
    try {
      repeatA = await input.io.createFreshClient(targetA);
    } catch {
      throw safeFailure('REPEAT_A_FAILED', 'Fresh target A CMS client could not be created');
    }
    assertOwnedTarget(repeatA, 'A', input.target);
    if (repeatA.process.pid !== targetA.process.pid || repeatA.client === targetA.client) {
      throw safeFailure('REPEAT_A_FAILED', 'Repeated target A did not use a fresh client for the same owned process');
    }
    let repeatedInventory: unknown;
    try {
      repeatedInventory = await input.io.refreshMediaInventory(repeatA);
    } catch {
      throw safeFailure('REPEAT_A_FAILED', 'Fresh target A media inventory could not be read');
    }
    const repeatedRasters = await uploadRasters(repeatA, repeatedInventory, assets.offlineMedia, input.io);
    sameMediaBindings(runA.rasters, repeatedRasters);
    await materializeTarget(repeatA, runA.release, normalized.materializer, repeatedRasters);
    const repeatedReadback = await input.io.readPublished(repeatA);
    assertSqlDemoNativeConservation(runA.release, normalized.materializer, runA.readback, repeatedReadback);
    sameTargetEntityIdentity(runA.readback, repeatedReadback);

    try {
      await input.io.capture([targetA, targetB]);
    } catch {
      throw safeFailure('CAPTURE_FAILED', 'Native rehearsal evidence could not be captured');
    }
    result = {
      status: 'success',
      sourceHash: source.sourceHash,
      targetCount: 2,
      rasterCount: assets.offlineMedia.length,
      documentCount: assets.offlineDocuments.length,
      repeatedTarget: 'A',
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (ownedSqlSourceMayBeRunning) {
      try {
        await input.io.stopOwnedSqlSource();
      } catch {
        if (primaryError === undefined) primaryError = safeFailure('SQL_SOURCE_CLEANUP_FAILED', 'Owned SQL source could not be stopped');
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (!result) throw safeFailure('REHEARSAL_FAILED', 'Native SQL rehearsal did not produce a result');
  return result;
}
