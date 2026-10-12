import { createHash } from 'node:crypto';
import { parseFragment } from 'parse5';
import type { SqlPublicContentOptions, SqlPublicContentResult, SqlPublicSource } from './sql-public-content.js';
import type { SqlMaterializerOptions } from './sql-public-materializer.js';
import type {
  SqlDemoAssetManifest,
  SqlDemoAssetManifestEntry,
  SqlDemoSupplementManifest,
} from './sql-demo-assets.js';
import { computeSqlDemoSupplementManifestSha256 } from './sql-demo-assets.js';
import type {
  SqlDemoAcceptedSupplements,
  SqlDemoAllowlistedAssets,
  SqlDemoOwnerDecisions,
} from './sql-demo-release.js';

export const SQL_DEMO_PRIVATE_JSON_NAMES = [
  'approved-supplements.json',
  'reached-media-manifest.json',
  'article-body-reached-public-unlinked-media.json',
  'classification-candidates.json',
  'public-schema-inventory.json',
  'content-media-manifest.json',
  'demo-owner-decisions.json',
  'video-source-reference-decisions.json',
] as const;

export type SqlDemoPrivateJsonName = typeof SQL_DEMO_PRIVATE_JSON_NAMES[number];

export interface SqlDemoPrivateInputRootConfig {
  baseline: { sqlSha256: string; archiveSha256: string };
  roots: { assetRoot: string; supplementRoot: string };
  acceptedLegacyIds: SqlPublicContentOptions['acceptedLegacyIds'];
  privateJson: Record<SqlDemoPrivateJsonName, { bytes: Uint8Array; expectedSha256: string }>;
  supplementBlobs: { path: string; revision: string; sha256: string; bytes: Uint8Array }[];
}

export interface SqlDemoSelectedPublicHeaderReference {
  sourceTable: 'Institutes' | 'Programs' | 'Teachers' | 'Events' | 'Articles' | 'News' | 'Promotions' | 'Videos';
  sourceId: number;
  imageId: string;
}

export interface SqlDemoNormalizedPrivateInputs {
  mapperOptions: SqlPublicContentOptions;
  loader: {
    source: SqlPublicSource;
    selectedPublicHeaders: { sourceHash: string; references: SqlDemoSelectedPublicHeaderReference[] };
    baseline: { sqlSha256: string; archiveSha256: string };
    assetRoot: string;
    assetManifest: SqlDemoAssetManifest;
    approvedBodyFileGrants: { sourceFileId: string; sourceSha256: string; decisionId: string }[];
    supplementRoot: string;
    supplementManifest: SqlDemoSupplementManifest;
    expectedSupplements: { codeRevision: string; manifestSha256: string };
  };
  composer: {
    acceptedSupplements: SqlDemoAcceptedSupplements;
    allowlistedAssets: SqlDemoAllowlistedAssets;
    ownerDecisions: SqlDemoOwnerDecisions;
  };
  materializer: Pick<SqlMaterializerOptions, 'classification'>['classification'];
}

type JsonObject = Record<string, unknown>;
type ParsedPrivate = Record<SqlDemoPrivateJsonName, JsonObject>;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
};
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
};
const digest = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^(?:sha256:)?[a-f\d]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value.replace(/^sha256:/i, '').toLowerCase();
};
const sameDigest = (left: unknown, right: unknown, label: string): string => {
  const a = digest(left, label);
  const b = digest(right, label);
  if (a !== b) throw new Error(`${label} identity hash mismatch`);
  return a;
};
const valueAt = (row: JsonObject, snake: string, camel?: string): unknown => row[snake] ?? (camel ? row[camel] : undefined);
const idString = (value: unknown, label: string): string => string(value, label);
const numberId = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
};
const parsedHtml = (html: string): { nodeName?: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: unknown[] } => parseFragment(html) as never;

function verifyRawPins(config: SqlDemoPrivateInputRootConfig): void {
  const baselineSql = digest(config.baseline.sqlSha256, 'baseline SQL SHA-256');
  digest(config.baseline.archiveSha256, 'baseline archive SHA-256');
  // Deliberately finish this pass over all eight byte streams before parsing any JSON.
  for (const name of SQL_DEMO_PRIVATE_JSON_NAMES) {
    const pinned = config.privateJson[name];
    if (!pinned || !(pinned.bytes instanceof Uint8Array)) throw new Error(`${name} raw bytes are missing`);
    const expected = digest(pinned.expectedSha256, `${name} expected SHA-256`);
    if (sha256(pinned.bytes) !== expected) throw new Error(`${name} SHA-256 does not match its raw byte pin`);
  }
  void baselineSql;
}

function parsePrivate(config: SqlDemoPrivateInputRootConfig): ParsedPrivate {
  const result = {} as ParsedPrivate;
  for (const name of SQL_DEMO_PRIVATE_JSON_NAMES) {
    try {
      result[name] = object(JSON.parse(Buffer.from(config.privateJson[name].bytes).toString('utf8')) as unknown, name);
    } catch {
      throw new Error(`${name} contains invalid JSON`);
    }
  }
  return result;
}

function verifySupplementBlobs(config: SqlDemoPrivateInputRootConfig, approved: JsonObject): void {
  const acceptedRevision = string(valueAt(approved, 'accepted_corpus_revision', 'acceptedCorpusRevision'), 'accepted corpus revision');
  const rows = array(valueAt(approved, 'supplements'), 'approved supplements');
  const byKey = new Map<string, { revision: string; sha256: string; bytes: number }>();
  for (const raw of rows) {
    const row = object(raw, 'approved supplement');
    const path = string(valueAt(row, 'path', 'sourcePath'), 'approved supplement path');
    const revision = string(valueAt(row, 'revision'), `${path} revision`);
    if (!/^[a-f\d]{40}$/i.test(revision)) throw new Error(`${path} revision must be a full Git commit SHA`);
    const hash = digest(valueAt(row, 'sha256'), `${path} SHA-256`);
    const bytes = valueAt(row, 'bytes');
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) throw new Error(`${path} byte count is invalid`);
    const key = `${path}@${revision}`;
    if (byKey.has(key)) throw new Error(`${path} has a duplicate pinned supplement identity`);
    byKey.set(key, { revision, sha256: hash, bytes: bytes as number });
  }
  const seen = new Set<string>();
  for (const blob of config.supplementBlobs) {
    const key = `${blob.path}@${blob.revision}`;
    const pin = byKey.get(key);
    if (!pin) throw new Error(`${blob.path} at ${blob.revision} is not an approved Git blob pin`);
    if (seen.has(key)) throw new Error(`${blob.path} has duplicate supplied Git blob bytes`);
    seen.add(key);
    if (Buffer.byteLength(blob.bytes) !== pin.bytes || sha256(blob.bytes) !== pin.sha256 || digest(blob.sha256, `${blob.path} expected blob SHA-256`) !== pin.sha256) {
      throw new Error(`${blob.path} Git blob bytes do not match the accepted revision SHA-256 pin`);
    }
  }
  for (const [key, pin] of byKey) {
    if (pin.revision === acceptedRevision && !seen.has(key)) throw new Error(`${key.split('@')[0]} accepted Git blob bytes are missing`);
  }
}

function classify(privateData: ParsedPrivate, source: SqlPublicSource) {
  const candidate = privateData['classification-candidates.json'];
  const activeTeachers = new Set(source.Teachers.filter((row) => row.status === 'active').map((row) => row.id));
  const activeArticles = new Set(source.Articles.filter((row) => row.status === 'active').map((row) => row.id));
  const activePrograms = new Set(source.Programs.filter((row) => row.status === 'active').map((row) => row.id));
  const teachers: { sourceId: number; trait: 'teacher' | 'method-author' }[] = [];
  const articles: { sourceId: number; sourceProgramIds: number[] }[] = [];
  const teacherIds = new Set<number>();
  for (const raw of array(candidate.teachers, 'classification teachers')) {
    const row = object(raw, 'classification teacher');
    const id = numberId(valueAt(row, 'sourceTeacherId', 'source_teacher_id'), 'classification Teachers source ID');
    if (!activeTeachers.has(id)) throw new Error(`Teachers#${id} classification does not match an active source record`);
    if (teacherIds.has(id)) throw new Error(`Teachers#${id} classification is duplicated`);
    teacherIds.add(id);
    const trait = string(valueAt(row, 'candidateTrait', 'candidate_trait'), `Teachers#${id} candidate trait`);
    if (trait !== 'teacher' && trait !== 'method-author') throw new Error(`Teachers#${id} classification trait is unsupported`);
    teachers.push({ sourceId: id, trait });
  }
  for (const id of activeTeachers) if (!teacherIds.has(id)) throw new Error(`Teachers#${id} classification coverage is missing`);
  const articleIds = new Set<number>();
  for (const raw of array(candidate.articles, 'classification articles')) {
    const row = object(raw, 'classification article');
    const id = numberId(valueAt(row, 'sourceArticleId', 'source_article_id'), 'classification Articles source ID');
    if (!activeArticles.has(id)) throw new Error(`Articles#${id} classification does not match an active source record`);
    if (articleIds.has(id)) throw new Error(`Articles#${id} classification is duplicated`);
    articleIds.add(id);
    const programs = array(valueAt(row, 'sourceProgramIds', 'source_program_ids'), `Articles#${id} program IDs`).map((value) => numberId(value, `Articles#${id} program ID`));
    if (!programs.length) throw new Error(`Articles#${id} classification categories are missing`);
    for (const programId of programs) if (!activePrograms.has(programId)) throw new Error(`Programs#${programId} classification does not match an active source record`);
    articles.push({ sourceId: id, sourceProgramIds: [...new Set(programs)] });
  }
  for (const id of activeArticles) if (!articleIds.has(id)) throw new Error(`Articles#${id} classification coverage is missing`);
  for (const raw of array(candidate.programs, 'classification programs')) {
    const row = object(raw, 'classification program');
    const id = numberId(valueAt(row, 'sourceProgramId', 'source_program_id'), 'classification Programs source ID');
    if (!activePrograms.has(id)) throw new Error(`Programs#${id} classification does not match an active source record`);
  }
  return { teachers, articles };
}

function validateOwnerClassification(owner: JsonObject, candidatesFile: JsonObject): void {
  const ownerDecision = object(valueAt(owner, 'ownerDecision', 'owner_decision'), 'owner decision');
  const classifications = object(valueAt(owner, 'classifications'), 'owner classification decision');
  const media = object(valueAt(owner, 'mediaAllowlist', 'media_allowlist'), 'owner media allowlist');
  const ownerStatus = string(valueAt(classifications, 'status'), 'owner classification status');
  if (!['demo-provisional-approved', 'approved-for-demo'].includes(ownerStatus)) throw new Error('owner classification decision is not approved for demo-only use');
  if (valueAt(ownerDecision, 'productionAcceptance', 'production_acceptance') !== false || valueAt(classifications, 'productionAcceptance', 'production_acceptance') !== false) {
    throw new Error('owner classification decision must not imply production acceptance');
  }
  for (const key of ['source', 'media', 'classification']) {
    const decision = object(valueAt(ownerDecision, key), `owner ${key} decision`);
    if (valueAt(decision, 'productionAcceptance', 'production_acceptance') !== false) throw new Error(`owner ${key} decision must not imply production acceptance`);
  }
  if (valueAt(ownerDecision, 'demoWriteOrImportAuthorization', 'demo_write_or_import_authorization') !== true) throw new Error('owner decision does not authorize the bounded demo import');
  if (valueAt(classifications, 'confidenceAndEvidenceRemainAsCandidateValues', 'confidence_and_evidence_remain_as_candidate_values') !== true) {
    throw new Error('owner decision must preserve candidate confidence and evidence');
  }
  if (valueAt(media, 'allowlistOnly', 'allowlist_only') !== true || valueAt(media, 'wildcard') !== false || valueAt(media, 'otherUnlinkedFilesApproved', 'other_unlinked_files_approved') !== false) {
    throw new Error('owner media decision must remain exact-identity-only and non-wildcard');
  }
  for (const [field, camel] of [
    ['allEntriesReachableFromActiveArticleHtml', 'all_entries_reachable_from_active_article_html'],
    ['allSourceEntriesArePublicAndUnlinked', 'all_source_entries_are_public_and_unlinked'],
    ['allCrcSizeAndSha256ChecksVerified', 'all_crc_size_and_sha256_checks_verified'],
  ]) if (valueAt(media, field, camel) !== true) throw new Error('owner media decision lacks complete public, active-HTML, byte-integrity evidence');
  const compare = (ownerRows: unknown, candidateRows: unknown, idField: string, candidateIdField: string, label: string) => {
    const decisions = array(ownerRows, `${label} owner decisions`).map((raw) => object(raw, `${label} owner decision`));
    const candidates = array(candidateRows, `${label} candidates`).map((raw) => object(raw, `${label} candidate`));
    if (decisions.length !== candidates.length) throw new Error(`${label} owner decisions do not cover the candidate set`);
    const candidateById = new Map(candidates.map((row) => [numberId(valueAt(row, candidateIdField), `${label} candidate source ID`), row]));
    const seen = new Set<number>();
    for (const decision of decisions) {
      const id = numberId(valueAt(decision, idField), `${label} owner source ID`);
      const candidate = candidateById.get(id);
      if (!candidate || seen.has(id)) throw new Error(`${label}#${id} owner decision does not match exactly one candidate`);
      seen.add(id);
      if (valueAt(decision, 'demoProvisionalApproved', 'demo_provisional_approved') !== true ||
          valueAt(decision, 'candidatePrimaryApprovalUnchanged', 'candidate_primary_approval_unchanged') !== 'pending' ||
          valueAt(decision, 'productionAcceptance', 'production_acceptance') !== false) {
        throw new Error(`${label}#${id} owner decision must remain demo-provisional, primary-pending, and not production-accepted`);
      }
      for (const field of ['confidence', 'evidence', 'candidateTrait', 'sourceProgramIds']) {
        if (decision[field] !== undefined && JSON.stringify(decision[field]) !== JSON.stringify(candidate[field])) {
          throw new Error(`${label}#${id} owner decision changes candidate ${field}`);
        }
      }
    }
  };
  compare(classifications.people, candidatesFile.teachers, 'sourceTeacherId', 'sourceTeacherId', 'Teachers');
  compare(classifications.articles, candidatesFile.articles, 'sourceArticleId', 'sourceArticleId', 'Articles');
}

export function prepareSqlDemoPrivateInputs(
  config: SqlDemoPrivateInputRootConfig,
): Pick<SqlPublicContentOptions, 'expectedSourceHash' | 'acceptedLegacyIds' | 'classificationCandidates'> {
  verifyRawPins(config);
  const data = parsePrivate(config);
  verifySupplementBlobs(config, data['approved-supplements.json']);
  const baseline = digest(config.baseline.sqlSha256, 'baseline SQL SHA-256');
  const approved = data['approved-supplements.json'];
  sameDigest(valueAt(approved, 'sql_baseline_sha256', 'sqlBaselineSha256'), baseline, 'approved supplements SQL baseline');
  const media = data['reached-media-manifest.json'];
  sameDigest(valueAt(media, 'baseline_sql_sha256', 'baselineSqlSha256'), baseline, 'reached media SQL baseline');
  sameDigest(valueAt(media, 'archive_sha256', 'archiveSha256'), config.baseline.archiveSha256, 'reached media archive identity');
  const body = data['article-body-reached-public-unlinked-media.json'];
  sameDigest(valueAt(body, 'baseline_sql_sha256', 'baselineSqlSha256'), baseline, 'body media SQL baseline');
  sameDigest(valueAt(body, 'archive_sha256', 'archiveSha256'), config.baseline.archiveSha256, 'body media archive identity');
  const existing = data['content-media-manifest.json'];
  sameDigest(valueAt(existing, 'baseline_sha256', 'baselineSha256'), baseline, 'existing content media SQL baseline');
  sameDigest(valueAt(existing, 'archive_sha256', 'archiveSha256'), config.baseline.archiveSha256, 'existing content media archive identity');
  sameDigest(valueAt(media, 'existing_content_image_manifest_sha256', 'existingContentImageManifestSha256'), valueAt(existing, 'canonical_sha256', 'canonicalSha256'), 'existing content image manifest identity');
  // Phase one has no SQL rows. Keep the private classification candidates provisional;
  // full active-ID coverage is checked in phase two once the pinned native source exists.
  const candidate = data['classification-candidates.json'];
  const teachers: { sourceId: number; trait: 'teacher' | 'method-author' }[] = array(candidate.teachers, 'classification teachers').map((raw) => {
    const row = object(raw, 'classification teacher');
    const trait = valueAt(row, 'candidateTrait', 'candidate_trait');
    if (trait !== 'teacher' && trait !== 'method-author') throw new Error('classification teacher trait is unsupported');
    return { sourceId: numberId(valueAt(row, 'sourceTeacherId', 'source_teacher_id'), 'classification teacher source ID'), trait: trait as 'teacher' | 'method-author' };
  });
  const articles = array(candidate.articles, 'classification articles').map((raw) => {
    const row = object(raw, 'classification article');
    return {
      sourceId: numberId(valueAt(row, 'sourceArticleId', 'source_article_id'), 'classification article source ID'),
      sourceProgramIds: array(valueAt(row, 'sourceProgramIds', 'source_program_ids'), 'classification article programs').map((id) => numberId(id, 'classification program ID')),
    };
  });
  return {
    expectedSourceHash: `sha256:${baseline}`,
    acceptedLegacyIds: config.acceptedLegacyIds,
    classificationCandidates: { teachers, articles },
  };
}

function parseNodes(node: ReturnType<typeof parsedHtml>, visit: (node: NonNullable<ReturnType<typeof parsedHtml>>) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) parseNodes(child as ReturnType<typeof parsedHtml>, visit);
}
function attr(node: ReturnType<typeof parsedHtml>, name: string): string | undefined {
  return node.attrs?.find((item) => item.name === name)?.value;
}
function textContent(node: ReturnType<typeof parsedHtml>): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map((child) => textContent(child as ReturnType<typeof parsedHtml>)).join('');
}
function htmlImages(html: string): string[] {
  const found: string[] = [];
  parseNodes(parsedHtml(html), (node) => {
    if (node.tagName === 'img') {
      const src = attr(node, 'src');
      if (src) found.push(src);
    }
  });
  return found;
}
function selectedHeaders(mapped: SqlPublicContentResult): SqlDemoSelectedPublicHeaderReference[] {
  const tableFor: Record<string, SqlDemoSelectedPublicHeaderReference['sourceTable']> = {
    institutes: 'Institutes', programs: 'Programs', teachers: 'Teachers', events: 'Events', articles: 'Articles',
    news: 'News', promotions: 'Promotions', videos: 'Videos',
  };
  const refs: SqlDemoSelectedPublicHeaderReference[] = [];
  for (const [collection, table] of Object.entries(tableFor)) {
    for (const entity of (mapped.entities[collection as keyof typeof mapped.entities] ?? []) as { sourceId: number; imageId?: unknown }[]) {
      if (typeof entity.imageId === 'string' && entity.imageId) refs.push({ sourceTable: table, sourceId: entity.sourceId, imageId: entity.imageId });
    }
  }
  return refs;
}

function normalizePrivateInputs(config: SqlDemoPrivateInputRootConfig, source: SqlPublicSource, mapped: SqlPublicContentResult): SqlDemoNormalizedPrivateInputs {
  const prepared = prepareSqlDemoPrivateInputs(config);
  const privateData = parsePrivate(config);
  const sourceHash = sameDigest(source.sourceHash, config.baseline.sqlSha256, 'native SQL source hash');
  const mappedHash = sameDigest(mapped.provenance.sourceHash, config.baseline.sqlSha256, 'mapper source hash');
  if (sourceHash !== mappedHash) throw new Error('mapper source hash does not match native SQL source hash');
  const candidates = classify(privateData, source);
  const sourceForLoader: SqlPublicSource = { ...source, sourceHash };
  const headers = selectedHeaders(mapped);
  const reached = privateData['reached-media-manifest.json'];
  const body = privateData['article-body-reached-public-unlinked-media.json'];
  const existing = privateData['content-media-manifest.json'];
  const owner = privateData['demo-owner-decisions.json'];
  validateOwnerClassification(owner, privateData['classification-candidates.json']);
  const ownerMedia = object(valueAt(owner, 'mediaAllowlist', 'media_allowlist'), 'owner media allowlist');
  const ownerEntries = array(ownerMedia.entries, 'owner media grants').map((raw) => object(raw, 'owner media grant'));
  const ownerGrantIds = new Set<string>();
  for (const entry of ownerEntries) {
    const id = idString(valueAt(entry, 'sourceFileId', 'source_file_id'), 'owner media grant source file ID');
    digest(valueAt(entry, 'sourceSha256', 'source_sha256'), `${id} owner grant SHA-256`);
    if (ownerGrantIds.has(id)) throw new Error(`${id} has duplicate owner file grants`);
    ownerGrantIds.add(id);
    if (valueAt(entry, 'demoApproved', 'demo_approved') !== true) throw new Error(`${id} owner file grant is not approved for demo`);
  }
  const declaredGrantCount = valueAt(ownerMedia, 'exactIdentityCount', 'exact_identity_count');
  if (declaredGrantCount !== ownerEntries.length) throw new Error('owner media exact identity count differs from its grant rows');
  const decisionFor = (fileId: string, hash: string): string | undefined => {
    const match = ownerEntries.find((row) => valueAt(row, 'sourceFileId', 'source_file_id') === fileId && digest(valueAt(row, 'sourceSha256', 'source_sha256'), `${fileId} owner grant hash`) === hash && valueAt(row, 'demoApproved', 'demo_approved') === true);
    if (!match) return undefined;
    return string(valueAt(match, 'decisionId', 'decision_id') ?? `demo-owner:${fileId}:${hash}`, `${fileId} owner decision identity`);
  };
  const nativeFiles = new Map((source.Files ?? []).map((file) => [file.id, file]));
  const reachedRows = array(reached.verified_assets, 'reached verified assets').map((raw) => object(raw, 'reached asset proof'));
  const bodyRows = array(body.entries, 'body-reached assets').map((raw) => object(raw, 'body asset proof'));
  const reachedDocs = array(reached.documents, 'document metadata').map((raw) => object(raw, 'document metadata row'));
  const reachedThumbs = array(reached.video_thumbnails, 'video thumbnail metadata').map((raw) => object(raw, 'video thumbnail metadata row'));
  const existingRows = array(existing.entries, 'existing content media entries').map((raw) => object(raw, 'existing content media entry'));
  const existingById = new Map<string, JsonObject>();
  for (const row of existingRows) {
    const id = idString(valueAt(row, 'legacy_file_id', 'legacyFileId'), 'existing media file ID');
    if (existingById.has(id)) throw new Error(`${id} has a duplicate existing manifest identity`);
    existingById.set(id, row);
  }
  const proofById = new Map<string, JsonObject>();
  for (const row of reachedRows) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'reached asset file ID');
    if (proofById.has(id)) throw new Error(`${id} has a duplicate byte proof identity`);
    proofById.set(id, row);
    const old = existingById.get(id);
    if (old && (
      digest(valueAt(old, 'sha256'), `${id} existing manifest SHA-256`) !== digest(valueAt(row, 'sha256'), `${id} reached SHA-256`) ||
      valueAt(old, 'archive_relative_path', 'archiveRelativePath') !== valueAt(row, 'archive_relative_path', 'archiveRelativePath') ||
      valueAt(old, 'bytes') !== valueAt(row, 'bytes') || valueAt(old, 'crc_verified', 'crcVerified') !== true
    )) throw new Error(`${id} identity collision between accepted existing and reached manifests`);
  }
  const bodyById = new Map<string, JsonObject>();
  for (const row of bodyRows) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'body-reached file ID');
    if (bodyById.has(id)) throw new Error(`${id} has a duplicate body-reached identity`);
    bodyById.set(id, row);
    const reachedProof = proofById.get(id);
    if (reachedProof && (
      digest(valueAt(reachedProof, 'sha256'), `${id} reached SHA-256`) !== digest(valueAt(row, 'sha256'), `${id} body SHA-256`) ||
      valueAt(reachedProof, 'archive_relative_path', 'archiveRelativePath') !== valueAt(row, 'archive_relative_path', 'archiveRelativePath') ||
      valueAt(reachedProof, 'bytes') !== valueAt(row, 'bytes')
    )) throw new Error(`${id} identity collision between reached and article-body manifests`);
    const existingProof = existingById.get(id);
    if (existingProof && (
      digest(valueAt(existingProof, 'sha256'), `${id} existing SHA-256`) !== digest(valueAt(row, 'sha256'), `${id} body SHA-256`) ||
      valueAt(existingProof, 'archive_relative_path', 'archiveRelativePath') !== valueAt(row, 'archive_relative_path', 'archiveRelativePath') ||
      valueAt(existingProof, 'bytes') !== valueAt(row, 'bytes') ||
      valueAt(existingProof, 'crc_verified', 'crcVerified') !== true
    )) throw new Error(`${id} identity collision between existing and article-body manifests`);
  }
  // Validate collisions for every shared exact ID before checking which files are
  // requested by the SQL graph; an unrelated proof can still contradict a pinned row.
  for (const [id, old] of existingById) {
    const row = proofById.get(id);
    if (!row) continue;
    const differingStatus = valueAt(old, 'status', 'source_status') !== undefined && valueAt(old, 'status', 'source_status') !== valueAt(row, 'status', 'source_status');
    const differingPrivacy = valueAt(old, 'privacy', 'source_privacy') !== undefined && valueAt(old, 'privacy', 'source_privacy') !== valueAt(row, 'privacy', 'source_privacy');
    if (differingStatus || differingPrivacy) throw new Error(`${id} identity collision between accepted existing and reached manifests`);
  }
  for (const [id, proof] of proofById) {
    const native = nativeFiles.get(id);
    const proofStatus = valueAt(proof, 'status', 'source_status');
    const proofPrivacy = valueAt(proof, 'privacy', 'source_privacy');
    if (native && (proofStatus !== native.status || proofPrivacy !== native.privacy)) {
      throw new Error(`${id} identity collision: proof status or privacy differs from native Files`);
    }
  }
  for (const row of reachedDocs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'document metadata source file ID');
    if (!proofById.has(id)) throw new Error(`${id} document metadata has no matching verified byte proof`);
  }
  for (const row of reachedThumbs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'thumbnail source file ID');
    if (!proofById.has(id)) throw new Error(`${id} video thumbnail metadata has no matching verified byte proof`);
  }
  const refsById = new Map<string, SqlDemoSelectedPublicHeaderReference[]>();
  for (const ref of headers) refsById.set(ref.imageId, [...(refsById.get(ref.imageId) ?? []), ref]);
  const activeSource = (id: string, expectedType: 'image' | 'document', expectedStatus: 'active' | 'unlinked') => {
    const file = nativeFiles.get(id);
    if (!file) throw new Error(`${id} has no matching native Files identity`);
    if (file.fileType !== expectedType || file.status !== expectedStatus || file.privacy !== 'public') throw new Error(`${id} native file type, status, or privacy does not match its proof`);
    return file;
  };
  const entries: SqlDemoAssetManifestEntry[] = [];
  const addProof = (id: string, reachability: SqlDemoAssetManifestEntry['reachability'], expectedType: 'image' | 'document' = 'image', expectedStatus: 'active' | 'unlinked' = 'active') => {
    const proof = proofById.get(id) ?? bodyById.get(id);
    if (!proof) throw new Error(`${id} has no matching verified byte proof`);
    const file = activeSource(id, expectedType, expectedStatus);
    const sourceFileType = valueAt(proof, 'source_file_type', 'sourceFileType');
    if (sourceFileType !== expectedType) throw new Error(`${id} byte proof file type does not match native Files`);
    const path = string(valueAt(proof, 'archive_relative_path', 'archiveRelativePath'), `${id} archive path`);
    const byteCount = valueAt(proof, 'bytes');
    if (!Number.isSafeInteger(byteCount) || (byteCount as number) < 0 || valueAt(proof, 'zip_crc_verified', 'crc_verified') !== true && valueAt(proof, 'crc_verified', 'zip_crc_verified') !== true) throw new Error(`${id} byte proof or CRC verification is invalid`);
    const proofHash = digest(valueAt(proof, 'sha256'), `${id} byte proof SHA-256`);
    const privacy = valueAt(proof, 'privacy', 'source_privacy');
    const status = valueAt(proof, 'status', 'source_status');
    if (privacy !== 'public' || status !== expectedStatus) throw new Error(`${id} byte proof status or privacy does not match native Files`);
    const mime = valueAt(proof, 'mime_type_from_magic', 'verified_mime');
    const ext = valueAt(proof, 'source_extension', 'target_extension_from_magic');
    if (valueAt(proof, 'extension_matches_magic') !== undefined && valueAt(proof, 'extension_matches_magic') !== true) throw new Error(`${id} byte proof extension does not match detected magic`);
    if (expectedType === 'image' && (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mime)) || !['png', 'jpg', 'jpeg', 'webp'].includes(String(ext)))) throw new Error(`${id} byte proof has unsupported image magic metadata`);
    if (expectedType === 'document' && (mime !== 'application/pdf' || ext !== 'pdf')) throw new Error(`${id} byte proof has unsupported document magic metadata`);
    const prior = entries.find((entry) => entry.sourceFileId === id);
    const next: SqlDemoAssetManifestEntry = {
      sourceFileId: id, archiveRelativePath: path, sha256: proofHash,
      sourceFileType: expectedType, sourceStatus: expectedStatus, sourcePrivacy: 'public', reachability,
    };
    if (prior) {
      if (prior.archiveRelativePath !== path || prior.sha256 !== proofHash || prior.sourceFileType !== expectedType || prior.sourceStatus !== expectedStatus) throw new Error(`${id} identity collision across requested reachability`);
      // A file reached from multiple exact SQL relationships needs one manifest row;
      // preserve the strongest loader-supported reason without making an unrelated claim.
      if (prior.reachability.kind === 'sql-header' || reachability.kind === 'sql-header') prior.reachability = { kind: 'sql-header' };
      else if (prior.reachability.kind === 'article-body' && reachability.kind === 'article-body') prior.reachability.articleSourceIds = [...new Set([...prior.reachability.articleSourceIds, ...reachability.articleSourceIds])];
      return prior;
    }
    entries.push(next);
    void file;
    return next;
  };
  for (const ref of headers) addProof(ref.imageId, { kind: 'sql-header' });

  // The accepted loader currently supports active article-body references only.
  // Rich fields such as Programs.content and Seminars.learningProcess are intentionally
  // not promoted to header or article reachability here.
  const activeArticles = source.Articles.filter((article) => article.status === 'active');
  const bodyRequests = new Map<string, number[]>();
  for (const article of activeArticles) {
    for (const url of htmlImages(article.content)) {
      const matches = (source.Files ?? []).filter((file) => file.url === url);
      if (matches.length !== 1) throw new Error(`Articles#${article.id} image source does not resolve to one native file identity`);
      const file = matches[0]!;
      bodyRequests.set(file.id, [...(bodyRequests.get(file.id) ?? []), article.id]);
    }
  }
  const grants: { sourceFileId: string; sourceSha256: string; decisionId: string }[] = [];
  for (const [id, articleIds] of bodyRequests) {
    const file = nativeFiles.get(id)!;
    if (file.status === 'unlinked') {
      const bodyProof = bodyRows.find((row) => valueAt(row, 'source_file_id', 'sourceFileId') === id);
      if (!bodyProof) throw new Error(`${id} requested by active article HTML is missing an exact owner allowlist grant`);
      const sourceHash = digest(valueAt(bodyProof, 'sha256'), `${id} body proof SHA-256`);
      const decisionId = decisionFor(id, sourceHash);
      if (!decisionId) throw new Error(`${id} requested by active article HTML lacks an exact owner file and hash grant`);
      const grant: { sourceFileId: string; sourceSha256: string; decisionId: string } = { sourceFileId: id, sourceSha256: sourceHash, decisionId };
      grants.push(grant);
      addProof(id, { kind: 'article-body', articleSourceIds: [...new Set(articleIds)] }, 'image', 'unlinked');
    } else if (file.status === 'active') {
      addProof(id, { kind: 'article-body', articleSourceIds: [...new Set(articleIds)] });
    } else {
      throw new Error(`${id} requested by active article HTML is not active or owner-approved unlinked media`);
    }
  }

  const videos = (source.Videos ?? []).filter((row) => row.status === 'active');
  for (const row of reachedThumbs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'thumbnail source file ID');
    const videoId = numberId(valueAt(row, 'source_video_id', 'sourceVideoId'), `${id} video ID`);
    const video = videos.find((item) => item.id === videoId && item.imageId === id);
    if (!video) throw new Error(`${id} thumbnail metadata does not match native Videos`);
    addProof(id, { kind: 'video-thumbnail', videoSourceId: video.id });
  }
  const bindings = source.FileBindingOrganizationInfo ?? [];
  for (const row of reachedDocs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'document metadata source file ID');
    const bindingId = numberId(valueAt(row, 'binding_id', 'bindingId'), `${id} binding ID`);
    const binding = bindings.find((item) => item.id === bindingId && item.fileId === id);
    const info = binding && (source.OrganizationInfo ?? []).filter((item) => item.id === binding.organizationInfoId && item.status === 'active');
    if (!binding || info?.length !== 1) throw new Error(`${id} document metadata does not match native FileBindingOrganizationInfo`);
    addProof(id, { kind: 'document-binding', bindingSourceId: binding.id }, 'document');
  }

  const approved = privateData['approved-supplements.json'];
  const acceptedCorpusRevision = string(valueAt(approved, 'accepted_corpus_revision', 'acceptedCorpusRevision'), 'accepted corpus revision');
  const staticBlobCandidates = config.supplementBlobs.filter((blob) => blob.revision === acceptedCorpusRevision && /static_pages\.json$/i.test(blob.path));
  const staticBlob = staticBlobCandidates.find((blob) => /(?:^|\/)discovery\/entities\/static_pages\.json$/i.test(blob.path))
    ?? staticBlobCandidates.find((blob) => /static_pages\.json$/i.test(blob.path));
  const staticBlobs = staticBlob ? [staticBlob] : [];
  const pages: SqlDemoAcceptedSupplements['pages'] = [];
  const targetLocations: SqlDemoAcceptedSupplements['targetLocations'] = [];
  const pageOwners: { page: SqlDemoAcceptedSupplements['pages'][number]['page']; sourcePath: string }[] = [];
  for (const blob of staticBlobs) {
    let pageRows: unknown[];
    try { pageRows = array(JSON.parse(Buffer.from(blob.bytes).toString('utf8')), `${blob.path} page DTOs`); }
    catch { throw new Error(`${blob.path} must contain a JSON array of static page DTOs`); }
    for (const raw of pageRows) {
      const row = object(raw, `${blob.path} static page DTO`);
      const dto = {
        title: string(row.title, `${blob.path} page title`), slug: string(row.slug, `${blob.path} page slug`),
        legacy_id: string(valueAt(row, 'legacy_id', 'legacyId'), `${blob.path} page legacy ID`),
        body: string(valueAt(row, 'body_html', 'bodyHtml'), `${blob.path} page body HTML`),
        seo: { seo_title: string(valueAt(row, 'seo_title', 'seoTitle'), `${blob.path} SEO title`), seo_description: string(valueAt(row, 'seo_description', 'seoDescription'), `${blob.path} SEO description`) },
      };
      pages.push({ sourcePath: blob.path, revision: blob.revision, sha256: digest(blob.sha256, `${blob.path} blob SHA-256`), page: dto });
      pageOwners.push({ page: dto, sourcePath: blob.path });
    }
  }
  // The loader's supplement scopes are executable verification contracts, not
  // labels for every descriptive approval role. Only the selected JSON page corpus
  // is in-scope here; other accepted code/data blobs remain byte-pinned above.
  const supplementEntries = staticBlob ? [{
    name: staticBlob.path,
    scope: 'public-static-page' as const,
    sourcePath: staticBlob.path,
    revision: staticBlob.revision,
    sha256: digest(staticBlob.sha256, `${staticBlob.path} supplement SHA-256`),
  }] : [];
  const codeRevision = string(valueAt(approved, 'application_candidate_revision', 'applicationCandidateRevision'), 'supplement manifest code revision');
  const supplementManifestPayload = { schemaVersion: 1 as const, scope: 'sql-demo-approved-supplements' as const, codeRevision, entries: supplementEntries };
  const supplementManifest: SqlDemoSupplementManifest = { ...supplementManifestPayload, sha256: computeSqlDemoSupplementManifestSha256(supplementManifestPayload) };
  const expectedSupplements = { codeRevision, manifestSha256: supplementManifest.sha256 };

  const orgRows = source.OrganizationInfo ?? [];
  const orgEntities = mapped.entities.organizationInfo ?? [];
  const orgEntityById = new Map(orgEntities.map((row) => [row.sourceId, row]));
  const organizationIds = new Set(orgEntities.map((row) => String(row.sourceId)));
  const pagePositions: { page: SqlDemoAcceptedSupplements['pages'][number]['page']; id: string; title: string; index: number }[] = [];
  for (const { page } of pageOwners) {
    const fragment = parsedHtml(page.body);
    const topLevelItems: { id: string; title: string }[] = [];
    const collectItems = (node: ReturnType<typeof parsedHtml>, nestedInItem: boolean): void => {
      const insideItem = nestedInItem || node.tagName === 'li';
      if (node.tagName === 'li' && !nestedInItem) {
        const id = attr(node, 'id') ?? '';
        let title = '';
        let hasRadixPanel = false;
        parseNodes(node, (nested) => {
          if (nested.tagName === 'div' && attr(nested, 'data-state') === 'closed') {
            parseNodes(nested, (button) => {
              if (button.tagName === 'button' && (attr(button, 'class') ?? '').split(/\s+/).includes('collapsible_trigger')) {
                parseNodes(button, (heading) => {
                  if (heading.tagName === 'h2' && attr(heading, 'data-collapsible-title') === 'true') {
                    title = textContent(heading).trim();
                    hasRadixPanel = true;
                  }
                });
              }
            });
          }
        });
        topLevelItems.push({ id: hasRadixPanel ? id : '', title: hasRadixPanel ? title : '' });
      }
      for (const child of node.childNodes ?? []) collectItems(child as ReturnType<typeof parsedHtml>, insideItem);
    };
    collectItems(fragment, false);
    for (const [index, item] of topLevelItems.entries()) {
      if (item.id && organizationIds.has(item.id)) pagePositions.push({ page, ...item, index });
    }
  }
  const officialInfoSlug = 'svedeniya-ob-obrazovatelnoy-organizatsii';
  const officialPage = pages.find((entry) => entry.page.slug === officialInfoSlug)?.page;
  const matchingPages = officialPage ? [officialPage] : [...new Set(pagePositions.map((position) => position.page))];
  for (const row of orgRows.filter((item) => item.status === 'active')) {
    const mappedEntity = orgEntityById.get(row.id);
    if (!mappedEntity) continue;
    const matches = pagePositions.filter((item) => item.id === String(row.id) && matchingPages.includes(item.page));
    if (matches.length !== 1 || matches[0]!.title !== row.name) throw new Error(`OrganizationInfo#${row.id} must match one exact static-page DOM position and title`);
    targetLocations.push({
      sourceTable: 'OrganizationInfo', sourceId: row.id, targetCollection: 'pages', targetLegacyId: matches[0]!.page.legacy_id,
      targetField: 'body', sectionKey: `organization-info-${row.id}`, anchor: `section-${matches[0]!.index + 1}`,
    });
  }

  for (const row of reachedDocs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'document metadata source file ID');
    const proof = proofById.get(id);
    if (!proof || !entries.some((entry) => entry.sourceFileId === id && entry.sourceFileType === 'document')) throw new Error(`${id} document metadata has no matching verified byte proof`);
    const bindingId = numberId(valueAt(row, 'binding_id', 'bindingId'), `${id} binding ID`);
    const binding = bindings.find((item) => item.id === bindingId && item.fileId === id);
    if (!binding) throw new Error(`${id} document metadata does not match native FileBindingOrganizationInfo`);
    const info = (source.OrganizationInfo ?? []).find((item) => item.id === binding.organizationInfoId && item.status === 'active');
    if (!info || valueAt(row, 'organization_info_id', 'organizationInfoId') !== info.id ||
      valueAt(row, 'priority') !== binding.priority || valueAt(row, 'title') !== binding.title || valueAt(row, 'section_name', 'sectionName') !== info.name) {
      throw new Error(`${id} document metadata does not match native binding and section identity`);
    }
  }
  for (const row of reachedThumbs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'thumbnail source file ID');
    const proof = proofById.get(id);
    if (!proof || !entries.some((entry) => entry.sourceFileId === id && entry.reachability.kind === 'video-thumbnail')) throw new Error(`${id} video thumbnail metadata has no matching verified byte proof`);
    const videoId = numberId(valueAt(row, 'source_video_id', 'sourceVideoId'), `${id} video ID`);
    if (!videos.some((video) => video.id === videoId && video.imageId === id && video.name === valueAt(row, 'source_video_name', 'sourceVideoName'))) throw new Error(`${id} thumbnail metadata does not match native Videos`);
  }

  const videoFile = privateData['video-source-reference-decisions.json'];
  const decisionRows = array(valueAt(videoFile, 'records'), 'video source decisions');
  const expectedRel = string(valueAt(videoFile, 'target_rel', 'targetRel'), 'video decision rel policy');
  const videoReferences: SqlDemoOwnerDecisions['videoReferences'] = [];
  for (const raw of decisionRows) {
    const row = object(raw, 'video source decision');
    if (valueAt(row, 'source_table', 'sourceTable') !== 'Seminars') throw new Error('video source decision must bind to Seminars.description');
    const sourceId = numberId(valueAt(row, 'source_id', 'sourceId'), 'video decision seminar ID');
    const sourceUrl = string(valueAt(row, 'source_url', 'sourceUrl'), `Seminars#${sourceId} source URL`);
    const safeHref = string(valueAt(row, 'safe_target_href', 'safeTargetHref'), `Seminars#${sourceId} safe target`);
    if (sourceUrl !== safeHref) throw new Error(`Seminars#${sourceId} video decision must preserve its exact approved URL`);
    const seminar = source.Seminars.find((item) => item.id === sourceId && item.status === 'active');
    const mappedSeminar = mapped.entities.seminars.find((item) => item.sourceId === sourceId);
    if (!seminar || !mappedSeminar || !seminar.description?.includes(sourceUrl) || !String(mappedSeminar.description ?? '').includes(sourceUrl) ||
      valueAt(row, 'source_slug', 'sourceSlug') !== mappedSeminar.slug) throw new Error(`Seminars#${sourceId} video decision does not match active description source`);
    const decision = string(valueAt(row, 'decision'), `Seminars#${sourceId} video decision`);
    const action = decision.includes('canonicalize_same_https_rutube_embed_id') ? 'rutube-trailing-slash' : decision.includes('preserve_exact_source_url') || decision === 'external-link' ? 'external-link' : undefined;
    if (!action) throw new Error(`Seminars#${sourceId} video decision is unsupported`);
    const targetRel = valueAt(row, 'target_rel', 'targetRel');
    if (targetRel !== expectedRel) throw new Error(`Seminars#${sourceId} video decision rel policy differs from its pinned manifest`);
    const linkText = string(valueAt(row, 'link_text', 'linkText'), `Seminars#${sourceId} video link text`);
    const pathEnd = safeHref.search(/[?#]/);
    const pathPart = pathEnd < 0 ? safeHref : safeHref.slice(0, pathEnd);
    const suffix = pathEnd < 0 ? '' : safeHref.slice(pathEnd);
    const slashHref = `${pathPart.endsWith('/') ? pathPart : `${pathPart}/`}${suffix}`;
    const expectedOutput = action === 'rutube-trailing-slash'
      ? `<iframe src="${slashHref}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`
      : `<a href="${safeHref}" rel="${string(targetRel, `Seminars#${sourceId} target rel`)}">Открыть видео</a>`;
    void linkText;
    videoReferences.push({ sourceTable: 'Seminars', sourceId, field: 'description', originalURL: sourceUrl, action, expectedOutput });
  }

  const acceptedSupplements: SqlDemoAcceptedSupplements = {
    acceptedCorpus: {
      revision: acceptedCorpusRevision,
      sha256: digest(valueAt(approved, 'corpus_sha256', 'corpusSha256') ?? staticBlob?.sha256, 'accepted corpus SHA-256'),
    },
    pages, instituteMetadata: [], videoPlaylists: [], targetLocations,
  };
  const ownerDecisions: SqlDemoOwnerDecisions = {
    approvedUnlinkedArticleImages: grants.map((grant) => ({ sourceFileId: grant.sourceFileId, sourceUrl: nativeFiles.get(grant.sourceFileId)!.url!, decisionId: grant.decisionId })),
    videoReferences,
  };
  const allowlistedAssets: SqlDemoAllowlistedAssets = { images: [], documents: [] };
  const mapperOptions: SqlPublicContentOptions = { ...prepared, classificationCandidates: candidates };
  return {
    mapperOptions,
    loader: {
      source: sourceForLoader,
      selectedPublicHeaders: { sourceHash: sourceHash, references: headers },
      baseline: { sqlSha256: digest(config.baseline.sqlSha256, 'baseline SQL SHA-256'), archiveSha256: digest(config.baseline.archiveSha256, 'baseline archive SHA-256') },
      assetRoot: config.roots.assetRoot, assetManifest: {
        schemaVersion: 1, scope: 'sql-demo-public-assets', baselineSqlSha256: digest(config.baseline.sqlSha256, 'baseline SQL SHA-256'),
        archiveSha256: digest(config.baseline.archiveSha256, 'baseline archive SHA-256'), entries,
      },
      approvedBodyFileGrants: grants,
      supplementRoot: config.roots.supplementRoot, supplementManifest, expectedSupplements,
    },
    composer: { acceptedSupplements, allowlistedAssets, ownerDecisions },
    materializer: { status: 'pending-confirmation', teachers: candidates.teachers, articles: candidates.articles },
  };
}

export function normalizeSqlDemoPrivateInputs(input: {
  config: SqlDemoPrivateInputRootConfig;
  mapperOptions: Pick<SqlPublicContentOptions, 'expectedSourceHash' | 'acceptedLegacyIds' | 'classificationCandidates'>;
  nativeSqlPublicSource: SqlPublicSource;
  mapped: SqlPublicContentResult;
}): SqlDemoNormalizedPrivateInputs {
  const result = normalizePrivateInputs(input.config, input.nativeSqlPublicSource, input.mapped);
  if (digest(input.mapperOptions.expectedSourceHash, 'mapper options expected source hash') !== digest(result.mapperOptions.expectedSourceHash, 'baseline SQL SHA-256')) {
    throw new Error('mapper options expected source hash does not match the pinned SQL baseline');
  }
  return result;
}
