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
