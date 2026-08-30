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

test('редактор меняет состояние события через поле, не занятое Draft & Publish', () => {
  const scheduleUpdate = find('api::schedule-entry.schedule-entry', 'update');
  assert.ok(scheduleUpdate?.properties?.fields.includes('eventStatus'));
  assert.equal(scheduleUpdate?.properties?.fields.includes('status'), false);
});

test('у программы редактор меняет только признак категории', () => {
  assert.deepEqual(find('api::course-group.course-group', 'update')?.properties, {
    fields: ['is_article_category'],
  });
  assert.equal(find('api::course-group.course-group', 'create'), undefined);
  assert.equal(find('api::course-group.course-group', 'publish'), undefined);
});

test('программы и преподаватели доступны для выбора связей только на чтение', () => {
  assert.ok(find('api::course-group.course-group', 'read'));
  assert.ok(find('api::teacher.teacher', 'read'));
  assert.equal(find('api::teacher.teacher', 'update'), undefined);
});

test('нет удаления, чужих типов и административных действий', () => {
  assert.equal(EDITOR_PERMISSIONS.some((permission) => permission.action === action('delete')), false);
  assert.equal(
    EDITOR_PERMISSIONS.some((permission) =>
      ['api::news-item.news-item', 'api::page.page', 'api::institute.institute'].includes(
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
