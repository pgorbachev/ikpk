import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test('blocks relation loss or reassignment when table row counts stay equal', () => {
  const sourceDbPath = join(directory, 'source.db');
  const candidateDbPath = join(directory, 'candidate.db');
  createFixture(sourceDbPath, 1);
  createFixture(candidateDbPath, 2);
  const manifestPath = join(directory, 'plan.json');
  writeFileSync(manifestPath, '{"version":1,"steps":[]}\n');
  const plan = { manifestPath, planSha256: sha256(readFileSync(manifestPath)), steps: [] };
  const receipt = {
    sourceDbPath,
    candidateDbPath,
    planSha256: plan.planSha256,
    steps: [],
    source: { sourceFileFingerprint: fileFingerprint(sourceDbPath) },
    candidatePostMigrationSha256: sha256(require('node:fs').readFileSync(candidateDbPath)),
    candidatePostMigrationFileFingerprint: fileFingerprint(candidateDbPath),
  };

  const report = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt });

  assert.equal(report.passed, false, 'changed relation target must block despite identical row counts');
  assert.ok(report.differences.some(({ table, kind }) => table === 'teachers_institute_lnk' && ['row-content', 'row-added', 'row-removed'].includes(kind)),
    'report should identify the changed relation using private digests');
  assert.doesNotMatch(JSON.stringify(report), /Teacher A|Teacher B|Institute/,
    'private report must not contain sensitive cell values');
});
