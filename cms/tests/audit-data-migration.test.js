import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { auditMigration } from '../scripts/audit-data-migration.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const Database = require('better-sqlite3');
const directory = mkdtempSync(join(tmpdir(), 'ikpk-migration-audit-'));
after(() => rmSync(directory, { recursive: true, force: true }));

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function createFixture(path, linkedTeacherId) {
  const db = new Database(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE teachers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE institutes (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE teachers_institute_lnk (
      teacher_id INTEGER NOT NULL REFERENCES teachers(id),
      institute_id INTEGER NOT NULL REFERENCES institutes(id),
      PRIMARY KEY (teacher_id, institute_id)
    );
    INSERT INTO teachers VALUES (1, 'Teacher A'), (2, 'Teacher B');
    INSERT INTO institutes VALUES (1, 'Institute');
  `);
  db.prepare('INSERT INTO teachers_institute_lnk VALUES (?, 1)').run(linkedTeacherId);
  db.close();
}
function fileFingerprint(path) {
  const parts = [path, `${path}-wal`].map((file) => {
    try { return { file: file.split('/').at(-1), sha256: sha256(require('node:fs').readFileSync(file)) }; }
    catch (error) { if (error.code === 'ENOENT' && file !== path) return { file: file.split('/').at(-1), absent: true }; throw error; }
  });
  return sha256(Buffer.from(JSON.stringify(parts)));
}
function boundReceipt(sourceDbPath, candidateDbPath, plan) {
  return {
    sourceDbPath, candidateDbPath, planSha256: plan.planSha256, steps: [],
    source: { sourceFileFingerprint: fileFingerprint(sourceDbPath) },
    lifecycle: [
      { event: 'closed-load-started', at: new Date(1792101825410).toISOString() },
      { event: 'strapi-load-complete', at: new Date(1792101926810).toISOString() },
    ],
    candidatePostMigrationSha256: sha256(require('node:fs').readFileSync(candidateDbPath)),
    candidatePostMigrationFileFingerprint: fileFingerprint(candidateDbPath),
  };
}
function emptyBoundPlan() {
  const manifestPath = join(directory, `plan-${Math.random()}.json`);
  writeFileSync(manifestPath, '{"version":1,"steps":[]}\n');
  return { manifestPath, planSha256: sha256(readFileSync(manifestPath)), steps: [] };
}

function createScheduleEntryCoreStore(path, value) {
  const db = new Database(path);
  db.exec('CREATE TABLE strapi_core_store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, environment TEXT, tag TEXT)');
  db.prepare('INSERT INTO strapi_core_store_settings (key, value, environment, tag) VALUES (?, ?, ?, ?)')
    .run('plugin_content_manager_configuration_content_types::api::schedule-entry.schedule-entry', JSON.stringify(value), 'default', 'default');
  db.close();
}

function addEmptyMigrationLineage(path, operationId = 'teachers-layout-test') {
  const lineageId = 'a'.repeat(64);
  const sourceSnapshotSha256 = 'b'.repeat(64);
  const sourceSchemaSha256 = 'c'.repeat(64);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ikpk_migration_lineage (singleton, lineage_id, source_snapshot_sha256, source_schema_sha256, created_at);
    CREATE TABLE ikpk_migration_operations (operation_id, lineage_id, source_snapshot_sha256, source_schema_sha256, created_at);
    CREATE TABLE ikpk_data_migration_history (lineage_id, operation_id, step_id, payload_sha256, result_json, completed_at);
  `);
  db.prepare('INSERT INTO ikpk_migration_lineage VALUES (1, ?, ?, ?, ?)').run(lineageId, sourceSnapshotSha256, sourceSchemaSha256, 1);
  db.prepare('INSERT INTO ikpk_migration_operations VALUES (?, ?, ?, ?, ?)')
    .run(operationId, lineageId, sourceSnapshotSha256, sourceSchemaSha256, 1);
  db.close();
  return { lineageId, sourceSnapshotSha256, sourceSchemaSha256, operationId };
}

function scheduleEntryEditorConfiguration() {
  return {
    settings: {},
    metadatas: {
      teachers: {
        edit: { description: '', editable: false, label: 'Преподаватели проведения', mainField: 'name', placeholder: '', visible: false },
        list: { label: 'Преподаватели проведения', searchable: false, sortable: false },
      },
      image: { edit: { label: 'Изображение', description: '', placeholder: '', visible: true, editable: true }, list: { label: 'Изображение', searchable: false, sortable: false } },
      isEventCollection: { edit: { label: 'Исходный флаг коллекции', description: '', placeholder: '', visible: false, editable: false }, list: { label: 'Исходный флаг коллекции', searchable: true, sortable: true } },
      city: { edit: { label: 'Город', visible: true, editable: true }, list: { label: 'Город' } },
    },
    layouts: { edit: [[{ name: 'seminar', size: 6 }], [{ name: 'startAt', size: 6 }], [{ name: 'image', size: 6 }], [{ name: 'city', size: 6 }]] },
  };
}

test('preservation audit allows only the expected teachers editor layout and metadata change', () => {
  const sourceDbPath = join(directory, 'teachers-layout-source.db');
  const candidateDbPath = join(directory, 'teachers-layout-candidate.db');
  const sourceValue = scheduleEntryEditorConfiguration();
  const candidateValue = structuredClone(sourceValue);
  candidateValue.layouts.edit.splice(1, 0, [{ name: 'teachers', size: 6 }]);
  candidateValue.metadatas.teachers.edit = {
    ...candidateValue.metadatas.teachers.edit,
    description: 'Выбор применяется только к этому проведению.',
    editable: true,
    visible: true,
  };
  createScheduleEntryCoreStore(sourceDbPath, sourceValue);
  createScheduleEntryCoreStore(candidateDbPath, candidateValue);
  const plan = emptyBoundPlan();
  const lineage = addEmptyMigrationLineage(candidateDbPath);
  const receipt = boundReceipt(sourceDbPath, candidateDbPath, plan);
  Object.assign(receipt, { operationId: 'teachers-layout-test' });
  Object.assign(receipt.source, { snapshotSha256: lineage.sourceSnapshotSha256, schemaFingerprint: lineage.sourceSchemaSha256 });

  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt });

  assert.equal(report.passed, true, JSON.stringify(report.differences));
});

test('preservation audit still blocks any unrelated change beside the teachers layout update', () => {
  const sourceDbPath = join(directory, 'teachers-layout-negative-source.db');
  const candidateDbPath = join(directory, 'teachers-layout-negative-candidate.db');
  const sourceValue = scheduleEntryEditorConfiguration();
  const candidateValue = structuredClone(sourceValue);
  candidateValue.layouts.edit.splice(1, 0, [{ name: 'teachers', size: 6 }]);
  candidateValue.metadatas.teachers.edit = {
    ...candidateValue.metadatas.teachers.edit,
    description: 'Выбор применяется только к этому проведению.',
    editable: true,
    visible: true,
  };
  candidateValue.metadatas.city.edit.label = 'Непредусмотренное изменение';
  createScheduleEntryCoreStore(sourceDbPath, sourceValue);
  createScheduleEntryCoreStore(candidateDbPath, candidateValue);
  const plan = emptyBoundPlan();
  const lineage = addEmptyMigrationLineage(candidateDbPath);
  const receipt = boundReceipt(sourceDbPath, candidateDbPath, plan);
  Object.assign(receipt, { operationId: 'teachers-layout-test' });
  Object.assign(receipt.source, { snapshotSha256: lineage.sourceSnapshotSha256, schemaFingerprint: lineage.sourceSchemaSha256 });

  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt });

  assert.equal(report.passed, false);
  assert.ok(report.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind === 'core-store-structure-mismatch'));
});

test('blocks relation loss or reassignment when table row counts stay equal', () => {
  const sourceDbPath = join(directory, 'source.db');
  const candidateDbPath = join(directory, 'candidate.db');
  createFixture(sourceDbPath, 1);
  createFixture(candidateDbPath, 2);
  const manifestPath = join(directory, 'plan.json');
  writeFileSync(manifestPath, '{"version":1,"steps":[]}\n');
  const plan = { manifestPath, planSha256: sha256(readFileSync(manifestPath)), steps: [] };
  const receipt = boundReceipt(sourceDbPath, candidateDbPath, plan);

  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt });

  assert.equal(report.passed, false, 'changed relation target must block despite identical row counts');
  assert.ok(report.differences.some(({ table, kind }) => table === 'teachers_institute_lnk' && ['row-content', 'row-added', 'row-removed'].includes(kind)),
    'report should identify the changed relation using private digests');
  assert.doesNotMatch(JSON.stringify(report), /Teacher A|Teacher B|Institute/,
    'private report must not contain sensitive cell values');
});

test('preservation audit distinguishes adjacent 64-bit SQLite integers exactly', () => {
  const sourceDbPath = join(directory, 'wide-source.db');
  const candidateDbPath = join(directory, 'wide-candidate.db');
  for (const [path, value] of [[sourceDbPath, 9007199254740992n], [candidateDbPath, 9007199254740993n]]) {
    const db = new Database(path);
    db.exec('CREATE TABLE identifiers (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO identifiers(id) VALUES (?)').run(value);
    db.close();
  }
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
  assert.equal(report.passed, false);
  assert.ok(report.differences.some(({ table, kind }) => table === 'identifiers' && ['row-content', 'row-added', 'row-removed'].includes(kind)));
});

test('preservation audit notices CHECK, partial-index predicate, and trigger changes', () => {
  const sourceDbPath = join(directory, 'schema-source.db');
  const candidateDbPath = join(directory, 'schema-candidate.db');
  const source = new Database(sourceDbPath);
  source.exec('CREATE TABLE guarded (id INTEGER PRIMARY KEY, value INTEGER CHECK(value > 0)); INSERT INTO guarded VALUES (1, 1); CREATE INDEX guarded_positive ON guarded(value) WHERE value > 0; CREATE TRIGGER guarded_noop AFTER UPDATE ON guarded BEGIN SELECT 1; END;');
  source.close();
  const candidate = new Database(candidateDbPath);
  candidate.exec('CREATE TABLE guarded (id INTEGER PRIMARY KEY, value INTEGER CHECK(value >= 0)); INSERT INTO guarded VALUES (1, 1); CREATE INDEX guarded_positive ON guarded(value) WHERE value >= 0; CREATE TRIGGER guarded_noop AFTER UPDATE ON guarded BEGIN SELECT 2; END;');
  candidate.close();
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
  assert.equal(report.passed, false);
  assert.ok(report.differences.some(({ table, kind }) => table === 'guarded' && kind === 'relation-schema-mismatch'));
});

function createProductionColumnShape(path, { addedColumns = false, promotionType = null, eventCollection = null } = {}) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE promotions (id INTEGER PRIMARY KEY, name varchar(255) NOT NULL${addedColumns ? ', type varchar(255)' : ''});
    CREATE TABLE schedule_entries (id INTEGER PRIMARY KEY, name varchar(255) NOT NULL${addedColumns ? ', is_event_collection boolean' : ''});
    INSERT INTO promotions(id, name${addedColumns ? ', type' : ''}) VALUES (1, 'promotion'${addedColumns ? ', NULL' : ''});
    INSERT INTO schedule_entries(id, name${addedColumns ? ', is_event_collection' : ''}) VALUES (1, 'entry'${addedColumns ? ', NULL' : ''});
    CREATE TABLE strapi_migrations (id INTEGER NOT NULL PRIMARY KEY, name varchar(255), time datetime);
    INSERT INTO strapi_migrations VALUES (1, '5.0.0-02-created-document-id', 1791523597813);
  `);
  if (addedColumns && (promotionType !== null || eventCollection !== null)) {
    db.prepare('UPDATE promotions SET type = ? WHERE id = 1').run(promotionType);
    db.prepare('UPDATE schedule_entries SET is_event_collection = ? WHERE id = 1').run(eventCollection);
  }
  db.close();
}
function addSerializedSchemaRow(path, { addedColumns = false, corruptHash = false } = {}) {
  const sourceColumns = {
    promotions: [{ name: 'id', type: 'increments', unsigned: true }, { name: 'name', type: 'string', notNullable: true }],
    schedule_entries: [{ name: 'id', type: 'increments', unsigned: true }, { name: 'name', type: 'string', notNullable: true }],
  };
  const tables = Object.entries(sourceColumns).map(([name, columns]) => ({ name, columns, indexes: [], foreignKeys: [] }));
  if (addedColumns) {
    tables.find(({ name }) => name === 'promotions').columns.push({ name: 'type', type: 'string', args: [], defaultTo: null, notNullable: false, unsigned: false });
    tables.find(({ name }) => name === 'schedule_entries').columns.push({ name: 'is_event_collection', type: 'boolean', args: [], defaultTo: null, notNullable: false, unsigned: false });
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));
  const schema = JSON.stringify({ version: 1, tables });
  const hash = corruptHash ? '0'.repeat(64) : sha256(Buffer.from(schema));
  const db = new Database(path);
  db.exec('CREATE TABLE strapi_database_schema (id INTEGER PRIMARY KEY, schema TEXT NOT NULL, time INTEGER NOT NULL, hash TEXT NOT NULL)');
  db.prepare('INSERT INTO strapi_database_schema VALUES (?, ?, ?, ?)').run(addedColumns ? 3 : 2, schema, addedColumns ? 200 : 100, hash);
  db.close();
}

test('193 current native history and exact nullable CMS columns are accepted without changing inherited data', () => {
  const sourceDbPath = join(directory, 'production-shape-source.db');
  const candidateDbPath = join(directory, 'production-shape-candidate.db');
  createProductionColumnShape(sourceDbPath);
  createProductionColumnShape(candidateDbPath, { addedColumns: true });
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });

  assert.equal(report.differences.some(({ table, kind }) => table === 'strapi_migrations' && kind === 'unsupported-native-history-schema'), false,
    'Strapi 5.51.2 native history includes the inherited integer id column');
  assert.equal(report.differences.some(({ table, kind }) => table === 'strapi_migrations' && kind === 'existing-history-changed'), false,
    'native migration ids and timestamps must be preserved');
});

test('exact NULL-only promotion and schedule columns are accepted', () => {
  const sourceDbPath = join(directory, 'production-columns-source.db');
  const candidateDbPath = join(directory, 'production-columns-candidate.db');
  createProductionColumnShape(sourceDbPath);
  createProductionColumnShape(candidateDbPath, { addedColumns: true });
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });

  assert.equal(report.differences.some(({ table, kind }) => ['promotions', 'schedule_entries'].includes(table) && kind === 'column-set-mismatch'), false,
    'the two exact current content-type columns must be recognized');
  assert.equal(report.differences.some(({ table, kind }) => ['promotions', 'schedule_entries'].includes(table) && kind === 'row-content'), false,
    'inherited content values must remain unchanged');
  assert.equal(report.differences.some(({ table, kind }) => ['promotions', 'schedule_entries'].includes(table) && kind === 'column-definition-mismatch'), false,
    'added columns must match the observed nullable, no-SQL-default definitions');
});

test('193 content additions must leave pre-existing rows NULL', () => {
  const sourceDbPath = join(directory, 'production-null-source.db');
  const candidateDbPath = join(directory, 'production-nonnull-candidate.db');
  createProductionColumnShape(sourceDbPath);
  createProductionColumnShape(candidateDbPath, { addedColumns: true, promotionType: 'SHOP' });
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });

  assert.equal(report.passed, false, 'existing rows are not backfilled from newly declared defaults');
  assert.ok(report.differences.some(({ table, kind, column }) => table === 'promotions' && kind === 'added-column-value-mismatch' && column === 'type'),
    'the dedicated new-column gate must reject a pre-existing non-NULL value');
});

test('new-column exception does not permit any additional target-table column', () => {
  const sourceDbPath = join(directory, 'production-extra-column-source.db');
  const candidateDbPath = join(directory, 'production-extra-column-candidate.db');
  createProductionColumnShape(sourceDbPath);
  createProductionColumnShape(candidateDbPath, { addedColumns: true });
  const db = new Database(candidateDbPath);
  db.exec('ALTER TABLE promotions ADD COLUMN unplanned_value TEXT');
  db.close();
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });

  assert.equal(report.passed, false);
  assert.ok(report.differences.some(({ table, kind }) => table === 'promotions' && kind === 'column-set-mismatch'));
});

function createConstrainedColumnShape(path, { candidate = false, addedCheck = false } = {}) {
  const db = new Database(path);
  db.exec(`CREATE TABLE admins (id INTEGER PRIMARY KEY);
    CREATE TABLE promotions (id INTEGER PRIMARY KEY, name varchar(255) NULL, author_id INTEGER${candidate ? `, "type" varchar(255) null${addedCheck ? " CHECK(type <> 'x')" : ''}` : ''}, CONSTRAINT promotions_author_fk FOREIGN KEY(author_id) REFERENCES admins(id) ON DELETE SET NULL);
    CREATE TABLE schedule_entries (id INTEGER PRIMARY KEY, name varchar(255) NULL, author_id INTEGER${candidate ? ', "is_event_collection" boolean null' : ''}, CONSTRAINT schedule_author_fk FOREIGN KEY(author_id) REFERENCES admins(id) ON DELETE SET NULL);
    INSERT INTO promotions VALUES (1, 'promotion', NULL${candidate ? ', NULL' : ''});
    INSERT INTO schedule_entries VALUES (1, 'entry', NULL${candidate ? ', NULL' : ''});
    CREATE TABLE strapi_migrations (id INTEGER NOT NULL PRIMARY KEY, name varchar(255), time datetime);
    INSERT INTO strapi_migrations VALUES (1, '5.0.0-02-created-document-id', 1791523597813);`);
  db.close();
}

test('normalizes only the exact nullable added-column fragment before table constraints', () => {
  const sourceDbPath = join(directory, 'constrained-column-source.db');
  const candidateDbPath = join(directory, 'constrained-column-candidate.db');
  createConstrainedColumnShape(sourceDbPath);
  createConstrainedColumnShape(candidateDbPath, { candidate: true });
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
  assert.equal(report.differences.some(({ table, kind }) => ['promotions', 'schedule_entries'].includes(table) && kind === 'relation-schema-mismatch'), false,
    'the exact NULL column fragment may appear before preserved table-level foreign-key constraints');

  const checkedCandidatePath = join(directory, 'constrained-column-check-candidate.db');
  createConstrainedColumnShape(checkedCandidatePath, { candidate: true, addedCheck: true });
  const checked = auditMigration({ sourceDbPath, candidateDbPath: checkedCandidatePath, plan, receipt: boundReceipt(sourceDbPath, checkedCandidatePath, plan) });
  assert.equal(checked.passed, false, 'an added-column CHECK constraint is not covered by the nullable-column exception');
  assert.ok(checked.differences.some(({ table, kind }) => table === 'promotions' && kind === 'relation-schema-mismatch'));
});

test('serialized Strapi schema history accepts only the verified two-column regeneration', () => {
  const sourceDbPath = join(directory, 'schema-history-source.db');
  const candidateDbPath = join(directory, 'schema-history-candidate.db');
  createProductionColumnShape(sourceDbPath);
  createProductionColumnShape(candidateDbPath, { addedColumns: true });
  addSerializedSchemaRow(sourceDbPath);
  addSerializedSchemaRow(candidateDbPath, { addedColumns: true });
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });

  assert.equal(report.differences.some(({ table, kind }) => table === 'strapi_database_schema' && kind === 'schema-snapshot-mismatch'), false,
    'Strapi hash, old schema, and exact new definitions are validated before accepting regenerated history');
});

function createPermissionShape(path, { candidate = false, mutate = null, mutateLinks = null } = {}) {
  const db = new Database(path);
  db.exec(`CREATE TABLE admin_roles (id INTEGER PRIMARY KEY, code TEXT NOT NULL);
    CREATE TABLE admin_permissions (id INTEGER PRIMARY KEY, document_id TEXT, action TEXT NOT NULL, subject TEXT, properties TEXT, conditions TEXT, action_parameters TEXT, created_at INTEGER, updated_at INTEGER, published_at INTEGER);
    CREATE TABLE admin_permissions_role_lnk (id INTEGER PRIMARY KEY, permission_id INTEGER NOT NULL, role_id INTEGER NOT NULL, permission_ord INTEGER);
    INSERT INTO admin_roles VALUES (1, 'strapi-editor'), (2, 'content-admin'), (3, 'strapi-super-admin'), (4, 'strapi-author');`);
  const descriptors = [];
  for (const verb of ['create', 'read', 'update']) {
    for (const role of [
      { id: 1, code: 'strapi-editor', subject: 'api::schedule-entry.schedule-entry', sourceFields: ['startAt'], added: ['image'] },
      { id: 2, code: 'content-admin', subject: 'api::schedule-entry.schedule-entry', sourceFields: ['startAt'], added: ['image', 'isEventCollection'] },
      { id: 3, code: 'strapi-super-admin', subject: 'api::schedule-entry.schedule-entry', sourceFields: ['startAt'], added: ['image', 'isEventCollection'] },
      { id: 3, code: 'strapi-super-admin', subject: 'api::promotion.promotion', sourceFields: ['name'], added: ['type'] },
    ]) descriptors.push({ action: `plugin::content-manager.explorer.${verb}`, ...role, conditions: [], properties: { fields: candidate ? [...role.sourceFields, ...role.added] : role.sourceFields } });
  }
  for (const [index, initial] of descriptors.entries()) {
    let descriptor = { ...initial, roleId: initial.id, properties: { ...initial.properties, fields: [...initial.properties.fields] } };
    if (candidate && mutate) descriptor = mutate(descriptor, index) ?? descriptor;
    const permissionId = (candidate ? 20 : 10) + index;
    const ordinalWithinRole = descriptors.slice(0, index).filter(({ id }) => id === initial.id).length;
    const roleCount = descriptors.filter(({ id }) => id === initial.id).length;
    const permissionOrd = candidate ? roleCount + ordinalWithinRole : ordinalWithinRole;
    const timestamp = candidate ? 1792101826000 + index : 1700000000000 + index;
    db.prepare('INSERT INTO admin_permissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      permissionId, `${candidate ? 'candidate' : 'source'}-doc-${index}`, descriptor.action, descriptor.subject,
      JSON.stringify(descriptor.properties), JSON.stringify(descriptor.conditions), null,
      timestamp, timestamp, timestamp + 1,
    );
    db.prepare('INSERT INTO admin_permissions_role_lnk VALUES (?, ?, ?, ?)').run((candidate ? 40 : 30) + index, permissionId, descriptor.roleId, permissionOrd);
  }
  db.prepare('INSERT INTO admin_permissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(99, 'stable-document', 'plugin::upload.read', null, '{}', '[]', '{"scope":"read"}', 1700000000100, 1700000000100, 1700000000101);
  db.prepare('INSERT INTO admin_permissions_role_lnk VALUES (?, ?, ?, ?)').run(99, 99, 4, 0);
  if (candidate && mutateLinks) mutateLinks(db);
  db.close();
}

test('permission graph accepts exact current fields while permission and link IDs churn', () => {
  const sourceDbPath = join(directory, 'permissions-source.db');
  const candidateDbPath = join(directory, 'permissions-candidate.db');
  createPermissionShape(sourceDbPath);
  createPermissionShape(candidateDbPath, { candidate: true });
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });

  assert.equal(report.differences.some(({ table, kind }) => table === 'admin_permissions' && kind.startsWith('logical-permission-')), false,
    'the semantic role/action/subject/condition graph is stable despite regenerated storage IDs');
  assert.equal(report.differences.some(({ table }) => table === 'admin_permissions_role_lnk'), false,
    'permission relation storage IDs may change only when the linked role graph is unchanged');
  assert.equal(report.transformations.permissionRowsRecreated, 12, 'only the twelve reviewed fieldset changes may recreate rows');
});

test('permission audit accepts an already-current next-release no-op without recreating rows', () => {
  const sourceDbPath = join(directory, 'permissions-noop-source.db');
  const candidateDbPath = join(directory, 'permissions-noop-candidate.db');
  createPermissionShape(sourceDbPath, { candidate: true });
  createPermissionShape(candidateDbPath, { candidate: true });
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
  assert.equal(report.differences.some(({ table }) => table === 'admin_permissions' || table === 'admin_permissions_role_lnk'), false);
  assert.equal(report.transformations.permissionRowsRecreated, 0);
});

test('permission graph rejects unapproved fields, changed conditions, role reassignment, and dangling links', () => {
  const mutations = [
    (permission, index) => index === 0 ? { ...permission, properties: { fields: ['startAt', 'image', 'price'] } } : permission,
    (permission, index) => index === 0 ? { ...permission, conditions: [{ name: 'not-allowed' }] } : permission,
    (permission, index) => index === 0 ? { ...permission, roleId: 99 } : permission,
    (permission, index) => index === 0 ? { ...permission, subject: 'api::promotion.promotion' } : permission,
  ];
  for (const [index, mutate] of mutations.entries()) {
    const sourceDbPath = join(directory, `permissions-negative-source-${index}.db`);
    const candidateDbPath = join(directory, `permissions-negative-candidate-${index}.db`);
    createPermissionShape(sourceDbPath);
    createPermissionShape(candidateDbPath, { candidate: true, mutate });
    const plan = emptyBoundPlan();
    const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
    assert.equal(report.passed, false, `mutation ${index} must block preservation acceptance`);
    assert.ok(report.differences.some(({ table, kind }) => table === 'admin_permissions' && kind.startsWith('logical-permission-')),
      `mutation ${index} should be rejected by logical permission comparison`);
  }
  for (const [index, mutateLinks] of [
    (db) => db.prepare('DELETE FROM admin_permissions_role_lnk WHERE id = 40').run(),
    (db) => db.prepare('INSERT INTO admin_permissions_role_lnk VALUES (999, 20, 1, 0)').run(),
    (db) => db.prepare('UPDATE admin_permissions_role_lnk SET permission_id = 999 WHERE id = 40').run(),
    (db) => db.prepare('UPDATE admin_permissions_role_lnk SET permission_ord = 999 WHERE id = 40').run(),
  ].entries()) {
    const sourceDbPath = join(directory, `permissions-link-source-${index}.db`);
    const candidateDbPath = join(directory, `permissions-link-candidate-${index}.db`);
    createPermissionShape(sourceDbPath);
    createPermissionShape(candidateDbPath, { candidate: true, mutateLinks });
    const plan = emptyBoundPlan();
    const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
    assert.equal(report.passed, false, `link mutation ${index} must block preservation acceptance`);
    assert.ok(report.differences.some(({ table, kind }) => ['admin_permissions', 'admin_permissions_role_lnk'].includes(table)
      && (kind.startsWith('logical-permission-') || kind.startsWith('recreated-permission-'))),
    `link mutation ${index} should be rejected by logical permission comparison`);
  }
  const sourceDbPath = join(directory, 'permissions-action-parameters-source.db');
  const candidateDbPath = join(directory, 'permissions-action-parameters-candidate.db');
  createPermissionShape(sourceDbPath);
  createPermissionShape(candidateDbPath, { candidate: true });
  const db = new Database(candidateDbPath);
  db.prepare('UPDATE admin_permissions SET action_parameters = ? WHERE id = 20').run('{"scope":"changed"}');
  db.close();
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
  assert.equal(report.passed, false, 'permission action_parameters are part of the preserved authorization graph');

  const stableSourcePath = join(directory, 'permissions-stable-metadata-source.db');
  const stableCandidatePath = join(directory, 'permissions-stable-metadata-candidate.db');
  createPermissionShape(stableSourcePath);
  createPermissionShape(stableCandidatePath, { candidate: true });
  const stableDb = new Database(stableCandidatePath);
  stableDb.prepare('UPDATE admin_permissions SET action_parameters = ? WHERE id = 99').run('{"scope":"changed"}');
  stableDb.close();
  const stablePlan = emptyBoundPlan();
  const stableReport = auditMigration({ sourceDbPath: stableSourcePath, candidateDbPath: stableCandidatePath, plan: stablePlan, receipt: boundReceipt(stableSourcePath, stableCandidatePath, stablePlan) });
  assert.equal(stableReport.passed, false, 'unchanged permission descriptors retain all non-ID metadata');

  const documentSourcePath = join(directory, 'permissions-documentid-source.db');
  const documentCandidatePath = join(directory, 'permissions-documentid-candidate.db');
  createPermissionShape(documentSourcePath);
  createPermissionShape(documentCandidatePath, { candidate: true });
  const documentDb = new Database(documentCandidatePath);
  documentDb.prepare('UPDATE admin_permissions SET document_id = ? WHERE id = 20').run('invalid document id');
  documentDb.close();
  const documentPlan = emptyBoundPlan();
  const documentReport = auditMigration({ sourceDbPath: documentSourcePath, candidateDbPath: documentCandidatePath, plan: documentPlan, receipt: boundReceipt(documentSourcePath, documentCandidatePath, documentPlan) });
  assert.equal(documentReport.passed, false, 'regenerated permission document IDs must be safe and unique');

  for (const [name, sql] of [
    ['outside-window', 'UPDATE admin_permissions SET created_at = 1800000000000, updated_at = 1800000000000, published_at = 1800000000000 WHERE id = 20'],
    ['published-before-created', 'UPDATE admin_permissions SET published_at = created_at - 1 WHERE id = 20'],
    ['null-timestamp', 'UPDATE admin_permissions SET updated_at = NULL WHERE id = 20'],
  ]) {
    const timestampSourcePath = join(directory, `permissions-timestamp-${name}-source.db`);
    const timestampCandidatePath = join(directory, `permissions-timestamp-${name}-candidate.db`);
    createPermissionShape(timestampSourcePath);
    createPermissionShape(timestampCandidatePath, { candidate: true });
    const timestampDb = new Database(timestampCandidatePath);
    timestampDb.exec(sql);
    timestampDb.close();
    const timestampPlan = emptyBoundPlan();
    const timestampReport = auditMigration({ sourceDbPath: timestampSourcePath, candidateDbPath: timestampCandidatePath, plan: timestampPlan, receipt: boundReceipt(timestampSourcePath, timestampCandidatePath, timestampPlan) });
    assert.equal(timestampReport.passed, false, `recreated permission timestamp mutation ${name} must be refused`);
    assert.ok(timestampReport.differences.some(({ kind }) => kind.startsWith('invalid-recreated-permission-timestamp')),
      `recreated permission timestamp mutation ${name} must be rejected by the timestamp-specific gate`);
  }
  const noWindowSourcePath = join(directory, 'permissions-timestamp-no-window-source.db');
  const noWindowCandidatePath = join(directory, 'permissions-timestamp-no-window-candidate.db');
  createPermissionShape(noWindowSourcePath);
  createPermissionShape(noWindowCandidatePath, { candidate: true });
  const noWindowPlan = emptyBoundPlan();
  const noWindowReceipt = boundReceipt(noWindowSourcePath, noWindowCandidatePath, noWindowPlan);
  delete noWindowReceipt.lifecycle;
  const noWindowReport = auditMigration({ sourceDbPath: noWindowSourcePath, candidateDbPath: noWindowCandidatePath, plan: noWindowPlan, receipt: noWindowReceipt });
  assert.ok(noWindowReport.differences.some(({ kind }) => kind === 'invalid-recreated-permission-timestamp'),
    'recreated timestamps require a receipt-bound closed-load window');
});

const PROMOTION_CONFIG_KEY = 'plugin_content_manager_configuration_content_types::api::promotion.promotion';
const SCHEDULE_CONFIG_KEY = 'plugin_content_manager_configuration_content_types::api::schedule-entry.schedule-entry';
const SEMINAR_CONFIG_KEY = 'plugin_content_manager_configuration_content_types::api::seminar.seminar';
const ARTICLE_CONFIG_KEY = 'plugin_content_manager_configuration_content_types::api::article.article';
const ARTICLE_FIELD_LABELS = [
  ['title', 'Заголовок', 'Заголовок статьи.'],
  ['slug', 'Адрес страницы', 'Формируется из заголовка при первом сохранении. После сохранения адрес не меняется.'],
  ['body', 'Текст статьи', 'Основной текст статьи на странице.'],
  ['image', 'Изображение', 'Показывается в шапке статьи и карточках каталога.'],
  ['published_date', 'Дата публикации', 'Выберите календарный день по Москве. Новая статья без даты получит день первой публикации; если очистить уже сохранённую дату, останется прежний день.'],
  ['legacy_id', 'Старый идентификатор', ''],
  ['seo', 'SEO', 'Можно не заполнять: сайт возьмёт заголовок из названия статьи, а описание — из её текста после очистки. Если SEO-описание не заполнено и после очистки текста не останется, обновление сайта не состоится; запись в CMS останется опубликованной.'],
  ['categories', 'Категории', ''],
];
const SEMINAR_SEO_DESCRIPTION = 'Можно не заполнять: сайт сам соберёт заголовок и описание из названия семинара, программы и института.';
const CONTENT_SCHEMA_KEY = 'strapi_content_types_schema';
const UPLOAD_METRICS_KEY = 'plugin_upload_metrics';
const METRICS_LOAD_START = 1792101825410;
const METRICS_LOAD_COMPLETE = 1792101926810;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function articleEditorConfiguration() {
  const metadatas = Object.fromEntries(ARTICLE_FIELD_LABELS.map(([name]) => [name, {
    edit: { label: `old-${name}`, description: `Сохранённое описание ${name}.`, placeholder: `placeholder-${name}`, visible: false, editable: false },
    list: { label: `old-${name}`, searchable: false, sortable: true },
  }]));
  metadatas.customField = {
    edit: { label: 'Пользовательское поле', description: 'Оставить как есть.', visible: false, editable: false },
    list: { label: 'Пользовательское поле', searchable: false, sortable: false },
  };
  metadatas.slug.edit.editable = true;
  return {
    settings: { defaultSortBy: 'published_date', defaultSortOrder: 'DESC', retainedSetting: 'keep-me' },
    layouts: { edit: [[{ name: 'title', size: 12 }], [{ name: 'body', size: 12 }]], list: ['title', 'published_date'] },
    metadatas,
    unrelated: { keep: true },
  };
}

function articleLabelsSynced(source) {
  const candidate = structuredClone(source);
  for (const [name, label, description] of ARTICLE_FIELD_LABELS) {
    const existing = candidate.metadatas[name] ?? { edit: {}, list: {} };
    candidate.metadatas[name] = {
      ...existing,
      edit: { ...existing.edit, label, ...(description ? { description } : {}) },
      list: { ...existing.list, label },
    };
  }
  candidate.metadatas.slug.edit.editable = false;
  return candidate;
}

function createArticleCoreStore(path, value, extraRows = []) {
  const db = new Database(path);
  db.exec('CREATE TABLE strapi_core_store_settings (id INTEGER PRIMARY KEY, key TEXT NOT NULL, value TEXT, type TEXT, environment TEXT, tag TEXT)');
  const insert = db.prepare('INSERT INTO strapi_core_store_settings VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(1, ARTICLE_CONFIG_KEY, typeof value === 'string' ? value : JSON.stringify(value), 'object', null, null);
  extraRows.forEach(([key, rowValue], index) => insert.run(index + 2, key, rowValue, 'object', null, null));
  db.close();
}

function articleFormReceipt(sourceDbPath, candidateDbPath, plan) {
  const lineage = addEmptyMigrationLineage(candidateDbPath, 'article-form-test');
  const receipt = boundReceipt(sourceDbPath, candidateDbPath, plan);
  Object.assign(receipt, { operationId: lineage.operationId });
  Object.assign(receipt.source, { snapshotSha256: lineage.sourceSnapshotSha256, schemaFingerprint: lineage.sourceSchemaSha256 });
  return receipt;
}

test('preservation audit accepts only the exact article editor label and description synchronization', () => {
  const sourceDbPath = join(directory, 'article-form-source.db');
  const candidateDbPath = join(directory, 'article-form-candidate.db');
  const source = articleEditorConfiguration();
  createArticleCoreStore(sourceDbPath, source);
  createArticleCoreStore(candidateDbPath, articleLabelsSynced(source));
  const plan = emptyBoundPlan();

  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: articleFormReceipt(sourceDbPath, candidateDbPath, plan) });

  assert.equal(report.passed, true, JSON.stringify(report.differences));
});

test('article label synchronization creates missing edit and list metadata while preserving existing descriptions', () => {
  const sourceDbPath = join(directory, 'article-form-partial-source.db');
  const candidateDbPath = join(directory, 'article-form-partial-candidate.db');
  const source = articleEditorConfiguration();
  delete source.metadatas.legacy_id;
  delete source.metadatas.categories.list;
  createArticleCoreStore(sourceDbPath, source);
  createArticleCoreStore(candidateDbPath, articleLabelsSynced(source));
  const plan = emptyBoundPlan();

  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: articleFormReceipt(sourceDbPath, candidateDbPath, plan) });

  assert.equal(report.passed, true, JSON.stringify(report.differences));
});

test('article label synchronization rejects layout, settings, visibility, editability, unrelated metadata, other keys, and malformed JSON changes', () => {
  const mutateArticle = (mutate) => (values) => {
    const value = articleLabelsSynced(JSON.parse(values.get(ARTICLE_CONFIG_KEY)));
    mutate(value);
    values.set(ARTICLE_CONFIG_KEY, JSON.stringify(value));
  };
  const mutations = [
    ['settings', mutateArticle((value) => { value.settings.defaultSortBy = 'title'; })],
    ['layouts', mutateArticle((value) => { value.layouts.edit[0][0].size = 6; })],
    ['visible', mutateArticle((value) => { value.metadatas.title.edit.visible = true; })],
    ['editable', mutateArticle((value) => { value.metadatas.title.edit.editable = true; })],
    ['slug-remains-editable', mutateArticle((value) => { value.metadatas.slug.edit.editable = true; })],
    ['unrelated-label', mutateArticle((value) => { value.metadatas.body.edit.label = 'Другое поле'; })],
    ['empty-approved-description-changed', mutateArticle((value) => { value.metadatas.legacy_id.edit.description = 'Изменённое сохранённое описание.'; })],
    ['existing-placeholder-changed', mutateArticle((value) => { value.metadatas.title.edit.placeholder = 'Не согласовано'; })],
    ['unrelated-property-changed', mutateArticle((value) => { value.metadatas.title.edit.customProperty = 'Не согласовано'; })],
    ['custom-field-label', mutateArticle((value) => { value.metadatas.customField.edit.label = 'Не согласовано'; })],
    ['missing-edit-metadata', mutateArticle((value) => { delete value.metadatas.title.edit; })],
    ['missing-list-metadata', mutateArticle((value) => { delete value.metadatas.title.list; })],
    ['other-key', (values) => values.set('unrelated-key', JSON.stringify({ preserved: false }))],
    ['malformed-json', (values) => values.set(ARTICLE_CONFIG_KEY, '{not-json')],
  ];
  for (const [name, mutate] of mutations) {
    const sourceDbPath = join(directory, `article-form-negative-${name}-source.db`);
    const candidateDbPath = join(directory, `article-form-negative-${name}-candidate.db`);
    const source = articleEditorConfiguration();
    const candidate = new Map([[ARTICLE_CONFIG_KEY, JSON.stringify(articleLabelsSynced(source))], ['unrelated-key', JSON.stringify({ preserved: true })]]);
    mutate(candidate);
    createArticleCoreStore(sourceDbPath, source, [['unrelated-key', JSON.stringify({ preserved: true })]]);
    createArticleCoreStore(candidateDbPath, candidate.get(ARTICLE_CONFIG_KEY), [['unrelated-key', candidate.get('unrelated-key')]]);
    const plan = emptyBoundPlan();
    const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: articleFormReceipt(sourceDbPath, candidateDbPath, plan) });
    assert.equal(report.passed, false, `${name} must block preservation acceptance`);
    assert.ok(report.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')),
      `${name} must be reported as a core-store preservation difference`);
  }
});

function weeklyCronAt(value) {
  const date = new Date(value);
  return `${date.getUTCSeconds()} ${date.getUTCMinutes()} ${date.getUTCHours()} * * ${date.getUTCDay()}`;
}
function coreStoreValues(candidate) {
  const promotion = {
    layouts: { edit: ['name', 'description', 'date', 'image', 'link'].map((name) => [{ name, size: 6 }]) },
    metadatas: { name: { edit: { label: 'name' }, list: { label: 'name' } } }, settings: { defaultSortBy: 'name' },
  };
  const scheduleFields = ['seminar', 'startAt', 'endAt', 'city', 'price', 'oldPrice', 'isFree', 'entry_status', 'registrationFormLink', 'description', 'additionalText', 'duration'];
  const schedule = {
    layouts: { edit: scheduleFields.map((name) => [{ name, size: 6 }]) },
    metadatas: {
      startAt: { edit: { label: 'startAt' }, list: { label: 'startAt' } },
      teachers: {
        edit: { description: '', editable: false, label: 'Преподаватели проведения', mainField: 'name', placeholder: '', visible: false },
        list: { label: 'Преподаватели проведения', searchable: false, sortable: false },
      },
    },
    settings: { defaultSortBy: 'startAt' },
  };
  const seminar = {
    layouts: { edit: [[{ name: 'name', size: 6 }], [{ name: 'seo', size: 12 }]], list: ['name', 'slug'] },
    metadatas: {
      seo: {
        edit: { label: 'SEO', description: '', placeholder: '', visible: true, editable: true },
        list: { label: 'SEO', searchable: false, sortable: false },
      },
    },
    settings: { mainField: 'name', defaultSortBy: 'name', defaultSortOrder: 'ASC' },
  };
  const schema = {
    'api::promotion.promotion': { attributes: { name: { type: 'string' } }, __schema__: { attributes: { name: { type: 'string' } } } },
    'api::schedule-entry.schedule-entry': { attributes: { startAt: { type: 'datetime' } }, __schema__: { attributes: { startAt: { type: 'datetime' } } } },
  };
  if (candidate) {
    promotion.layouts.edit.push([{ name: 'type', size: 6 }]);
    promotion.metadatas.type = { edit: { label: 'type', description: '', placeholder: '', visible: true, editable: true }, list: { label: 'type', searchable: true, sortable: true } };
    schedule.layouts.edit.splice(scheduleFields.indexOf('city'), 0, [{ name: 'image', size: 6 }]);
    schedule.layouts.edit.splice(1, 0, [{ name: 'teachers', size: 6 }]);
    schedule.metadatas.teachers.edit = {
      ...schedule.metadatas.teachers.edit,
      description: 'Выбор применяется только к этому проведению.',
      editable: true,
      visible: true,
    };
    schedule.metadatas.image = { edit: { label: 'Изображение', description: '', placeholder: '', visible: true, editable: true }, list: { label: 'Изображение', searchable: false, sortable: false } };
    schedule.metadatas.isEventCollection = { edit: { label: 'Исходный флаг коллекции', description: '', placeholder: '', visible: false, editable: false }, list: { label: 'Исходный флаг коллекции', searchable: true, sortable: true } };
    seminar.metadatas.seo.edit.description = SEMINAR_SEO_DESCRIPTION;
    for (const uid of Object.keys(schema)) {
      const fields = uid === 'api::promotion.promotion'
        ? [['type', { type: 'enumeration', enum: ['SHOP', 'INSTITUTE'] }]]
        : [['image', { type: 'media', multiple: false, allowedTypes: ['images'] }], ['isEventCollection', { type: 'boolean', default: false }]];
      for (const [name, definition] of fields) {
        schema[uid].attributes[name] = structuredClone(definition);
        schema[uid].__schema__.attributes[name] = structuredClone(definition);
      }
    }
  }
  return new Map([
    [PROMOTION_CONFIG_KEY, JSON.stringify(promotion)],
    [SCHEDULE_CONFIG_KEY, JSON.stringify(schedule)],
    [SEMINAR_CONFIG_KEY, JSON.stringify(seminar)],
    [CONTENT_SCHEMA_KEY, JSON.stringify(schema)],
    [UPLOAD_METRICS_KEY, JSON.stringify({ lastWeeklyUpdate: METRICS_LOAD_START - WEEK_MS - 1, weeklySchedule: candidate ? weeklyCronAt(METRICS_LOAD_START + 15_000) : '0 0 0 * * 0' })],
    ['unrelated-key', JSON.stringify({ preserved: true })],
  ]);
}
function createCoreStoreShape(path, { candidate = false, mutate = null } = {}) {
  const values = coreStoreValues(candidate);
  if (mutate) mutate(values);
  const db = new Database(path);
  db.exec('CREATE TABLE strapi_core_store_settings (id INTEGER PRIMARY KEY, key TEXT NOT NULL, value TEXT, type TEXT, environment TEXT, tag TEXT)');
  const insert = db.prepare('INSERT INTO strapi_core_store_settings VALUES (?, ?, ?, ?, ?, ?)');
  let id = 1;
  for (const [key, value] of values) insert.run(id++, key, value, 'object', null, null);
  db.close();
}

test('core-store accepts only reviewed content-type updates and a stale upload metrics schedule refresh', () => {
  const sourceDbPath = join(directory, 'core-store-source.db');
  const candidateDbPath = join(directory, 'core-store-candidate.db');
  createCoreStoreShape(sourceDbPath);
  createCoreStoreShape(candidateDbPath, { candidate: true });
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });

  assert.equal(report.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')), false,
    'only exact metadata, layout, compiled content schema additions, and stale upload schedule refresh are allowed');
});

test('upload metrics refresh preserves the timestamp and accepts only the upstream cron inside a closed-load window', () => {
  const runAudit = (name, mutateSource = null, mutateCandidate = null, lifecycle = null) => {
    const sourceDbPath = join(directory, `metrics-source-${name}.db`);
    const candidateDbPath = join(directory, `metrics-candidate-${name}.db`);
    createCoreStoreShape(sourceDbPath, { mutate: mutateSource });
    createCoreStoreShape(candidateDbPath, { candidate: true, mutate: mutateCandidate });
    const plan = emptyBoundPlan();
    const receipt = boundReceipt(sourceDbPath, candidateDbPath, plan);
    if (lifecycle) receipt.lifecycle = lifecycle;
    return auditMigration({ sourceDbPath, candidateDbPath, plan, receipt });
  };
  const metrics = (values) => JSON.parse(values.get(UPLOAD_METRICS_KEY));
  const setMetrics = (values, value) => values.set(UPLOAD_METRICS_KEY, JSON.stringify(value));
  const valid = runAudit('valid');
  assert.equal(valid.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')), false,
    'the exact stale schedule refresh is the only accepted metrics change');

  const invalidCases = [
    ['timestamp-changed', null, (values) => { const row = metrics(values); row.lastWeeklyUpdate += 1; setMetrics(values, row); }],
    ['fresh-source', (values) => { const row = metrics(values); row.lastWeeklyUpdate = METRICS_LOAD_START - WEEK_MS + 1; setMetrics(values, row); }, (values) => { const row = metrics(values); row.lastWeeklyUpdate = METRICS_LOAD_START - WEEK_MS + 1; setMetrics(values, row); }],
    ['extra-field', null, (values) => { const row = metrics(values); row.extra = true; setMetrics(values, row); }],
    ['wrong-scalar', null, (values) => { const row = metrics(values); row.weeklySchedule = 26; setMetrics(values, row); }],
    ['rounded-raw-number', null, (values) => values.set(UPLOAD_METRICS_KEY,
      `{"lastWeeklyUpdate":9007199254740993,"weeklySchedule":"${weeklyCronAt(METRICS_LOAD_START + 15_000)}"}`)],
    ['invalid-cron', null, (values) => { const row = metrics(values); row.weeklySchedule = '0 0 0 * *'; setMetrics(values, row); }],
    ['outside-window', null, (values) => { const row = metrics(values); row.weeklySchedule = weeklyCronAt(METRICS_LOAD_COMPLETE + 16_000); setMetrics(values, row); }],
  ];
  for (const [name, mutateSource, mutateCandidate] of invalidCases) {
    const report = runAudit(name, mutateSource, mutateCandidate);
    assert.ok(report.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')), `${name} must be rejected`);
  }
  const unmatched = runAudit('unmatched-window', null, null, [
    { event: 'closed-load-started', at: new Date(METRICS_LOAD_START).toISOString() },
  ]);
  assert.ok(unmatched.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')),
    'an unmatched closed-load start cannot authorize a metrics change');

  const crossStart = Math.floor(METRICS_LOAD_START / 1000) * 1000 + 900;
  const crossEnd = crossStart + 200;
  const crossSecond = runAudit('cross-second', null, (values) => {
    const row = metrics(values);
    row.weeklySchedule = weeklyCronAt(crossStart + 150 + 15_000);
    setMetrics(values, row);
  }, [
    { event: 'closed-load-started', at: new Date(crossStart).toISOString() },
    { event: 'strapi-load-complete', at: new Date(crossEnd).toISOString() },
  ]);
  assert.equal(crossSecond.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')), false,
    'a cron second containing an in-window producer instant must be accepted across fractional boundaries');

  const exactStart = Math.floor(METRICS_LOAD_START / 1000) * 1000;
  const exactEnd = exactStart + 1000;
  for (const [name, time] of [['before', exactStart + 14_000], ['after', exactEnd + 16_000]]) {
    const report = runAudit(`neighbor-${name}`, null, (values) => {
      const row = metrics(values);
      row.weeklySchedule = weeklyCronAt(time);
      setMetrics(values, row);
    }, [
      { event: 'closed-load-started', at: new Date(exactStart).toISOString() },
      { event: 'strapi-load-complete', at: new Date(exactEnd).toISOString() },
    ]);
    assert.ok(report.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')),
      `the cron one second ${name} the permitted interval must be rejected`);
  }

  const secondStart = METRICS_LOAD_START + 2 * 24 * 60 * 60 * 1000;
  const secondEnd = secondStart + 1000;
  const twoWindows = [
    { event: 'closed-load-started', at: new Date(METRICS_LOAD_START).toISOString() },
    { event: 'strapi-load-complete', at: new Date(METRICS_LOAD_START + 1000).toISOString() },
    { event: 'activation-closed-load-started', at: new Date(secondStart).toISOString() },
    { event: 'strapi-load-complete', at: new Date(secondEnd).toISOString() },
  ];
  const activationWindow = runAudit('activation-window', null, (values) => {
    const row = metrics(values);
    row.weeklySchedule = weeklyCronAt(secondStart + 15_000);
    setMetrics(values, row);
  }, twoWindows);
  assert.equal(activationWindow.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')), false,
    'a schedule matching the second activation closed-load window must be accepted');
  const lifecycleGap = runAudit('lifecycle-gap', null, (values) => {
    const row = metrics(values);
    row.weeklySchedule = weeklyCronAt(METRICS_LOAD_START + 24 * 60 * 60 * 1000 + 15_000);
    setMetrics(values, row);
  }, twoWindows);
  assert.ok(lifecycleGap.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')),
    'a schedule matching only the gap between closed loads must be rejected');
});

test('core-store rejects unapproved key changes, layout changes, and malformed target field definitions', () => {
  const mutations = [
    (values) => values.set('unrelated-key', JSON.stringify({ preserved: false })),
    (values) => values.set(PROMOTION_CONFIG_KEY, JSON.stringify({ ...JSON.parse(values.get(PROMOTION_CONFIG_KEY)), layouts: { edit: [] } })),
    (values) => {
      const schema = JSON.parse(values.get(CONTENT_SCHEMA_KEY));
      schema['api::promotion.promotion'].attributes.type.enum = ['OTHER'];
      values.set(CONTENT_SCHEMA_KEY, JSON.stringify(schema));
    },
    (values) => values.set('unexpected-new-key', '{}'),
    (values) => {
      const seminar = JSON.parse(values.get(SEMINAR_CONFIG_KEY));
      seminar.layouts.edit = [];
      values.set(SEMINAR_CONFIG_KEY, JSON.stringify(seminar));
    },
    (values) => {
      const seminar = JSON.parse(values.get(SEMINAR_CONFIG_KEY));
      seminar.metadatas.seo.edit.description = 'другая подпись';
      values.set(SEMINAR_CONFIG_KEY, JSON.stringify(seminar));
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const sourceDbPath = join(directory, `core-store-negative-source-${index}.db`);
    const candidateDbPath = join(directory, `core-store-negative-candidate-${index}.db`);
    createCoreStoreShape(sourceDbPath);
    createCoreStoreShape(candidateDbPath, { candidate: true, mutate });
    const plan = emptyBoundPlan();
    const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
    assert.equal(report.passed, false, `core-store mutation ${index} must block preservation acceptance`);
    assert.ok(report.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')),
      `core-store mutation ${index} should be rejected by the bounded comparator`);
  }
});

test('core-store table presence and schema constraints remain part of preservation acceptance', () => {
  for (const [name, mutate] of [
    ['missing', (db) => db.exec('DROP TABLE strapi_core_store_settings')],
    ['index', (db) => db.exec('CREATE INDEX unexpected_core_store_index ON strapi_core_store_settings(key)')],
    ['metadata', (db) => db.prepare('UPDATE strapi_core_store_settings SET type = ? WHERE key = ?').run('unexpected', PROMOTION_CONFIG_KEY)],
  ]) {
    const sourceDbPath = join(directory, `core-store-schema-source-${name}.db`);
    const candidateDbPath = join(directory, `core-store-schema-candidate-${name}.db`);
    createCoreStoreShape(sourceDbPath);
    createCoreStoreShape(candidateDbPath, { candidate: true });
    const db = new Database(candidateDbPath);
    mutate(db);
    db.close();
    const plan = emptyBoundPlan();
    const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
    assert.equal(report.passed, false, `core-store ${name} drift must block acceptance`);
    assert.ok(report.differences.some(({ table }) => table === 'strapi_core_store_settings'));
  }
});

function createProgramLabelShape(path, { added = false, label = 'Институт — Специализированные' } = {}) {
  const db = new Database(path);
  const column = added ? ', editor_label varchar(255)' : '';
  const value = added ? `, '${label}'` : '';
  db.exec(`
    CREATE TABLE institutes (id INTEGER PRIMARY KEY, name varchar(255) NOT NULL);
    CREATE TABLE course_groups (id INTEGER PRIMARY KEY, name varchar(255) NOT NULL${column});
    CREATE TABLE course_groups_institute_lnk (id INTEGER PRIMARY KEY, course_group_id INTEGER NOT NULL, institute_id INTEGER NOT NULL);
    INSERT INTO institutes VALUES (1, 'Институт');
    INSERT INTO course_groups VALUES (1, 'Специализированные'${value});
    INSERT INTO course_groups_institute_lnk VALUES (1, 1, 1);
  `);
  db.close();
}

test('program editor labels are accepted only when they name the institute and the program', () => {
  const sourceDbPath = join(directory, 'program-label-source.db');
  const candidateDbPath = join(directory, 'program-label-candidate.db');
  createProgramLabelShape(sourceDbPath);
  createProgramLabelShape(candidateDbPath, { added: true });
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
  assert.equal(report.differences.some(({ table, kind }) => table === 'course_groups' && ['column-set-mismatch', 'added-column-value-mismatch', 'row-content'].includes(kind)), false,
    'the nullable editor label filled from the institute and program name is the accepted addition');

  const wrongPath = join(directory, 'program-label-wrong.db');
  createProgramLabelShape(wrongPath, { added: true, label: 'Специализированные' });
  const wrong = auditMigration({ sourceDbPath, candidateDbPath: wrongPath, plan, receipt: boundReceipt(sourceDbPath, wrongPath, plan) });
  assert.equal(wrong.passed, false);
  assert.ok(wrong.differences.some(({ table, kind, column }) => table === 'course_groups' && kind === 'added-column-value-mismatch' && column === 'editor_label'));
});

function insertProgramPermission(db, { id, documentId, roleId, action, fields, ordinal, timestamp, linkId }) {
  db.prepare('INSERT INTO admin_permissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, documentId, action, 'api::course-group.course-group',
    JSON.stringify({ fields }), '[]', null, timestamp, timestamp, timestamp,
  );
  db.prepare('INSERT INTO admin_permissions_role_lnk VALUES (?, ?, ?, ?)').run(linkId, id, roleId, ordinal);
}

test('program editor label recreates the four full-list permissions and updates content-admin in place', () => {
  const sourceDbPath = join(directory, 'program-permission-source.db');
  const candidateDbPath = join(directory, 'program-permission-candidate.db');
  const baseFields = ['name', 'slug'];
  const editorFields = ['name', 'slug', 'is_article_category'];
  for (const [path, candidate] of [[sourceDbPath, false], [candidateDbPath, true]]) {
    const db = new Database(path);
    db.exec(`CREATE TABLE admin_roles (id INTEGER PRIMARY KEY, code TEXT NOT NULL);
      CREATE TABLE admin_permissions (id INTEGER PRIMARY KEY, document_id TEXT, action TEXT NOT NULL, subject TEXT, properties TEXT, conditions TEXT, action_parameters TEXT, created_at INTEGER, updated_at INTEGER, published_at INTEGER);
      CREATE TABLE admin_permissions_role_lnk (id INTEGER PRIMARY KEY, permission_id INTEGER NOT NULL, role_id INTEGER NOT NULL, permission_ord INTEGER);
      INSERT INTO admin_roles VALUES (1, 'strapi-editor'), (2, 'content-admin'), (3, 'strapi-super-admin');`);
    const stamp = candidate ? 1792101826000 : 1700000000000;
    insertProgramPermission(db, {
      id: 1, documentId: 'content-admin-read', roleId: 2, linkId: 1, ordinal: 0, timestamp: candidate ? stamp : 1700000000000,
      action: 'plugin::content-manager.explorer.read',
      fields: [...baseFields, ...(candidate ? ['editor_label'] : [])],
    });
    if (candidate) db.prepare('UPDATE admin_permissions SET created_at = ?, published_at = ? WHERE id = 1').run(1700000000000, 1700000000000);
    const verbs = [
      ['strapi-editor', 1, 'plugin::content-manager.explorer.read', editorFields],
      ['strapi-super-admin', 3, 'plugin::content-manager.explorer.create', baseFields],
      ['strapi-super-admin', 3, 'plugin::content-manager.explorer.read', baseFields],
      ['strapi-super-admin', 3, 'plugin::content-manager.explorer.update', baseFields],
    ];
    verbs.forEach(([role, roleId, action, fields], index) => {
      const sourceOrdinal = role === 'strapi-editor' ? 0 : index - 1;
      insertProgramPermission(db, {
        id: candidate ? 20 + index : 2 + index,
        documentId: `${candidate ? 'next' : 'source'}-${index}`,
        roleId, linkId: candidate ? 20 + index : 2 + index,
        ordinal: candidate ? (role === 'strapi-editor' ? 1 : 2 + index) : sourceOrdinal,
        timestamp: stamp + index,
        action,
        fields: [...fields, ...(candidate ? ['editor_label'] : [])],
      });
    });
    db.close();
  }
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
  assert.equal(report.differences.some(({ table }) => table === 'admin_permissions' || table === 'admin_permissions_role_lnk'), false,
    'editor and super-admin rows may be recreated, while content-admin keeps its id');
  assert.equal(report.transformations.permissionRowsRecreated, 4);

  const movedPath = join(directory, 'program-permission-moved.db');
  copyFileSync(candidateDbPath, movedPath);
  const movedDb = new Database(movedPath);
  movedDb.prepare('UPDATE admin_permissions SET id = 99 WHERE id = 1').run();
  movedDb.prepare('UPDATE admin_permissions_role_lnk SET permission_id = 99 WHERE permission_id = 1').run();
  movedDb.close();
  const movedReport = auditMigration({ sourceDbPath, candidateDbPath: movedPath, plan, receipt: boundReceipt(sourceDbPath, movedPath, plan) });
  assert.ok(movedReport.differences.some(({ kind }) => kind === 'in-place-permission-identity-changed' || kind === 'logical-permission-removed'));
});

test('program editor configuration, institute relation and schema display name are the accepted core-store changes', () => {
  const courseGroup = {
    uid: 'api::course-group.course-group',
    settings: { mainField: 'name', defaultSortBy: 'name', defaultSortOrder: 'ASC', pageSize: 10 },
    layouts: { list: ['id', 'name'], edit: [[{ name: 'name', size: 6 }]] },
    metadatas: {
      name: { edit: { label: 'name', description: '', placeholder: '', visible: true, editable: true }, list: { label: 'name', searchable: true, sortable: true } },
      slug: { edit: { label: 'slug', description: '', placeholder: '', visible: true, editable: true }, list: { label: 'slug', searchable: true, sortable: true } },
      legacy_id: { edit: { label: 'legacy_id', description: '', placeholder: '', visible: true, editable: true }, list: { label: 'legacy_id', searchable: true, sortable: true } },
    },
  };
  const institute = {
    uid: 'api::institute.institute',
    settings: { mainField: 'name' },
    layouts: { list: ['name'], edit: [[{ name: 'course_groups', size: 6 }]] },
    metadatas: {
      course_groups: { edit: { label: 'course_groups', description: '', mainField: 'name', visible: true, editable: true }, list: { label: 'course_groups', searchable: false, sortable: false } },
    },
  };
  const seminar = {
    settings: { mainField: 'name' },
    layouts: { list: ['name'], edit: [[{ name: 'course_group', size: 6 }]] },
    metadatas: {
      seo: { edit: { label: 'SEO', description: SEMINAR_SEO_DESCRIPTION, placeholder: '', visible: true, editable: true }, list: { label: 'SEO', searchable: false, sortable: false } },
      course_group: { edit: { label: 'Программа', description: '', placeholder: '', visible: true, editable: true, mainField: 'name' }, list: { label: 'Программа', searchable: true, sortable: true } },
    },
  };
  const schema = {
    'api::course-group.course-group': {
      info: { displayName: 'Course Group', description: 'Group of courses/seminars within an institute' },
      attributes: { name: { type: 'string', required: false } },
      __schema__: {
        info: { displayName: 'Course Group', description: 'Group of courses/seminars within an institute' },
        attributes: { name: { type: 'string', required: false } },
      },
    },
  };
  const courseGroupKey = 'plugin_content_manager_configuration_content_types::api::course-group.course-group';
  const instituteKey = 'plugin_content_manager_configuration_content_types::api::institute.institute';
  const write = (path, candidate) => {
    const db = new Database(path);
    db.exec('CREATE TABLE strapi_core_store_settings (id INTEGER PRIMARY KEY, key TEXT NOT NULL, value TEXT, type TEXT, environment TEXT, tag TEXT)');
    const insert = db.prepare('INSERT INTO strapi_core_store_settings VALUES (?, ?, ?, ?, ?, ?)');
    const nextCourseGroup = structuredClone(courseGroup);
    const nextInstitute = structuredClone(institute);
    const nextSeminar = structuredClone(seminar);
    const nextSchema = structuredClone(schema);
    if (candidate) {
      nextCourseGroup.settings.mainField = 'editor_label';
      nextCourseGroup.layouts.list = ['editor_label', 'name'];
      nextCourseGroup.layouts.edit = [
        [{ name: 'name', size: 6 }], [{ name: 'slug', size: 6 }], [{ name: 'description', size: 12 }],
        [{ name: 'image', size: 6 }], [{ name: 'institute', size: 6 }], [{ name: 'seminars', size: 12 }],
        [{ name: 'seo', size: 12 }], [{ name: 'order', size: 4 }], [{ name: 'is_article_category', size: 6 }],
      ];
      nextCourseGroup.metadatas.name.edit.label = 'Название';
      nextCourseGroup.metadatas.name.list.label = 'Название';
      nextCourseGroup.metadatas.slug.edit = { ...nextCourseGroup.metadatas.slug.edit, label: 'Адрес', description: 'Создаётся из названия. Уже заданный адрес сам не меняется.', editable: false };
      nextCourseGroup.metadatas.slug.list.label = 'Адрес';
      nextCourseGroup.metadatas.legacy_id.edit = { ...nextCourseGroup.metadatas.legacy_id.edit, label: 'Старый идентификатор', visible: false, editable: false };
      nextCourseGroup.metadatas.legacy_id.list.label = 'Старый идентификатор';
      for (const [name, label, editable, description] of [
        ['description', 'Описание', true, ''], ['image', 'Изображение', true, ''], ['institute', 'Институт', true, ''],
        ['seminars', 'Семинары', true, ''], ['seo', 'SEO', true, ''], ['order', 'Порядок', true, ''],
        ['is_article_category', 'Категория статей', true, ''],
      ]) {
        nextCourseGroup.metadatas[name] = { edit: { label, description, visible: true, editable }, list: { label } };
      }
      nextCourseGroup.metadatas.editor_label = {
        edit: { label: 'editor_label', description: '', placeholder: '', visible: false, editable: false },
        list: { label: 'editor_label', searchable: true, sortable: true },
      };
      nextInstitute.metadatas.course_groups.edit.label = 'Программы';
      nextInstitute.metadatas.course_groups.edit.mainField = 'editor_label';
      nextInstitute.metadatas.course_groups.list.label = 'Программы';
      nextSeminar.metadatas.course_group.edit.mainField = 'editor_label';
      const contentType = nextSchema['api::course-group.course-group'];
      contentType.info.displayName = 'Программа';
      contentType.info.description = 'Программа одного института';
      contentType.__schema__.info.displayName = 'Программа';
      contentType.__schema__.info.description = 'Программа одного института';
      contentType.attributes.editor_label = { type: 'string' };
      contentType.__schema__.attributes.editor_label = { type: 'string' };
    }
    insert.run(1, courseGroupKey, JSON.stringify(nextCourseGroup), 'object', null, null);
    insert.run(2, instituteKey, JSON.stringify(nextInstitute), 'object', null, null);
    insert.run(3, SEMINAR_CONFIG_KEY, JSON.stringify(nextSeminar), 'object', null, null);
    insert.run(4, CONTENT_SCHEMA_KEY, JSON.stringify(nextSchema), 'object', null, null);
    db.close();
  };
  const sourceDbPath = join(directory, 'program-config-source.db');
  const candidateDbPath = join(directory, 'program-config-candidate.db');
  write(sourceDbPath, false);
  write(candidateDbPath, true);
  const plan = emptyBoundPlan();
  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: boundReceipt(sourceDbPath, candidateDbPath, plan) });
  assert.equal(report.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind.startsWith('core-store-')), false,
    'the program picker label is the only accepted content-manager and schema change');
});
