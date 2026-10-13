import type { SqlDemoRelease } from './sql-demo-release.js';
import type { SqlDemoVerifiedAssetMapping } from './sql-demo-release.js';
import { projectSqlPublicContentForConservation, type SqlMaterializerInput, type SqlMaterializerOptions, type SqlMaterializerProjectionRecord } from './sql-public-materializer.js';

const parse5Url = new URL('../../web/node_modules/parse5/dist/index.js', import.meta.url);
const { parseFragment } = await import(parse5Url.href);

export type SqlDemoNativeCollection =
  | 'institutes'
  | 'course-groups'
  | 'teachers'
  | 'seminars'
  | 'schedule-entries'
  | 'articles'
  | 'news-items'
  | 'promotions'
  | 'video-playlists'
  | 'pages';

/** Published record returned by a populated Strapi 5 Content API GET. */
export interface SqlDemoStrapi5PublishedRecord extends Record<string, unknown> {
  id: number;
  documentId: string;
  publishedAt: string;
  legacy_id: string;
}

/** Media row from the current Strapi inventory plus its independently hashed stored bytes. */
export interface SqlDemoStrapi5MediaReadback {
  id: number;
  url: string;
  provider_metadata?: unknown;
  verifiedStoredSha256: string;
}

export interface SqlDemoStrapi5Readback {
  collections: Partial<Record<SqlDemoNativeCollection, readonly SqlDemoStrapi5PublishedRecord[]>>;
  media: readonly SqlDemoStrapi5MediaReadback[];
}

const COLLECTIONS: readonly SqlDemoNativeCollection[] = [
  'institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries', 'articles',
  'news-items', 'promotions', 'video-playlists', 'pages',
];
const SHA256 = /^[a-f\d]{64}$/i;
type Row = Record<string, unknown>;
type HtmlNode = { nodeName?: string; tagName?: string; value?: string; data?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[]; content?: HtmlNode };
type CanonicalHtmlAttribute = { kind: 'raw'; value: string } | { kind: 'verified-image'; sourceFileId: string };
type ExpectedMediaByUrl = ReadonlyMap<string, ReadonlySet<string>>;
type PhysicalMediaByUrl = ReadonlyMap<string, ReadonlySet<string>>;
const STRAPI_SYSTEM_FIELDS = new Set(['id', 'documentId', 'publishedAt', 'createdAt', 'updatedAt', 'locale']);
const RICH_HTML_FIELDS = new Set(['body', 'description', 'full_text', 'learning_plan', 'learning_mode', 'recommendations', 'additionalText', 'bio']);

function fail(identity: string, detail: string): never {
  throw new Error(`${identity}: ${detail}`);
}

function identity(plan: SqlMaterializerProjectionRecord): string {
  return plan.sourceId === undefined
    ? `${plan.sourceTable}/${plan.legacyId}`
    : `${plan.sourceTable}#${plan.sourceId}`;
}

function asRecord(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}

function sha(value: unknown, context: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(context, 'SHA-256 digest is missing or invalid');
  return value.toLowerCase();
}

function compareValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'string' && typeof actual === 'string') {
    return expected === actual;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length
      && expected.every((value, index) => compareValue(value, actual[index]));
  }
  if (expected && typeof expected === 'object') {
    const actualRecord = asRecord(actual);
    if (!actualRecord) return false;
    const expectedEntries = Object.entries(expected as Row);
    return Object.keys(actualRecord).length === expectedEntries.length && expectedEntries.every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(actualRecord, key)
      && compareValue(value, actualRecord[key]));
  }
  return Object.is(expected, actual);
}

function canonicalImageSrcPair(
  expectedUrl: string,
  actualUrl: string,
  expectedMediaByUrl: ExpectedMediaByUrl,
  physicalMediaByUrl: PhysicalMediaByUrl,
): [CanonicalHtmlAttribute, CanonicalHtmlAttribute] | null {
  const sourceFileIds = expectedMediaByUrl.get(expectedUrl);
  if (!sourceFileIds) {
    return [{ kind: 'raw', value: expectedUrl }, { kind: 'raw', value: actualUrl }];
  }
  if (sourceFileIds.size !== 1) return null;
  const [sourceFileId] = sourceFileIds;
  if (!sourceFileId || !physicalMediaByUrl.get(actualUrl)?.has(sourceFileId)) return null;
  const canonical: CanonicalHtmlAttribute = { kind: 'verified-image', sourceFileId };
  return [canonical, canonical];
}

function sameHtml(expected: string, actual: string, expectedMediaByUrl: ExpectedMediaByUrl, physicalMediaByUrl: PhysicalMediaByUrl): boolean {
  const expectedRoot = parseFragment(expected) as HtmlNode;
  const actualRoot = parseFragment(actual) as HtmlNode;
  const sameChildren = (left: readonly HtmlNode[], right: readonly HtmlNode[], inTemplate: boolean): boolean =>
    left.length === right.length && left.every((node, index) => sameNode(node, right[index]!, inTemplate));
  const sameAttributes = (
    left: readonly { name: string; value: string }[],
    right: readonly { name: string; value: string }[],
    inTemplate: boolean,
    isImage: boolean,
  ): boolean => {
    if (left.length !== right.length) return false;
    return left.every((attribute, index) => {
      const actualAttribute = right[index]!;
      if (attribute.name !== actualAttribute.name) return false;
      if (attribute.name === 'src' && !inTemplate && isImage) {
        const pair = canonicalImageSrcPair(attribute.value, actualAttribute.value, expectedMediaByUrl, physicalMediaByUrl);
        return pair !== null && JSON.stringify(pair[0]) === JSON.stringify(pair[1]);
      }
      return attribute.value === actualAttribute.value;
    });
  };
  const sameNode = (left: HtmlNode, right: HtmlNode, inTemplate: boolean): boolean => {
    if (left.tagName !== right.tagName || left.nodeName !== right.nodeName) return false;
    if (left.tagName === 'template') {
      const leftAttrs = [...(left.attrs ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      const rightAttrs = [...(right.attrs ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      if (!sameAttributes(leftAttrs, rightAttrs, true, false)) return false;
      return sameChildren(left.content?.childNodes ?? [], right.content?.childNodes ?? [], true);
    }
    if (left.tagName) {
      const leftAttrs = [...(left.attrs ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      const rightAttrs = [...(right.attrs ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      if (!sameAttributes(leftAttrs, rightAttrs, inTemplate, left.tagName === 'img')) return false;
    } else if (left.nodeName === '#text' && left.value !== right.value) return false;
    else if (left.nodeName === '#comment' && left.data !== right.data) return false;
    return sameChildren(left.childNodes ?? [], right.childNodes ?? [], inTemplate);
  };
  return sameChildren(expectedRoot.childNodes ?? [], actualRoot.childNodes ?? [], false)
    && expectedRoot.nodeName === actualRoot.nodeName;
}

function sameSeo(expected: unknown, actual: unknown): boolean {
  const expectedRecord = asRecord(expected);
  const actualRecord = asRecord(actual);
  if (!expectedRecord || !actualRecord) return false;
  const actualKeys = Object.keys(actualRecord).filter((key) => key !== 'id');
  if (actualKeys.length !== Object.keys(expectedRecord).length) return false;
  if (Object.prototype.hasOwnProperty.call(actualRecord, 'id')
    && (!Number.isSafeInteger(actualRecord.id) || (actualRecord.id as number) <= 0)) return false;
  return compareValue(expectedRecord, Object.fromEntries(actualKeys.map((key) => [key, actualRecord[key]])));
}

function sameAttribute(field: string, expected: unknown, actual: unknown, expectedMediaByUrl: ExpectedMediaByUrl, physicalMediaByUrl: PhysicalMediaByUrl): boolean {
  if (field === 'published_date' && typeof expected === 'string' && typeof actual === 'string') {
    const expectedDay = /^\d{4}-\d{2}-\d{2}$/.test(expected) ? expected : null;
    const actualMidnight = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/.exec(actual)?.[1] ?? null;
    return expected === actual || (expectedDay !== null && expectedDay === actualMidnight);
  }
  if (RICH_HTML_FIELDS.has(field) && typeof expected === 'string' && typeof actual === 'string') {
    return sameHtml(expected, actual, expectedMediaByUrl, physicalMediaByUrl);
  }
  if (field === 'seo') return sameSeo(expected, actual);
  return compareValue(expected, actual);
}

function mediaSources(value: unknown, context: string): Record<string, Row> {
  const metadata = asRecord(value);
  const importer = asRecord(metadata?.ikpk_media_import);
  const sources = asRecord(importer?.sources);
  if (!sources) return fail(context, 'provider_metadata has no ikpk_media_import.sources map');
  const result: Record<string, Row> = {};
  for (const [url, claim] of Object.entries(sources)) {
    const record = asRecord(claim);
    if (!record) return fail(context, 'provider_metadata contains a malformed source claim');
    result[url] = record;
  }
  return result;
}

interface TargetIndex {
  byLegacy: Map<SqlDemoNativeCollection, Map<string, SqlDemoStrapi5PublishedRecord>>;
  expectedMediaByUrl: Map<string, Set<string>>;
  physicalMediaByUrl: Map<string, Set<string>>;
  mediaFileIdsById: Map<number, Set<string>>;
  storedHashByFile: Map<string, string>;
}

function addAlias(aliases: Map<string, Set<string>>, url: string, fileId: string): void {
  const fileIds = aliases.get(url) ?? new Set<string>();
  fileIds.add(fileId);
  aliases.set(url, fileIds);
}

function indexMedia(
  expected: SqlDemoRelease,
  readback: SqlDemoStrapi5Readback,
  targetName: string,
): { expectedMediaByUrl: Map<string, Set<string>>; physicalMediaByUrl: Map<string, Set<string>>; mediaFileIdsById: Map<number, Set<string>>; storedHashByFile: Map<string, string> } {
  const imageMappings = expected.provenance.assetMappings.filter((asset) => asset.detectedMimeType.startsWith('image/'));
  const byFile = new Map<string, SqlDemoVerifiedAssetMapping>();
  const bySourceUrl = new Map<string, string>();
  for (const asset of imageMappings) {
    const context = `Files#${asset.sourceFileId}`;
    if (!asset.sourceFileId.trim() || !asset.sourceUrl.trim() || !asset.targetPublicUrl.trim()) fail(context, 'expected media identity is incomplete');
    sha(asset.sha256, `${context} source hash`);
    if (byFile.has(asset.sourceFileId)) fail(context, 'expected source media identity is duplicated');
    if (bySourceUrl.has(asset.sourceUrl)) fail(context, 'expected source URL maps to multiple files');
    byFile.set(asset.sourceFileId, asset);
    bySourceUrl.set(asset.sourceUrl, asset.sourceFileId);
  }

  const idSeen = new Set<number>();
  const urlSeen = new Set<string>();
  const actualByFile = new Map<string, SqlDemoStrapi5MediaReadback>();
  const fileIdsByMediaId = new Map<number, Set<string>>();
  const storedHashByFile = new Map<string, string>();
  const expectedMediaByUrl = new Map<string, Set<string>>();
  const physicalMediaByUrl = new Map<string, Set<string>>();
  for (const asset of imageMappings) {
    addAlias(expectedMediaByUrl, asset.sourceUrl, asset.sourceFileId);
    addAlias(expectedMediaByUrl, asset.targetPublicUrl, asset.sourceFileId);
  }

  for (const media of readback.media) {
    if (!Number.isSafeInteger(media.id) || media.id <= 0) fail(`${targetName} media`, 'contains an invalid media id');
    if (idSeen.has(media.id)) fail(`${targetName} media#${media.id}`, 'duplicate media row');
    idSeen.add(media.id);
    if (typeof media.url !== 'string' || !media.url.trim()) fail(`${targetName} media#${media.id}`, 'URL is missing');
    if (urlSeen.has(media.url)) fail(`${targetName} media#${media.id}`, 'duplicate media URL');
    urlSeen.add(media.url);
    const storedSha = sha(media.verifiedStoredSha256, `${targetName} media#${media.id} independently verified stored hash`);
    const sourceClaims = mediaSources(media.provider_metadata, `${targetName} media#${media.id}`);
    const claimsForMedia: string[] = [];
    for (const [sourceUrl, claim] of Object.entries(sourceClaims)) {
      const fileId = bySourceUrl.get(sourceUrl);
      if (fileId) {
        const asset = byFile.get(fileId)!;
        if (sha(claim.sha256, `${targetName} Files#${fileId} source claim`) !== asset.sha256.toLowerCase()) {
          fail(`${targetName} Files#${fileId}`, 'source SHA-256 claim differs from the composed release');
        }
        const claimedStoredSha = sha(claim.storedSha256, `${targetName} Files#${fileId} stored hash claim`);
        if (claimedStoredSha !== storedSha) fail(`${targetName} Files#${fileId}`, 'provider metadata stored hash differs from the independent stored-byte witness');
        claimsForMedia.push(fileId);
      }
    }
    if (!claimsForMedia.length) fail(`${targetName} media#${media.id}`, 'extra media row has no expected SQL source-file identity');
    for (const fileId of new Set(claimsForMedia)) {
      if (actualByFile.has(fileId)) fail(`${targetName} Files#${fileId}`, 'source media appears in multiple target media rows');
      actualByFile.set(fileId, media);
      const fileIds = fileIdsByMediaId.get(media.id) ?? new Set<string>();
      fileIds.add(fileId);
      fileIdsByMediaId.set(media.id, fileIds);
      storedHashByFile.set(fileId, storedSha);
      addAlias(physicalMediaByUrl, media.url, fileId);
    }
  }

  for (const asset of imageMappings) {
    if (!actualByFile.has(asset.sourceFileId)) fail(`${targetName} Files#${asset.sourceFileId}`, 'expected source media is missing');
  }
  return { expectedMediaByUrl, physicalMediaByUrl, mediaFileIdsById: fileIdsByMediaId, storedHashByFile };
}

function relationRows(value: unknown): Row[] | null {
  const normalized = asRecord(value)?.data ?? value;
  if (Array.isArray(normalized)) {
    const records = normalized.map((item) => asRecord(item));
    return records.some((item) => item === null) ? null : records as Row[];
  }
  const record = asRecord(normalized);
  return record ? [record] : null;
}

function compareRelations(
  plan: SqlMaterializerProjectionRecord,
  actual: Row,
  index: TargetIndex,
): void {
  const context = identity(plan);
  for (const relation of plan.relations) {
    const raw = actual[relation.field];
    if (relation.cardinality === 'single' && raw == null && relation.optional && relation.legacyIds.length === 0) continue;
    const references = relationRows(raw);
    if (!references) fail(context, `${relation.field} relation is missing or malformed`);
    const actualLegacyIds: string[] = [];
    for (const reference of references) {
      if (typeof reference.legacy_id !== 'string' || typeof reference.documentId !== 'string' || !Number.isSafeInteger(reference.id)) {
        fail(context, `${relation.field} relation has inconsistent target identity fields`);
      }
      const target = index.byLegacy.get(relation.collection)?.get(reference.legacy_id);
      if (!target || target.documentId !== reference.documentId || target.id !== reference.id) {
        fail(context, `${relation.field} relation target has inconsistent IDs`);
      }
      actualLegacyIds.push(reference.legacy_id);
    }
    const expectedIds = [...relation.legacyIds];
    if (relation.cardinality === 'many') {
      if (new Set(expectedIds).size !== expectedIds.length || new Set(actualLegacyIds).size !== actualLegacyIds.length) {
        fail(context, `${relation.field} relation contains duplicate targets`);
      }
      expectedIds.sort();
      actualLegacyIds.sort();
    }
    if (expectedIds.length !== actualLegacyIds.length || expectedIds.some((id, position) => id !== actualLegacyIds[position])) {
      fail(context, `${relation.field} relation does not match the composed release`);
    }
  }
}

function isMultipleMediaField(plan: SqlMaterializerProjectionRecord): boolean {
  return (plan.collection === 'institutes' && plan.image?.field === 'image')
    || (plan.collection === 'course-groups' && plan.image?.field === 'image')
    || (plan.collection === 'teachers' && plan.image?.field === 'photo');
}

function compareImage(
  plan: SqlMaterializerProjectionRecord,
  row: Row,
  index: TargetIndex,
  readback: SqlDemoStrapi5Readback,
): void {
  if (!plan.image) return;
  const context = identity(plan);
  const field = plan.image.field;
  if (!Object.prototype.hasOwnProperty.call(row, field)) fail(context, `${field} readback is missing`);
  const raw = row[field];
  const multiple = isMultipleMediaField(plan);
  const expectedFileId = plan.image.sourceId;
  if (expectedFileId === null) {
    if (multiple) {
      if (!Array.isArray(raw) || raw.length !== 0) fail(context, `${field} must be an empty media array`);
    } else if (raw != null) fail(context, `${field} should be null`);
    return;
  }

  const references = multiple ? (Array.isArray(raw) ? raw : null) : (Array.isArray(raw) ? null : [raw]);
  if (!references || references.length !== 1) fail(context, `${field} must contain exactly one media reference`);
  const image = asRecord(asRecord(references[0])?.data ?? references[0]);
  if (!image || !Number.isSafeInteger(image.id)) fail(context, `${field} media reference is missing or malformed`);
  const actualFileIds = index.mediaFileIdsById.get(image.id as number);
  if (!actualFileIds?.has(expectedFileId)) fail(context, `${field} does not resolve to Files#${expectedFileId}`);
  const targetMedia = readback.media.find((item) => item.id === image.id);
  if (!targetMedia || image.url !== targetMedia.url) fail(context, `${field} URL and media id are inconsistent`);
}

function compareTarget(
  plans: readonly SqlMaterializerProjectionRecord[],
  expected: SqlDemoRelease,
  readback: SqlDemoStrapi5Readback,
  targetName: string,
): TargetIndex {
  const media = indexMedia(expected, readback, targetName);
  const byLegacy = new Map<SqlDemoNativeCollection, Map<string, SqlDemoStrapi5PublishedRecord>>();
  const expectedByCollection = new Map<SqlDemoNativeCollection, SqlMaterializerProjectionRecord[]>();
  for (const plan of plans) {
    const collection = plan.collection as SqlDemoNativeCollection;
    const rows = expectedByCollection.get(collection) ?? [];
    rows.push(plan);
    expectedByCollection.set(collection, rows);
  }

  for (const collection of COLLECTIONS) {
    const rows = readback.collections[collection] ?? [];
    const expectedRows = expectedByCollection.get(collection) ?? [];
    const index = new Map<string, SqlDemoStrapi5PublishedRecord>();
    const seenIds = new Set<number>();
    const seenDocumentIds = new Set<string>();
    byLegacy.set(collection, index);
    for (const row of rows) {
      const matchingPlan = expectedRows.find((plan) => plan.legacyId === row?.legacy_id);
      const context = matchingPlan ? identity(matchingPlan) : `${targetName} ${collection}`;
      if (!row || !Number.isSafeInteger(row.id) || row.id <= 0) fail(context, 'published row has an invalid numeric id');
      if (typeof row.documentId !== 'string' || !row.documentId.trim()) fail(context, 'published row is missing documentId');
      if (typeof row.legacy_id !== 'string' || !row.legacy_id.trim()) fail(context, 'published row is missing legacy_id');
      if (typeof row.publishedAt !== 'string' || !row.publishedAt.trim()) fail(context, 'row is not published');
      if (seenIds.has(row.id)) fail(context, 'duplicate numeric Strapi id in collection');
      if (seenDocumentIds.has(row.documentId)) fail(context, 'duplicate documentId in collection');
      seenIds.add(row.id);
      seenDocumentIds.add(row.documentId);
      if (index.has(row.legacy_id)) fail(context, 'duplicate logical source row');
      index.set(row.legacy_id, row);
    }
    if (rows.length !== expectedRows.length) {
      const expectedIds = new Set(expectedRows.map((plan) => plan.legacyId));
      const actualIds = new Set(rows.map((row) => row.legacy_id));
      const missing = expectedRows.find((plan) => !actualIds.has(plan.legacyId));
      const extra = rows.find((row) => !expectedIds.has(row.legacy_id));
      if (missing) fail(identity(missing), `${targetName} ${collection} row is missing`);
      if (extra) fail(`${targetName} ${collection}`, 'extra logical source row');
      fail(`${targetName} ${collection}`, 'row count differs from the composed release');
    }
  }

  const targetIndex: TargetIndex = {
    byLegacy,
    expectedMediaByUrl: media.expectedMediaByUrl,
    physicalMediaByUrl: media.physicalMediaByUrl,
    mediaFileIdsById: media.mediaFileIdsById,
    storedHashByFile: media.storedHashByFile,
  };
  for (const plan of plans) {
    const row = byLegacy.get(plan.collection as SqlDemoNativeCollection)?.get(plan.legacyId);
    if (!row) fail(identity(plan), `${targetName} ${plan.collection} row is missing`);
    const context = identity(plan);
    const unexpectedFields = Object.keys(row).filter((field) =>
      !Object.prototype.hasOwnProperty.call(plan.attributes, field)
      && !STRAPI_SYSTEM_FIELDS.has(field)
      && field !== 'legacy_id'
      && field !== plan.image?.field
      && !(plan.collection === 'schedule-entries' && field === 'admin_label')
      && !plan.relations.some((relation) => relation.field === field));
    if (unexpectedFields.length) fail(context, `published row contains unexpected ${plan.collection} field`);
    if (plan.collection === 'schedule-entries' && Object.prototype.hasOwnProperty.call(row, 'admin_label')
      && typeof row.admin_label !== 'string') fail(context, 'schedule-entries admin_label must be a string');
    for (const [field, value] of Object.entries(plan.attributes)) {
      if (field === 'image' || field === 'photo') continue;
      if (!Object.prototype.hasOwnProperty.call(row, field)) fail(context, `${targetName} readback omitted ${field}`);
      if (!sameAttribute(field, value, row[field], targetIndex.expectedMediaByUrl, targetIndex.physicalMediaByUrl)) {
        fail(context, `${field} differs from the composed release`);
      }
    }
    compareImage(plan, row, targetIndex, readback);
    compareRelations(plan, row, targetIndex);
  }
  return targetIndex;
}

/** Validate each freshly read Strapi target against the composed SQL release. */
export function assertSqlDemoNativeConservation(
  expected: SqlDemoRelease,
  classification: SqlMaterializerOptions['classification'],
  targetA: SqlDemoStrapi5Readback,
  targetB: SqlDemoStrapi5Readback,
): void {
  if (classification.status !== 'pending-confirmation') fail('classification', 'status must remain pending-confirmation');
  const programBySourceId = new Map(expected.entities.programs.map((program) => [program.sourceId, program]));
  for (const article of classification.articles) {
    if (new Set(article.sourceProgramIds).size !== article.sourceProgramIds.length) {
      fail(`Articles#${article.sourceId}`, 'approved categories contain duplicate source IDs');
    }
    for (const sourceProgramId of article.sourceProgramIds) {
      const program = programBySourceId.get(sourceProgramId);
      if (!program || program.is_article_category !== true) {
        fail(`Articles#${article.sourceId}`, `approved category Programs#${sourceProgramId} is missing or not an article category`);
      }
    }
  }
  // composeSqlDemoRelease validates and returns the same public DTO shape; its convenience
  // supplements type permits optional SEO fields even though composition fills them in.
  const plans = projectSqlPublicContentForConservation(expected as unknown as SqlMaterializerInput, classification);
  const indexA = compareTarget(plans, expected, targetA, 'target A');
  const indexB = compareTarget(plans, expected, targetB, 'target B');

  for (const [fileId, storedHashA] of indexA.storedHashByFile) {
    if (indexB.storedHashByFile.get(fileId) !== storedHashA) {
      fail(`Files#${fileId}`, 'independently verified stored-byte hash differs between targets');
    }
  }
}
