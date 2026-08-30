import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import {
  checkPublication,
  checkDocumentRecord,
  checkCategoryFlagRemoval,
  checkDocumentsStateChange,
  type DocumentRecord,
  type DocumentsState,
} from '../lib/publication-validation';

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
const SEMINAR_UID = 'api::seminar.seminar';

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
        published_at: entity.publication_date,
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
        status: entity.status,
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

    if (type && context.action === 'publish') {
      const documentId = (context.params as { documentId?: string }).documentId;
      if (documentId) {
        const draft = (await strapi.documents(context.uid as never).findOne({
          documentId,
          status: 'draft',
          populate: POPULATE_BY_TYPE[type],
        })) as Record<string, unknown> | null;

        if (draft) {
          const record = buildPublicationRecord(type, draft);
          const verdict = checkPublication({ type, record });
          if (!verdict.ok) throw new ApplicationError(verdict.message);

          if (type === 'seminar' && Array.isArray(draft.documents)) {
            for (const raw of draft.documents as Record<string, unknown>[]) {
              const docVerdict = checkDocumentRecord(mapDocumentRecord(raw));
              if (!docVerdict.ok) throw new ApplicationError(docVerdict.message);
            }
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
  });
}
