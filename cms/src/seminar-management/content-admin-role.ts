import { contentTypes as contentTypeUtils } from '@strapi/utils';

const ROLE_CODE = 'content-admin';
const ROLE_NAME = 'Администратор контента';

const CONTENT_TYPES = [
  'api::seminar.seminar',
  'api::schedule-entry.schedule-entry',
  'api::course-group.course-group',
  'api::teacher.teacher',
];

const WRITE_TYPES = new Set(['api::seminar.seminar', 'api::schedule-entry.schedule-entry']);

function authorizableFields(model, components, prefix = '') {
  const hidden = new Set(contentTypeUtils.getNonVisibleAttributes(model));
  const fields = [];
  const attributes = model.attributes ?? {};
  for (const name of Object.keys(attributes)) {
    const attribute = attributes[name];
    if (hidden.has(name) || name === 'legacy_id' || name === 'content_format' || name === 'content_section_anchors') continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (attribute.type === 'component') {
      const children = authorizableFields(components[attribute.component], components, path);
      fields.push(...(children.length ? children : [path]));
      continue;
    }
    fields.push(path);
  }
  return fields;
}

function permissions(strapi) {
  const rows = [];
  for (const subject of CONTENT_TYPES) {
    const fields = authorizableFields(strapi.contentType(subject), strapi.components);
    const withFields = () => ({ fields: [...fields] });
    rows.push({ action: 'plugin::content-manager.explorer.read', subject, properties: withFields() });
    if (!WRITE_TYPES.has(subject)) continue;
    rows.push({ action: 'plugin::content-manager.explorer.create', subject, properties: withFields() });
    rows.push({ action: 'plugin::content-manager.explorer.update', subject, properties: withFields() });
    rows.push({ action: 'plugin::content-manager.explorer.publish', subject });
  }
  rows.push({ action: 'plugin::upload.read' });
  rows.push({ action: 'plugin::upload.assets.create' });
  rows.push({ action: 'plugin::upload.assets.update' });
  rows.push({ action: 'plugin::upload.assets.download' });
  rows.push({ action: 'plugin::upload.assets.copy-link' });
  return rows;
}

export async function ensureContentAdminRole(strapi) {
  const roleService = strapi.service('admin::role');
  let role = await roleService.findOne({ code: ROLE_CODE });
  if (!role) {
    role = await strapi.db.transaction(async () => {
      const created = await roleService.create({
        name: ROLE_NAME,
        code: ROLE_CODE,
        description: 'Создаёт и публикует семинары и проведения. Не является супер-администратором.',
      });
      await roleService.assignPermissions(created.id, permissions(strapi));
      return created;
    });
  }
  await ensureContentAdminUser(strapi, role.id);
}

// Explicit data migration: do not broaden customized roles on ordinary startup.
// Knex's transaction is supplied by Strapi, while tests provide a transactional mock.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateContentAdminSchemaPermissions(strapi, { onApplied }: { onApplied?: (trx: any, result: { updatedRows: number }) => Promise<void> | void } = {}) {
  if (onApplied !== undefined && typeof onApplied !== 'function') throw new Error('onApplied must be a function');
  const role = await strapi.service('admin::role').findOne({ code: ROLE_CODE });
  const additions = {
    'api::seminar.seminar': [
      'duration', 'audience', 'documents.document_type_unspecified', 'documents.issuer_unknown', 'documents.completion_scope', 'documents.completion_cycle_name', 'documents.completion_required', 'documents.completion_after_seminar_number', 'documents.other_seminar_href', 'documents.other_seminar_label',
      'documents.signed_by', 'documents.qualification_topic', 'documents.hours_mode', 'documents.hours_may_vary', 'documents.regulation_url', 'documents.regulation_issuer', 'documents.document_on_template', 'documents.includes_completed_level',
      'documents.registry.name', 'documents.registry.international', 'documents.registry.subject', 'documents.registry.url', 'documents.registry.basis',
      'training_registries.name', 'training_registries.international', 'training_registries.subject', 'training_registries.url', 'training_registries.basis',
      'nmo.status', 'nmo.audience', 'nmo.awarded_for', 'nmo.completion_required', 'nmo.purpose', 'nmo.url', 'documents_owner_verified',
    ],
    'api::schedule-entry.schedule-entry': ['isOnline'],
  };
  return strapi.db.transaction(async ({ trx }) => {
    let updatedRows = 0;
    const query = strapi.db.query('admin::permission');
    const rows = role ? await query.findMany({ where: { role: { id: role.id } } }) : [];
    for (const row of rows) {
      const available = additions[row.subject];
      if (!available || !['read', 'create', 'update'].some((verb) => row.action === `plugin::content-manager.explorer.${verb}`)) continue;
      const fields = row.properties?.fields;
      if (!Array.isArray(fields)) continue;
      const modelFields = authorizableFields(strapi.contentType(row.subject), strapi.components);
      const newFields = available.filter((field) => modelFields.includes(field) && !fields.includes(field));
      if (newFields.length === 0) continue;
      const baseline = modelFields.filter((name) => !available.includes(name));
      if (!baseline.every((name) => fields.includes(name))) continue;
      await query.update({ where: { id: row.id }, data: { properties: { ...row.properties, fields: [...fields, ...newFields] } } });
      updatedRows++;
    }
    const result = { updatedRows };
    await onApplied?.(trx, result);
    return result;
  });
}

async function ensureContentAdminUser(strapi, roleId) {
  const email = process.env.CONTENT_ADMIN_EMAIL?.trim();
  const password = process.env.CONTENT_ADMIN_PASSWORD;
  if (!email || !password) return;
  const users = strapi.service('admin::user');
  const existing = await users.findOneByEmail(email);
  if (existing) return;
  await users.create({
    email,
    firstname: 'Администратор',
    lastname: 'контента',
    password,
    isActive: true,
    preferedLanguage: 'ru',
    roles: [roleId],
  });
  strapi.log.info('Создана учётная запись администратора контента. Пароль в журнал не пишется.');
}
