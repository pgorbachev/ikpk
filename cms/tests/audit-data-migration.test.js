import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const CONTENT_SCHEMA_KEY = 'strapi_content_types_schema';
const UPLOAD_METRICS_KEY = 'plugin_upload_metrics';
const METRICS_LOAD_START = 1792101825410;
const METRICS_LOAD_COMPLETE = 1792101926810;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function weeklyCronAt(value) {
  const date = new Date(value);
  return `${date.getUTCSeconds()} ${date.getUTCMinutes()} ${date.getUTCHours()} * * ${date.getUTCDay()}`;
}
function coreStoreValues(candidate) {
  const promotion = {
    layouts: { edit: ['name', 'description', 'date', 'image', 'link'].map((name) => [{ name, size: 6 }]) },
    metadatas: { name: { edit: { label: 'name' }, list: { label: 'name' } } }, settings: { defaultSortBy: 'name' },
  };
  const scheduleFields = ['startAt', 'endAt', 'city', 'price', 'oldPrice', 'isFree', 'entry_status', 'registrationFormLink', 'description', 'additionalText', 'duration', 'seminar'];
  const schedule = {
    layouts: { edit: scheduleFields.map((name) => [{ name, size: 6 }]) },
    metadatas: { startAt: { edit: { label: 'startAt' }, list: { label: 'startAt' } } }, settings: { defaultSortBy: 'startAt' },
  };
  const schema = {
    'api::promotion.promotion': { attributes: { name: { type: 'string' } }, __schema__: { attributes: { name: { type: 'string' } } } },
    'api::schedule-entry.schedule-entry': { attributes: { startAt: { type: 'datetime' } }, __schema__: { attributes: { startAt: { type: 'datetime' } } } },
  };
  if (candidate) {
    promotion.layouts.edit.push([{ name: 'type', size: 6 }]);
    promotion.metadatas.type = { edit: { label: 'type', description: '', placeholder: '', visible: true, editable: true }, list: { label: 'type', searchable: true, sortable: true } };
    schedule.layouts.edit.splice(2, 0, [{ name: 'image', size: 6 }]);
    schedule.metadatas.image = { edit: { label: 'Изображение', description: '', placeholder: '', visible: true, editable: true }, list: { label: 'Изображение', searchable: false, sortable: false } };
    schedule.metadatas.isEventCollection = { edit: { label: 'Исходный флаг коллекции', description: '', placeholder: '', visible: false, editable: false }, list: { label: 'Исходный флаг коллекции', searchable: true, sortable: true } };
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
