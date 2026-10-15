import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareNormalizedBackup } from '../scripts/normalize-null-documents-state.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { checkPublication } = await import('../src/lib/publication-validation.ts');

function fixture(t, { contradiction = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ikpk-documents-state-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.db');
  const db = new Database(sourcePath);
  db.exec(`
    CREATE TABLE seminars (
      id INTEGER PRIMARY KEY,
      document_id TEXT,
      name TEXT,
      slug TEXT,
      description TEXT,
      created_at TEXT,
      updated_at TEXT,
      published_at TEXT,
      documents_state TEXT,
      documents_confirmation_date TEXT,
      documents_confirmation_source TEXT,
      documents_confirmation_author TEXT
    );
    CREATE TABLE seminars_cmps (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER,
      cmp_id INTEGER,
      component_type TEXT,
      field TEXT,
      "order" REAL
    );
    CREATE TABLE components_seminar_document_records (
      id INTEGER PRIMARY KEY,
      document TEXT,
      issuer TEXT,
      prior_education TEXT,
      prior_education_note TEXT,
      outcome TEXT,
      basis TEXT
    );
    CREATE TABLE seminars_course_group_lnk (seminar_id INTEGER, course_group_id INTEGER);
    CREATE TABLE seminars_teachers_lnk (seminar_id INTEGER, teacher_id INTEGER, "order" REAL);
    INSERT INTO seminars VALUES
      (1, 'doc-null', 'Draft name', 'draft-name', 'Draft description', '2025-01-01', '2025-02-01', NULL, NULL, NULL, NULL, NULL),
      (2, 'doc-null', 'Published name', 'published-name', 'Published description', '2025-01-02', '2025-02-02', '2025-02-03', NULL, NULL, NULL, NULL),
      (3, 'doc-issued', 'Issued name', 'issued-name', 'Issued description', '2025-01-03', '2025-02-03', '2025-02-04', 'issued', NULL, 'approved', 'editor'),
      (4, 'doc-not-issued', 'Not issued name', 'not-issued-name', 'Not issued description', '2025-01-04', '2025-02-04', NULL, 'not-issued', NULL, NULL, NULL);
    INSERT INTO seminars_course_group_lnk VALUES (1, 21), (2, 21), (3, 22);
    INSERT INTO seminars_teachers_lnk VALUES (1, 31, 0), (2, 31, 0), (3, 32, 0);
    ${contradiction ? `
      INSERT INTO seminars (id, document_id, name, slug, published_at, documents_state)
      VALUES (5, 'doc-conflict', 'Conflict', 'conflict', '2025-02-05', NULL);
      INSERT INTO components_seminar_document_records VALUES (50, 'Удостоверение', 'ИКПК', NULL, NULL, NULL, NULL);
      INSERT INTO seminars_cmps VALUES (60, 5, 50, 'seminar.document-record', 'documents', 0);
    ` : ''}
  `);
  db.close();
  return { directory, sourcePath, outputPath: join(directory, 'prepared.db') };
}

function digest(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function snapshot(db) {
  return {
    seminars: db.prepare('SELECT * FROM seminars ORDER BY id').all(),
    components: db.prepare('SELECT * FROM seminars_cmps ORDER BY id').all(),
    documentRecords: db.prepare('SELECT * FROM components_seminar_document_records ORDER BY id').all(),
    courseGroups: db.prepare('SELECT * FROM seminars_course_group_lnk ORDER BY seminar_id').all(),
    teachers: db.prepare('SELECT * FROM seminars_teachers_lnk ORDER BY seminar_id').all(),
  };
}

test('legacy null documents_state is blocked by publication validation', () => {
  const legacy = checkPublication({
    type: 'seminar',
    record: {
      name: 'Seminar', identifier: 'seminar', course_group: 'program', description: 'Description',
      seo_title: 'SEO', seo_description: 'SEO description', documentsState: null,
    },
  });
  assert.deepEqual(legacy.missing, ['documentsState']);
  assert.equal(legacy.ok, false);
});

test('dry-run reads a real SQLite source without creating its output', async (t) => {
  const { sourcePath, outputPath } = fixture(t);
  const sourceBefore = digest(sourcePath);
  const plan = await prepareNormalizedBackup({ sourcePath, outputPath });

  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.blocked, false);
  assert.equal(plan.nullStateRows.length, 2);
  assert.equal(plan.logicalDocuments, 1);
  assert.equal(plan.candidateRows.length, 2);
  assert.deepEqual(plan.contradictions, []);
  assert.equal(digest(sourcePath), sourceBefore);
  assert.equal(require('node:fs').existsSync(outputPath), false);
});

test('apply copies first, changes only null states, preserves physical versions and relations, then remains idempotent', async (t) => {
  const { sourcePath, outputPath, directory } = fixture(t);
  const sourceBefore = digest(sourcePath);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const before = snapshot(source);
  source.close();

  const first = await prepareNormalizedBackup({ sourcePath, outputPath, apply: true });
  assert.deepEqual(first, { mode: 'apply', sourcePath, outputPath: join(realpathSync(directory), 'prepared.db'), updatedRows: 2, logicalDocuments: 1 });
  assert.equal(digest(sourcePath), sourceBefore);

  const output = new Database(outputPath, { readonly: true, fileMustExist: true });
  const after = snapshot(output);
  output.close();
  assert.equal(after.seminars.length, before.seminars.length);
  for (let index = 0; index < before.seminars.length; index += 1) {
    const prior = before.seminars[index];
    const next = after.seminars[index];
    assert.deepEqual({ ...next, documents_state: prior.documents_state }, prior);
    if (prior.document_id === 'doc-null') assert.equal(next.documents_state, 'unconfirmed');
  }
  assert.deepEqual(after.components, before.components);
  assert.deepEqual(after.documentRecords, before.documentRecords);
  assert.deepEqual(after.courseGroups, before.courseGroups);
  assert.deepEqual(after.teachers, before.teachers);
  assert.equal(after.seminars.find((row) => row.id === 3).documents_state, 'issued');
  assert.equal(after.seminars.find((row) => row.id === 4).documents_state, 'not-issued');

  const normalizedVerdict = checkPublication({
    type: 'seminar',
    record: {
      name: 'Seminar', identifier: 'seminar', course_group: 'program', description: 'Description',
      seo_title: 'SEO', seo_description: 'SEO description', documentsState: 'unconfirmed',
    },
  });
  assert.equal(normalizedVerdict.ok, true);

  const secondOutput = join(directory, 'prepared-again.db');
  const second = await prepareNormalizedBackup({ sourcePath: outputPath, outputPath: secondOutput, apply: true });
  assert.deepEqual(second, { mode: 'apply', sourcePath: outputPath, outputPath: join(realpathSync(directory), 'prepared-again.db'), updatedRows: 0, logicalDocuments: 0 });
  const secondDb = new Database(secondOutput, { readonly: true, fileMustExist: true });
  assert.deepEqual(snapshot(secondDb), after);
  secondDb.close();
});

test('existing output is refused without changing its bytes or the source', async (t) => {
  const { directory, sourcePath } = fixture(t);
  const outputPath = join(directory, 'already-exists.db');
  const bytes = Buffer.from('keep this existing file intact');
  require('node:fs').writeFileSync(outputPath, bytes);
  const sourceBefore = digest(sourcePath);
  await assert.rejects(prepareNormalizedBackup({ sourcePath, outputPath, apply: true }), /output already exists/);
  assert.deepEqual(readFileSync(outputPath), bytes);
  assert.equal(digest(sourcePath), sourceBefore);
});

test('failed normalization removes only its exclusively created output and leaves the source intact', async (t) => {
  const { sourcePath, outputPath } = fixture(t);
  const sourceDb = new Database(sourcePath);
  sourceDb.exec(`
    CREATE TRIGGER refuse_documents_state_update
    BEFORE UPDATE OF documents_state ON seminars
    BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;
  `);
  sourceDb.close();
  const sourceBefore = digest(sourcePath);

  await assert.rejects(prepareNormalizedBackup({ sourcePath, outputPath, apply: true }), /synthetic write failure/);
  assert.equal(require('node:fs').existsSync(outputPath), false);
  assert.equal(digest(sourcePath), sourceBefore);
});

test('source path, symlink, and hardlink outputs are refused without source mutation', async (t) => {
  const { directory, sourcePath } = fixture(t);
  const sourceBefore = digest(sourcePath);
  const symlinkPath = join(directory, 'source-link.db');
  const hardlinkPath = join(directory, 'source-hardlink.db');
  symlinkSync(sourcePath, symlinkPath);
  linkSync(sourcePath, hardlinkPath);

  for (const outputPath of [sourcePath, symlinkPath, hardlinkPath]) {
    await assert.rejects(prepareNormalizedBackup({ sourcePath, outputPath, apply: true }), /output already exists|resolves to the source/);
    assert.equal(digest(sourcePath), sourceBefore);
  }
});

test('a documents-component contradiction is reported and prevents output creation', async (t) => {
  const { sourcePath, outputPath } = fixture(t, { contradiction: true });
  const sourceBefore = digest(sourcePath);
  const plan = await prepareNormalizedBackup({ sourcePath, outputPath });
  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.contradictions, [{
    documentId: 'doc-conflict',
    seminarRowId: 5,
    reason: 'structured documents are attached to a physical version',
  }]);
  assert.deepEqual(plan.candidateRows, []);
  await assert.rejects(prepareNormalizedBackup({ sourcePath, outputPath, apply: true }), /structured documents/);
  assert.equal(require('node:fs').existsSync(outputPath), false);
  assert.equal(digest(sourcePath), sourceBefore);
});
