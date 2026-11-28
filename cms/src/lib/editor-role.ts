import { isDeepStrictEqual } from 'node:util';
import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

export interface EditorPermission {
  action: string;
  subject?: string | null;
  properties?: { fields: string[] };
}

interface EditorRoleService {
  findOne(params: { code: string }): Promise<{ id: number | string } | null>;
  assignPermissions(roleId: number | string, permissions: EditorPermission[]): Promise<unknown>;
}

export interface EditorRoleStrapi {
  service(name: string): EditorRoleService;
}

const contentAction = (name: 'create' | 'read' | 'update' | 'publish') =>
  `plugin::content-manager.explorer.${name}`;

const articleFields = [
  'title',
  'slug',
  'body',
  'image',
  'published_date',
  'categories',
  'seo.seo_title',
  'seo.seo_description',
  'seo.og_image',
  'seo.noindex',
];

const seminarFields = [
  'name',
  'slug',
  'description',
  'full_text',
  'duration',
  'audience',
  'learning_plan',
  'learning_mode',
  'recommendations',
  'image',
  'order',
  'documents_state',
  'documents.document',
  'documents.document_type_unspecified',
  'documents.issuer',
  'documents.issuer_unknown',
  'documents.prior_education',
  'documents.prior_education_note',
  'documents.outcome',
  'documents.basis',
  'documents.completion_scope',
  'documents.completion_cycle_name',
  'documents.completion_required',
  'documents.completion_after_seminar_number',
  'documents.other_seminar_href',
  'documents.other_seminar_label',
  'documents.signed_by',
  'documents.qualification_topic',
  'documents.hours_mode',
  'documents.hours_may_vary',
  'documents.regulation_url',
  'documents.regulation_issuer',
  'documents.document_on_template',
  'documents.includes_completed_level',
  'documents.registry.name',
  'documents.registry.international',
  'documents.registry.subject',
  'documents.registry.url',
  'documents.registry.basis',
  'training_registries.name',
  'training_registries.international',
  'training_registries.subject',
  'training_registries.url',
  'training_registries.basis',
  'nmo.status',
  'nmo.audience',
  'nmo.awarded_for',
  'nmo.completion_required',
  'nmo.purpose',
  'nmo.url',
  'documents_owner_verified',
  'documents_confirmation_date',
  'documents_confirmation_source',
  'documents_confirmation_author',
  'course_group',
  'teachers',
  'schedule_entries',
  'seo.seo_title',
  'seo.seo_description',
  'seo.og_image',
  'seo.noindex',
];

const scheduleFields = [
  'name',
  'startAt',
  'endAt',
  'image',
  'city',
  'isOnline',
  'price',
  'oldPrice',
  'isFree',
  'entry_status',
  'registrationFormLink',
  'description',
  'additionalText',
  'duration',
  'seminar',
  'teachers',
];

function contentPermissions(subject: string, fields: string[]): EditorPermission[] {
  const permissions: EditorPermission[] = (['create', 'read', 'update'] as const).map((name) => ({
    action: contentAction(name),
    subject,
    properties: { fields },
  }));
  permissions.push({ action: contentAction('publish'), subject });
  return permissions;
}

const editableCards = [
  {
    subject: 'api::course-group.course-group',
    read: ['name', 'slug', 'editor_label', 'description', 'image', 'order', 'is_article_category', 'institute', 'seo.seo_title', 'seo.seo_description'],
    update: ['name', 'description', 'image', 'order', 'is_article_category', 'seo.seo_title', 'seo.seo_description'],
  },
  {
    subject: 'api::teacher.teacher',
    read: ['name', 'slug', 'trait', 'order', 'institute', 'photo', 'bio'],
    update: ['name', 'trait', 'order', 'photo', 'bio'],
  },
  {
    subject: 'api::institute.institute',
    read: ['name', 'slug', 'shortName', 'description', 'image', 'order', 'seo.seo_title', 'seo.seo_description'],
    update: ['name', 'shortName', 'description', 'image', 'order', 'seo.seo_title', 'seo.seo_description'],
  },
];

export const EDITOR_PERMISSIONS: EditorPermission[] = [
  ...contentPermissions('api::article.article', articleFields),
  ...contentPermissions('api::seminar.seminar', seminarFields),
  ...contentPermissions('api::schedule-entry.schedule-entry', scheduleFields),
  ...editableCards.flatMap(({ subject, read, update }) => [
    { action: contentAction('read'), subject, properties: { fields: read } },
    { action: contentAction('update'), subject, properties: { fields: update } },
    { action: contentAction('publish'), subject },
  ]),
  { action: 'plugin::upload.read' },
  { action: 'plugin::upload.configure-view' },
  { action: 'plugin::upload.assets.create' },
  { action: 'plugin::upload.assets.update' },
  { action: 'plugin::upload.assets.download' },
  { action: 'plugin::upload.assets.copy-link' },
];

/** Сводит встроенную роль Editor к проектному allowlist на каждом запуске. */
export async function syncEditorRolePermissions(strapi: EditorRoleStrapi): Promise<void> {
  const roleService = strapi.service('admin::role');
  const editorRole = await roleService.findOne({ code: 'strapi-editor' });
  if (!editorRole) {
    throw new Error('роль Strapi Editor не найдена');
  }
  await roleService.assignPermissions(editorRole.id, EDITOR_PERMISSIONS);
}

type CardSeo = {
  seo_title?: string | null;
  seo_description?: string | null;
  noindex?: boolean;
  og_image?: { id: number } | null;
};

type CardVersion = {
  slug?: string;
  legacy_id?: string;
  institute?: { documentId: string } | null;
  seo?: CardSeo | null;
};

function protectedValues(version: CardVersion) {
  return {
    slug: version.slug,
    legacyId: version.legacy_id,
    institute: version.institute?.documentId ?? null,
    ogImage: version.seo?.og_image?.id ?? null,
    noindex: version.seo?.noindex ?? false,
  };
}

export function registerEditorCardRestrictions(strapi: Core.Strapi): void {
  strapi.documents.use(async (context, next) => {
    const card = editableCards.find(({ subject }) => subject === context.uid);
    if (!card || !['unpublish', 'update', 'publish', 'discardDraft'].includes(context.action)) return next();
    const roles = strapi.requestContext.get()?.state?.user?.roles as { code: string }[] | undefined;
    if (!roles?.some(({ code }) => code === 'strapi-editor') || roles.some(({ code }) => code === 'strapi-super-admin')) {
      return next();
    }
    if (context.action === 'unpublish') {
      throw new errors.ForbiddenError('Редактор может публиковать правки, но не может снять карточку с публикации.');
    }

    const { data, documentId } = context.params as { data?: Record<string, unknown>; documentId?: string };
    const hasSeo = card.update.includes('seo.seo_title');
    const seoTouched = hasSeo && data && Object.prototype.hasOwnProperty.call(data, 'seo');
    if (!documentId || (context.action === 'update' && !seoTouched)) return next();
    const populate = {
      ...(hasSeo ? { seo: { populate: ['og_image'] } } : {}),
      ...(card.read.includes('institute') ? { institute: true } : {}),
    };
    const load = (status: 'draft' | 'published') => strapi.documents(context.uid as never).findOne({
      documentId, status, populate,
    }) as Promise<CardVersion | null>;

    return strapi.db.transaction(async () => {
      const draft = await load('draft');
      if (context.action !== 'update' && draft) {
        // Native publish and discard act on the entire shared draft.
        const published = await load('published');
        if (published && !isDeepStrictEqual(protectedValues(draft), protectedValues(published))) {
          throw new errors.ForbiddenError('В черновике есть изменения защищённых полей. Их должен проверить администратор.');
        }
      } else if (seoTouched && draft?.seo) {
        const seo = data.seo as CardSeo | null;
        // Strapi replaces the component on update. Preserve fields outside this write grant.
        data.seo = {
          seo_title: seo === null ? null : seo.seo_title === undefined ? draft.seo.seo_title : seo.seo_title,
          seo_description: seo === null ? null : seo.seo_description === undefined ? draft.seo.seo_description : seo.seo_description,
          noindex: draft.seo.noindex,
          og_image: draft.seo.og_image?.id ?? null,
        };
      }
      return next();
    });
  });
}
