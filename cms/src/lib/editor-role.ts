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

export function registerEditorCardRestrictions(strapi: Core.Strapi): void {
  strapi.documents.use(async (context, next) => {
    const card = editableCards.find(({ subject }) => subject === context.uid);
    if (!card || !['unpublish', 'update'].includes(context.action)) return next();
    const roles = strapi.requestContext.get()?.state?.user?.roles as { code: string }[] | undefined;
    if (!roles?.some(({ code }) => code === 'strapi-editor') || roles.some(({ code }) => code === 'strapi-super-admin')) {
      return next();
    }
    if (context.action === 'unpublish') {
      throw new errors.ForbiddenError('Редактор может публиковать правки, но не может снять карточку с публикации.');
    }

    const { data, documentId } = context.params as { data?: Record<string, unknown>; documentId?: string };
    if (documentId && data && Object.prototype.hasOwnProperty.call(data, 'seo') && card.update.includes('seo.seo_title')) {
      // Strapi replaces the component on update. Keep fields outside this role's write grant.
      const draft = await strapi.documents(context.uid as never).findOne({
        documentId,
        status: 'draft',
        populate: { seo: { populate: ['og_image'] } },
      }) as { seo?: { seo_title?: string; seo_description?: string; noindex?: boolean; og_image?: { id: number } | null } | null } | null;
      if (draft?.seo) {
        const seo = data.seo as { seo_title?: string; seo_description?: string } | null;
        data.seo = {
          seo_title: seo === null || 'seo_title' in seo ? seo?.seo_title ?? null : draft.seo.seo_title,
          seo_description: seo === null || 'seo_description' in seo ? seo?.seo_description ?? null : draft.seo.seo_description,
          noindex: draft.seo.noindex,
          og_image: draft.seo.og_image?.id ?? null,
        };
      }
    }
    return next();
  });
}
