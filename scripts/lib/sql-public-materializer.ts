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

export interface SqlMaterializerPage extends Record<string, unknown> {
  title: string;
  slug: string;
  body: string;
  legacy_id: string;
  seo: { seo_title: string; seo_description: string };
}

export interface SqlMaterializerVideoPlaylist extends Record<string, unknown> {
  name: string;
  slug: string;
  legacy_id: string;
  videos: unknown[] | null;
  seo: { seo_title: string; seo_description: string };
}

/** SQL content after public composition; playlist and page DTOs intentionally have no SQL sourceId. */
export type SqlMaterializerInput = Omit<SqlPublicContentResult, 'entities'> & {
  entities: Omit<SqlPublicContentResult['entities'], 'videos'> & {
    videos?: readonly SqlMaterializerVideoPlaylist[];
    pages?: readonly SqlMaterializerPage[];
  };
};

type Collection = 'institutes' | 'course-groups' | 'teachers' | 'seminars' | 'schedule-entries' | 'articles'
  | 'news-items' | 'promotions' | 'video-playlists' | 'pages';
type SourceTable = 'Institutes' | 'Programs' | 'Teachers' | 'Seminars' | 'Events' | 'Articles'
  | 'News' | 'Promotions' | 'Videos' | 'Pages';
type RecordValue = Record<string, unknown>;

class SafeMaterializerError extends Error {}

interface RelationPlan {
  field: string;
  cardinality: 'single' | 'many';
  optional?: boolean;
  targets: { collection: Collection; legacyId: string }[];
}

interface EntityPlan {
  collection: Collection;
  sourceTable: SourceTable;
  entity: RecordValue;
  legacyId: string;
  data: RecordValue;
  imageField?: 'image' | 'photo';
  imageSourceId?: string | null;
  imageRequired?: boolean;
  imageFormat?: 'connect' | 'numeric';
  relations: RelationPlan[];
  verifyAttributes?: boolean;
  populate?: readonly string[];
}

interface StoredRef {
  documentId: string;
}

const API_COLLECTIONS: readonly Collection[] = [
  'institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries', 'articles',
  'news-items', 'promotions', 'video-playlists', 'pages',
];

function recordContext(table: SourceTable, entity: RecordValue): string {
  return Number.isSafeInteger(entity.sourceId)
    ? `${table}#${String(entity.sourceId)}`
    : `${table}/${String(entity.legacy_id ?? 'unknown')}`;
}

function fail(context: string, message: string): never {
  throw new SafeMaterializerError(`${context}: ${message}`);
}

function requiredString(entity: RecordValue, table: SourceTable, field: string, allowEmpty = false): string {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    return fail(context, `${field} is required and must be a${allowEmpty ? ' string' : ' non-empty string'}`);
  }
  return value;
}

function nullableString(entity: RecordValue, table: SourceTable, field: string): string | null {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return fail(context, `${field} must be a string or null`);
  return value;
}

function requiredNumber(entity: RecordValue, table: SourceTable, field: string): number {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(context, `${field} must be numeric`);
  return value;
}

function requiredInteger(entity: RecordValue, table: SourceTable, field: string): number {
  const value = requiredNumber(entity, table, field);
  if (!Number.isSafeInteger(value)) return fail(recordContext(table, entity), `${field} must be an integer`);
  return value;
}

function nullableNumber(entity: RecordValue, table: SourceTable, field: string): number | null {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(context, `${field} must be numeric or null`);
  return value;
}

function requiredBoolean(entity: RecordValue, table: SourceTable, field: string): boolean {
  const context = recordContext(table, entity);
  const value = entity[field];
  if (typeof value !== 'boolean') return fail(context, `${field} must be boolean`);
  return value;
}

function stringList(entity: RecordValue, table: SourceTable, field: string): string[] {
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

function requiredLegacyId(entity: RecordValue, table: SourceTable): string {
  return requiredString(entity, table, 'legacy_id');
}

function seoComponent(entity: RecordValue, table: SourceTable): RecordValue {
  const context = recordContext(table, entity);
  const value = entity.seo;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(context, 'seo must contain seo_title and seo_description');
  const seo = value as RecordValue;
  if (typeof seo.seo_title !== 'string' || !seo.seo_title.trim()) return fail(context, 'seo.seo_title is required');
  if (typeof seo.seo_description !== 'string' || !seo.seo_description.trim()) return fail(context, 'seo.seo_description is required');
  return { seo_title: seo.seo_title, seo_description: seo.seo_description };
}

function entityPlans(
  mapped: SqlMaterializerInput | SqlPublicContentResult,
  classification: SqlMaterializerOptions['classification'],
  allowNullableProgramDescription = false,
): EntityPlan[] {
  const teacherClassification = new Map<number, 'teacher' | 'method-author'>();
  for (const candidate of classification.teachers) {
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
  for (const candidate of classification.articles) {
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
        description: allowNullableProgramDescription
          ? nullableString(entity, table, 'description')
          : requiredString(entity, table, 'description'),
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
  for (const entity of mapped.entities.news ?? []) {
    const table: SourceTable = 'News';
    const legacyId = requiredLegacyId(entity, table);
    plans.push({
      collection: 'news-items', sourceTable: table, entity, legacyId,
      data: {
        name: requiredString(entity, table, 'name'),
        description: requiredString(entity, table, 'description'),
        date: requiredString(entity, table, 'date'),
        link: nullableString(entity, table, 'link'),
        priority: requiredInteger(entity, table, 'priority'),
        legacy_id: legacyId,
      },
      imageField: 'image', imageSourceId: nullableString(entity, table, 'imageId'),
      imageFormat: 'numeric', relations: [], verifyAttributes: true, populate: ['image'],
    });
  }
  for (const entity of mapped.entities.promotions ?? []) {
    const table: SourceTable = 'Promotions';
    const legacyId = requiredLegacyId(entity, table);
    const promotionType = requiredString(entity, table, 'type');
    if (promotionType !== 'SHOP' && promotionType !== 'INSTITUTE') {
      fail(recordContext(table, entity), `type has unsupported value ${promotionType}`);
    }
    plans.push({
      collection: 'promotions', sourceTable: table, entity, legacyId,
      data: {
        name: requiredString(entity, table, 'name'),
        description: requiredString(entity, table, 'description'),
        date: requiredString(entity, table, 'date'),
        type: promotionType,
        link: nullableString(entity, table, 'link'),
        priority: requiredInteger(entity, table, 'priority'),
        active: requiredBoolean(entity, table, 'active'),
        legacy_id: legacyId,
      },
      imageField: 'image', imageSourceId: nullableString(entity, table, 'imageId'),
      imageFormat: 'numeric', relations: [], verifyAttributes: true, populate: ['image'],
    });
  }
  for (const candidate of mapped.entities.videos ?? []) {
    const table: SourceTable = 'Videos';
    const entity: RecordValue = candidate;
    const legacyId = requiredLegacyId(entity, table);
    const name = requiredString(entity, table, 'name');
    const slug = requiredString(entity, table, 'slug');
    const videos = entity.videos;
    if (videos !== null && !Array.isArray(videos)) fail(recordContext(table, entity), 'videos must be an array or null');
    const seo = seoComponent(entity, table);
    plans.push({
      collection: 'video-playlists', sourceTable: table, entity, legacyId,
      data: { name, slug, videos, legacy_id: legacyId, seo },
      relations: [], verifyAttributes: true, populate: ['seo'],
    });
  }
  for (const entity of ('pages' in mapped.entities ? mapped.entities.pages : undefined) ?? []) {
    const table: SourceTable = 'Pages';
    const legacyId = requiredLegacyId(entity, table);
    plans.push({
      collection: 'pages', sourceTable: table, entity, legacyId,
      data: {
        title: requiredString(entity, table, 'title'),
        slug: requiredString(entity, table, 'slug'),
        body: requiredString(entity, table, 'body'),
        legacy_id: legacyId,
        seo: seoComponent(entity, table),
      },
      relations: [], verifyAttributes: true, populate: ['seo'],
    });
  }
  return plans;
}

/** The public projection used by both materialization and the read-only conservation check. */
export interface SqlMaterializerProjectionRecord {
  collection: Collection;
  sourceTable: SourceTable;
  sourceId?: number;
  legacyId: string;
  attributes: Record<string, unknown>;
  image?: { field: 'image' | 'photo'; sourceId: string | null };
  relations: { field: string; cardinality: 'single' | 'many'; optional?: boolean; legacyIds: readonly string[]; collection: Collection }[];
}

/** Derives the exact public fields and logical relations without resolving or writing media. */
export function projectSqlPublicContentForConservation(
  mapped: SqlMaterializerInput | SqlPublicContentResult,
  classification: SqlMaterializerOptions['classification'],
): SqlMaterializerProjectionRecord[] {
  return entityPlans(mapped, classification, true).map((plan) => ({
    collection: plan.collection,
    sourceTable: plan.sourceTable,
    ...(Number.isSafeInteger(plan.entity.sourceId) ? { sourceId: plan.entity.sourceId as number } : {}),
    legacyId: plan.legacyId,
    attributes: {
      ...plan.data,
      ...(plan.sourceTable === 'Seminars'
        ? Object.fromEntries(['full_text', 'learning_plan', 'learning_mode', 'recommendations'].map((field) => [field, plan.entity[field] ?? null]))
        : {}),
    },
    ...(plan.imageField ? { image: { field: plan.imageField, sourceId: plan.imageSourceId ?? null } } : {}),
    relations: plan.relations.map((relation) => ({
      field: relation.field,
      cardinality: relation.cardinality,
      ...(relation.optional ? { optional: true } : {}),
      legacyIds: relation.targets.map((target) => target.legacyId),
      collection: relation.targets[0]?.collection ?? (relation.field === 'institute' ? 'institutes' : 'teachers'),
    })),
  }));
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

function slugIsUnique(plan: EntityPlan): boolean {
  return typeof plan.data.slug === 'string';
}

function validatePlanIdentities(plans: readonly EntityPlan[]): void {
  const legacyIds = new Map<Collection, Map<string, EntityPlan>>();
  const slugs = new Map<Collection, Map<string, EntityPlan>>();
  for (const plan of plans) {
    const collectionIds = legacyIds.get(plan.collection) ?? new Map<string, EntityPlan>();
    const previousLegacyId = collectionIds.get(plan.legacyId);
    if (previousLegacyId) {
      fail(recordContext(plan.sourceTable, plan.entity), `legacy_id ${plan.legacyId} collides with another planned ${plan.collection} document`);
    }
    collectionIds.set(plan.legacyId, plan);
    legacyIds.set(plan.collection, collectionIds);

    if (slugIsUnique(plan)) {
      const slug = requiredString(plan.data, plan.sourceTable, 'slug');
      const collectionSlugs = slugs.get(plan.collection) ?? new Map<string, EntityPlan>();
      if (collectionSlugs.has(slug)) {
        fail(plan.collection, `slug ${slug} for ${recordContext(plan.sourceTable, plan.entity)} collides with another planned document`);
      }
      collectionSlugs.set(slug, plan);
      slugs.set(plan.collection, collectionSlugs);
    }
  }

  for (const plan of plans) {
    for (const relation of plan.relations) {
      for (const relationTarget of relation.targets) {
        if (!legacyIds.get(relationTarget.collection)?.has(relationTarget.legacyId)) {
          fail(recordContext(plan.sourceTable, plan.entity), `${relation.field} relation target ${relationTarget.collection}/${relationTarget.legacyId} is missing from the materialization plan`);
        }
      }
    }
  }
}

async function findSlugCollisions(plan: EntityPlan, target: SqlStrapiRestClient): Promise<void> {
  if (!slugIsUnique(plan)) return;
  const context = recordContext(plan.sourceTable, plan.entity);
  const slug = requiredString(plan.data, plan.sourceTable, 'slug');
  const filter = `filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=2`;
  const byStatus = new Map<'published' | 'draft', RecordValue>();
  for (const status of ['published', 'draft'] as const) {
    let results: RecordValue[];
    try {
      results = responseList(
        await target.request('GET', `/api/${plan.collection}?${filter}&status=${status}`),
        `${context} slug lookup`,
      ).filter((result) => result.slug === slug);
    } catch {
      return fail(context, 'slug lookup request failed');
    }
    if (results.length > 1) return fail(context, `slug ${slug} matches multiple ${status} documents`);
    if (results.length === 1) {
      if (results[0]!.legacy_id !== plan.legacyId) {
        return fail(context, `slug ${slug} is already used by a different ${plan.collection} legacy_id`);
      }
      byStatus.set(status, results[0]!);
    }
  }
  const published = byStatus.get('published');
  const draft = byStatus.get('draft');
  if (published && draft && documentId(published, context) !== documentId(draft, context)) {
    fail(context, `slug ${slug} points to different published and draft documents`);
  }
}

async function preflightPlans(plans: readonly EntityPlan[], target: SqlStrapiRestClient): Promise<Map<EntityPlan, RecordValue | null>> {
  validatePlanIdentities(plans);
  const existing = new Map<EntityPlan, RecordValue | null>();
  for (const plan of plans) {
    existing.set(plan, await findExisting(plan, target));
    await findSlugCollisions(plan, target);
  }
  return existing;
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
      data[plan.imageField] = plan.imageFormat === 'numeric' ? media.id : { connect: [media.id] };
    }
  }
  return data;
}

async function writeDraft(plan: EntityPlan, data: RecordValue, existing: RecordValue | null, target: SqlStrapiRestClient): Promise<StoredRef> {
  const context = recordContext(plan.sourceTable, plan.entity);
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

function populatedAttributeMatches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length
      && expected.every((value, index) => populatedAttributeMatches(value, actual[index]));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected as RecordValue).every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(actual, key)
      && populatedAttributeMatches(value, (actual as RecordValue)[key]));
  }
  return Object.is(expected, actual);
}

function populatedMediaId(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Number.NaN;
  const record = value as RecordValue;
  if (Number.isSafeInteger(record.id)) return record.id as number;
  return Number.NaN;
}

function verifyMaterializedAttributes(plan: EntityPlan, expected: RecordValue, actual: RecordValue): void {
  const context = recordContext(plan.sourceTable, plan.entity);
  for (const [field, value] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, field)) fail(context, `published Content API verification omitted ${field}`);
    if (field === 'image' || field === 'photo') {
      const expectedId = populatedMediaId(value);
      const actualId = populatedMediaId(actual[field]);
      if (expectedId !== actualId) fail(context, `published Content API verification changed ${field}`);
    } else if (!populatedAttributeMatches(value, actual[field])) {
      fail(context, `published Content API verification changed ${field}`);
    }
  }
}

async function publishAndVerify(plan: EntityPlan, document: StoredRef, expected: RecordValue, target: SqlStrapiRestClient): Promise<void> {
  const context = recordContext(plan.sourceTable, plan.entity);
  try {
    await target.request('PUT', `/api/${plan.collection}/${encodeURIComponent(document.documentId)}?status=published`, { data: {} });
    const populate = plan.populate?.map((field) => `populate[${field}]=true`).join('&');
    const query = ['status=published', populate].filter(Boolean).join('&');
    const response = await target.request('GET', `/api/${plan.collection}/${encodeURIComponent(document.documentId)}?${query}`);
    const published = responseRecord(response, context);
    if (documentId(published, context) !== document.documentId || typeof published.publishedAt !== 'string' || !published.publishedAt) {
      fail(context, 'published Content API verification failed');
    }
    if (plan.verifyAttributes) verifyMaterializedAttributes(plan, expected, published);
  } catch (error) {
    if (error instanceof SafeMaterializerError) throw error;
    fail(context, 'publish or verification failed');
  }
}

/**
 * Materializes a mapped synthetic or private SQL DTO through Strapi's public Content API.
 * Provenance and source media identities remain private to the caller/resolver boundary.
 */
export async function materializeSqlPublicContent(
  mapped: SqlMaterializerInput | SqlPublicContentResult,
  options: SqlMaterializerOptions,
): Promise<void> {
  if (options.classification.status !== 'pending-confirmation') throw new Error('SQL classification must remain pending-confirmation');

  // Validate source-ID coverage and every required public projection before the first target write.
  // Programs.description is nullable in the active CMS schema and in the accepted
  // SQL projection. Keep the write path aligned with the conservation projection.
  const plans = entityPlans(mapped, options.classification, true);
  const existing = await preflightPlans(plans, options.target);
  const payloads = new Map<EntityPlan, RecordValue>();
  for (const plan of plans) payloads.set(plan, await payloadFor(plan, options));
  const refs = new Map<Collection, Map<string, StoredRef>>(API_COLLECTIONS.map((collection) => [collection, new Map()]));

  for (const plan of plans) {
    const data = payloads.get(plan)!;
    const ref = await writeDraft(plan, data, existing.get(plan) ?? null, options.target);
    refs.get(plan.collection)!.set(plan.legacyId, ref);
  }

  for (const plan of plans) {
    const ref = refs.get(plan.collection)!.get(plan.legacyId)!;
    const relations = resolveRelations(plan, refs);
    await writeRelations(plan, ref, relations, options.target);
  }

  for (const plan of plans) {
    const ref = refs.get(plan.collection)!.get(plan.legacyId)!;
    await publishAndVerify(plan, ref, payloads.get(plan)!, options.target);
  }
}
