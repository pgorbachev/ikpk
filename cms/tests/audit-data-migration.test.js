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
    CREATE TABLE strapi_migrations (id INTEGER PRIMARY KEY, name varchar(255), time datetime);
    INSERT INTO strapi_migrations VALUES (1, '5.0.0-02-created-document-id', 1791523597813);
  `);
  if (addedColumns && (promotionType !== null || eventCollection !== null)) {
    db.prepare('UPDATE promotions SET type = ? WHERE id = 1').run(promotionType);
    db.prepare('UPDATE schedule_entries SET is_event_collection = ? WHERE id = 1').run(eventCollection);
  }
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
