import assert from 'node:assert/strict';
import test from 'node:test';
import * as roleModule from './content-admin-role.ts';

const seminar = 'api::seminar.seminar';
const schedule = 'api::schedule-entry.schedule-entry';
const action = (verb) => `plugin::content-manager.explorer.${verb}`;
// Complete pre-change sets for this fixture; a familiar field alone is not
// evidence that an intentionally restricted permission is a baseline grant.
const models = {
  [seminar]: ['name', 'description', 'course_group', 'teachers'],
  [schedule]: ['name', 'city', 'isFree', 'duration', 'seminar'],
  'api::course-group.course-group': ['name'],
  'api::teacher.teacher': ['name'],
};

async function fixture() {
  let role = null;
  let assignments = 0;
  let writes = 0;
  let upgraded = false;
  const rows = [];
  const ledger = [];
  const trx = { ledger };
  const roleService = {
    findOne: async () => role,
    create: async () => (role = { id: 17, code: 'content-admin', permissions: rows }),
    assignPermissions: async (_id, permissions) => {
      assignments++;
      rows.splice(0, rows.length, ...structuredClone(permissions).map((row, i) => ({ ...row, id: i + 1, role: 17 })));
    },
  };
  const permissions = {
    findMany: async () => structuredClone(rows),
    findOne: async ({ where }) => structuredClone(rows.find((row) => row.id === where.id) ?? null),
    update: async ({ where, data }) => {
      const row = rows.find((item) => item.id === where.id);
      assert.ok(row, `unexpected permission ${where.id}`);
      writes++;
      Object.assign(row, structuredClone(data));
      return structuredClone(row);
    },
  };
  const strapi = {
    db: {
      transaction: async (callback) => {
        const before = structuredClone(rows), ledgerBefore = structuredClone(ledger);
        try { return await callback({ trx }); }
        catch (error) { rows.splice(0, rows.length, ...before); ledger.splice(0, ledger.length, ...ledgerBefore); throw error; }
      },
      query: (uid) => { assert.equal(uid, 'admin::permission'); return permissions; },
    },
    service: (uid) => ({ 'admin::role': roleService, 'admin::user': {} })[uid],
    contentType: (uid) => ({ uid, attributes: Object.fromEntries([...models[uid], ...(upgraded && uid === seminar ? ['duration'] : []), ...(upgraded && uid === schedule ? ['isOnline'] : [])].map((field) => [field, { type: 'string' }])) }),
    components: {},
  };
  const email = process.env.CONTENT_ADMIN_EMAIL;
  const password = process.env.CONTENT_ADMIN_PASSWORD;
  delete process.env.CONTENT_ADMIN_EMAIL;
  delete process.env.CONTENT_ADMIN_PASSWORD;
  try { await roleModule.ensureContentAdminRole(strapi); }
  finally {
    if (email === undefined) delete process.env.CONTENT_ADMIN_EMAIL; else process.env.CONTENT_ADMIN_EMAIL = email;
    if (password === undefined) delete process.env.CONTENT_ADMIN_PASSWORD; else process.env.CONTENT_ADMIN_PASSWORD = password;
  }
  upgraded = true;
  return { strapi, rows, trx, ledger, get assignments() { return assignments; }, get writes() { return writes; } };
}

async function migrate(strapi) {
  assert.equal(typeof roleModule.migrateContentAdminSchemaPermissions, 'function', 'an explicit migration entry point is required');
  await roleModule.migrateContentAdminSchemaPermissions(strapi);
}

test('explicit migration extends baseline field grants in place and is idempotent', async () => {
  const context = await fixture();
  const conditional = context.rows.find((row) => row.subject === seminar && row.action === action('read'));
  conditional.conditions = ['admin::is-creator'];
  conditional.actionParameters = { scope: 'own' };
  context.rows.push({ id: 99, role: 17, action: action('update'), subject: 'api::news-item.news-item', conditions: [], properties: { fields: ['title'] } });
  const before = structuredClone(context.rows);

  await migrate(context.strapi);

  const expected = structuredClone(before);
  for (const row of expected) {
    if (!['read', 'create', 'update'].some((verb) => row.action === action(verb))) continue;
    if (row.subject === seminar) row.properties.fields.push('duration');
    if (row.subject === schedule) row.properties.fields.push('isOnline');
  }
  assert.deepEqual(context.rows, expected, 'only the new fields may be added to qualifying grants');
  assert.equal(context.assignments, 1, 'migration must not replace the permission graph via assignPermissions');
  const writesAfterFirstRun = context.writes;
  await migrate(context.strapi);
  assert.deepEqual(context.rows, expected, 'a repeated migration must not duplicate fields or modify other permissions');
  assert.equal(context.writes, writesAfterFirstRun, 'a repeated migration must not write again');
});

test('migration preserves intentional field and action restrictions', async () => {
  const context = await fixture();
  const restricted = context.rows.find((row) => row.subject === seminar && row.action === action('update'));
  restricted.properties.fields = ['name'];
  const scheduleCreateIndex = context.rows.findIndex((row) => row.subject === schedule && row.action === action('create'));
  context.rows.splice(scheduleCreateIndex, 1);
  const restrictedSchedule = context.rows.find((row) => row.subject === schedule && row.action === action('update'));
  restrictedSchedule.properties.fields = ['name', 'isFree'];
  const before = structuredClone(context.rows);

  await migrate(context.strapi);

  assert.deepEqual(context.rows.find((row) => row.id === restricted.id), before.find((row) => row.id === restricted.id));
  assert.deepEqual(context.rows.find((row) => row.id === restrictedSchedule.id), before.find((row) => row.id === restrictedSchedule.id));
  assert.ok(!context.rows.some((row) => row.subject === schedule && row.action === action('create')), 'missing create grant must stay missing');
  assert.equal(context.assignments, 1, 'migration must not replace the graph');
});

test('runner callback uses the same transaction and failure rolls back permissions and ledger', async () => {
  const c = await fixture(), before = structuredClone(c.rows);
  await assert.rejects(roleModule.migrateContentAdminSchemaPermissions(c.strapi, { onApplied: async (trx, result) => {
    assert.equal(trx, c.trx); assert.equal(result.updatedRows, 6);
    trx.ledger.push('step'); throw new Error('injected ledger failure');
  }}), /injected ledger failure/);
  assert.deepEqual(c.rows, before); assert.deepEqual(c.ledger, []);
  const result = await roleModule.migrateContentAdminSchemaPermissions(c.strapi, { onApplied: async (trx) => trx.ledger.push('step') });
  assert.equal(result.updatedRows, 6); assert.deepEqual(c.ledger, ['step']);
});
