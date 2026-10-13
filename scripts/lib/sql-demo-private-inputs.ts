import { createHash } from 'node:crypto';
import { parseFragment } from 'parse5';
import type { SqlPublicContentOptions, SqlPublicContentResult, SqlPublicSource } from './sql-public-content.js';
import type { SqlMaterializerOptions } from './sql-public-materializer.js';
import type {
  SqlDemoAssetManifest,
  SqlDemoAssetManifestEntry,
  SqlDemoSupplementEntry,
  SqlDemoSupplementManifest,
} from './sql-demo-assets.js';
import { computeSqlDemoSupplementManifestSha256 } from './sql-demo-assets.js';
import { resolveSqlImageFile } from './sql-demo-image-identity.js';
import type {
  SqlDemoAcceptedSupplements,
  SqlDemoAllowlistedAssets,
  SqlDemoOwnerDecisions,
} from './sql-demo-release.js';
import { canonicalSqlDemoRutubeIframe } from './sql-demo-release.js';

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
    approvedPublicRichTextGrants: {
      sourceTable: 'Programs' | 'Seminars'; sourceId: number; sourceField: 'content' | 'learningProcess';
      sourceFileId: string; sourceSha256: string; decisionId: string; sourceReferenceAlias: string;
    }[];
    approvedMissingOriginalReplacements: {
      sourceFileId: string; replacementPath: string; replacementRevision: string; replacementSha256: string; sourceBytesAvailable: false;
    }[];
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
const manifestNumberId = (value: unknown, label: string): number => {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return numberId(Number(value), label);
  return numberId(value, label);
};
const parsedHtml = (html: string): { nodeName?: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: unknown[] } => parseFragment(html) as never;

const IMAGE_MAGIC_METADATA: Record<string, { magicClass: string; extensions: readonly string[] }> = {
  'image/png': { magicClass: 'png', extensions: ['png'] },
  'image/jpeg': { magicClass: 'jpeg', extensions: ['jpg', 'jpeg'] },
  'image/webp': { magicClass: 'webp', extensions: ['webp'] },
};

function validateByteProofMagic(proof: JsonObject, id: string, expectedType: 'image' | 'document', allowMissing = false): void {
  const mime = valueAt(proof, 'mime_type_from_magic', 'verified_mime');
  const magicClass = valueAt(proof, 'magic_class', 'magicClass');
  const targetExtension = valueAt(proof, 'target_extension_from_magic', 'targetExtensionFromMagic');
  if (proof.mime_type_from_magic !== undefined && proof.verified_mime !== undefined && proof.mime_type_from_magic !== proof.verified_mime) {
    throw new Error(`${id} byte proof has contradictory MIME metadata`);
  }
  if (proof.target_extension_from_magic !== undefined && proof.targetExtensionFromMagic !== undefined && proof.target_extension_from_magic !== proof.targetExtensionFromMagic) {
    throw new Error(`${id} byte proof has contradictory target extension metadata`);
  }
  const extensionMatch = valueAt(proof, 'extension_matches_magic', 'extensionMatchesMagic');
  if (extensionMatch !== undefined && typeof extensionMatch !== 'boolean') throw new Error(`${id} byte proof extension match metadata is invalid`);
  if (allowMissing && mime === undefined && magicClass === undefined && targetExtension === undefined) return;
  if (expectedType === 'document') {
    if (mime !== 'application/pdf' || magicClass !== 'pdf' || (targetExtension !== undefined && targetExtension !== 'pdf')) {
      throw new Error(`${id} byte proof has unsupported or contradictory document magic metadata`);
    }
    const sourceExtension = valueAt(proof, 'source_extension', 'declared_extension');
    if (extensionMatch === true && sourceExtension !== undefined && sourceExtension !== 'pdf') throw new Error(`${id} byte proof contradicts its source extension match claim`);
    return;
  }

  const detected = IMAGE_MAGIC_METADATA[String(mime)];
  if (!detected || (magicClass !== undefined && magicClass !== detected.magicClass) ||
      (targetExtension !== undefined && !detected.extensions.includes(String(targetExtension)))) {
    throw new Error(`${id} byte proof has unsupported or contradictory image magic metadata`);
  }
  const sourceExtension = valueAt(proof, 'source_extension', 'declared_extension');
  if (extensionMatch === true && sourceExtension !== undefined && !detected.extensions.includes(String(sourceExtension))) {
    throw new Error(`${id} byte proof contradicts its source extension match claim`);
  }
}

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
  for (const key of byKey.keys()) {
    if (!seen.has(key)) throw new Error(`${key.split('@')[0]} approved Git blob bytes are missing`);
  }
}

function selectedBlob(
  config: SqlDemoPrivateInputRootConfig,
  path: string,
  revision: string,
): { path: string; revision: string; sha256: string; bytes: Uint8Array } {
  const matches = config.supplementBlobs.filter((blob) => blob.path === path && blob.revision === revision);
  if (matches.length !== 1) throw new Error(`${path} at ${revision} must have exactly one approved pinned Git blob`);
  return matches[0]!;
}

function jsonArrayFromBlob(blob: { path: string; bytes: Uint8Array }): JsonObject[] {
  let rows: unknown[];
  try {
    rows = array(JSON.parse(Buffer.from(blob.bytes).toString('utf8')) as unknown, `${blob.path} rows`);
  } catch {
    throw new Error(`${blob.path} must contain a JSON array`);
  }
  return rows.map((row, index) => object(row, `${blob.path} row ${index + 1}`));
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
    const rawDecision = valueAt(ownerDecision, key);
    // Historical owner packets record these decisions as descriptive prose.
    // Keep prose non-authoritative; machine authorization stays in the DTO fields.
    if (typeof rawDecision === 'string' && rawDecision.trim()) continue;
    const decision = object(rawDecision, `owner ${key} decision`);
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
  const visitActive = (node: NonNullable<ReturnType<typeof parsedHtml>>): void => {
    if (node.tagName === 'script' || node.tagName === 'template') return;
    if (node.tagName === 'img') {
      const src = attr(node, 'src');
      if (src) found.push(src);
    }
    for (const child of node.childNodes ?? []) visitActive(child as ReturnType<typeof parsedHtml>);
  };
  visitActive(parsedHtml(html));
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
  const rawOwnerDecision = object(valueAt(owner, 'ownerDecision', 'owner_decision'), 'owner decision');
  validateOwnerClassification(owner, privateData['classification-candidates.json']);
  const ownerMedia = object(valueAt(owner, 'mediaAllowlist', 'media_allowlist'), 'owner media allowlist');
  const richTextAllowlistValue = valueAt(owner, 'richTextMediaAllowlist', 'rich_text_media_allowlist');
  const richTextAllowlist = richTextAllowlistValue === undefined ? undefined : object(richTextAllowlistValue, 'owner rich-text media allowlist');
  const richTextOwnerRows = richTextAllowlist
    ? array(richTextAllowlist.entries, 'owner rich-text media grants').map((raw) => object(raw, 'owner rich-text media grant'))
    : [];
  if (richTextAllowlist) {
    if (valueAt(richTextAllowlist, 'status') !== 'approved-for-demo' || valueAt(richTextAllowlist, 'allowlistOnly', 'allowlist_only') !== true ||
      valueAt(richTextAllowlist, 'wildcard') !== false || valueAt(richTextAllowlist, 'allEntriesReachableFromNamedActiveRichTextFields', 'all_entries_reachable_from_named_active_rich_text_fields') !== true ||
      valueAt(richTextAllowlist, 'allSourceEntriesArePublicAndUnlinked', 'all_source_entries_are_public_and_unlinked') !== true ||
      valueAt(richTextAllowlist, 'allCrcSizeAndSha256ChecksVerified', 'all_crc_size_and_sha256_checks_verified') !== true ||
      valueAt(richTextAllowlist, 'exactIdentityCount', 'exact_identity_count') !== richTextOwnerRows.length) {
      throw new Error('owner rich-text media allowlist is incomplete or not approved for this exact demo scope');
    }
  }
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
  const replacementRows: JsonObject[] = [];
  const rawMediaDecision = valueAt(rawOwnerDecision, 'media');
  if (rawMediaDecision && typeof rawMediaDecision === 'object' && !Array.isArray(rawMediaDecision)) {
    replacementRows.push(...array(valueAt(rawMediaDecision as JsonObject, 'missingOriginalReplacements', 'missing_original_replacements') ?? [], 'missing-original replacement decisions').map((raw) => object(raw, 'missing-original replacement decision')));
  }
  const replacementEntries: SqlDemoSupplementEntry[] = [];
  const replacementSourceIds = new Set<string>();
  const approvedSupplementRows = array(valueAt(privateData['approved-supplements.json'], 'supplements'), 'approved supplements').map((raw) => object(raw, 'approved supplement'));
  for (const replacement of replacementRows) {
    const sourceFileId = idString(valueAt(replacement, 'sourceFileId', 'source_file_id'), 'replacement source Files ID');
    if (replacementSourceIds.has(sourceFileId)) throw new Error(`Files#${sourceFileId} has duplicate missing-original replacement decisions`);
    replacementSourceIds.add(sourceFileId);
    const replacementPath = string(valueAt(replacement, 'replacementPath', 'replacement_path'), `Files#${sourceFileId} replacement path`);
    const replacementRevision = string(valueAt(replacement, 'replacementRevision', 'replacement_revision'), `${replacementPath} replacement revision`);
    const replacementSha256 = digest(valueAt(replacement, 'replacementSha256', 'replacement_sha256'), `${replacementPath} replacement SHA-256`);
    if (valueAt(replacement, 'sourceBytesAvailable', 'source_bytes_available') !== false || valueAt(replacement, 'demoApproved', 'demo_approved') !== true) {
      throw new Error(`Files#${sourceFileId} missing-original replacement lacks explicit demo-only approval or missing-byte provenance`);
    }
    const file = nativeFiles.get(sourceFileId);
    if (!file || file.fileType !== 'image' || file.status !== 'active' || file.privacy !== 'public') throw new Error(`Files#${sourceFileId} missing-original replacement does not join to an active public image`);
    const headerRefs = refsById.get(sourceFileId) ?? [];
    if (headerRefs.length !== 1 || headerRefs[0]!.sourceTable !== 'Institutes' || headerRefs[0]!.sourceId !== 3) {
      throw new Error(`Files#${sourceFileId} replacement is not the exact selected Institutes#3 header`);
    }
    const supplement = approvedSupplementRows.find((row) => valueAt(row, 'path', 'sourcePath') === replacementPath &&
      valueAt(row, 'revision') === replacementRevision && digest(valueAt(row, 'sha256'), `${replacementPath} approved supplement SHA-256`) === replacementSha256 &&
      valueAt(row, 'replaces_missing_source_file_id', 'replacesMissingSourceFileId') === sourceFileId);
    if (!supplement) throw new Error(`Files#${sourceFileId} replacement is not pinned as its named approved supplement`);
    const blob = config.supplementBlobs.find((item) => item.path === replacementPath && item.revision === replacementRevision);
    if (!blob || digest(blob.sha256, `${replacementPath} replacement blob SHA-256`) !== replacementSha256 || sha256(blob.bytes) !== replacementSha256) {
      throw new Error(`Files#${sourceFileId} named replacement bytes do not match their owner-pinned SHA-256`);
    }
    replacementEntries.push({ name: replacementPath, scope: 'missing-original-replacement', sourcePath: replacementPath, revision: replacementRevision, sha256: replacementSha256, replacesMissingSourceFileId: sourceFileId });
  }
  const activeSource = (id: string, expectedType: 'image' | 'document', expectedStatus: 'active' | 'unlinked') => {
    const file = nativeFiles.get(id);
    if (!file) throw new Error(`${id} has no matching native Files identity`);
    if (file.fileType !== expectedType || file.status !== expectedStatus || file.privacy !== 'public') throw new Error(`${id} native file type, status, or privacy does not match its proof`);
    return file;
  };
  const entries: SqlDemoAssetManifestEntry[] = [];
  const addProof = (id: string, reachability: SqlDemoAssetManifestEntry['reachability'], expectedType: 'image' | 'document' = 'image', expectedStatus: 'active' | 'unlinked' = 'active') => {
    if (reachability.kind === 'sql-header' && replacementEntries.some((entry) => entry.replacesMissingSourceFileId === id)) return undefined;
    const selectedHeaderProof = reachability.kind === 'sql-header' && refsById.has(id) ? existingById.get(id) : undefined;
    const proof = proofById.get(id) ?? bodyById.get(id) ?? selectedHeaderProof;
    if (!proof) throw new Error(`${id} has no matching verified byte proof`);
    const file = activeSource(id, expectedType, expectedStatus);
    const sourceFileType = valueAt(proof, 'source_file_type', 'sourceFileType');
    if (sourceFileType !== expectedType && !(proof === selectedHeaderProof && sourceFileType === undefined && expectedType === 'image')) {
      throw new Error(`${id} byte proof file type does not match native Files`);
    }
    const path = string(valueAt(proof, 'archive_relative_path', 'archiveRelativePath'), `${id} archive path`);
    const byteCount = valueAt(proof, 'bytes');
    if (!Number.isSafeInteger(byteCount) || (byteCount as number) < 0 || valueAt(proof, 'zip_crc_verified', 'crc_verified') !== true && valueAt(proof, 'crc_verified', 'zip_crc_verified') !== true) throw new Error(`${id} byte proof or CRC verification is invalid`);
    const proofHash = digest(valueAt(proof, 'sha256'), `${id} byte proof SHA-256`);
    const privacy = valueAt(proof, 'privacy', 'source_privacy');
    const status = valueAt(proof, 'status', 'source_status');
    if (proof === selectedHeaderProof) {
      if (valueAt(proof, 'crc_verified', 'crcVerified') !== true || !Number.isSafeInteger(byteCount) || (byteCount as number) < 0) {
        throw new Error(`${id} existing byte proof size or CRC verification is invalid`);
      }
    } else if (privacy !== 'public' || status !== expectedStatus) {
      throw new Error(`${id} byte proof status or privacy does not match native Files`);
    }
    // The source extension describes the original filename. It may disagree with
    // the verified bytes; only an explicit target extension is a byte-magic claim.
    validateByteProofMagic(proof, id, expectedType, proof === selectedHeaderProof && expectedType === 'image');
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

  const activeArticles = source.Articles.filter((article) => article.status === 'active');
  const bodyRequests = new Map<string, { articleIds: number[]; sourceUrls: string[] }>();
  for (const article of activeArticles) {
    for (const url of htmlImages(article.content)) {
      const file = resolveSqlImageFile(source.Files ?? [], url, `Articles#${article.id}.content`);
      const prior = bodyRequests.get(file.id) ?? { articleIds: [], sourceUrls: [] };
      prior.articleIds.push(article.id);
      prior.sourceUrls.push(url);
      bodyRequests.set(file.id, prior);
    }
  }
  const articleSourceUrlsById = new Map<string, string>();
  const grants: { sourceFileId: string; sourceSha256: string; decisionId: string }[] = [];
  for (const [id, request] of bodyRequests) {
    const file = nativeFiles.get(id)!;
    articleSourceUrlsById.set(id, request.sourceUrls[0]!);
    if (file.status === 'unlinked') {
      const bodyProof = bodyRows.find((row) => valueAt(row, 'source_file_id', 'sourceFileId') === id);
      if (!bodyProof) throw new Error(`${id} requested by active article HTML is missing an exact owner allowlist grant`);
      const sourceHash = digest(valueAt(bodyProof, 'sha256'), `${id} body proof SHA-256`);
      const decisionId = decisionFor(id, sourceHash);
      if (!decisionId) throw new Error(`${id} requested by active article HTML lacks an exact owner file and hash grant`);
      const grant: { sourceFileId: string; sourceSha256: string; decisionId: string } = { sourceFileId: id, sourceSha256: sourceHash, decisionId };
      grants.push(grant);
      addProof(id, { kind: 'article-body', articleSourceIds: [...new Set(request.articleIds)] }, 'image', 'unlinked');
    } else if (file.status === 'active') {
      addProof(id, { kind: 'article-body', articleSourceIds: [...new Set(request.articleIds)] });
    } else {
      throw new Error(`${id} requested by active article HTML is not active or owner-approved unlinked media`);
    }
  }

  type RichTextGrant = {
    sourceTable: 'Programs' | 'Seminars'; sourceId: number; sourceField: 'content' | 'learningProcess';
    sourceFileId: string; sourceSha256: string; decisionId: string; sourceReferenceAlias: string;
  };
  const approvedPublicRichTextGrants: RichTextGrant[] = [];
  const richTextDecisions: SqlDemoOwnerDecisions['approvedPublicRichTextImages'] = [];
  const richTextSources = [
    ...source.Programs.filter((row) => row.status === 'active').map((row) => ({ table: 'Programs' as const, id: row.id, sourceField: 'content' as const, html: row.content ?? '' })),
    ...source.Seminars.filter((row) => row.status === 'active').map((row) => ({ table: 'Seminars' as const, id: row.id, sourceField: 'learningProcess' as const, html: row.learningProcess ?? '' })),
  ];
  const richRefsByKey = new Map<string, { sourceUrl: string; sourceFileId: string }[]>();
  for (const context of richTextSources) {
    for (const sourceUrl of htmlImages(context.html)) {
      const file = resolveSqlImageFile(source.Files ?? [], sourceUrl, `${context.table}#${context.id}.${context.sourceField}`);
      if (file.status !== 'unlinked') continue;
      const key = `${context.table}#${context.id}.${context.sourceField}\0${file.id}`;
      richRefsByKey.set(key, [...(richRefsByKey.get(key) ?? []), { sourceUrl, sourceFileId: file.id }]);
    }
  }
  const usedRichTextOwnerKeys = new Set<string>();
  for (const raw of richTextOwnerRows) {
    const table = valueAt(raw, 'sourceTable', 'source_table');
    const sourceField = valueAt(raw, 'sourceField', 'source_field');
    const sourceId = numberId(valueAt(raw, 'sourceId', 'source_id'), 'owner rich-text source ID');
    if ((table !== 'Programs' || sourceField !== 'content') && (table !== 'Seminars' || sourceField !== 'learningProcess')) {
      throw new Error(`rich-text owner decision for ${table}#${sourceId} has an unsupported source field`);
    }
    const sourceTable = table as RichTextGrant['sourceTable'];
    const field = sourceField as RichTextGrant['sourceField'];
    const fileId = idString(valueAt(raw, 'sourceFileId', 'source_file_id'), 'owner rich-text source file ID');
    const sourceSha256 = digest(valueAt(raw, 'sourceSha256', 'source_sha256'), `Files#${fileId} rich-text owner SHA-256`);
    const decisionId = string(valueAt(raw, 'decisionId', 'decision_id'), `Files#${fileId} rich-text owner decision`);
    if (valueAt(raw, 'demoApproved', 'demo_approved') !== true || valueAt(raw, 'verifiedMime', 'verified_mime') !== 'image/png' ||
      valueAt(raw, 'approvedExtension', 'approved_extension') !== 'png') {
      throw new Error(`Files#${fileId} rich-text owner decision lacks its exact approved PNG proof`);
    }
    activeSource(fileId, 'image', 'unlinked');
    const byteProof = bodyById.get(fileId);
    if (!byteProof || digest(valueAt(byteProof, 'sha256'), `Files#${fileId} rich-text byte proof SHA-256`) !== sourceSha256 ||
      valueAt(raw, 'sourceBytes', 'source_bytes') !== valueAt(byteProof, 'bytes') ||
      valueAt(byteProof, 'source_file_type', 'sourceFileType') !== 'image' ||
      valueAt(byteProof, 'source_privacy', 'privacy') !== 'public' || valueAt(byteProof, 'source_status', 'status') !== 'unlinked' ||
      valueAt(byteProof, 'verified_mime', 'mime_type_from_magic') !== 'image/png' ||
      valueAt(byteProof, 'target_extension_from_magic', 'source_extension') !== 'png' ||
      valueAt(byteProof, 'crc_verified', 'zip_crc_verified') !== true || !Number.isSafeInteger(valueAt(byteProof, 'bytes'))) {
      throw new Error(`Files#${fileId} rich-text byte proof does not match its approved exact PNG identity`);
    }
    const sourceRows = sourceTable === 'Programs'
      ? source.Programs.filter((row) => row.id === sourceId && row.status === 'active')
      : source.Seminars.filter((row) => row.id === sourceId && row.status === 'active');
    if (sourceRows.length !== 1) throw new Error(`${sourceTable}#${sourceId} rich-text owner decision does not identify one active SQL row`);
    const mappedRows = sourceTable === 'Programs'
      ? mapped.entities.programs.filter((row) => row.sourceId === sourceId)
      : mapped.entities.seminars.filter((row) => row.sourceId === sourceId);
    if (mappedRows.length !== 1) throw new Error(`${sourceTable}#${sourceId} rich-text owner decision does not identify one mapped public row`);
    const sourceHtml = sourceTable === 'Programs'
      ? source.Programs.find((row) => row.id === sourceId)!.content ?? ''
      : source.Seminars.find((row) => row.id === sourceId)!.learningProcess ?? '';
    const mappedHtml = sourceTable === 'Programs'
      ? String(mappedRows[0]!.description ?? '')
      : String(mappedRows[0]!.learning_plan ?? '');
    if (mappedHtml !== sourceHtml) throw new Error(`${sourceTable}#${sourceId}.${field} is not preserved in its exact mapped public field`);
    const aliases = htmlImages(sourceHtml).filter((sourceUrl) => resolveSqlImageFile(source.Files ?? [], sourceUrl, `${sourceTable}#${sourceId}.${field}`).id === fileId);
    if (!aliases.length) throw new Error(`Files#${fileId} owner decision is not reached by ${sourceTable}#${sourceId}.${field}`);
    const key = `${sourceTable}#${sourceId}.${field}\0${fileId}`;
    usedRichTextOwnerKeys.add(key);
    const references: SqlDemoAssetManifestEntry['reachability'] = {
      kind: 'public-rich-text', references: [{ sourceTable, sourceId, sourceField: field }],
    };
    addProof(fileId, references, 'image', 'unlinked');
    for (const sourceUrl of new Set(aliases)) {
      approvedPublicRichTextGrants.push({ sourceTable, sourceId, sourceField: field, sourceFileId: fileId, sourceSha256, decisionId, sourceReferenceAlias: sourceUrl });
      richTextDecisions.push({ sourceTable, sourceId, sourceField: field, sourceFileId: fileId, sourceSha256, decisionId, sourceUrl });
    }
  }
  for (const key of richRefsByKey.keys()) {
    if (!usedRichTextOwnerKeys.has(key)) throw new Error(`unlinked SQL rich-text image ${key.replace('\0', ' ')} has no exact owner file and field approval`);
  }

  const videos = (source.Videos ?? []).filter((row) => row.status === 'active');
  for (const row of reachedThumbs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'thumbnail source file ID');
    const videoId = manifestNumberId(valueAt(row, 'source_video_id', 'sourceVideoId'), `${id} video ID`);
    const video = videos.find((item) => item.id === videoId && item.imageId === id);
    if (!video) throw new Error(`${id} thumbnail metadata does not match native Videos`);
    addProof(id, { kind: 'video-thumbnail', videoSourceId: video.id });
  }
  const bindings = source.FileBindingOrganizationInfo ?? [];
  for (const row of reachedDocs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'document metadata source file ID');
    const bindingId = manifestNumberId(valueAt(row, 'binding_id', 'bindingId'), `${id} binding ID`);
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
  const supplementEntries: SqlDemoSupplementEntry[] = [...(staticBlob ? [{
    name: staticBlob.path,
    scope: 'public-static-page' as const,
    sourcePath: staticBlob.path,
    revision: staticBlob.revision,
    sha256: digest(staticBlob.sha256, `${staticBlob.path} supplement SHA-256`),
  }] : []), ...replacementEntries];
  const codeRevision = string(valueAt(approved, 'application_candidate_revision', 'applicationCandidateRevision'), 'supplement manifest code revision');
  const supplementManifestPayload = { schemaVersion: 1 as const, scope: 'sql-demo-approved-supplements' as const, codeRevision, entries: supplementEntries };
  const supplementManifest: SqlDemoSupplementManifest = { ...supplementManifestPayload, sha256: computeSqlDemoSupplementManifestSha256(supplementManifestPayload) };
  const expectedSupplements = { codeRevision, manifestSha256: supplementManifest.sha256 };

  const approvedPinPaths = new Set(array(valueAt(approved, 'supplements'), 'approved supplements').map((raw) =>
    string(valueAt(object(raw, 'approved supplement'), 'path'), 'approved supplement path')));
  const metadataPinPaths = [
    'discovery/entities/institutes.json',
    'fixtures/content-snapshot/types/institutes.json',
    'discovery/entities/video_playlists.json',
    'fixtures/content-snapshot/types/video_playlists.json',
    'web/src/lib/video-mirrors.ts',
  ];
  const hasSelectedMetadata = metadataPinPaths.some((path) => approvedPinPaths.has(path));
  const instituteMetadata: SqlDemoAcceptedSupplements['instituteMetadata'] = [];
  const videoPlaylists: SqlDemoAcceptedSupplements['videoPlaylists'] = [];
  if (hasSelectedMetadata) {
  const instituteBlob = selectedBlob(config, 'discovery/entities/institutes.json', acceptedCorpusRevision);
  const playlistBlob = selectedBlob(config, 'discovery/entities/video_playlists.json', acceptedCorpusRevision);
  // Pin the selected mirror mapping at the approved application revision. Its
  // contents do not replace SQL identity or the asset binder's target URL.
  selectedBlob(config, 'web/src/lib/video-mirrors.ts', codeRevision);

  const instituteRows = jsonArrayFromBlob(instituteBlob);
  const institutesByLegacyId = new Map<string, JsonObject>();
  for (const row of instituteRows) {
    const legacyId = string(valueAt(row, 'legacy_id', 'legacyId'), `${instituteBlob.path} legacy_id`);
    if (institutesByLegacyId.has(legacyId)) throw new Error(`${instituteBlob.path} has duplicate institute legacy identity ${legacyId}`);
    institutesByLegacyId.set(legacyId, row);
  }
  instituteMetadata.push(...(mapped.entities.institutes ?? []).map((entity) => {
    const sourceId = numberId(entity.sourceId, 'Institutes source ID');
    const legacyId = idString(entity.legacy_id, `Institutes#${sourceId} legacy identity`);
    const row = institutesByLegacyId.get(legacyId);
    if (!row) throw new Error(`Institutes#${sourceId} has no exact accepted JSON metadata row`);
    if (valueAt(row, 'slug') !== entity.slug) throw new Error(`Institutes#${sourceId} accepted slug does not match its SQL identity`);
    institutesByLegacyId.delete(legacyId);
    return {
      sourceId,
      slug: string(valueAt(row, 'slug'), `Institutes#${sourceId} accepted slug`),
      order: numberId(valueAt(row, 'order'), `Institutes#${sourceId} accepted order`),
      seo: {
        seo_title: string(valueAt(row, 'seo_title', 'seoTitle'), `Institutes#${sourceId} SEO title`),
        seo_description: string(valueAt(row, 'seo_description', 'seoDescription'), `Institutes#${sourceId} SEO description`),
      },
    };
  }));
  if (institutesByLegacyId.size) throw new Error(`${instituteBlob.path} contains metadata without a matching SQL institute identity`);

  const playlistRows = jsonArrayFromBlob(playlistBlob);
  const playlistsByLegacyId = new Map<string, JsonObject>();
  for (const row of playlistRows) {
    const legacyId = string(valueAt(row, 'legacy_id', 'legacyId'), `${playlistBlob.path} legacy_id`);
    if (playlistsByLegacyId.has(legacyId)) throw new Error(`${playlistBlob.path} has duplicate playlist legacy identity ${legacyId}`);
    playlistsByLegacyId.set(legacyId, row);
  }
  const sourceVideos = new Map((source.Videos ?? []).map((row) => [row.id, row]));
  const thumbnailsByVideoId = new Map<number, JsonObject>();
  for (const row of reachedThumbs) {
    const videoId = manifestNumberId(valueAt(row, 'source_video_id', 'sourceVideoId'), 'video thumbnail source ID');
    if (thumbnailsByVideoId.has(videoId)) throw new Error(`Videos#${videoId} has duplicate thumbnail byte attestations`);
    thumbnailsByVideoId.set(videoId, row);
  }
  videoPlaylists.push(...(mapped.entities.videos ?? []).map((entity) => {
    const sourceId = numberId(entity.sourceId, 'Videos source ID');
    const legacyId = idString(entity.legacy_id, `Videos#${sourceId} legacy identity`);
    const row = playlistsByLegacyId.get(legacyId);
    const sql = sourceVideos.get(sourceId);
    if (!row || !sql || sql.status !== 'active') throw new Error(`Videos#${sourceId} must match one active SQL playlist and one accepted JSON identity`);
    const expectedLegacyId = `video/pleylist/${sourceId}`;
    if (legacyId !== expectedLegacyId || valueAt(row, 'slug') !== String(sourceId)) {
      throw new Error(`Videos#${sourceId} accepted slug or legacy identity does not match the approved playlist ID`);
    }
    const title = string(sql.name, `Videos#${sourceId} SQL name`);
    if (valueAt(row, 'title') !== title || entity.title !== title) throw new Error(`Videos#${sourceId} accepted title does not match SQL`);
    if (entity.slug !== String(sourceId)) throw new Error(`Videos#${sourceId} mapped slug does not match its SQL identity`);
    playlistsByLegacyId.delete(legacyId);

    let thumbnailSourceFileId: string | null = null;
    let thumbnailSourceUrl: string | null = null;
    if (sql.imageId !== null) {
      const proof = thumbnailsByVideoId.get(sourceId);
      const file = source.Files?.find((item) => item.id === sql.imageId);
      if (!proof || valueAt(proof, 'source_file_id', 'sourceFileId') !== sql.imageId || !file?.url) {
        throw new Error(`Videos#${sourceId} SQL imageId lacks an exact source file and byte proof`);
      }
      thumbnailSourceFileId = sql.imageId;
      thumbnailSourceUrl = file.url;
    } else if (thumbnailsByVideoId.has(sourceId)) {
      throw new Error(`Videos#${sourceId} has thumbnail proof without a SQL imageId`);
    }

    return {
      sourceId,
      sourcePath: playlistBlob.path,
      revision: playlistBlob.revision,
      sha256: digest(playlistBlob.sha256, `${playlistBlob.path} SHA-256`),
      slug: String(sourceId),
      legacy_id: expectedLegacyId,
      seo: {
        seo_title: string(valueAt(row, 'seo_title', 'seoTitle'), `Videos#${sourceId} SEO title`),
        seo_description: string(valueAt(row, 'seo_description', 'seoDescription'), `Videos#${sourceId} SEO description`),
      },
      videos: null,
      thumbnailSourceFileId,
      thumbnailSourceUrl,
      // The asset binder supplies the target URL after byte verification.
      thumbnailPublicUrl: null,
    };
  }));
  if (playlistsByLegacyId.size) throw new Error(`${playlistBlob.path} contains a playlist without a matching active SQL Videos identity`);
  for (const sourceId of thumbnailsByVideoId.keys()) {
    if (!(mapped.entities.videos ?? []).some((video) => video.sourceId === sourceId)) {
      throw new Error(`Videos#${sourceId} has thumbnail proof without a selected SQL playlist identity`);
    }
  }
  }

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
        const directElements = (parent: ReturnType<typeof parsedHtml>): ReturnType<typeof parsedHtml>[] =>
          (parent.childNodes ?? []).filter((child) => (child as ReturnType<typeof parsedHtml>).tagName) as ReturnType<typeof parsedHtml>[];
        const directDivs = directElements(node).filter((child) => child.tagName === 'div');
        const containers = directDivs.flatMap((child) => {
          if (attr(child, 'data-state') === 'closed') return [child];
          // The approved source page wraps the Radix root in one CSS-module div.
          // Keep this finite shape explicit; do not search through arbitrary wrappers.
          if (!attr(child, 'class')) return [];
          const nested = directElements(child).filter((candidate) =>
            candidate.tagName === 'div' && attr(candidate, 'data-state') === 'closed');
          return directElements(child).length === 1 ? nested : [];
        });
        if (containers.length === 1) {
          const [container] = containers;
          const triggers = directElements(container!).filter((child) => {
            if (child.tagName !== 'button') return false;
            return (attr(child, 'class') ?? '').split(/\s+/).some((token) =>
              token === 'collapsible_trigger' || /^collapsible_trigger__[A-Za-z0-9_-]+$/.test(token));
          });
          if (triggers.length === 1) {
            const trigger = triggers[0]!;
            const directHeadings = directElements(trigger).filter((child) => child.tagName === 'h2');
            const wrappedHeadings = directElements(trigger)
              .filter((child) => child.tagName === 'div')
              .flatMap((wrapper) => directElements(wrapper)
                .filter((child) => child.tagName === 'div')
                .flatMap((inner) => directElements(inner).filter((child) => child.tagName === 'h2')));
            const headings = [...directHeadings, ...wrappedHeadings];
            if (headings.length === 1) {
              title = textContent(headings[0]!).trim();
              hasRadixPanel = title.length > 0;
            }
          }
        }
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
    const exactTitleMatches = matches.filter((position) => position.title === row.name).length;
    if (matches.length !== 1 || exactTitleMatches !== 1) {
      throw new Error(`OrganizationInfo#${row.id} must match one exact static-page DOM position and title (domMatches=${matches.length}, exactTitleMatches=${exactTitleMatches})`);
    }
    targetLocations.push({
      sourceTable: 'OrganizationInfo', sourceId: row.id, targetCollection: 'pages', targetLegacyId: matches[0]!.page.legacy_id,
      targetField: 'body', sectionKey: `organization-info-${row.id}`, anchor: `section-${matches[0]!.index + 1}`,
    });
  }

  for (const row of reachedDocs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'document metadata source file ID');
    const proof = proofById.get(id);
    if (!proof || !entries.some((entry) => entry.sourceFileId === id && entry.sourceFileType === 'document')) throw new Error(`${id} document metadata has no matching verified byte proof`);
    const bindingId = manifestNumberId(valueAt(row, 'binding_id', 'bindingId'), `${id} binding ID`);
    const binding = bindings.find((item) => item.id === bindingId && item.fileId === id);
    if (!binding) throw new Error(`${id} document metadata does not match native FileBindingOrganizationInfo`);
    const info = (source.OrganizationInfo ?? []).find((item) => item.id === binding.organizationInfoId && item.status === 'active');
    const organizationInfoId = manifestNumberId(valueAt(row, 'organization_info_id', 'organizationInfoId'), `${id} organization info ID`);
    if (!info || organizationInfoId !== info.id ||
      valueAt(row, 'priority') !== binding.priority || valueAt(row, 'title') !== binding.title || valueAt(row, 'section_name', 'sectionName') !== info.name) {
      throw new Error(`${id} document metadata does not match native binding and section identity`);
    }
  }
  for (const row of reachedThumbs) {
    const id = idString(valueAt(row, 'source_file_id', 'sourceFileId'), 'thumbnail source file ID');
    const proof = proofById.get(id);
    if (!proof || !entries.some((entry) => entry.sourceFileId === id)) throw new Error(`${id} video thumbnail metadata has no matching verified byte proof`);
    const videoId = manifestNumberId(valueAt(row, 'source_video_id', 'sourceVideoId'), `${id} video ID`);
    if (!videos.some((video) => video.id === videoId && video.imageId === id && video.name === valueAt(row, 'source_video_name', 'sourceVideoName'))) throw new Error(`${id} thumbnail metadata does not match native Videos`);
  }

  const videoFile = privateData['video-source-reference-decisions.json'];
  const decisionRows = array(valueAt(videoFile, 'records'), 'video source decisions');
  const expectedRel = string(valueAt(videoFile, 'target_rel', 'targetRel'), 'video decision rel policy');
  const videoReferences: SqlDemoOwnerDecisions['videoReferences'] = [];
  for (const raw of decisionRows) {
    const row = object(raw, 'video source decision');
    if (valueAt(row, 'source_table', 'sourceTable') !== 'Seminars') throw new Error('video source decision must bind to Seminars.description');
    const sourceId = manifestNumberId(valueAt(row, 'source_id', 'sourceId'), 'video decision seminar ID');
    const sourceUrl = string(valueAt(row, 'source_url', 'sourceUrl'), `Seminars#${sourceId} source URL`);
    const safeHref = string(valueAt(row, 'safe_target_href', 'safeTargetHref'), `Seminars#${sourceId} safe target`);
    const decision = string(valueAt(row, 'decision'), `Seminars#${sourceId} video decision`);
    const action = decision.includes('canonicalize_same_https_rutube_embed_id') ? 'rutube-trailing-slash' : decision.includes('preserve_exact_source_url') || decision === 'external-link' ? 'external-link' : undefined;
    if (!action) throw new Error(`Seminars#${sourceId} video decision is unsupported`);
    let sourceVideoUrl: URL;
    let safeVideoUrl: URL;
    try {
      sourceVideoUrl = new URL(sourceUrl);
      safeVideoUrl = new URL(safeHref);
    } catch {
      throw new Error(`Seminars#${sourceId} video decision URL is invalid`);
    }
    const canonicalRutube = action === 'rutube-trailing-slash'
      && sourceVideoUrl.protocol === 'https:' && sourceVideoUrl.hostname === 'rutube.ru'
      && !sourceVideoUrl.username && !sourceVideoUrl.password && !sourceVideoUrl.port && !sourceVideoUrl.hash
      && /^\/play\/embed\/[\da-f]{32}$/i.test(sourceVideoUrl.pathname)
      && [...sourceVideoUrl.searchParams.keys()].every((name) => name === 'p')
      && sourceVideoUrl.searchParams.size <= 1
      && sourceVideoUrl.searchParams.get('p') !== ''
      && safeVideoUrl.protocol === 'https:' && safeVideoUrl.hostname === 'rutube.ru'
      && !safeVideoUrl.username && !safeVideoUrl.password && !safeVideoUrl.port && !safeVideoUrl.search && !safeVideoUrl.hash
      && safeVideoUrl.pathname === `${sourceVideoUrl.pathname}/`;
    if (action === 'rutube-trailing-slash' ? !canonicalRutube : safeHref !== sourceUrl) {
      throw new Error(`Seminars#${sourceId} video decision must preserve the exact approved URL identity`);
    }
    const seminar = source.Seminars.find((item) => item.id === sourceId && item.status === 'active');
    const mappedSeminar = mapped.entities.seminars.find((item) => item.sourceId === sourceId);
    const sourceUrlMatch = Boolean(seminar?.description?.includes(sourceUrl));
    const mappedUrlMatch = Boolean(mappedSeminar && String(mappedSeminar.description ?? '').includes(sourceUrl));
    const sourceSlug = valueAt(row, 'source_slug', 'sourceSlug');
    const sourceSlugMatches = sourceSlug == null || sourceSlug === mappedSeminar?.slug;
    if (!seminar || !mappedSeminar || !sourceUrlMatch || !mappedUrlMatch || !sourceSlugMatches) {
      throw new Error(`video decision source association mismatch (sourceRow=${Boolean(seminar)}, mappedRow=${Boolean(mappedSeminar)}, sourceUrlMatch=${sourceUrlMatch}, mappedUrlMatch=${mappedUrlMatch}, sourceSlugMatches=${sourceSlugMatches})`);
    }
    const targetRel = valueAt(row, 'target_rel', 'targetRel');
    if (action === 'external-link' ? targetRel !== expectedRel : targetRel != null && targetRel !== expectedRel) {
      throw new Error(`Seminars#${sourceId} video decision rel policy differs from its pinned manifest`);
    }
    if (action === 'external-link') string(valueAt(row, 'link_text', 'linkText'), `Seminars#${sourceId} video link text`);
    const expectedOutput = action === 'rutube-trailing-slash'
      ? canonicalSqlDemoRutubeIframe(sourceUrl)
      : `<a href="${safeHref}" rel="${string(targetRel, `Seminars#${sourceId} target rel`)}">Открыть видео</a>`;
    videoReferences.push({ sourceTable: 'Seminars', sourceId, field: 'description', originalURL: sourceUrl, action, expectedOutput });
  }

  const acceptedSupplements: SqlDemoAcceptedSupplements = {
    acceptedCorpus: {
      revision: acceptedCorpusRevision,
      sha256: digest(valueAt(approved, 'corpus_sha256', 'corpusSha256') ?? staticBlob?.sha256, 'accepted corpus SHA-256'),
    },
    pages, instituteMetadata, videoPlaylists, targetLocations,
  };
  const ownerDecisions: SqlDemoOwnerDecisions = {
    approvedUnlinkedArticleImages: grants.map((grant) => ({ sourceFileId: grant.sourceFileId, sourceUrl: articleSourceUrlsById.get(grant.sourceFileId)!, decisionId: grant.decisionId })),
    approvedPublicRichTextImages: richTextDecisions ?? [],
    missingOriginalReplacements: replacementRows.map((row) => ({
      sourceFileId: idString(valueAt(row, 'sourceFileId', 'source_file_id'), 'replacement source Files ID'),
      replacementPath: string(valueAt(row, 'replacementPath', 'replacement_path'), 'replacement path'),
      replacementRevision: string(valueAt(row, 'replacementRevision', 'replacement_revision'), 'replacement revision'),
      replacementSha256: digest(valueAt(row, 'replacementSha256', 'replacement_sha256'), 'replacement SHA-256'),
      sourceBytesAvailable: false,
    })),
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
      approvedPublicRichTextGrants,
      approvedMissingOriginalReplacements: ownerDecisions.missingOriginalReplacements ?? [],
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
