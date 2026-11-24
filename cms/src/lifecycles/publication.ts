import type { Core } from '@strapi/strapi';
import { createRequire } from 'node:module';
import { errors } from '@strapi/utils';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  checkPublication,
  checkDocumentRecord,
  checkCategoryFlagRemoval,
  checkDocumentsStateChange,
  type DocumentRecord,
  type DocumentsState,
} from '../lib/publication-validation';
import { isTrustedImport } from '../seminar-management/rules.js';
import { checkPagePhones } from '../lib/site-phones';
import { articleSlug, moscowCalendarDateISO, todayInMoscow } from '../lib/article-publication';
const sourceEmptyFields = createRequire(`${process.cwd()}/src/lifecycles/publication.ts`)('../lib/demo193-source-empty-fields.json') as {
  sourceSqlSha256: string;
  entries: SourceEmptyFieldEntry[];
};

const { ApplicationError } = errors;

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
const ARTICLE_UID = 'api::article.article';
const INTERNAL_ARTICLE_WRITE = new AsyncLocalStorage<boolean>();
const ARTICLE_SLUG_LOCK_KEY = 'ikpk:article-slug-allocation';
type ArticleTransactionLock = {
  transaction: object;
  ready: Promise<void>;
  tail: Promise<void>;
};
const ARTICLE_LOCK_CONTEXT = new AsyncLocalStorage<ArticleTransactionLock>();
const ARTICLE_TRANSACTION_LOCKS = new WeakMap<object, ArticleTransactionLock>();
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
  'schedule-entry': { seminar: true },
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
      return {
        title: entity.title, identifier: entity.slug, body: entity.body, seo_title, seo_description,
        center_phone: entity.center_phone, manager_phone: entity.manager_phone,
      };
    case 'schedule-entry':
      return {
        seminar: entity.seminar,
        startAt: entity.startAt,
        endAt: entity.endAt,
        city: entity.city,
        isOnline: entity.isOnline,
        // `status` — имя в независимом публикационном контракте. В Strapi поле
        // называется иначе, потому что status занят Document Service / REST API.
        status: entity.entry_status,
      };
    case 'news-item':
    case 'promotion':
      return { title: entity.name, date: entity.date, body: entity.description };
  }
}

async function uniqueArticleSlug(
  strapi: Core.Strapi,
  title: unknown,
  documentId?: string,
): Promise<string> {
  const base = articleSlug(title);
  if (!base) return '';
  const rows = (await strapi.db.query(ARTICLE_UID).findMany({
    select: ['documentId', 'slug'],
  })) as { documentId: string; slug: string | null }[];
  const occupied = new Set(rows.filter((row) => row.documentId !== documentId).map((row) => row.slug).filter(Boolean));
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new ApplicationError('Не удалось подобрать уникальный адрес статьи');
}

async function withArticleSlugLock<T>(strapi: Core.Strapi, operation: () => Promise<T>): Promise<T> {
  const activeTransaction = strapi.db.inTransaction()
    ? (await strapi.db.transaction()).get() as object
    : null;
  const inheritedLock = ARTICLE_LOCK_CONTEXT.getStore();
  if (activeTransaction && inheritedLock?.transaction === activeTransaction) return operation();

  return strapi.db.transaction(async ({ trx, onCommit, onRollback }) => {
    const transaction = trx as object;
    let lock = ARTICLE_TRANSACTION_LOCKS.get(transaction);
    if (!lock) {
      const ready = strapi.db.config.connection.client === 'postgres'
        ? Promise.resolve()
          .then(() => trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [ARTICLE_SLUG_LOCK_KEY]))
          .then(() => undefined)
        : Promise.resolve();
      lock = { transaction, ready, tail: Promise.resolve() };
      ARTICLE_TRANSACTION_LOCKS.set(transaction, lock);
      const clearTransactionLock = () => ARTICLE_TRANSACTION_LOCKS.delete(transaction);
      onCommit(clearTransactionLock);
      onRollback(clearTransactionLock);
    }

    await lock.ready;
    if (ARTICLE_LOCK_CONTEXT.getStore() === lock) return operation();

    const previous = lock.tail;
    let release!: () => void;
    lock.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await ARTICLE_LOCK_CONTEXT.run(lock, operation);
    } finally {
      release();
    }
  });
}

/*
 * Preserve source publication values when an older draft has null scalar fields.
 * The current draft remains authoritative for title and other fields.
 */
function mergeArticlePublishedDefaults(
  draft: Record<string, unknown> | null,
  published: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!draft) return published;
  if (!published) return draft;
  return {
    ...published,
    ...draft,
    slug: draft.slug || published.slug,
    published_date: draft.published_date || published.published_date,
  };
}

async function prepareArticleDefaults(
  strapi: Core.Strapi,
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
  documentId: string | undefined,
  publishedWrite: boolean,
  trustedImport: boolean,
): Promise<Record<string, unknown>> {
  const data = { ...incoming };
  const slugAlreadyAssigned = typeof existing?.slug === 'string' && existing.slug.length > 0;
  const title = Object.prototype.hasOwnProperty.call(data, 'title') ? data.title : existing?.title;

  if (trustedImport) {
    // Imported historical URLs and dates are source data.
    if (typeof data.slug === 'string') {
      const rows = (await strapi.db.query(ARTICLE_UID).findMany({ select: ['documentId', 'slug'] })) as {
        documentId: string; slug: string | null;
      }[];
      if (rows.some((row) => row.slug === data.slug && row.documentId !== documentId)) {
        throw new ApplicationError(`Адрес импортируемой статьи уже занят: ${data.slug}`);
      }
    }
    if (!data.slug && existing?.slug) data.slug = existing.slug;
    if (publishedWrite) {
      if (!data.published_date) data.published_date = existing?.published_date ?? moscowCalendarDateISO(todayInMoscow());
    }
    return data;
  }

  if (slugAlreadyAssigned) {
    if (existing?.slug) data.slug = existing.slug;
  } else {
    delete data.slug;
    if (typeof title === 'string' && title.trim() && (data.title !== undefined || !existing?.slug)) {
      data.slug = await uniqueArticleSlug(strapi, title, documentId);
    } else if (existing?.slug) {
      data.slug = existing.slug;
    }
  }

  // If a saved date is cleared, keep the previous day even when the draft has no slug yet.
  // A new article with no saved date can still remain empty until its first publication.
  if (Object.prototype.hasOwnProperty.call(data, 'published_date') && !data.published_date && existing?.published_date) {
    data.published_date = existing.published_date;
  }

  if (publishedWrite && !data.published_date) {
    data.published_date = existing?.published_date ?? moscowCalendarDateISO(todayInMoscow());
  }
  return data;
}

function mapDocumentRecord(raw: Record<string, unknown>): DocumentRecord {
  return {
    document: raw.document as string,
    issuer: raw.issuer as string,
    issuerUnknown: raw.issuer_unknown === true,
    completionScope: raw.completion_scope as DocumentRecord['completionScope'],
    otherSeminarHref: raw.other_seminar_href as string | undefined,
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
    const run = async () => {
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
    const continueWrite = async () => {
      try {
        return await next();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (context.uid === ARTICLE_UID && /unique|constraint|duplicate/i.test(detail) && /slug/i.test(detail)) {
          throw new ApplicationError('Адрес этой статьи уже занят. Обновите форму и сохраните запись ещё раз.');
        }
        throw error;
      }
    };
    if (
      type === 'article' && context.action === 'update' && params.documentId &&
      params.data && Object.prototype.hasOwnProperty.call(params.data, 'seo') && params.data.seo !== null &&
      typeof params.data.seo === 'object' && !Array.isArray(params.data.seo)
    ) {
      const existing = (await strapi.documents(context.uid as never).findOne({
        documentId: params.documentId,
        status: 'draft',
        populate: POPULATE_BY_TYPE.article,
      })) as Record<string, unknown> | null ?? (await strapi.documents(context.uid as never).findOne({
        documentId: params.documentId,
        status: 'published',
        populate: POPULATE_BY_TYPE.article,
      })) as Record<string, unknown> | null;
      const currentSeo = existing?.seo;
      if (currentSeo && typeof currentSeo === 'object' && !Array.isArray(currentSeo)) {
        // Strapi treats an object component in an update payload as a full replacement.
        // Keep omitted Article SEO fields intact; explicit null/blank values still clear them.
        params.data.seo = { ...(currentSeo as Record<string, unknown>), ...(params.data.seo as Record<string, unknown>) };
      }
    }

    const publishedWrite: boolean =
      context.action === 'publish' ||
      ((context.action === 'create' || context.action === 'update') && params.status === 'published');

    if (type === 'static-page' && !publishedWrite && ['create', 'update', 'clone'].includes(context.action)) {
      const existing = params.documentId ? await strapi.documents(context.uid as never).findOne({
        documentId: params.documentId,
        status: 'draft',
        fields: ['slug', 'center_phone', 'manager_phone'],
      }) as Record<string, unknown> | null : null;
      const page = { ...existing, ...params.data };
      const error = checkPagePhones(page.slug, page, false);
      if (error) throw new ApplicationError(error.message);
    }

    if (type === 'article' && context.action === 'clone' && !isTrustedImport(strapi)) {
      const source = params.documentId
        ? (await strapi.documents(ARTICLE_UID as never).findOne({
            documentId: params.documentId,
            status: 'draft',
            fields: ['title'],
          })) as Record<string, unknown> | null
        : null;
      if (source) {
        const cloneTitle = Object.prototype.hasOwnProperty.call(params.data ?? {}, 'title')
          ? params.data?.title
          : source.title;
        params.data = {
          ...(params.data ?? {}),
          slug: typeof cloneTitle === 'string' && cloneTitle.trim()
            ? await uniqueArticleSlug(strapi, cloneTitle)
            : null,
        };
        return continueWrite();
      }
    }

    let articlePublishData: Record<string, unknown> | null = null;
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
        if (type === 'article' && !INTERNAL_ARTICLE_WRITE.getStore()) {
          const publishedDefaults = (await strapi.documents(ARTICLE_UID as never).findOne({
            documentId: params.documentId,
            status: 'published',
            fields: ['title', 'slug', 'published_date'],
          })) as Record<string, unknown> | null;
          existing = mergeArticlePublishedDefaults(existing, publishedDefaults);
        }
      }

      if (context.action === 'publish' ? existing : true) {
        let incoming = params.data ?? {};
        if (type === 'article' && !INTERNAL_ARTICLE_WRITE.getStore()) {
          incoming = await prepareArticleDefaults(
            strapi,
            existing,
            incoming,
            params.documentId,
            true,
            isTrustedImport(strapi),
          );
          if (context.action === 'publish') articlePublishData = incoming;
          else params.data = incoming;
        }
        const entity = prospectiveEntity(type, existing, incoming);
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

    // A publish action has no data payload. Persist defaults in the already locked transaction.
    if (articlePublishData && params.documentId) {
      await INTERNAL_ARTICLE_WRITE.run(true, () => strapi.documents(ARTICLE_UID as never).update({
        documentId: params.documentId as string,
        status: 'draft',
        data: articlePublishData as Record<string, unknown>,
      }));
      return continueWrite();
    }

    // Draft writes also generate the slug immediately and reject user supplied overrides.
    if (
      type === 'article' && !publishedWrite && !INTERNAL_ARTICLE_WRITE.getStore() &&
      (context.action === 'create' || context.action === 'update')
    ) {
      let existing = params.documentId
        ? (await strapi.documents(ARTICLE_UID as never).findOne({
            documentId: params.documentId,
            status: 'draft',
            fields: ['title', 'slug', 'published_date'],
          })) as Record<string, unknown> | null
        : null;
      if (params.documentId) {
        const publishedVersion = (await strapi.documents(ARTICLE_UID as never).findOne({
          documentId: params.documentId,
          status: 'published',
          fields: ['title', 'slug', 'published_date'],
        })) as Record<string, unknown> | null;
        existing = mergeArticlePublishedDefaults(existing, publishedVersion);
      }
      params.data = await prepareArticleDefaults(
        strapi,
        existing,
        params.data ?? {},
        params.documentId,
        false,
        isTrustedImport(strapi),
      );
    }

    if (type === 'article' && context.action === 'unpublish' && params.documentId) {
      const draft = (await strapi.documents(ARTICLE_UID as never).findOne({
        documentId: params.documentId,
        status: 'draft',
        fields: ['slug', 'published_date'],
      })) as Record<string, unknown> | null;
      const publishedVersion = (await strapi.documents(ARTICLE_UID as never).findOne({
        documentId: params.documentId,
        status: 'published',
        fields: ['slug', 'published_date'],
      })) as Record<string, unknown> | null;
      if (draft && publishedVersion) {
        const fallback: Record<string, unknown> = {};
        if (!draft.slug && publishedVersion.slug) fallback.slug = publishedVersion.slug;
        if (!draft.published_date && publishedVersion.published_date) {
          fallback.published_date = publishedVersion.published_date;
        }
        if (Object.keys(fallback).length > 0) {
          await INTERNAL_ARTICLE_WRITE.run(true, () => strapi.documents(ARTICLE_UID as never).update({
            documentId: params.documentId as string,
            status: 'draft',
            data: fallback,
          }));
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

    return continueWrite();
    };

    if (
      context.uid === ARTICLE_UID && !INTERNAL_ARTICLE_WRITE.getStore() &&
      ['create', 'update', 'publish', 'clone', 'unpublish', 'delete'].includes(context.action)
    ) {
      // Keep every read, validation, slug allocation, and write inside one lock per Document Service action.
      return withArticleSlugLock(strapi, run);
    }
    return run();
  });
}
