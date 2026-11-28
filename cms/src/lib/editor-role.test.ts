import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDITOR_PERMISSIONS,
  syncEditorRolePermissions,
  type EditorPermission,
} from './editor-role.ts';

const action = (name: string) => `plugin::content-manager.explorer.${name}`;
const find = (subject: string, actionName: string): EditorPermission | undefined =>
  EDITOR_PERMISSIONS.find(
    (permission) => permission.subject === subject && permission.action === action(actionName),
  );

test('редактор создаёт, читает, меняет и публикует статьи, семинары и расписание', () => {
  for (const subject of [
    'api::article.article',
    'api::seminar.seminar',
    'api::schedule-entry.schedule-entry',
  ]) {
    for (const actionName of ['create', 'read', 'update', 'publish']) {
      assert.ok(find(subject, actionName), `${subject}: нет ${actionName}`);
    }
  }
});

test('SEO редакторские поля доступны в статье, семинаре и программе', () => {
  for (const subject of ['api::article.article', 'api::seminar.seminar']) {
    const update = find(subject, 'update');
    assert.ok(update, `${subject}: нет update`);
    assert.ok(update.properties?.fields.includes('seo.og_title'));
    assert.ok(update.properties?.fields.includes('seo.og_description'));
  }
  for (const actionName of ['read', 'update']) {
    const fields = find('api::course-group.course-group', actionName)?.properties?.fields ?? [];
    for (const field of ['seo.og_title', 'seo.og_description']) assert.ok(fields.includes(field), `${actionName}: ${field}`);
  }
});

test('редактор меняет состояние события через поле, не занятое Draft & Publish', () => {
  const scheduleUpdate = find('api::schedule-entry.schedule-entry', 'update');
  assert.ok(scheduleUpdate?.properties?.fields.includes('entry_status'));
  assert.equal(scheduleUpdate?.properties?.fields.includes('status'), false);
});

test('изображение расписания доступно редактору, а isEventCollection остаётся закрытым', () => {
  const subject = 'api::schedule-entry.schedule-entry';
  for (const actionName of ['create', 'read', 'update']) {
    const permission = find(subject, actionName);
    assert.ok(permission, `${subject}: нет ${actionName}`);
    assert.ok(
      permission.properties?.fields.includes('image'),
      `${subject}: ${actionName} не разрешает image`,
    );
    assert.equal(
      permission.properties?.fields.includes('isEventCollection'),
      false,
      `${subject}: ${actionName} разрешает isEventCollection`,
    );
  }
});

test('редактор меняет разрешённые поля программ, преподавателей и институтов', () => {
  const expected = {
    'api::course-group.course-group': ['name', 'description', 'image', 'order', 'is_article_category', 'seo.seo_title', 'seo.seo_description', 'seo.og_title', 'seo.og_description'],
    'api::teacher.teacher': ['name', 'trait', 'order', 'photo', 'bio'],
    'api::institute.institute': ['name', 'shortName', 'description', 'image', 'order', 'seo.seo_title', 'seo.seo_description'],
  };
  for (const [subject, fields] of Object.entries(expected)) {
    assert.deepEqual(find(subject, 'update')?.properties?.fields, fields, `${subject} editable fields`);
    for (const actionName of ['read', 'publish']) assert.ok(find(subject, actionName), `${subject}: нет ${actionName}`);
    assert.equal(find(subject, 'create'), undefined, `${subject}: создание закрыто`);
  }
  assert.deepEqual(find('api::course-group.course-group', 'read')?.properties?.fields,
    ['name', 'slug', 'editor_label', 'description', 'image', 'order', 'is_article_category', 'institute', 'seo.seo_title', 'seo.seo_description', 'seo.og_title', 'seo.og_description']);
  assert.deepEqual(find('api::teacher.teacher', 'read')?.properties?.fields,
    ['name', 'slug', 'trait', 'order', 'institute', 'photo', 'bio']);
  assert.deepEqual(find('api::institute.institute', 'read')?.properties?.fields,
    ['name', 'slug', 'shortName', 'description', 'image', 'order', 'seo.seo_title', 'seo.seo_description']);
  for (const subject of Object.keys(expected)) {
    for (const actionName of ['read', 'update']) {
      const fields = find(subject, actionName)?.properties?.fields ?? [];
      for (const forbidden of ['legacy_id', 'seo.og_image']) assert.equal(fields.includes(forbidden), false, `${subject}: ${actionName} exposes ${forbidden}`);
    }
  }
  for (const [subject, forbidden] of [['api::course-group.course-group', 'institute'], ['api::course-group.course-group', 'slug'], ['api::teacher.teacher', 'institute']]) {
    assert.equal(find(subject, 'update')?.properties?.fields?.includes(forbidden), false);
  }
});

test('телефоны доступны редактору только через отдельный endpoint, Page закрыта', () => {
  assert.equal(EDITOR_PERMISSIONS.some((permission) => permission.subject === 'api::page.page'), false);
});

test('нет удаления, чужих типов и административных действий', () => {
  assert.equal(EDITOR_PERMISSIONS.some((permission) => permission.action === action('delete')), false);
  assert.equal(
    EDITOR_PERMISSIONS.some((permission) =>
      ['api::news-item.news-item', 'api::page.page'].includes(
        permission.subject ?? '',
      ),
    ),
    false,
  );
  assert.equal(
    EDITOR_PERMISSIONS.some(
      (permission) =>
        permission.action.includes('role') ||
        permission.action.includes('user') ||
        permission.action.includes('content-type-builder'),
    ),
    false,
  );
});

test('повторный запуск передаёт Strapi полный эталонный набор, удаляющий лишние права', async () => {
  let assigned: EditorPermission[] | undefined;
  const strapi = {
    service(name: string) {
      assert.equal(name, 'admin::role');
      return {
        findOne: async () => ({ id: 7, code: 'strapi-editor' }),
        assignPermissions: async (_roleId: number, permissions: EditorPermission[]) => {
          assigned = permissions;
        },
      };
    },
  };

  await syncEditorRolePermissions(strapi);
  assert.deepEqual(assigned, EDITOR_PERMISSIONS);
  assert.equal(assigned?.some((permission) => permission.action === action('delete')), false);
});
