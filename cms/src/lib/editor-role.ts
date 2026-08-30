export interface EditorPermission {
  action: string;
  subject?: string;
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
  'publication_date',
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
  'learning_plan',
  'learning_mode',
  'recommendations',
  'image',
  'order',
  'documents_state',
  'documents.document',
  'documents.issuer',
  'documents.prior_education',
  'documents.prior_education_note',
  'documents.outcome',
  'documents.basis',
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
  'city',
  'price',
  'oldPrice',
  'isFree',
  'status',
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

export const EDITOR_PERMISSIONS: EditorPermission[] = [
  ...contentPermissions('api::article.article', articleFields),
  ...contentPermissions('api::seminar.seminar', seminarFields),
  ...contentPermissions('api::schedule-entry.schedule-entry', scheduleFields),
  {
    action: contentAction('read'),
    subject: 'api::course-group.course-group',
    properties: { fields: ['name', 'slug', 'is_article_category'] },
  },
  {
    action: contentAction('update'),
    subject: 'api::course-group.course-group',
    properties: { fields: ['is_article_category'] },
  },
  {
    action: contentAction('read'),
    subject: 'api::teacher.teacher',
    properties: { fields: ['name', 'slug'] },
  },
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
