const ROLE_CODE = 'content-admin';
const ROLE_NAME = 'Администратор контента';

const CONTENT_TYPES = [
  'api::seminar.seminar',
  'api::schedule-entry.schedule-entry',
  'api::course-group.course-group',
  'api::teacher.teacher',
];

const WRITE_TYPES = new Set(['api::seminar.seminar', 'api::schedule-entry.schedule-entry']);

function permissions() {
  const rows = [];
  for (const subject of CONTENT_TYPES) {
    rows.push({ action: 'plugin::content-manager.explorer.read', subject });
    if (!WRITE_TYPES.has(subject)) continue;
    rows.push({ action: 'plugin::content-manager.explorer.create', subject });
    rows.push({ action: 'plugin::content-manager.explorer.update', subject });
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
    role = await roleService.create({
      name: ROLE_NAME,
      code: ROLE_CODE,
      description: 'Создаёт и публикует семинары и проведения. Не является супер-администратором.',
    });
  }
  await roleService.assignPermissions(role.id, permissions());
  await ensureContentAdminUser(strapi, role.id);
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
