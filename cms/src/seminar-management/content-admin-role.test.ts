import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureContentAdminRole } from './content-admin-role.ts';

const uid = 'api::schedule-entry.schedule-entry';

function createStrapi({ existingRole, existingPermissions = [], assignmentError = null }) {
  let assigned = null;
  let roleExists = existingRole;
  const role = { id: 17, code: 'content-admin', permissions: structuredClone(existingPermissions) };
  const roleService = {
    findOne: async () => roleExists ? role : null,
    create: async () => { roleExists = true; return role; },
    assignPermissions: async (_roleId, permissions) => {
      assigned = permissions;
      role.permissions = permissions;
      if (assignmentError) throw assignmentError;
    },
  };
  const userService = {
    findOneByEmail: async () => ({ id: 23 }),
  };
  return {
    role,
    get assigned() { return assigned; },
    get roleExists() { return roleExists; },
    strapi: {
      db: {
        transaction: async (action) => {
          const originalRoleExists = roleExists;
          const originalAssigned = assigned;
          const originalPermissions = structuredClone(role.permissions);
          try { return await action({}); }
          catch (error) {
            roleExists = originalRoleExists;
            assigned = originalAssigned;
            role.permissions = originalPermissions;
            throw error;
          }
        },
      },
      service: (name) => ({
        'admin::role': roleService,
        'admin::user': userService,
      })[name],
      contentType: (name) => ({
        uid: name,
        attributes: {
          teachers: { type: 'relation' },
          legacy_id: { type: 'string' },
          name: { type: 'string' },
        },
      }),
      components: {},
    },
  };
}

async function withoutContentAdminCredentials(action) {
  const email = process.env.CONTENT_ADMIN_EMAIL;
  const password = process.env.CONTENT_ADMIN_PASSWORD;
  delete process.env.CONTENT_ADMIN_EMAIL;
  delete process.env.CONTENT_ADMIN_PASSWORD;
  try { await action(); }
  finally {
    if (email === undefined) delete process.env.CONTENT_ADMIN_EMAIL;
    else process.env.CONTENT_ADMIN_EMAIL = email;
    if (password === undefined) delete process.env.CONTENT_ADMIN_PASSWORD;
    else process.env.CONTENT_ADMIN_PASSWORD = password;
  }
}

test('bootstrap leaves an existing content-admin permission graph unchanged', async () => {
  await withoutContentAdminCredentials(async () => {
    const extraGrant = {
      action: 'plugin::content-manager.explorer.update',
      subject: 'api::news-item.news-item',
      conditions: [],
      properties: { fields: ['title'] },
    };
    const scheduleGrant = {
      action: 'plugin::content-manager.explorer.read',
      subject: uid,
      conditions: [],
      properties: { fields: ['teachers'] },
    };
    const context = createStrapi({ existingRole: true, existingPermissions: [extraGrant, scheduleGrant] });

    await ensureContentAdminRole(context.strapi);

    assert.equal(context.assigned, null, 'bootstrap must not reassign grants on an existing role');
    assert.deepEqual(context.role.permissions, [extraGrant, scheduleGrant], 'custom grants and field restrictions remain intact');
  });
});

test('read-only and conditional permissions are unchanged on bootstrap', async () => {
  await withoutContentAdminCredentials(async () => {
    const restrictedGrants = [
      {
        action: 'plugin::content-manager.explorer.read',
        subject: uid,
        conditions: ['admin::is-creator'],
        properties: { fields: ['teachers'] },
      },
      {
        action: 'plugin::content-manager.explorer.update',
        subject: uid,
        conditions: [],
        actionParameters: { scope: 'own' },
        properties: { fields: ['teachers'] },
      },
    ];
    const context = createStrapi({ existingRole: true, existingPermissions: restrictedGrants });

    await ensureContentAdminRole(context.strapi);

    assert.equal(context.assigned, null, 'bootstrap must not add write grants over a read-only or conditional role');
    assert.deepEqual(context.role.permissions, restrictedGrants, 'conditions, action parameters, and field restrictions remain intact');
  });
});

test('a new content-admin role receives only the baseline permissions without legacy_id', async () => {
  await withoutContentAdminCredentials(async () => {
    const context = createStrapi({ existingRole: false });

    await ensureContentAdminRole(context.strapi);

    assert.ok(context.assigned, 'new role must receive its baseline permissions');
    assert.ok(context.assigned.some(({ action, subject }) => action === 'plugin::content-manager.explorer.read' && subject === uid));
    assert.ok(context.assigned.every(({ properties }) => !properties?.fields?.includes('legacy_id')));
  });
});

test('failed baseline assignment rolls back the newly created role and its permissions', async () => {
  await withoutContentAdminCredentials(async () => {
    const assignmentError = new Error('permission assignment failed');
    const context = createStrapi({ existingRole: false, assignmentError });

    await assert.rejects(ensureContentAdminRole(context.strapi), (error) => error === assignmentError);

    assert.equal(context.roleExists, false, 'failed assignment must roll back role creation');
    assert.equal(context.assigned, null, 'failed assignment must roll back permission writes');
  });
});
