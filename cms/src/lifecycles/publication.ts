import type { Core } from '@strapi/strapi';
import { createRequire } from 'node:module';
import { errors } from '@strapi/utils';
import {
  checkPublication,
  checkDocumentRecord,
  checkCategoryFlagRemoval,
  checkDocumentsStateChange,
  type DocumentRecord,
  type DocumentsState,
} from '../lib/publication-validation';
import { isTrustedImport, scheduleEntryIsBeforeStart } from '../seminar-management/rules.js';
const sourceEmptyFields = createRequire(`${process.cwd()}/src/lifecycles/publication.ts`)('../lib/demo193-source-empty-fields.json') as {
  sourceSqlSha256: string;
  entries: SourceEmptyFieldEntry[];
};

const { ApplicationError } = errors;
type DocumentMiddleware = Parameters<Core.Strapi['documents']['use']>[0];
type DocumentMiddlewareContext = Parameters<DocumentMiddleware>[0];
type DocumentMiddlewareNext = Parameters<DocumentMiddleware>[1];

type PublicationType =
  | 'institute'
  | 'course-group'
  | 'seminar'
  | 'person'
  | 'article'
  | 'video-playlist'
  | 'static-page'
  | 'schedule-entry'
  | 'news-item'
  | 'promotion';

const TYPE_BY_UID: Record<string, PublicationType> = {
  'api::institute.institute': 'institute',
  'api::course-group.course-group': 'course-group',
  'api::seminar.seminar': 'seminar',
  'api::teacher.teacher': 'person',
  'api::article.article': 'article',
  'api::video-playlist.video-playlist': 'video-playlist',
  'api::page.page': 'static-page',
  'api::schedule-entry.schedule-entry': 'schedule-entry',
  'api::news-item.news-item': 'news-item',
  'api::promotion.promotion': 'promotion',
};

const COURSE_GROUP_UID = 'api::course-group.course-group';
const TEACHER_UID = 'api::teacher.teacher';
const SCHEDULE_ENTRY_UID = 'api::schedule-entry.schedule-entry';
const ARTICLE_UID = 'api::article.article';
const SEMINAR_UID = 'api::seminar.seminar';
const DEMO193_SOURCE_SQL_SHA256 = 'b7b056d6a226b9caed224c737dad18dc366d47a0ec397e0ef0f1c66f61762be2';
const DEMO193_PUBLICATION_TYPE: Partial<Record<PublicationType, string>> = {
  'course-group': 'course-group',
  seminar: 'seminar',
  article: 'article',
};

type SourceEmptyField = 'description' | 'seo_title' | 'seo_description';
type SourceEmptyFieldEntry = {
  type: string;
  legacyId: string;
  slug: string;
  fields: SourceEmptyField[];
};

function allowsPinnedSourceEmptyFields(
  strapi: Core.Strapi,
  type: PublicationType,
  entity: Record<string, unknown>,
  missing: readonly string[],
  verdictMessage: string,
): boolean {
  if (
    process.env.IKPK_DEMO193_SOURCE_EMPTY_PUBLICATION !== '1' ||
    process.env.IKPK_DEMO193_SOURCE_SQL_SHA256 !== DEMO193_SOURCE_SQL_SHA256 ||
    sourceEmptyFields.sourceSqlSha256 !== DEMO193_SOURCE_SQL_SHA256 ||
    !isTrustedImport(strapi)
    // Do not treat other publication invariants (for example issued seminars requiring
    // document rows) as source-empty required-field failures merely because `missing`
    // happens to contain an allowlisted SEO field too.
    || !verdictMessage.startsWith('не заполнены обязательные поля:')
  ) return false;

  const allowlistType = DEMO193_PUBLICATION_TYPE[type];
  const legacyId = entity.legacy_id;
  const slug = entity.slug;
  if (!allowlistType || typeof legacyId !== 'string' || typeof slug !== 'string') return false;
  const entry = (sourceEmptyFields.entries as SourceEmptyFieldEntry[]).find((candidate) =>
    candidate.type === allowlistType && candidate.legacyId === legacyId && candidate.slug === slug);
  if (!entry) return false;
  const allowed = [...entry.fields].sort();
  const actual = [...missing].sort();
  return actual.length === allowed.length && actual.every((field, index) => field === allowed[index]);
}

/** Что нужно `populate`, чтобы обязательные поля-связи/компоненты не выглядели пустыми. */
const POPULATE_BY_TYPE: Record<PublicationType, Record<string, unknown> | undefined> = {
  institute: { seo: true },
  'course-group': { institute: true, seo: true },
  seminar: { course_group: true, seo: true, documents: true },
  person: undefined,
  article: { categories: true, seo: true, image: true },
  'video-playlist': undefined,
  'static-page': { seo: true },
  'schedule-entry': { seminar: true, teachers: true },
  'news-item': undefined,
  promotion: undefined,
};

const RELATION_FIELDS_BY_TYPE: Partial<Record<PublicationType, string[]>> = {
  'course-group': ['institute'],
  seminar: ['course_group'],
  article: ['image', 'categories'],
  'schedule-entry': ['seminar'],
};

function relationItems(value: unknown): unknown[] {
  if (value === null || value === undefined || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function relationIds(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return [item.documentId, item.id]
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
      .map(String);
  }
  return [];
}

function relationReferences(value: unknown): unknown[] {
  if (value === null || value === undefined || value === false) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [value];
  const operation = value as Record<string, unknown>;
  if ('documentId' in operation || 'id' in operation) return [value];
  if ('set' in operation) return relationReferences(operation.set);
  const current: unknown[] = [];
  if ('disconnect' in operation && operation.disconnect !== true) current.push(operation.disconnect);
  if ('connect' in operation) current.push(operation.connect);
  return current.flatMap((item) => Array.isArray(item) ? item : item == null ? [] : [item]);
}

function relationKey(value: unknown): string | null {
  const ids = relationIds(value);
  return ids[0] ? String(ids[0]) : null;
}

function selectedTeachers(existing: unknown, incoming: unknown): unknown[] {
  let selected = relationReferences(existing);
  if (incoming === undefined) return selected;
  if (incoming === null || incoming === false) return [];
  if (Array.isArray(incoming) || typeof incoming !== 'object') return relationReferences(incoming);

  const operation = incoming as Record<string, unknown>;
  if ('set' in operation) return relationReferences(operation.set);
  if (!('connect' in operation) && !('disconnect' in operation)) return relationReferences([incoming]);
  if (operation.disconnect === true) selected = [];
  else if (operation.disconnect !== undefined && operation.disconnect !== false && operation.disconnect !== null) {
    const removed = new Set(relationReferences(operation.disconnect).flatMap(relationIds));
    selected = selected.filter((value) => !relationIds(value).some((id) => removed.has(id)));
  }
  if ('connect' in operation) selected.push(...relationReferences(operation.connect));
  const unique = new Map<string, unknown>();
  for (const value of selected) {
    const key = relationKey(value);
    if (key) unique.set(key, value);
  }
  return [...unique.values()];
}

async function publishedTeacherByReference(strapi: Core.Strapi, reference: unknown): Promise<Record<string, unknown> | null> {
  const ids = relationIds(reference);
  if (ids.length === 0) return null;
  const first = ids[0];
  let documentId = typeof reference === 'object' && reference !== null
    ? (reference as Record<string, unknown>).documentId
    : undefined;
  if (typeof documentId !== 'string' && !/^\d+$/.test(first)) documentId = first;
  if (typeof documentId !== 'string') {
    const row = await strapi.db.query(TEACHER_UID).findOne({ where: { id: Number(first) }, select: ['documentId'] });
    documentId = row?.documentId;
  }
  if (typeof documentId !== 'string' || !documentId) return null;
  return await strapi.documents(TEACHER_UID as never).findOne({
    documentId,
    status: 'published',
    fields: ['name', 'legacy_id'],
  }) as Record<string, unknown> | null;
}

async function validateScheduleEntryTeachers(
  strapi: Core.Strapi,
  entry: Record<string, unknown>,
  currentTeachers: unknown,
  incomingTeachers: unknown,
): Promise<void> {
  if ((entry.entry_status ?? 'active') !== 'active' || !scheduleEntryIsBeforeStart(entry)) return;
  const teachers = selectedTeachers(currentTeachers, incomingTeachers);
  if (teachers.length === 0) {
    throw new ApplicationError('Выберите хотя бы одного преподавателя проведения перед публикацией.');
  }
  for (const reference of teachers) {
    const published = await publishedTeacherByReference(strapi, reference);
    const label = published?.name ?? relationKey(reference) ?? 'без идентификатора';
    if (!published || typeof published.name !== 'string' || !published.name.trim() ||
        typeof published.legacy_id !== 'string' || !published.legacy_id.trim()) {
      throw new ApplicationError(
        `Преподаватель «${label}» проведения должен иметь опубликованную версию с именем и legacy_id.`,
      );
    }
  }
}

async function guardTeacherRemoval(strapi: Core.Strapi, teacherDocumentId: string): Promise<void> {
  const entries = await strapi.db.query(SCHEDULE_ENTRY_UID).findMany({
    where: { publishedAt: { $notNull: true }, entry_status: 'active' },
    select: ['documentId', 'admin_label', 'startAt', 'additionalText'],
    populate: { teachers: { select: ['documentId'] } },
  }) as Record<string, unknown>[];
  for (const entry of entries) {
    if (!scheduleEntryIsBeforeStart(entry)) continue;
    const teachers = Array.isArray(entry.teachers) ? entry.teachers as Record<string, unknown>[] : [];
    if (teachers.some((teacher) => teacher.documentId === teacherDocumentId)) {
      const label = entry.admin_label || entry.documentId || 'без подписи';
      throw new ApplicationError(
        `Нельзя удалить или снять с публикации преподавателя: он назначен активному будущему проведению «${label}».`,
      );
    }
  }
}

function requiresSqliteWriterFence(context: { uid?: unknown; action?: unknown; params?: unknown }): boolean {
  const action = context.action;
  if (context.uid === 'api::schedule-entry.schedule-entry') {
    return ['create', 'update', 'publish', 'unpublish', 'delete'].includes(String(action));
  }
  return context.uid === TEACHER_UID && ['create', 'update', 'publish', 'unpublish', 'delete'].includes(String(action));
}

/** Resolve relation connect/disconnect/set input to the effective nonempty state for validation. */
function relationHasValue(current: unknown, incoming: unknown): boolean {
  if (incoming === null || incoming === undefined || incoming === false) return false;
  if (typeof incoming === 'string' || typeof incoming === 'number') return String(incoming).trim() !== '';
  if (Array.isArray(incoming)) return incoming.length > 0;
  if (!incoming || typeof incoming !== 'object') return Boolean(incoming);

  const operation = incoming as Record<string, unknown>;
  const hasOperations = 'set' in operation || 'connect' in operation || 'disconnect' in operation;
  if (!hasOperations) return Object.keys(operation).length > 0;

  let items = relationItems(current);
  // Strapi's `set` declares the complete resulting relation, unlike connect/disconnect deltas.
  if ('set' in operation) return relationItems(operation.set).length > 0;
  const disconnect = operation.disconnect;
  if (disconnect === true) items = [];
  else if (disconnect !== undefined && disconnect !== false && disconnect !== null) {
    const removed = new Set(relationItems(disconnect).flatMap(relationIds));
    items = items.filter((item) => {
      const ids = relationIds(item);
      return ids.length === 0 || !ids.some((id) => removed.has(id));
    });
  }
  if ('connect' in operation) items.push(...relationItems(operation.connect));
  return items.length > 0;
}

function prospectiveEntity(
  type: PublicationType,
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const entity = { ...(existing ?? {}), ...incoming };

  // SEO is a non-repeatable component. Preserve omitted fields when the request sends a partial
  // component update so validation sees the same component Strapi will publish.
  const previousSeo = existing?.seo;
  if (
    previousSeo && typeof previousSeo === 'object' &&
    incoming.seo && typeof incoming.seo === 'object' && !Array.isArray(incoming.seo) &&
    String((incoming.seo as Record<string, unknown>).id ?? '') === String((previousSeo as Record<string, unknown>).id ?? '') &&
    (incoming.seo as Record<string, unknown>).id !== undefined
  ) {
    entity.seo = { ...(previousSeo as Record<string, unknown>), ...(incoming.seo as Record<string, unknown>) };
  }

  for (const field of RELATION_FIELDS_BY_TYPE[type] ?? []) {
    if (Object.prototype.hasOwnProperty.call(incoming, field)) {
      entity[field] = relationHasValue(existing?.[field], incoming[field]) ? { documentId: 'present' } : null;
    }
  }
  return entity;
}

function seoFields(entity: Record<string, unknown>): { seo_title?: unknown; seo_description?: unknown } {
  const seo = entity.seo as Record<string, unknown> | null | undefined;
  return { seo_title: seo?.seo_title, seo_description: seo?.seo_description };
}

function buildPublicationRecord(type: PublicationType, entity: Record<string, unknown>): Record<string, unknown> {
  const { seo_title, seo_description } = seoFields(entity);
  switch (type) {
    case 'institute':
      return {
        name: entity.name,
        identifier: entity.slug,
        description: entity.description,
        seo_title,
        seo_description,
        order: entity.order,
      };
    case 'course-group':
      return {
        name: entity.name,
        identifier: entity.slug,
        institute: entity.institute,
        description: entity.description,
        seo_title,
        seo_description,
      };
    case 'seminar':
      return {
        name: entity.name,
        identifier: entity.slug,
        course_group: entity.course_group,
        description: entity.description,
        seo_title,
        seo_description,
        documentsState: entity.documents_state,
        documents: entity.documents,
      };
    case 'person':
      return { name: entity.name, identifier: entity.slug, trait: entity.trait };
    case 'article':
      return {
        title: entity.title,
        identifier: entity.slug,
        body: entity.body,
        seo_title,
        seo_description,
        image: entity.image,
        published_at: entity.published_date,
        categories: entity.categories,
      };
    case 'video-playlist':
      // Схема видео-плейлиста называет поле `name`, контракт — `title`; сопоставление ровно
      // здесь, а не переименованием поля схемы (переименование — предмет отдельного change).
      return { title: entity.name, identifier: entity.slug };
    case 'static-page':
      return { title: entity.title, identifier: entity.slug, body: entity.body, seo_title, seo_description };
    case 'schedule-entry':
      return {
        seminar: entity.seminar,
        startAt: entity.startAt,
        endAt: entity.endAt,
        city: entity.city,
        // `status` — имя в независимом публикационном контракте. В Strapi поле
        // называется иначе, потому что status занят Document Service / REST API.
        status: entity.entry_status,
      };
    case 'news-item':
    case 'promotion':
      return { title: entity.name, date: entity.date, body: entity.description };
  }
}

function mapDocumentRecord(raw: Record<string, unknown>): DocumentRecord {
  return {
    document: raw.document as string,
    issuer: raw.issuer as string,
    priorEducation: raw.prior_education as DocumentRecord['priorEducation'],
    priorEducationNote: raw.prior_education_note as string | undefined,
    outcome: raw.outcome as DocumentRecord['outcome'],
    basis: raw.basis as string | undefined,
  };
}

/**
 * Снятие признака «является категорией статей», снятие программы с публикации и её удаление
 * запрещены, пока программа остаётся единственной категорией хотя бы одной опубликованной
 * статьи (спека, требование про обязательную категорию статьи).
 */
async function guardCategoryFlagRemoval(strapi: Core.Strapi, courseGroupDocumentId: string): Promise<void> {
  const courseGroup = (await strapi.documents(COURSE_GROUP_UID).findOne({
    documentId: courseGroupDocumentId,
    status: 'draft',
    fields: ['slug'],
  })) as unknown as { slug: string } | null;
  if (!courseGroup) return;

  const articles = (await strapi.db.query(ARTICLE_UID).findMany({
    select: ['slug', 'publishedAt'],
    populate: { categories: { select: ['slug'] } },
  })) as { slug: string; publishedAt: string | null; categories?: { slug: string }[] }[];

  const verdict = checkCategoryFlagRemoval({
    programIdentifier: courseGroup.slug,
    articles: articles.map((a) => ({
      identifier: a.slug,
      categories: (a.categories ?? []).map((c) => c.slug),
      published: a.publishedAt !== null,
    })),
  });
  if (!verdict.ok) throw new ApplicationError(verdict.message);
}

/**
 * Вторая линия по design.md существует на стороне сборки; это — ПЕРВАЯ: отказ редактору на
 * его собственном действии публикации, а не молчаливая порча собранного сайта позже.
 * Черновик сохраняется всегда — здесь перехватывается только действие `publish`.
 */
export function registerPublicationLifecycle(strapi: Core.Strapi): void {
  strapi.documents.use(async (context, next) => {
    const client = strapi.config.get('database.connection.client');
    const serialized = client === 'sqlite' && requiresSqliteWriterFence(context);
    if (serialized) {
      // Strapi document middleware is outside the document-service transaction. Start our own
      // outer transaction and issue a no-op write before reading state: SQLite then holds its
      // single writer lock through both validation and the nested Document Service writes.
      return strapi.db.transaction(async ({ trx }) => {
        await trx.raw('UPDATE "schedule_entries" SET "id" = "id" WHERE 0');
        return runPublicationMiddleware(strapi, context, next);
      });
    }
    return runPublicationMiddleware(strapi, context, next);
  });
}

async function runPublicationMiddleware(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext,
  next: DocumentMiddlewareNext,
) {
    const sqliteTeacherRulesEnabled = strapi.config.get('database.connection.client') === 'sqlite';
    const type = TYPE_BY_UID[context.uid as string];

    if (context.uid === SEMINAR_UID && context.action === 'update') {
      const params = context.params as { documentId?: string; data?: Record<string, unknown> };
      const nextState = params.data?.documents_state;
      if (params.documentId && typeof nextState === 'string') {
        const existing = (await strapi.documents(SEMINAR_UID as never).findOne({
          documentId: params.documentId,
          status: 'draft',
          fields: [
            'documents_state',
            'documents_confirmation_date',
            'documents_confirmation_source',
            'documents_confirmation_author',
          ],
        })) as Record<string, unknown> | null;
        const previousState = existing?.documents_state;
        if (typeof previousState === 'string' && previousState !== nextState) {
          const data = params.data ?? {};
          const verdict = checkDocumentsStateChange({
            from: previousState as DocumentsState,
            to: nextState as DocumentsState,
            confirmation: {
              date: String(data.documents_confirmation_date ?? existing?.documents_confirmation_date ?? ''),
              source: String(data.documents_confirmation_source ?? existing?.documents_confirmation_source ?? ''),
              author: String(data.documents_confirmation_author ?? existing?.documents_confirmation_author ?? ''),
            },
          });
          if (!verdict.ok) throw new ApplicationError(verdict.message);
        }
      }
    }

    const params = context.params as { documentId?: string; status?: string; data?: Record<string, unknown> };
    if (sqliteTeacherRulesEnabled && context.uid === TEACHER_UID && params.documentId &&
        (context.action === 'unpublish' || context.action === 'delete')) {
      await guardTeacherRemoval(strapi, params.documentId);
    }
    const publishedWrite =
      context.action === 'publish' ||
      ((context.action === 'create' || context.action === 'update') && params.status === 'published');
    if (type && publishedWrite) {
      let existing: Record<string, unknown> | null = null;
      if (params.documentId) {
        existing = (await strapi.documents(context.uid as never).findOne({
          documentId: params.documentId,
          status: 'draft',
          populate: POPULATE_BY_TYPE[type],
        })) as Record<string, unknown> | null;
        if (!existing && context.action === 'update') {
          existing = (await strapi.documents(context.uid as never).findOne({
            documentId: params.documentId,
            status: 'published',
            populate: POPULATE_BY_TYPE[type],
          })) as Record<string, unknown> | null;
        }
      }

      if (context.action === 'publish' ? existing : true) {
        const entity = context.action === 'publish'
          ? existing as Record<string, unknown>
          : prospectiveEntity(type, existing, params.data ?? {});
        if (sqliteTeacherRulesEnabled && type === 'schedule-entry') {
          await validateScheduleEntryTeachers(
            strapi,
            entity,
            existing?.teachers,
            context.action === 'publish' ? undefined : params.data?.teachers,
          );
        }
        const record = buildPublicationRecord(type, entity);
        const verdict = checkPublication({ type, record });
        if (!verdict.ok && !allowsPinnedSourceEmptyFields(strapi, type, entity, verdict.missing, verdict.message)) {
          throw new ApplicationError(verdict.message);
        }

        if (type === 'seminar' && Array.isArray(entity.documents)) {
          for (const raw of entity.documents as Record<string, unknown>[]) {
            const docVerdict = checkDocumentRecord(mapDocumentRecord(raw));
            if (!docVerdict.ok) throw new ApplicationError(docVerdict.message);
          }
        }
      }
    }

    if (context.uid === COURSE_GROUP_UID) {
      const params = context.params as { documentId?: string; data?: Record<string, unknown> };
      if ((context.action === 'unpublish' || context.action === 'delete') && params.documentId) {
        await guardCategoryFlagRemoval(strapi, params.documentId);
      }
      if (context.action === 'update' && params.documentId && params.data?.is_article_category === false) {
        await guardCategoryFlagRemoval(strapi, params.documentId);
      }
    }

    return next();
}
