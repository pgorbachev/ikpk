import type { SqlPublicContentResult, SqlPublicEntity } from './sql-public-content.js';

export interface SqlStrapiRestClient {
  request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown>;
}

export interface SqlResolvedMedia {
  id: number;
  sourceHash: string;
  storedHash: string;
  sourceIdentity: string;
}

export interface SqlMaterializerOptions {
  target: SqlStrapiRestClient;
  media: {
    /** Resolves only after the media boundary has independently verified source and stored bytes. */
    resolve(sourceImageId: string, target: SqlStrapiRestClient): Promise<SqlResolvedMedia>;
  };
  classification: {
    status: 'pending-confirmation';
    teachers: readonly { sourceId: number; trait: 'teacher' | 'method-author' }[];
    articles: readonly { sourceId: number; sourceProgramIds: readonly number[] }[];
  };
}

type Collection = 'institutes' | 'course-groups' | 'teachers' | 'seminars' | 'schedule-entries' | 'articles';
type SourceTable = 'Institutes' | 'Programs' | 'Teachers' | 'Seminars' | 'Events' | 'Articles';
type RecordValue = Record<string, unknown>;

interface RelationPlan {
  field: string;
  cardinality: 'single' | 'many';
  optional?: boolean;
  targets: { collection: Collection; legacyId: string }[];
}

interface EntityPlan {
  collection: Collection;
  sourceTable: SourceTable;
  entity: SqlPublicEntity;
  legacyId: string;
  data: RecordValue;
  imageField?: 'image' | 'photo';
  imageSourceId?: string | null;
  imageRequired?: boolean;
  relations: RelationPlan[];
}

interface StoredRef {
  documentId: string;
}

const API_COLLECTIONS: readonly Collection[] = [
  'institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries', 'articles',
];

function recordContext(table: SourceTable, entity: SqlPublicEntity): string {
  return `${table}#${String(entity.sourceId)}`;
}

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function requiredString(entity: SqlPublicEntity, table: SourceTable, field: string, allowEmpty = false): string {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    return fail(context, `${field} is required and must be a${allowEmpty ? ' string' : ' non-empty string'}`);
  }
  return value;
}

function nullableString(entity: SqlPublicEntity, table: SourceTable, field: string): string | null {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return fail(context, `${field} must be a string or null`);
  return value;
}

function requiredNumber(entity: SqlPublicEntity, table: SourceTable, field: string): number {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(context, `${field} must be numeric`);
  return value;
}

function requiredInteger(entity: SqlPublicEntity, table: SourceTable, field: string): number {
  const value = requiredNumber(entity, table, field);
  if (!Number.isSafeInteger(value)) return fail(recordContext(table, entity), `${field} must be an integer`);
  return value;
}

function nullableNumber(entity: SqlPublicEntity, table: SourceTable, field: string): number | null {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(context, `${field} must be numeric or null`);
  return value;
}

function requiredBoolean(entity: SqlPublicEntity, table: SourceTable, field: string): boolean {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (typeof value !== 'boolean') return fail(context, `${field} must be boolean`);
  return value;
}

function stringList(entity: SqlPublicEntity, table: SourceTable, field: string): string[] {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    return fail(context, `${field} must be an array of non-empty strings`);
  }
  return [...new Set(value as string[])];
}

function requiredSourceId(entity: SqlPublicEntity, table: SourceTable): number {
  const context = recordContext(table, entity);
  if (!Number.isSafeInteger(entity.sourceId) || entity.sourceId <= 0) return fail(context, 'sourceId must be a positive integer');
  return entity.sourceId;
}

function requiredLegacyId(entity: SqlPublicEntity, table: SourceTable): string {
  return requiredString(entity, table, 'legacy_id');
}

function seoComponent(entity: SqlPublicEntity, table: SourceTable): RecordValue {
  const context = recordContext(table, entity);
  const value = entity.seo;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(context, 'seo must contain seo_title and seo_description');
  const seo = value as RecordValue;
  if (typeof seo.seo_title !== 'string' || !seo.seo_title.trim()) return fail(context, 'seo.seo_title is required');
  if (typeof seo.seo_description !== 'string' || !seo.seo_description.trim()) return fail(context, 'seo.seo_description is required');
  return { seo_title: seo.seo_title, seo_description: seo.seo_description };
}

function entityPlans(mapped: SqlPublicContentResult, options: SqlMaterializerOptions): EntityPlan[] {
  const teacherClassification = new Map<number, 'teacher' | 'method-author'>();
  for (const candidate of options.classification.teachers) {
    if (!['teacher', 'method-author'].includes(candidate.trait)) throw new Error(`Teachers#${candidate.sourceId}: classification trait is unsupported`);
    if (teacherClassification.has(candidate.sourceId)) throw new Error(`Teachers#${candidate.sourceId}: classification is duplicated`);
    teacherClassification.set(candidate.sourceId, candidate.trait);
  }
  const activeTeacherIds = new Set(mapped.entities.teachers.map((entity) => entity.sourceId));
  for (const entity of mapped.entities.teachers) {
    if (!teacherClassification.has(entity.sourceId)) fail(recordContext('Teachers', entity), 'classification is missing');
  }
  for (const sourceId of teacherClassification.keys()) {
    if (!activeTeacherIds.has(sourceId)) throw new Error(`Teachers#${sourceId}: classification does not match an active source record`);
  }

  const articleClassification = new Map<number, readonly number[]>();
  for (const candidate of options.classification.articles) {
    if (articleClassification.has(candidate.sourceId)) throw new Error(`Articles#${candidate.sourceId}: classification is duplicated`);
    if (!candidate.sourceProgramIds.length) throw new Error(`Articles#${candidate.sourceId}: classification categories are missing`);
    articleClassification.set(candidate.sourceId, candidate.sourceProgramIds);
  }
  const activeArticleIds = new Set(mapped.entities.articles.map((entity) => entity.sourceId));
  for (const entity of mapped.entities.articles) {
    if (!articleClassification.has(entity.sourceId)) fail(recordContext('Articles', entity), 'classification categories are missing');
  }
  for (const sourceId of articleClassification.keys()) {
    if (!activeArticleIds.has(sourceId)) throw new Error(`Articles#${sourceId}: classification does not match an active source record`);
  }

  const plans: EntityPlan[] = [];
  for (const entity of mapped.entities.institutes) {
    const table: SourceTable = 'Institutes';
    const legacyId = requiredLegacyId(entity, table);
    plans.push({
      collection: 'institutes', sourceTable: table, entity, legacyId,
      data: {
        name: requiredString(entity, table, 'name'),
        slug: requiredString(entity, table, 'slug'),
        shortName: nullableString(entity, table, 'shortName'),
        description: requiredString(entity, table, 'description'),
        order: requiredInteger(entity, table, 'order'),
        legacy_id: legacyId,
        seo: seoComponent(entity, table),
      },
      imageField: 'image', imageSourceId: nullableString(entity, table, 'imageId'), relations: [],
    });
  }
  for (const entity of mapped.entities.programs) {
    const table: SourceTable = 'Programs';
    const legacyId = requiredLegacyId(entity, table);
    plans.push({
      collection: 'course-groups', sourceTable: table, entity, legacyId,
      data: {
        name: requiredString(entity, table, 'name'),
        slug: requiredString(entity, table, 'slug'),
        description: requiredString(entity, table, 'description'),
        order: requiredInteger(entity, table, 'order'),
        legacy_id: legacyId,
        is_article_category: requiredBoolean(entity, table, 'is_article_category'),
        seo: seoComponent(entity, table),
      },
      imageField: 'image', imageSourceId: nullableString(entity, table, 'imageId'),
      relations: [{ field: 'institute', cardinality: 'single', targets: [{ collection: 'institutes', legacyId: requiredString(entity, table, 'institute_legacy_id') }] }],
    });
  }
  for (const entity of mapped.entities.teachers) {
    const table: SourceTable = 'Teachers';
    const legacyId = requiredLegacyId(entity, table);
    plans.push({
      collection: 'teachers', sourceTable: table, entity, legacyId,
      data: {
        name: requiredString(entity, table, 'name'),
        slug: requiredString(entity, table, 'slug'),
        trait: teacherClassification.get(requiredSourceId(entity, table))!,
        order: requiredInteger(entity, table, 'order'),
        bio: requiredString(entity, table, 'bio', true),
        legacy_id: legacyId,
      },
      imageField: 'photo', imageSourceId: nullableString(entity, table, 'imageId'),
      relations: [{
        field: 'institute', cardinality: 'single', optional: true,
        targets: entity.institute_legacy_id == null ? [] : [{
          collection: 'institutes', legacyId: requiredString(entity, table, 'institute_legacy_id'),
        }],
      }],
    });
  }
  for (const entity of mapped.entities.seminars) {
    const table: SourceTable = 'Seminars';
    const legacyId = requiredLegacyId(entity, table);
    const documentsState = requiredString(entity, table, 'documents_state');
    if (!['issued', 'not-issued', 'unconfirmed'].includes(documentsState)) {
      fail(recordContext(table, entity), `documents_state has unsupported value ${documentsState}`);
    }
    const data: RecordValue = {
      name: requiredString(entity, table, 'name'),
      slug: requiredString(entity, table, 'slug'),
      description: requiredString(entity, table, 'description'),
      documents_state: documentsState,
      order: requiredInteger(entity, table, 'order'),
      legacy_id: legacyId,
      seo: seoComponent(entity, table),
    };
    for (const field of ['full_text', 'learning_plan', 'learning_mode', 'recommendations'] as const) {
      const value = nullableString(entity, table, field);
      if (value !== null) data[field] = value;
    }
    plans.push({
      collection: 'seminars', sourceTable: table, entity, legacyId, data,
      relations: [
        { field: 'course_group', cardinality: 'single', targets: [{ collection: 'course-groups', legacyId: requiredString(entity, table, 'course_group_legacy_id') }] },
        { field: 'teachers', cardinality: 'many', targets: stringList(entity, table, 'directTeachers').map((teacherId) => ({ collection: 'teachers', legacyId: teacherId })) },
      ],
    });
  }
  for (const entity of mapped.entities.events) {
    const table: SourceTable = 'Events';
    const legacyId = requiredLegacyId(entity, table);
    const entryStatus = requiredString(entity, table, 'entry_status');
    if (!['active', 'cancelled', 'completed'].includes(entryStatus)) fail(recordContext(table, entity), `entry_status has unsupported value ${entryStatus}`);
    plans.push({
      collection: 'schedule-entries', sourceTable: table, entity, legacyId,
      data: {
        name: requiredString(entity, table, 'name'),
        startAt: requiredString(entity, table, 'startAt'),
        endAt: requiredString(entity, table, 'endAt'),
        city: requiredString(entity, table, 'city'),
        price: requiredNumber(entity, table, 'newPrice'),
        oldPrice: nullableNumber(entity, table, 'oldPrice'),
        isFree: requiredBoolean(entity, table, 'isFree'),
        isEventCollection: requiredBoolean(entity, table, 'isEventCollection'),
        entry_status: entryStatus,
        registrationFormLink: nullableString(entity, table, 'registrationFormLink'),
        description: nullableString(entity, table, 'description'),
        additionalText: nullableString(entity, table, 'additionalText'),
        duration: nullableString(entity, table, 'duration'),
        legacy_id: legacyId,
      },
      imageField: 'image', imageSourceId: nullableString(entity, table, 'imageId'),
      relations: [
        { field: 'seminar', cardinality: 'single', targets: [{ collection: 'seminars', legacyId: requiredString(entity, table, 'seminar_legacy_id') }] },
        { field: 'teachers', cardinality: 'many', targets: stringList(entity, table, 'primaryTeachers').map((teacherId) => ({ collection: 'teachers', legacyId: teacherId })) },
      ],
    });
  }
  for (const entity of mapped.entities.articles) {
    const table: SourceTable = 'Articles';
    const legacyId = requiredLegacyId(entity, table);
    const imageSourceId = nullableString(entity, table, 'imageId');
    if (!imageSourceId) fail(recordContext(table, entity), 'image is required');
    const categories = articleClassification.get(requiredSourceId(entity, table))!;
    plans.push({
      collection: 'articles', sourceTable: table, entity, legacyId,
      data: {
        title: requiredString(entity, table, 'title'),
        slug: requiredString(entity, table, 'slug'),
        body: requiredString(entity, table, 'body'),
        published_date: requiredString(entity, table, 'published_date'),
        legacy_id: legacyId,
        seo: seoComponent(entity, table),
      },
      imageField: 'image', imageSourceId, imageRequired: true,
      relations: [{ field: 'categories', cardinality: 'many', targets: categories.map((sourceProgramId) => {
        const program = mapped.entities.programs.find((candidate) => candidate.sourceId === sourceProgramId);
        if (!program) fail(recordContext(table, entity), `categories target Programs#${sourceProgramId} is missing or inactive`);
        return { collection: 'course-groups', legacyId: requiredLegacyId(program, 'Programs') };
      }) }],
    });
  }
  return plans;
}

function requestData(response: unknown, context: string): unknown {
  if (!response || typeof response !== 'object' || !('data' in response)) return fail(context, 'Content API response has no data field');
  return (response as { data: unknown }).data;
}

function responseRecord(response: unknown, context: string): RecordValue {
  const data = requestData(response, context);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(context, 'Content API response is not a document');
  return data as RecordValue;
}

function documentId(record: RecordValue, context: string): string {
  if (typeof record.documentId !== 'string' || !record.documentId.trim()) return fail(context, 'Content API documentId is missing');
  return record.documentId;
}

function responseList(response: unknown, context: string): RecordValue[] {
  const data = requestData(response, context);
  if (!Array.isArray(data)) return fail(context, 'Content API collection response is not a list');
  if (data.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
    return fail(context, 'Content API collection contains a malformed document');
  }
  return data as RecordValue[];
}

async function findExisting(plan: EntityPlan, target: SqlStrapiRestClient): Promise<RecordValue | null> {
  const context = recordContext(plan.sourceTable, plan.entity);
  const filter = `filters[legacy_id][$eq]=${encodeURIComponent(plan.legacyId)}&pagination[pageSize]=2`;
  const byStatus = new Map<'published' | 'draft', RecordValue>();
  for (const status of ['published', 'draft'] as const) {
    let results: RecordValue[];
    try {
      results = responseList(
        await target.request('GET', `/api/${plan.collection}?${filter}&status=${status}`),
        `${context} lookup`,
      );
    } catch {
      return fail(context, 'legacy_id lookup request failed');
    }
    if (results.length > 1) return fail(context, `legacy_id ${plan.legacyId} matches multiple ${status} documents`);
    if (results.length === 1) {
      const result = results[0]!;
      if (result.legacy_id !== plan.legacyId) return fail(context, `${status} lookup returned a different legacy_id`);
      byStatus.set(status, result);
    }
  }
  const published = byStatus.get('published');
  const draft = byStatus.get('draft');
  if (published && draft && documentId(published, context) !== documentId(draft, context)) {
    return fail(context, `legacy_id ${plan.legacyId} points to different published and draft documents`);
  }
  return published ?? draft ?? null;
}

function validateMedia(media: SqlResolvedMedia, context: string): void {
  if (!Number.isSafeInteger(media.id) || media.id <= 0) fail(context, 'media resolver returned an invalid target ID');
  if (!/^[a-f\d]{64}$/i.test(media.sourceHash) || !/^[a-f\d]{64}$/i.test(media.storedHash)) {
    fail(context, 'media source or stored hash is invalid');
  }
  if (typeof media.sourceIdentity !== 'string' || !media.sourceIdentity.trim()) fail(context, 'media source identity is missing');
}

async function payloadFor(plan: EntityPlan, options: SqlMaterializerOptions): Promise<RecordValue> {
  const data = { ...plan.data };
  if (plan.imageField) {
    if (!plan.imageSourceId) {
      if (plan.imageRequired) fail(recordContext(plan.sourceTable, plan.entity), `${plan.imageField} is required`);
      data[plan.imageField] = null;
    } else {
      const context = recordContext(plan.sourceTable, plan.entity);
      let media: SqlResolvedMedia;
      try {
        media = await options.media.resolve(plan.imageSourceId, options.target);
      } catch (error) {
        // Classify a verifier failure without copying its potentially private message.
        const reason = error instanceof Error && /hash|digest|checksum|byte/i.test(error.message)
          ? 'byte hash verification failed'
          : 'resolution failed';
        return fail(context, `${plan.imageField} ${reason}`);
      }
      validateMedia(media, context);
      // sourceIdentity and byte hashes stay in the private resolver boundary. Only Strapi's
      // numeric media ID is part of the public Content API payload.
      data[plan.imageField] = { connect: [media.id] };
    }
  }
  return data;
}

async function writeDraft(plan: EntityPlan, data: RecordValue, target: SqlStrapiRestClient): Promise<StoredRef> {
  const context = recordContext(plan.sourceTable, plan.entity);
  const existing = await findExisting(plan, target);
  try {
    if (existing) {
      const id = documentId(existing, context);
      const response = await target.request('PUT', `/api/${plan.collection}/${encodeURIComponent(id)}?status=draft`, { data });
      const updatedId = documentId(responseRecord(response, context), context);
      if (updatedId !== id) return fail(context, 'draft update changed the existing documentId');
      return { documentId: updatedId };
    }
    const response = await target.request('POST', `/api/${plan.collection}?status=draft`, { data });
    return { documentId: documentId(responseRecord(response, context), context) };
  } catch {
    return fail(context, 'draft write failed');
  }
}

function resolveRelations(plan: EntityPlan, refs: Map<Collection, Map<string, StoredRef>>): RecordValue {
  const context = recordContext(plan.sourceTable, plan.entity);
  const data: RecordValue = {};
  for (const relation of plan.relations) {
    if (relation.optional && relation.targets.length === 0) {
      data[relation.field] = null;
      continue;
    }
    const resolvedTargets = relation.targets.map((target) => {
      const resolved = refs.get(target.collection)?.get(target.legacyId);
      if (!resolved) fail(context, `${relation.field} relation target ${target.collection}/${target.legacyId} is missing`);
      return { documentId: resolved.documentId };
    });
    if (relation.cardinality === 'many') {
      data[relation.field] = { set: resolvedTargets };
    } else {
      if (resolvedTargets.length !== 1) fail(context, `${relation.field} relation requires exactly one target`);
      data[relation.field] = { connect: resolvedTargets };
    }
  }
  return data;
}

async function writeRelations(plan: EntityPlan, document: StoredRef, data: RecordValue, target: SqlStrapiRestClient): Promise<void> {
  if (!Object.keys(data).length) return;
  const context = recordContext(plan.sourceTable, plan.entity);
  try {
    await target.request('PUT', `/api/${plan.collection}/${encodeURIComponent(document.documentId)}?status=draft`, { data });
  } catch {
    fail(context, 'relation write failed');
  }
}

async function publishAndVerify(plan: EntityPlan, document: StoredRef, target: SqlStrapiRestClient): Promise<void> {
  const context = recordContext(plan.sourceTable, plan.entity);
  try {
    await target.request('PUT', `/api/${plan.collection}/${encodeURIComponent(document.documentId)}?status=published`, { data: {} });
    const response = await target.request('GET', `/api/${plan.collection}/${encodeURIComponent(document.documentId)}?status=published`);
    const published = responseRecord(response, context);
    if (documentId(published, context) !== document.documentId || typeof published.publishedAt !== 'string' || !published.publishedAt) {
      fail(context, 'published Content API verification failed');
    }
  } catch {
    fail(context, 'publish or verification failed');
  }
}

/**
 * Materializes a mapped synthetic or private SQL DTO through Strapi's public Content API.
 * Provenance and source media identities remain private to the caller/resolver boundary.
 */
export async function materializeSqlPublicContent(
  mapped: SqlPublicContentResult,
  options: SqlMaterializerOptions,
): Promise<void> {
  if (options.classification.status !== 'pending-confirmation') throw new Error('SQL classification must remain pending-confirmation');

  // Validate source-ID coverage and every required public projection before the first target write.
  const plans = entityPlans(mapped, options);
  const refs = new Map<Collection, Map<string, StoredRef>>(API_COLLECTIONS.map((collection) => [collection, new Map()]));

  for (const plan of plans) {
    const data = await payloadFor(plan, options);
    const ref = await writeDraft(plan, data, options.target);
    refs.get(plan.collection)!.set(plan.legacyId, ref);
  }

  for (const plan of plans) {
    const ref = refs.get(plan.collection)!.get(plan.legacyId)!;
    const relations = resolveRelations(plan, refs);
    await writeRelations(plan, ref, relations, options.target);
  }

  for (const plan of plans) {
    const ref = refs.get(plan.collection)!.get(plan.legacyId)!;
    await publishAndVerify(plan, ref, options.target);
  }
}
