import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
import { allowedSourceUrl, allowedSqlStorageKey } from './strapi-media-inventory.js';

type TargetName = 'A' | 'B';

export type SqlDemoNativeTargetConfig = {
  baseUrl: string;
  namespace: string;
  dataDirectory: string;
  uploadDirectory: string;
  /** Continue this private prototype target only when its existing media claims are complete. */
  resumeExistingMediaOnly?: boolean;
};

export type SqlDemoNativeSqlSourceLease = { readonly id?: string };

export type SqlDemoNativeOwnedTarget = {
  name: TargetName;
  baseUrl: string;
  namespace: string;
  dataDirectory: string;
  uploadDirectory: string;
  client: unknown;
  /** Concrete process evidence supplied by the owned local-process adapter. */
  process: { pid: number; endpoint: string; namespace: string; dataDirectory: string; uploadDirectory: string };
};

export type SqlDemoNativeUpload = { id: number; url: string; redirected?: boolean };

/** The only injected effects are local process, CMS, and byte-I/O boundaries. */
export interface SqlDemoNativeRehearsalIo {
  resolveCmsToken(): Promise<string>;
  acquireOwnedSqlSource(reader: SqlPublicReaderOptions): Promise<{ lease: SqlDemoNativeSqlSourceLease; reader: SqlPublicReaderOptions }>;
  openOwnedTarget(input: SqlDemoNativeTargetConfig & { name: TargetName; token: string }): Promise<SqlDemoNativeOwnedTarget>;
  stopOwnedTarget(target: SqlDemoNativeOwnedTarget): Promise<void>;
  refreshMediaInventory(target: SqlDemoNativeOwnedTarget): Promise<unknown>;
  readRasterBytes(path: string): Promise<Uint8Array>;
  uploadRaster(target: SqlDemoNativeOwnedTarget, inventory: unknown, proof: SqlDemoOfflineAssetProof, bytes: Uint8Array): Promise<SqlDemoNativeUpload>;
  readStoredMediaBytes(target: SqlDemoNativeOwnedTarget, mediaId: number): Promise<Uint8Array>;
  readPdfBytes(path: string): Promise<Uint8Array>;
  writeStaticDocument(target: SqlDemoNativeOwnedTarget, publicPath: string, bytes: Uint8Array): Promise<void>;
  readStaticDocument(target: SqlDemoNativeOwnedTarget, publicPath: string): Promise<Uint8Array>;
  createFreshClient(target: SqlDemoNativeOwnedTarget): Promise<SqlDemoNativeOwnedTarget>;
  readPublished(target: SqlDemoNativeOwnedTarget): Promise<SqlDemoStrapi5Readback>;
  readDraftContentCounts(target: SqlDemoNativeOwnedTarget): Promise<Record<string, number>>;
  prepareResumeMediaInventory(target: SqlDemoNativeOwnedTarget, proofs: readonly SqlDemoOfflineAssetProof[]): Promise<unknown>;
  capture(targets: readonly SqlDemoNativeOwnedTarget[]): Promise<void>;
  /** Live CMS snapshot; only required by the one-target prototype path. */
  captureLiveSnapshot?(target: SqlDemoNativeOwnedTarget, destination: string): Promise<void>;
  stopOwnedSqlSource(lease: SqlDemoNativeSqlSourceLease): Promise<void>;
}

export interface SqlDemoNativeRehearsalInput {
  reader: SqlPublicReaderOptions;
  privateInputConfig: SqlDemoPrivateInputRootConfig;
  targets: Record<TargetName, SqlDemoNativeTargetConfig>;
  /** Preflight destination fence retained for callers; never used as a target fallback. */
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

export interface SqlDemoNativePrototypeInput {
  reader: SqlPublicReaderOptions;
  privateInputConfig: SqlDemoPrivateInputRootConfig;
  target: SqlDemoNativeTargetConfig;
  snapshotDirectory: string;
  materializeApprovedAssets?: (manifest: SqlDemoNormalizedPrivateInputs['loader']['assetManifest']) => Promise<void>;
  io: SqlDemoNativeRehearsalIo;
}

export interface SqlDemoNativePrototypeResult {
  status: 'single-target-prototype-success';
  sourceHash: string;
  target: 'A';
  collectionCounts: Record<string, number>;
  rasterCount: number;
  documentCount: number;
  mediaCount: number;
  targetLocationCounts: { organizationInfo: number; instituteAdditionalInfo: number; documents: number };
  sourceUrlClassification: {
    approvedRelativeCount: number;
    verifiedStorageKeyCount: number;
    validAbsoluteCount: number;
    invalidCount: number;
    firstClass: 'approved-relative' | 'verified-storage-key' | 'valid-absolute' | 'invalid' | 'none';
  };
}

const APPROVED_RELATIVE_MEDIA_URLS = new Set([
  '/media/legacy/logo-v2.png',
  '/media/legacy/logo-upledger-inst.png',
  '/media/legacy/logo-barral-inst.png',
]);

export function classifyMediaSourceUrls(values: readonly string[]): SqlDemoNativePrototypeResult['sourceUrlClassification'] {
  let approvedRelativeCount = 0;
  let verifiedStorageKeyCount = 0;
  let validAbsoluteCount = 0;
  let invalidCount = 0;
  let firstClass: SqlDemoNativePrototypeResult['sourceUrlClassification']['firstClass'] = 'none';
  values.forEach((value, index) => {
    const kind = APPROVED_RELATIVE_MEDIA_URLS.has(value)
      ? 'approved-relative'
      : allowedSqlStorageKey(value) ? 'verified-storage-key'
        : allowedSourceUrl(value) ? 'valid-absolute' : 'invalid';
    if (index === 0) firstClass = kind;
    if (kind === 'approved-relative') approvedRelativeCount += 1;
    else if (kind === 'verified-storage-key') verifiedStorageKeyCount += 1;
    else if (kind === 'valid-absolute') validAbsoluteCount += 1;
    else invalidCount += 1;
  });
  return { approvedRelativeCount, verifiedStorageKeyCount, validAbsoluteCount, invalidCount, firstClass };
}

export class SqlDemoNativeRehearsalError extends Error {
  readonly code: string;
  readonly identity?: string;
  readonly diagnostic?: { causeCategory: string; frames: string[]; signals?: Record<string, number> };

  constructor(code: string, message: string, identity?: string, diagnostic?: { causeCategory: string; frames: string[]; signals?: Record<string, number> }) {
    super(message);
    this.name = 'SqlDemoNativeRehearsalError';
    this.code = code;
    if (identity) this.identity = identity;
    if (diagnostic) this.diagnostic = diagnostic;
  }
}

type LoadedRaster = {
  upload: SqlDemoNativeUpload;
  sourceHash: string;
  storedHash: string;
  sourceIdentity: string;
};

type TargetRun = {
  release: SqlDemoRelease;
  readback: SqlDemoStrapi5Readback;
  rasters: Map<string, LoadedRaster>;
};

const HASH = /^[a-f\d]{64}$/i;
const TARGET_NAMESPACE = /^ikpk_sql_demo_native(?:_[a-z0-9]+)?$/;

function safeFailure(code: string, message: string, identity?: string, diagnostic?: { causeCategory: string; frames: string[]; signals?: Record<string, number> }): SqlDemoNativeRehearsalError {
  return new SqlDemoNativeRehearsalError(code, message, identity, diagnostic);
}

function safeDiagnostic(error: unknown): { causeCategory: string; frames: string[]; signals?: Record<string, number> } {
  const causeCategory = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : 'unknown-error';
  const stack = error instanceof Error ? error.stack ?? '' : '';
  const frames = [...new Set(stack.split(/\r?\n/).map((line) =>
    line.match(/((?:sql-demo-[A-Za-z0-9-]+|sql-public-reader)\.ts):(\d+):(\d+)/)?.slice(1).join(':')).filter((frame): frame is string => Boolean(frame)))];
  const organizationInfo = error instanceof Error
    ? error.message.match(/one exact static-page DOM position and title \(domMatches=(\d+), exactTitleMatches=(\d+)\)/)
    : null;
  const videoAssociation = error instanceof Error
    ? error.message.match(/video decision source association mismatch \(sourceRow=(true|false), mappedRow=(true|false), sourceUrlMatch=(true|false), mappedUrlMatch=(true|false), sourceSlugMatches=(true|false)\)/)
    : null;
  const assetInventory = error instanceof Error
    ? error.message.match(/approved archive inventory mismatch \(count=(\d+), missing=(\d+), replacementMissing=(\d+), otherMissing=(\d+), ambiguous=(\d+), unexpectedExisting=(\d+)\)/)
    : null;
  return {
    causeCategory,
    frames,
    ...((error as { safeHttpStatus?: unknown } | null)?.safeHttpStatus && Number.isSafeInteger((error as { safeHttpStatus: number }).safeHttpStatus)
      ? { signals: { httpStatus: (error as { safeHttpStatus: number }).safeHttpStatus } }
      : {}),
    ...(organizationInfo ? { signals: { domMatches: Number(organizationInfo[1]), exactTitleMatches: Number(organizationInfo[2]) } } : {}),
    ...(videoAssociation ? { signals: {
      sourceRow: Number(videoAssociation[1] === 'true'),
      mappedRow: Number(videoAssociation[2] === 'true'),
      sourceUrlMatch: Number(videoAssociation[3] === 'true'),
      mappedUrlMatch: Number(videoAssociation[4] === 'true'),
      sourceSlugMatches: Number(videoAssociation[5] === 'true'),
    } } : {}),
    ...(assetInventory ? { signals: {
      archiveEntryCount: Number(assetInventory[1]),
      missingEntryCount: Number(assetInventory[2]),
      missingApprovedReplacementCount: Number(assetInventory[3]),
      missingOtherEntryCount: Number(assetInventory[4]),
      ambiguousArchiveMemberCount: Number(assetInventory[5]),
      unexpectedExistingFileCount: Number(assetInventory[6]),
    } } : {}),
  };
}

function loopbackOrigin(target: { baseUrl: string; namespace: string }): URL {
  let url: URL;
  try {
    url = new URL(target.baseUrl);
  } catch {
    throw safeFailure('INVALID_TARGET', 'Target must be the owned loopback CMS endpoint');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !TARGET_NAMESPACE.test(target.namespace)) {
    throw safeFailure('INVALID_TARGET', 'Target must be the owned loopback CMS endpoint');
  }
  return url;
}

function validateTarget(target: SqlDemoNativeRehearsalInput['target']): void {
  loopbackOrigin(target);
}

function validateTargets(targets: SqlDemoNativeRehearsalInput['targets']): void {
  const configs = [targets?.A, targets?.B];
  if (configs.some((config) => !config || typeof config.dataDirectory !== 'string' || !config.dataDirectory.trim()
    || typeof config.uploadDirectory !== 'string' || !config.uploadDirectory.trim())) {
    throw safeFailure('INVALID_TARGET', 'Both owned loopback targets require isolated storage locations');
  }
  const [a, b] = configs as SqlDemoNativeTargetConfig[];
  const originA = loopbackOrigin(a);
  const originB = loopbackOrigin(b);
  const directories = [a.dataDirectory, a.uploadDirectory, b.dataDirectory, b.uploadDirectory];
  const pathsOverlap = (left: string, right: string): boolean => {
    const leftToRight = relative(resolve(left), resolve(right));
    const rightToLeft = relative(resolve(right), resolve(left));
    return leftToRight === '' || rightToLeft === ''
      || (!isAbsolute(leftToRight) && leftToRight !== '..' && !leftToRight.startsWith(`..${sep}`))
      || (!isAbsolute(rightToLeft) && rightToLeft !== '..' && !rightToLeft.startsWith(`..${sep}`));
  };
  const distinct = originA.origin !== originB.origin
    && a.namespace !== b.namespace
    && directories.every((directory) => isAbsolute(directory))
    && directories.every((directory, index) => directories.slice(index + 1).every((other) => !pathsOverlap(directory, other)));
  if (!distinct) throw safeFailure('INVALID_TARGET', 'Targets A and B must have distinct origins, namespaces, and storage locations');
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
  expected: SqlDemoNativeTargetConfig,
): void {
  const process = target?.process;
  if (target?.name !== name || target.baseUrl !== expected.baseUrl || target.namespace !== expected.namespace
    || target.dataDirectory !== expected.dataDirectory || target.uploadDirectory !== expected.uploadDirectory
    || !process || !Number.isSafeInteger(process.pid) || process.pid <= 0
    || process.endpoint !== expected.baseUrl || process.namespace !== expected.namespace
    || process.dataDirectory !== expected.dataDirectory || process.uploadDirectory !== expected.uploadDirectory) {
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

function validateUpload(upload: SqlDemoNativeUpload, target: SqlDemoNativeOwnedTarget, sourceFileId: string): void {
  let url: URL | undefined;
  try {
    if (upload.url.startsWith('/')) url = new URL(upload.url, target.baseUrl);
    else url = new URL(upload.url);
  } catch {
    // Report a bounded error without reflecting an untrusted CMS URL.
  }
  const pathSegments = url?.pathname.split('/').map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }) ?? [];
  if (!Number.isSafeInteger(upload.id) || upload.id <= 0 || !url || !url.pathname.startsWith('/uploads/')
    || pathSegments.some((segment) => segment === '..' || segment === '.' || segment.includes('/') || segment.includes('\\'))
    || url.origin !== new URL(target.baseUrl).origin || url.username || url.password || url.search || url.hash
    || upload.redirected === true) {
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
    const expectedHash = 'sourceBytesAvailable' in proof
      ? proof.substitution.replacementSha256
      : proof.sourceSha256;
    if (!HASH.test(expectedHash)) {
      throw safeFailure('MEDIA_BINDING_FAILED', 'Approved raster has no valid source byte pin', `Files#${proof.sourceFileId}`);
    }
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = await io.readRasterBytes(proof.resolvedLocalPath);
    } catch {
      throw safeFailure('MEDIA_SOURCE_BYTES_INVALID', 'Approved raster bytes could not be read from the loader-resolved path', `Files#${proof.sourceFileId}`);
    }
    const sourceHash = sha256(sourceBytes);
    if (sourceHash !== expectedHash.toLowerCase()) {
      throw safeFailure('MEDIA_SOURCE_BYTES_INVALID', 'Raster bytes do not match the loader source or approved replacement pin', `Files#${proof.sourceFileId}`);
    }
    let upload: SqlDemoNativeUpload;
    try {
      upload = await io.uploadRaster(target, inventory, proof, sourceBytes);
      validateUpload(upload, target, proof.sourceFileId);
    } catch (error) {
      if (error instanceof SqlDemoNativeRehearsalError) throw error;
      throw safeFailure('MEDIA_BINDING_FAILED', 'CMS raster upload failed', `Files#${proof.sourceFileId}`, safeDiagnostic(error));
    }
    let storedHash: string;
    try {
      const storedBytes = await io.readStoredMediaBytes(target, upload.id);
      storedHash = sha256(storedBytes);
    } catch {
      throw safeFailure('MEDIA_BINDING_FAILED', 'Stored CMS raster bytes could not be independently verified', `Files#${proof.sourceFileId}`);
    }
    result.set(proof.sourceFileId, {
      upload,
      sourceHash: sourceHash.toLowerCase(),
      storedHash,
      sourceIdentity: `Files#${proof.sourceFileId}`,
    });
  }
  return result;
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
  const expectedPath = `/static-files/documents/${proof.sourceSha256}.pdf`;
  if (!document || !location?.publicDocumentPath || document.url !== proof.sourceUrl || location.publicDocumentPath !== expectedPath) {
    throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved PDF has no matching SQL binding and pinned public path', `Files#${proof.sourceFileId}`);
  }
  const segments = location.publicDocumentPath.split('/');
  const decodedSegments = segments.map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  if (!location.publicDocumentPath.startsWith('/static-files/') || decodedSegments.some((segment) => segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))
    || location.publicDocumentPath.includes('?') || location.publicDocumentPath.includes('#') || location.publicDocumentPath.includes('\\')) {
    throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved PDF path is not a safe static document location', `Files#${proof.sourceFileId}`);
  }
  return location.publicDocumentPath;
}

function validateTargetLocationBindings(mapped: SqlPublicContentResult, normalized: SqlDemoNormalizedPrivateInputs): SqlDemoNativePrototypeResult['targetLocationCounts'] {
  const locations = normalized.composer.acceptedSupplements.targetLocations;
  const locationFor = (table: typeof locations[number]['sourceTable'], id: number) => {
    const matches = locations.filter((item) => item.sourceTable === table && item.sourceId === id);
    if (matches.length !== 1) throw safeFailure('MAPPING_FAILED', 'Mapped SQL identity has no unique accepted target location', `${table}#${id}`);
    return matches[0]!;
  };
  for (const row of mapped.entities.organizationInfo ?? []) {
    const location = locationFor('OrganizationInfo', row.sourceId);
    if (location.targetCollection !== 'pages' || location.targetField !== 'body' || !location.anchor) {
      throw safeFailure('MAPPING_FAILED', 'OrganizationInfo target location is incomplete', `OrganizationInfo#${row.sourceId}`);
    }
  }
  const instituteBySourceId = new Map((mapped.entities.institutes ?? []).map((row) => [row.sourceId, row]));
  for (const row of mapped.entities.instituteAdditionalInfo ?? []) {
    const location = locationFor('InstituteAdditionalInfo', row.sourceId);
    if (!Number.isSafeInteger(row.instituteId) || (row.instituteId as number) <= 0) {
      throw safeFailure('MAPPING_FAILED', 'InstituteAdditionalInfo source parent ID is invalid', `InstituteAdditionalInfo#${row.sourceId}`);
    }
    const institute = instituteBySourceId.get(row.instituteId as number);
    if (!institute || location.targetCollection !== 'institutes' || location.targetField !== 'description'
      || location.targetLegacyId !== institute.legacy_id || location.anchor !== `institute-section-${row.sourceId}`) {
      throw safeFailure('MAPPING_FAILED', 'InstituteAdditionalInfo target does not match its exact SQL parent', `InstituteAdditionalInfo#${row.sourceId}`);
    }
  }
  for (const row of mapped.entities.documents ?? []) {
    const location = locationFor('FileBindingOrganizationInfo', row.bindingSourceId);
    const organization = locationFor('OrganizationInfo', row.organizationInfoSourceId);
    const proof = normalized.loader.assetManifest.entries.find((entry) => entry.sourceFileId === row.fileId && entry.sourceFileType === 'document');
    const expectedPath = proof ? `/static-files/documents/${proof.sha256}.pdf` : '';
    if (location.targetCollection !== 'pages' || location.targetField !== 'body'
      || location.targetLegacyId !== organization.targetLegacyId || location.anchor !== organization.anchor
      || location.sectionKey !== organization.sectionKey || location.publicDocumentPath !== expectedPath) {
      throw safeFailure('MAPPING_FAILED', 'PDF target location does not match its exact SQL file binding', `Files#${row.fileId}`);
    }
  }
  const expectedCounts = [
    ['OrganizationInfo', mapped.entities.organizationInfo?.length ?? 0],
    ['InstituteAdditionalInfo', mapped.entities.instituteAdditionalInfo?.length ?? 0],
    ['FileBindingOrganizationInfo', mapped.entities.documents?.length ?? 0],
  ] as const;
  for (const [table, count] of expectedCounts) {
    if (locations.filter((item) => item.sourceTable === table).length !== count) {
      throw safeFailure('MAPPING_FAILED', 'Accepted target location inventory has unexpected or unused entries', table);
    }
  }
  return {
    organizationInfo: expectedCounts[0][1],
    instituteAdditionalInfo: expectedCounts[1][1],
    documents: expectedCounts[2][1],
  };
}

async function verifyPublishedPdf(
  target: SqlDemoNativeOwnedTarget,
  proof: SqlDemoOfflineDocumentProof,
  publicPath: string,
  io: SqlDemoNativeRehearsalIo,
): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readStaticDocument(target, publicPath);
  } catch {
    throw safeFailure('DOCUMENT_BYTES_INVALID', 'Published static document could not be independently read', `Files#${proof.sourceFileId}`);
  }
  validatePdfBytes(proof, bytes);
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
  prevalidatedInventory?: unknown,
): Promise<TargetRun> {
  let inventory: unknown;
  if (prevalidatedInventory !== undefined) inventory = prevalidatedInventory;
  else {
    try {
      inventory = await io.refreshMediaInventory(target);
    } catch {
      throw safeFailure('MEDIA_INVENTORY_FAILED', `Fresh media inventory could not be read for target ${name}`);
    }
  }
  const rasters = await uploadRasters(target, inventory, assets.offlineMedia, io);
  for (const document of assets.offlineDocuments) {
    const bytes = pdfBytes.get(document.sourceFileId);
    if (!bytes) throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved document bytes were not retained for publication', `Files#${document.sourceFileId}`);
    const publicPath = publicDocumentPath(document, mapped, normalized);
    try {
      await io.writeStaticDocument(target, publicPath, bytes);
    } catch (error) {
      throw safeFailure('DOCUMENT_PUBLISH_FAILED', 'Approved static document could not be published', `Files#${document.sourceFileId}`, safeDiagnostic(error));
    }
    await verifyPublishedPdf(target, document, publicPath, io);
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
  } catch {
    throw safeFailure('PUBLISHED_READBACK_FAILED', `Published Content API readback failed for target ${name}`);
  }
  return { release, readback, rasters };
}

function mapFailure(error: unknown): SqlDemoNativeRehearsalError {
  if (error instanceof SqlDemoNativeRehearsalError) return error;
  return safeFailure('MAPPING_FAILED', 'SQL source mapping or private-input validation failed', sourceIdentity(error), safeDiagnostic(error));
}

/** Run the pinned public SQL projection against two independently owned local CMS targets. */
export async function runSqlDemoNativeRehearsal(
  input: SqlDemoNativeRehearsalInput,
): Promise<SqlDemoNativeRehearsalResult> {
  // Fence every destination before resolving credentials, opening SQL, or creating CMS clients.
  validateTarget(input.target);
  validateTargets(input.targets);
  assertLoadedVipsFloor();

  let sqlSourceLease: SqlDemoNativeSqlSourceLease | undefined;
  const ownedTargets: SqlDemoNativeOwnedTarget[] = [];
  const captureTargets: SqlDemoNativeOwnedTarget[] = [];
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

    let leasedReader: SqlPublicReaderOptions;
    let source: SqlPublicReaderResult;
    try {
      const acquired = await input.io.acquireOwnedSqlSource(input.reader);
      sqlSourceLease = acquired.lease;
      leasedReader = acquired.reader;
      source = await readSqlPublicSource(leasedReader);
    } catch (error) {
      throw safeFailure('SQL_SOURCE_INVALID', 'Pinned read-only SQL source could not be verified', undefined, safeDiagnostic(error));
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
      targetA = await input.io.openOwnedTarget({ ...input.targets.A, name: 'A', token });
      ownedTargets.push(targetA);
    } catch {
      throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', 'Owned CMS process for target A could not be started');
    }
    assertOwnedTarget(targetA, 'A', input.targets.A);
    const runA = await importTarget('A', targetA, mapped, normalized, assets, pdfBytes, input.io);

    let targetB: SqlDemoNativeOwnedTarget;
    try {
      targetB = await input.io.openOwnedTarget({ ...input.targets.B, name: 'B', token });
      ownedTargets.push(targetB);
    } catch {
      throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', 'Owned CMS process for target B could not be started');
    }
    assertOwnedTarget(targetB, 'B', input.targets.B);
    assertDistinctTargets(targetA, targetB);
    const runB = await importTarget('B', targetB, mapped, normalized, assets, pdfBytes, input.io);

    assertSqlDemoNativeConservation(runA.release, normalized.materializer, runA.readback, runA.readback);
    assertSqlDemoNativeConservation(runB.release, normalized.materializer, runB.readback, runB.readback);
    assertSqlDemoNativeConservation(runA.release, normalized.materializer, runA.readback, runB.readback);
    captureTargets.push(targetA, targetB);

    let repeatA: SqlDemoNativeOwnedTarget;
    try {
      repeatA = await input.io.createFreshClient(targetA);
    } catch {
      throw safeFailure('REPEAT_A_FAILED', 'Fresh target A CMS client could not be created');
    }
    assertOwnedTarget(repeatA, 'A', input.targets.A);
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
    for (const document of assets.offlineDocuments) {
      await verifyPublishedPdf(repeatA, document, publicDocumentPath(document, mapped, normalized), input.io);
    }
    const repeatedReadback = await input.io.readPublished(repeatA);
    assertSqlDemoNativeConservation(runA.release, normalized.materializer, runA.readback, repeatedReadback);
    sameTargetEntityIdentity(runA.readback, repeatedReadback);

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
    for (const target of [...ownedTargets].reverse()) {
      try {
        await input.io.stopOwnedTarget(target);
      } catch {
        if (primaryError === undefined) primaryError = safeFailure('TARGET_CLEANUP_FAILED', `Owned CMS target ${target.name} could not be stopped`);
      }
    }
    if (sqlSourceLease !== undefined) {
      try {
        await input.io.stopOwnedSqlSource(sqlSourceLease);
      } catch {
        if (primaryError === undefined) primaryError = safeFailure('SQL_SOURCE_CLEANUP_FAILED', 'Owned SQL source could not be stopped');
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (!result) throw safeFailure('REHEARSAL_FAILED', 'Native SQL rehearsal did not produce a result');
  try {
    await input.io.capture(captureTargets);
  } catch {
    throw safeFailure('CAPTURE_FAILED', 'Native rehearsal evidence could not be captured');
  }
  return result;
}

/** Import and read back exactly one owned local CMS target for the approved prototype path. */
export async function runSqlDemoNativePrototype(
  input: SqlDemoNativePrototypeInput,
): Promise<SqlDemoNativePrototypeResult> {
  validateTarget(input.target);
  if (!isAbsolute(input.snapshotDirectory)) throw safeFailure('SNAPSHOT_DESTINATION_INVALID', 'Prototype snapshot destination must be an absolute private path');
  assertLoadedVipsFloor();
  let sqlSourceLease: SqlDemoNativeSqlSourceLease | undefined;
  let target: SqlDemoNativeOwnedTarget | undefined;
  let primaryError: unknown;
  let result: SqlDemoNativePrototypeResult | undefined;
  try {
    const mapperOptions = prepareSqlDemoPrivateInputs(input.privateInputConfig);
    let token: string;
    try {
      token = await input.io.resolveCmsToken();
    } catch {
      throw safeFailure('CMS_CREDENTIALS_UNAVAILABLE', 'CMS credential could not be resolved');
    }
    if (typeof token !== 'string' || !token.trim()) throw safeFailure('CMS_CREDENTIALS_UNAVAILABLE', 'CMS credential could not be resolved');

    let source: SqlPublicReaderResult;
    try {
      const acquired = await input.io.acquireOwnedSqlSource(input.reader);
      sqlSourceLease = acquired.lease;
      source = await readSqlPublicSource(acquired.reader);
    } catch (error) {
      throw safeFailure('SQL_SOURCE_INVALID', 'Pinned read-only SQL source could not be verified', undefined, safeDiagnostic(error));
    }

    let mapped: SqlPublicContentResult;
    let normalized: SqlDemoNormalizedPrivateInputs;
    let assets: SqlDemoAssetLoaderResult;
    let targetLocationCounts: SqlDemoNativePrototypeResult['targetLocationCounts'];
    try {
      mapped = mapSqlPublicContent(source as SqlPublicSource, mapperOptions);
      normalized = normalizeSqlDemoPrivateInputs({
        config: input.privateInputConfig,
        mapperOptions,
        nativeSqlPublicSource: source as SqlPublicSource,
        mapped,
      });
      targetLocationCounts = validateTargetLocationBindings(mapped, normalized);
      if (input.materializeApprovedAssets) await input.materializeApprovedAssets(normalized.loader.assetManifest);
      assets = await loadSqlDemoAssets({
        ...normalized.loader,
        materializedReplacementRoot: normalized.loader.assetRoot,
      });
    } catch (error) {
      throw mapFailure(error);
    }

    const sourceUrlClassification = classifyMediaSourceUrls(assets.offlineMedia.map((proof) => proof.sourceUrl));
    if (sourceUrlClassification.invalidCount > 0) {
      throw safeFailure('MEDIA_SOURCE_URL_INVALID', 'Approved media source identities failed the offline URL classification', undefined, {
        causeCategory: 'SqlDemoMediaSourceUrlClassification', frames: [],
        signals: {
          approvedRelativeCount: sourceUrlClassification.approvedRelativeCount,
          verifiedStorageKeyCount: sourceUrlClassification.verifiedStorageKeyCount,
          validAbsoluteCount: sourceUrlClassification.validAbsoluteCount,
          invalidCount: sourceUrlClassification.invalidCount,
          firstApprovedRelative: Number(sourceUrlClassification.firstClass === 'approved-relative'),
          firstVerifiedStorageKey: Number(sourceUrlClassification.firstClass === 'verified-storage-key'),
          firstValidAbsolute: Number(sourceUrlClassification.firstClass === 'valid-absolute'),
          firstInvalid: Number(sourceUrlClassification.firstClass === 'invalid'),
        },
      });
    }

    // Verify every source path and byte pin before installing or booting the target CMS.
    for (const proof of assets.offlineMedia) {
      let bytes: Uint8Array;
      try { bytes = await input.io.readRasterBytes(proof.resolvedLocalPath); }
      catch { throw safeFailure('MEDIA_SOURCE_BYTES_INVALID', 'Approved media bytes are not available from the private pinned asset root', `Files#${proof.sourceFileId}`); }
      const expected = 'substitution' in proof && proof.substitution ? proof.substitution.replacementSha256 : proof.sourceSha256;
      if (createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) {
        throw safeFailure('MEDIA_SOURCE_BYTES_INVALID', 'Approved media bytes do not match their private source pin', `Files#${proof.sourceFileId}`);
      }
    }

    const pdfBytes = await readApprovedPdfBytes(assets, input.io);
    // Exercise the complete public composer before CMS startup. The raster URLs are
    // deliberately inert placeholders: this output is validation-only and is never
    // materialized or treated as target evidence.
    try {
      const preflightImages = assets.offlineMedia.map((proof) =>
        verifiedMapping(proof, `https://prototype-preflight.invalid/uploads/${proof.sourceFileId}.${proof.detectedExtension}`));
      const preflightDocuments = assets.offlineDocuments.map((proof) => ({
        sourceFileId: proof.sourceFileId,
        sourceUrl: proof.sourceUrl,
        targetPublicUrl: publicDocumentPath(proof, mapped, normalized),
        sha256: proof.sourceSha256,
        detectedMimeType: proof.detectedMimeType,
        verification: proof.verification,
      }));
      composeSqlDemoRelease(
        mapped,
        normalized.composer.acceptedSupplements,
        { images: preflightImages, documents: preflightDocuments },
        normalized.composer.ownerDecisions,
      );
    } catch (error) {
      throw safeFailure('COMPOSITION_PREFLIGHT_FAILED', 'Approved content failed full release composition before target startup', undefined, safeDiagnostic(error));
    }
    try {
      target = await input.io.openOwnedTarget({ ...input.target, name: 'A', token });
    } catch {
      throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', 'Owned CMS process for prototype target A could not be started');
    }
    assertOwnedTarget(target, 'A', input.target);
    if (input.target.resumeExistingMediaOnly) {
      let priorReadback: SqlDemoStrapi5Readback;
      let draftCounts: Record<string, number>;
      try { priorReadback = await input.io.readPublished(target); }
      catch (error) { throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Existing prototype content inventory could not be verified before continuation', undefined, safeDiagnostic(error)); }
      const existingContentCount = Object.values(priorReadback.collections).reduce((sum, rows) => sum + (rows?.length ?? 0), 0);
      try { draftCounts = await input.io.readDraftContentCounts(target); }
      catch (error) { throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Existing prototype draft inventory could not be verified before continuation', undefined, safeDiagnostic(error)); }
      const existingDraftCount = Object.values(draftCounts).reduce((sum, count) => sum + count, 0);
      if (existingContentCount !== 0 || existingDraftCount !== 0) throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Existing prototype target contains content rows and is not a media-only checkpoint');
    }
    let priorMediaInventory: unknown;
    if (input.target.resumeExistingMediaOnly) {
      try { priorMediaInventory = await input.io.prepareResumeMediaInventory(target, assets.offlineMedia); }
      catch (error) { throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Persisted prototype media claims do not exactly match the approved raster set', undefined, safeDiagnostic(error)); }
    }
    const imported = await importTarget('A', target, mapped, normalized, assets, pdfBytes, input.io, priorMediaInventory);
    assertSqlDemoNativeConservation(imported.release, normalized.materializer, imported.readback, imported.readback);

    if (!input.io.captureLiveSnapshot) throw safeFailure('LIVE_SNAPSHOT_UNAVAILABLE', 'Prototype adapter does not provide live CMS snapshot capture');
    try {
      await input.io.captureLiveSnapshot(target, resolve(input.snapshotDirectory));
    } catch {
      throw safeFailure('LIVE_SNAPSHOT_FAILED', 'Live CMS snapshot or static-file projection failed');
    }

    result = {
      status: 'single-target-prototype-success',
      sourceHash: source.sourceHash,
      target: 'A',
      collectionCounts: Object.fromEntries(Object.entries(imported.readback.collections).map(([name, rows]) => [name, rows?.length ?? 0])),
      rasterCount: assets.offlineMedia.length,
      documentCount: assets.offlineDocuments.length,
      mediaCount: imported.readback.media.length,
      targetLocationCounts,
      sourceUrlClassification,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (target) {
      try {
        await input.io.stopOwnedTarget(target);
      } catch {
        if (primaryError === undefined) primaryError = safeFailure('TARGET_CLEANUP_FAILED', 'Owned prototype CMS target A could not be stopped');
      }
    }
    if (sqlSourceLease !== undefined) {
      try {
        await input.io.stopOwnedSqlSource(sqlSourceLease);
      } catch {
        if (primaryError === undefined) primaryError = safeFailure('SQL_SOURCE_CLEANUP_FAILED', 'Owned SQL source could not be stopped');
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (!result) throw safeFailure('REHEARSAL_FAILED', 'Single-target prototype did not produce a result');
  try {
    if (!target) throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', 'Prototype target A was not retained for evidence capture');
    await input.io.capture([target]);
  } catch {
    throw safeFailure('CAPTURE_FAILED', 'Single-target prototype evidence could not be captured');
  }
  return result;
}
