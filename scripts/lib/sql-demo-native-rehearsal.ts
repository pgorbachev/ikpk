import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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
import type { SqlMaterializerOptions, SqlMaterializerProjectionRecord, SqlResolvedMedia, SqlStrapiRestClient } from './sql-public-materializer.js';
import { materializeSqlPublicContent, projectSqlPublicContentForConservation } from './sql-public-materializer.js';
import { checkPublication } from './cms-publication-validation.js';
const demo193SourceEmptyFields = createRequire(import.meta.url)('../../cms/src/lib/demo193-source-empty-fields.json') as {
  sourceSqlSha256: string;
  entries: { type: string; legacyId: string; slug: string; fields: string[] }[];
};
import { allowedSourceUrl, allowedSqlStorageKey } from './strapi-media-inventory.js';

type TargetName = 'A' | 'B';

export type SqlDemoNativeTargetConfig = {
  baseUrl: string;
  namespace: string;
  dataDirectory: string;
  uploadDirectory: string;
  /** Continue this private prototype target only when media and draft identities are exact approved subsets. */
  resumeExistingMediaOnly?: boolean;
};

export type SqlDemoNativeDraftIdentity = { legacyId: string; documentId: string; slug?: string };

type PrototypeExpectedIdentities = ReadonlyMap<string, ReadonlyMap<string, string | undefined>>;

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
  verifyExistingStaticDocuments(documents: readonly { publicPath: string; bytes: Uint8Array }[]): Promise<void>;
  writeStaticDocument(target: SqlDemoNativeOwnedTarget, publicPath: string, bytes: Uint8Array): Promise<void>;
  readStaticDocument(target: SqlDemoNativeOwnedTarget, publicPath: string): Promise<Uint8Array>;
  createFreshClient(target: SqlDemoNativeOwnedTarget): Promise<SqlDemoNativeOwnedTarget>;
  readPublished(target: SqlDemoNativeOwnedTarget): Promise<SqlDemoStrapi5Readback>;
  readDraftContentIdentities(target: SqlDemoNativeOwnedTarget): Promise<Record<string, readonly SqlDemoNativeDraftIdentity[]>>;
  prepareResumeMediaInventory(target: SqlDemoNativeOwnedTarget, proofs: readonly SqlDemoOfflineAssetProof[]): Promise<unknown>;
  capture(targets: readonly SqlDemoNativeOwnedTarget[]): Promise<void>;
  /** Live CMS snapshot; only required by the one-target prototype path. */
  captureLiveSnapshot?(target: SqlDemoNativeOwnedTarget, destination: string): Promise<void>;
  /** Persist the complete live API readback under the private artifact root before conservation. */
  persistReadback?(target: SqlDemoNativeOwnedTarget, readback: SqlDemoStrapi5Readback): Promise<{ path: string; sha256: string; bytes: number }>;
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
  /** Reconcile the already-imported, source-pinned single-A dataset without issuing writes. */
  readbackOnly?: boolean;
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
  publicationScan: { planCount: number; exceptionCount: number; exceptionsByField: Record<string, number> };
  sourceUrlClassification: {
    approvedRelativeCount: number;
    verifiedStorageKeyCount: number;
    validAbsoluteCount: number;
    invalidCount: number;
    firstClass: 'approved-relative' | 'verified-storage-key' | 'valid-absolute' | 'invalid' | 'none';
  };
  readbackArtifact?: { path: string; sha256: string; bytes: number };
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
  readonly diagnostic?: { causeCategory: string; frames: string[]; signals?: Record<string, number>; sourceIdentity?: string; field?: string; networkCode?: string };

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
const PROTOTYPE_COLLECTIONS = ['institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries', 'articles', 'news-items', 'promotions', 'video-playlists', 'pages'] as const;
const DEMO193_SOURCE_SQL_SHA256 = 'b7b056d6a226b9caed224c737dad18dc366d47a0ec397e0ef0f1c66f61762be2';
type Demo193EmptyField = 'description' | 'seo_title' | 'seo_description';
type Demo193SourceEmptyEntry = { type: string; legacyId: string; slug: string; fields: Demo193EmptyField[] };

const PUBLICATION_TYPE_BY_COLLECTION: Record<string, string> = {
  institutes: 'institute',
  'course-groups': 'course-group',
  teachers: 'person',
  seminars: 'seminar',
  'schedule-entries': 'schedule-entry',
  articles: 'article',
  'news-items': 'news-item',
  promotions: 'promotion',
  'video-playlists': 'video-playlist',
  pages: 'static-page',
};

function publicationRecordForPlan(plan: SqlMaterializerProjectionRecord): Record<string, unknown> {
  const attributes = plan.attributes;
  const seo = attributes.seo && typeof attributes.seo === 'object'
    ? attributes.seo as Record<string, unknown>
    : {};
  const relationValue = (field: string): unknown => {
    const relation = plan.relations.find((candidate) => candidate.field === field);
    if (!relation?.legacyIds.length) return [];
    return relation.legacyIds.map((legacyId) => ({ legacy_id: legacyId }));
  };
  const commonSeo = { seo_title: seo.seo_title, seo_description: seo.seo_description };
  switch (plan.collection) {
    case 'institutes':
      return { name: attributes.name, identifier: attributes.slug, description: attributes.description, order: attributes.order, ...commonSeo };
    case 'course-groups':
      return { name: attributes.name, identifier: attributes.slug, institute: relationValue('institute'), description: attributes.description, ...commonSeo };
    case 'teachers':
      return { name: attributes.name, identifier: attributes.slug, trait: attributes.trait };
    case 'seminars':
      return {
        name: attributes.name, identifier: attributes.slug, course_group: relationValue('course_group'),
        description: attributes.description, documentsState: attributes.documents_state,
        documents: attributes.documents, ...commonSeo,
      };
    case 'schedule-entries':
      return {
        seminar: relationValue('seminar'), startAt: attributes.startAt, endAt: attributes.endAt,
        city: attributes.city, status: attributes.entry_status,
      };
    case 'articles':
      return {
        title: attributes.title, identifier: attributes.slug, body: attributes.body,
        image: plan.image?.sourceId, published_at: attributes.published_date,
        categories: relationValue('categories'), ...commonSeo,
      };
    case 'video-playlists':
      return { title: attributes.name, identifier: attributes.slug };
    case 'pages':
      return { title: attributes.title, identifier: attributes.slug, body: attributes.body, ...commonSeo };
    case 'news-items':
      return { title: attributes.name, date: attributes.date, body: attributes.description };
    case 'promotions':
      return { title: attributes.name, date: attributes.date, body: attributes.description };
    default:
      return {};
  }
}

/** Validate every composed CMS publication payload and bind the approved empty fields to exact source identities. */
export function validatePrototypePublicationPlans(
  plans: readonly SqlMaterializerProjectionRecord[],
  sourceSqlSha256: string,
): { planCount: number; exceptionCount: number; exceptionsByField: Record<string, number> } {
  const sourceSqlHash = sourceSqlSha256.replace(/^sha256:/, '');
  if (
    sourceSqlHash !== DEMO193_SOURCE_SQL_SHA256 ||
    demo193SourceEmptyFields.sourceSqlSha256 !== DEMO193_SOURCE_SQL_SHA256
  ) throw new Error('Demo193 publication exception source pin does not match the composed SQL source');

  const entries = demo193SourceEmptyFields.entries as Demo193SourceEmptyEntry[];
  const allowlist = new Map(entries.map((entry) => [`${entry.type}\0${entry.legacyId}\0${entry.slug}`, entry]));
  const used = new Set<string>();
  const exceptionsByField: Record<string, number> = {};
  for (const plan of plans) {
    const type = PUBLICATION_TYPE_BY_COLLECTION[plan.collection];
    if (!type) throw new Error('Composed release has an unsupported publication collection');
    const record = publicationRecordForPlan(plan);
    const verdict = checkPublication({ type, record });
    if (!verdict.ok && !verdict.message.startsWith('не заполнены обязательные поля:')) {
      throw Object.assign(new Error('Composed source fails a non-field publication invariant'), {
        safeField: type === 'seminar' ? 'documents' : 'publication',
      });
    }
    let missing = verdict.missing;
    if (!verdict.ok && missing.length === 0) {
      missing = type === 'person' ? ['trait'] : type === 'seminar' ? ['documents'] : ['publication'];
    }
    if (missing.length === 0) continue;
    const slug = typeof plan.attributes.slug === 'string' ? plan.attributes.slug : '';
    const key = `${type}\0${plan.legacyId}\0${slug}`;
    const entry = allowlist.get(key);
    const expectedFields = entry ? [...entry.fields].sort() : [];
    const actualFields = [...missing].sort();
    if (!entry || expectedFields.length !== actualFields.length || actualFields.some((field, index) => field !== expectedFields[index])) {
      const identity = Number.isSafeInteger(plan.sourceId) ? `${plan.sourceTable}#${plan.sourceId}` : `${plan.sourceTable}/${plan.legacyId}`;
      throw Object.assign(new Error(`${identity}: publication fields do not match the pinned source-empty allowlist`), {
        safeField: actualFields[0] ?? 'publication',
      });
    }
    if (used.has(key)) throw new Error('Pinned source-empty allowlist identity is duplicated in the composed release');
    used.add(key);
    for (const field of actualFields) exceptionsByField[field] = (exceptionsByField[field] ?? 0) + 1;
  }
  if (used.size !== entries.length) throw new Error('Pinned source-empty allowlist contains an identity absent from the composed release');
  return { planCount: plans.length, exceptionCount: used.size, exceptionsByField };
}

/** Check only source identities across the private partial target; materialization overwrites planned drafts. */
export function validatePrototypeResumeContentIdentities(
  published: SqlDemoStrapi5Readback,
  drafts: Record<string, readonly SqlDemoNativeDraftIdentity[]>,
  expected: PrototypeExpectedIdentities,
): void {
  if (
    Object.keys(drafts).sort().join('\0') !== [...PROTOTYPE_COLLECTIONS].sort().join('\0') ||
    Object.keys(published.collections).sort().join('\0') !== [...PROTOTYPE_COLLECTIONS].sort().join('\0')
  ) throw new Error('Existing prototype content inventory omitted or added a collection');

  for (const collection of PROTOTYPE_COLLECTIONS) {
    const approved = expected.get(collection);
    if (!approved) throw new Error('Existing prototype target contains an unknown collection');
    const publishedRows = published.collections[collection] ?? [];
    const draftRows = drafts[collection] ?? [];
    const publishedByLegacy = new Map<string, string>();
    const draftByLegacy = new Map<string, string>();
    const validateIdentities = (rows: readonly { legacy_id?: unknown; legacyId?: unknown; documentId?: unknown; slug?: unknown }[], status: 'published' | 'draft', byLegacy: Map<string, string>) => {
      const documentIds = new Set<string>();
      for (const row of rows) {
        const legacyId = typeof row.legacy_id === 'string' ? row.legacy_id : row.legacyId;
        if (typeof legacyId !== 'string' || !legacyId || typeof row.documentId !== 'string' || !row.documentId || byLegacy.has(legacyId) || documentIds.has(row.documentId)) {
          throw new Error(`Existing prototype ${status} identities are malformed or duplicated`);
        }
        const approvedSlug = approved.get(legacyId);
        if (approvedSlug === undefined && !approved.has(legacyId)) {
          throw new Error(`Existing prototype ${status} inventory contains an unapproved identity`);
        }
        if (approvedSlug !== undefined && row.slug !== approvedSlug) {
          throw new Error(`Existing prototype ${status} identity does not match its approved slug`);
        }
        byLegacy.set(legacyId, row.documentId);
        documentIds.add(row.documentId);
      }
    };
    validateIdentities(publishedRows, 'published', publishedByLegacy);
    validateIdentities(draftRows, 'draft', draftByLegacy);
    for (const [legacyId, documentId] of publishedByLegacy) {
      if (draftByLegacy.has(legacyId) && draftByLegacy.get(legacyId) !== documentId) {
        throw new Error('Existing draft and published twins do not share one approved document identity');
      }
    }
  }
}

function safeFailure(code: string, message: string, identity?: string, diagnostic?: { causeCategory: string; frames: string[]; signals?: Record<string, number>; sourceIdentity?: string; field?: string; networkCode?: string }): SqlDemoNativeRehearsalError {
  return new SqlDemoNativeRehearsalError(code, message, identity, diagnostic);
}

function safeDiagnostic(error: unknown): { causeCategory: string; frames: string[]; signals?: Record<string, number>; sourceIdentity?: string; field?: string; networkCode?: string } {
  const causeCategory = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : 'unknown-error';
  const stack = error instanceof Error ? error.stack ?? '' : '';
  const safeContext = error instanceof Error ? error.message.match(/^([A-Za-z][A-Za-z0-9]*#\d+):/) : null;
  const fieldAllowlist = new Set(['title', 'slug', 'body', 'legacy_id', 'name', 'description', 'city', 'entry_status', 'seo', 'metaTitle', 'metaDescription', 'canonicalURL', 'keywords', 'robots', 'structuredData', 'image', 'photo', 'videos', 'url', 'date', 'startDate', 'endDate', 'priority', 'anchor']);
  const reportedField = error instanceof Error ? (error as Error & { safeField?: unknown }).safeField : undefined;
  const safeField = typeof reportedField === 'string' && fieldAllowlist.has(reportedField)
    ? reportedField
    : error instanceof Error ? error.message.match(/\b([A-Za-z][A-Za-z0-9_]*) (?:must be|is required|is invalid|verification changed|is missing)\b/)?.[1] : undefined;
  const frames = [...new Set(stack.split(/\r?\n/).map((line) =>
    line.match(/((?:sql-demo-[A-Za-z0-9-]+|sql-public-(?:reader|materializer))\.ts):(\d+):(\d+)/)?.slice(1).join(':')).filter((frame): frame is string => Boolean(frame)))];
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
    ...(safeContext ? { sourceIdentity: safeContext[1] } : {}),
    ...(safeField ? { field: safeField } : {}),
    ...((error as { safeNetworkCode?: unknown } | null)?.safeNetworkCode
      && /^[A-Z][A-Z0-9_]{1,40}$/.test((error as { safeNetworkCode: string }).safeNetworkCode)
      ? { networkCode: (error as { safeNetworkCode: string }).safeNetworkCode } : {}),
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

function composeExistingTargetRelease(
  mapped: SqlPublicContentResult,
  normalized: SqlDemoNormalizedPrivateInputs,
  assets: SqlDemoAssetLoaderResult,
  pdfBytes: Map<string, Uint8Array>,
  rasters: Map<string, LoadedRaster>,
): SqlDemoRelease {
  const images = assets.offlineMedia.map((proof) => {
    const uploaded = rasters.get(proof.sourceFileId);
    if (!uploaded) throw safeFailure('MEDIA_BINDING_FAILED', 'Raster readback is missing an approved source identity', `Files#${proof.sourceFileId}`);
    return verifiedMapping(proof, uploaded.upload.url);
  });
  const documents = assets.offlineDocuments.map((proof) => {
    if (!pdfBytes.has(proof.sourceFileId)) throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved public document bytes are missing', `Files#${proof.sourceFileId}`);
    return {
      sourceFileId: proof.sourceFileId,
      sourceUrl: proof.sourceUrl,
      targetPublicUrl: publicDocumentPath(proof, mapped, normalized),
      sha256: proof.sourceSha256,
      detectedMimeType: proof.detectedMimeType,
      verification: proof.verification,
    };
  });
  return composeSqlDemoRelease(mapped, normalized.composer.acceptedSupplements, { images, documents }, normalized.composer.ownerDecisions);
}

export function resumeRastersFromReadback(
  proofs: readonly SqlDemoOfflineAssetProof[],
  readback: SqlDemoStrapi5Readback,
  target: SqlDemoNativeOwnedTarget,
): Map<string, LoadedRaster> {
  const expected = new Map<string, SqlDemoOfflineAssetProof>();
  for (const proof of proofs) {
    if (expected.has(proof.sourceUrl)) throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Approved raster source identities are duplicated');
    expected.set(proof.sourceUrl, proof);
  }
  if (readback.media.length !== expected.size) throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Published media count differs from the exact approved source set');
  const result = new Map<string, LoadedRaster>();
  const seenSourceUrls = new Set<string>();
  for (const file of readback.media) {
    const metadata = file.provider_metadata && typeof file.provider_metadata === 'object' && !Array.isArray(file.provider_metadata)
      ? file.provider_metadata as Record<string, unknown> : {};
    const importMetadata = metadata.ikpk_media_import && typeof metadata.ikpk_media_import === 'object' && !Array.isArray(metadata.ikpk_media_import)
      ? metadata.ikpk_media_import as Record<string, unknown> : {};
    const claims = importMetadata.sources && typeof importMetadata.sources === 'object' && !Array.isArray(importMetadata.sources)
      ? importMetadata.sources as Record<string, unknown> : {};
    const entries = Object.entries(claims);
    if (entries.length !== 1) throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Published media has missing or extra source claims');
    const [sourceUrl, rawClaim] = entries[0]!;
    const proof = expected.get(sourceUrl);
    if (!proof || seenSourceUrls.has(sourceUrl) || !rawClaim || typeof rawClaim !== 'object' || Array.isArray(rawClaim)
      || typeof file.verifiedStoredSha256 !== 'string' || !HASH.test(file.verifiedStoredSha256)) {
      throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Published media identity is outside the exact approved source set');
    }
    const sourceHash = ('sourceBytesAvailable' in proof ? proof.substitution.replacementSha256 : proof.sourceSha256).toLowerCase();
    const claim = rawClaim as { version?: unknown; sha256?: unknown; storedSha256?: unknown };
    if (claim.version !== 1 || claim.sha256 !== sourceHash || claim.storedSha256 !== file.verifiedStoredSha256) {
      throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Published media source and stored-byte claims do not match the independently read inventory', `Files#${proof.sourceFileId}`);
    }
    const upload = { id: file.id, url: file.url };
    validateUpload(upload, target, proof.sourceFileId);
    result.set(proof.sourceFileId, {
      upload,
      sourceHash,
      storedHash: file.verifiedStoredSha256,
      sourceIdentity: `Files#${proof.sourceFileId}`,
    });
    seenSourceUrls.add(sourceUrl);
  }
  if (seenSourceUrls.size !== expected.size) throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Published media source identity set is incomplete');
  return result;
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
  try {
    await materializeSqlPublicContent(release as never, options);
  } catch (error) {
    throw safeFailure('CONTENT_MATERIALIZATION_FAILED', 'Approved content failed CMS materialization', safeDiagnostic(error).sourceIdentity, safeDiagnostic(error));
  }
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
  resumeExistingStaticFiles = false,
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
    if (!resumeExistingStaticFiles) {
      try {
        await io.writeStaticDocument(target, publicPath, bytes);
      } catch (error) {
        throw safeFailure('DOCUMENT_PUBLISH_FAILED', 'Approved static document could not be published', `Files#${document.sourceFileId}`, safeDiagnostic(error));
      }
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
  if (input.readbackOnly && !input.target.resumeExistingMediaOnly) {
    throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Readback-only continuation requires the exact single-A resume configuration');
  }
  if (!isAbsolute(input.snapshotDirectory)) throw safeFailure('SNAPSHOT_DESTINATION_INVALID', 'Prototype snapshot destination must be an absolute private path');
  assertLoadedVipsFloor();
  let sqlSourceLease: SqlDemoNativeSqlSourceLease | undefined;
  let target: SqlDemoNativeOwnedTarget | undefined;
  let primaryError: unknown;
  let result: SqlDemoNativePrototypeResult | undefined;
  let publicationScan: SqlDemoNativePrototypeResult['publicationScan'] | undefined;
  let expectedDrafts = new Map<string, Map<string, string | undefined>>();
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
    if (input.target.resumeExistingMediaOnly) {
      try {
        await input.io.verifyExistingStaticDocuments(assets.offlineDocuments.map((proof) => {
          const bytes = pdfBytes.get(proof.sourceFileId);
          if (!bytes) throw safeFailure('DOCUMENT_BYTES_INVALID', 'Approved document bytes were not retained for resume validation', `Files#${proof.sourceFileId}`);
          return { publicPath: publicDocumentPath(proof, mapped, normalized), bytes };
        }));
      } catch (error) {
        throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Existing static documents do not exactly match approved SQL file proofs', undefined, safeDiagnostic(error));
      }
    }
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
      const preflightRelease = composeSqlDemoRelease(
        mapped,
        normalized.composer.acceptedSupplements,
        { images: preflightImages, documents: preflightDocuments },
        normalized.composer.ownerDecisions,
      );
      const approvedRasterIds = new Set(assets.offlineMedia.map((proof) => String(proof.sourceFileId)));
      const contentPlans = projectSqlPublicContentForConservation(preflightRelease as never, normalized.materializer);
      publicationScan = validatePrototypePublicationPlans(contentPlans, source.sourceHash);
      expectedDrafts = new Map();
      for (const plan of contentPlans) {
        const collection = expectedDrafts.get(plan.collection) ?? new Map<string, string | undefined>();
        collection.set(plan.legacyId, typeof plan.attributes.slug === 'string' ? plan.attributes.slug : undefined);
        expectedDrafts.set(plan.collection, collection);
        if (plan.image?.sourceId != null && !approvedRasterIds.has(plan.image.sourceId)) {
          throw safeFailure('MEDIA_BINDING_FAILED', 'Mapped content references a raster outside the approved source set', `${plan.sourceTable}#${plan.sourceId ?? 'unknown'}`);
        }
      }
    } catch (error) {
      throw safeFailure('COMPOSITION_PREFLIGHT_FAILED', 'Approved content failed full release composition before target startup', undefined, safeDiagnostic(error));
    }
    try {
      target = await input.io.openOwnedTarget({ ...input.target, name: 'A', token });
    } catch {
      throw safeFailure('TARGET_OWNERSHIP_UNPROVEN', 'Owned CMS process for prototype target A could not be started');
    }
    assertOwnedTarget(target, 'A', input.target);
    let priorReadback: SqlDemoStrapi5Readback | undefined;
    let priorDraftIdentities: Record<string, readonly SqlDemoNativeDraftIdentity[]> | undefined;
    let readbackArtifact: { path: string; sha256: string; bytes: number } | undefined;
    if (input.target.resumeExistingMediaOnly) {
      try { priorReadback = await input.io.readPublished(target); }
      catch (error) { throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Existing prototype content inventory could not be verified before continuation', undefined, safeDiagnostic(error)); }
      if (input.readbackOnly) {
        if (!input.io.persistReadback) throw safeFailure('PUBLISHED_READBACK_FAILED', 'Private live readback persistence is unavailable');
        try { readbackArtifact = await input.io.persistReadback(target, priorReadback); }
        catch (error) { throw safeFailure('PUBLISHED_READBACK_FAILED', 'Complete API readback could not be persisted privately before conservation', undefined, safeDiagnostic(error)); }
      }
      try { priorDraftIdentities = await input.io.readDraftContentIdentities(target); }
      catch (error) { throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Existing prototype draft inventory could not be verified before continuation', undefined, safeDiagnostic(error)); }
      try { validatePrototypeResumeContentIdentities(priorReadback, priorDraftIdentities, expectedDrafts); }
      catch (error) { throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Existing prototype content identities are not an approved source-backed subset', undefined, safeDiagnostic(error)); }
    }
    let priorMediaInventory: unknown;
    if (input.target.resumeExistingMediaOnly && !input.readbackOnly) {
      try { priorMediaInventory = await input.io.prepareResumeMediaInventory(target, assets.offlineMedia); }
      catch (error) { throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Persisted prototype media claims do not exactly match the approved raster set', undefined, safeDiagnostic(error)); }
    }
    let imported: TargetRun;
    if (input.readbackOnly) {
      if (!priorReadback || !priorDraftIdentities || !readbackArtifact) throw safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Readback-only continuation did not complete its single private inventory checkpoint');
      let rasters: Map<string, LoadedRaster>;
      try { rasters = resumeRastersFromReadback(assets.offlineMedia, priorReadback, target); }
      catch (error) { throw error instanceof SqlDemoNativeRehearsalError ? error : safeFailure('PARTIAL_TARGET_RESUME_INVALID', 'Published media inventory is not the exact approved source set', undefined, safeDiagnostic(error)); }
      for (const document of assets.offlineDocuments) {
        await verifyPublishedPdf(target, document, publicDocumentPath(document, mapped, normalized), input.io);
      }
      const release = composeExistingTargetRelease(mapped, normalized, assets, pdfBytes, rasters);
      imported = { release, readback: priorReadback, rasters };
    } else {
      imported = await importTarget('A', target, mapped, normalized, assets, pdfBytes, input.io, priorMediaInventory, input.target.resumeExistingMediaOnly === true);
      if (input.io.persistReadback) {
        try { readbackArtifact = await input.io.persistReadback(target, imported.readback); }
        catch (error) { throw safeFailure('PUBLISHED_READBACK_FAILED', 'Complete API readback could not be persisted privately before conservation', undefined, safeDiagnostic(error)); }
      }
    }
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
      publicationScan: publicationScan!,
      sourceUrlClassification,
      ...(readbackArtifact ? { readbackArtifact } : {}),
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
