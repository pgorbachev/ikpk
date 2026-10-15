import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  applyDocumentsStateNormalization,
  planDocumentsStateNormalization,
} from '../scripts/normalize-null-documents-state.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { checkPublication } = await import('../src/lib/publication-validation.ts');

function fixture({ contradiction = false } = {}) {
  const db = new Database(':memory:');
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
  return db;
}

function seminarSnapshot(db) {
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

test('plan reports only null rows with no structured documents across either physical version', () => {
  const db = fixture();
  try {
    const plan = planDocumentsStateNormalization(db);
    assert.equal(plan.blocked, false);
    assert.deepEqual(plan.candidateRows, [
      { rowId: 1, documentId: 'doc-null', published: false },
      { rowId: 2, documentId: 'doc-null', published: true },
    ]);
    assert.deepEqual(plan.contradictions, []);
  } finally {
    db.close();
  }
});

test('apply changes only documents_state, preserves draft and published rows and all relations, and is idempotent', () => {
  const db = fixture();
  try {
    const before = seminarSnapshot(db);
    const first = applyDocumentsStateNormalization(db);
    const after = seminarSnapshot(db);

    assert.deepEqual(first, { updatedRows: 2, logicalDocuments: 1 });
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

    const normalized = checkPublication({
      type: 'seminar',
      record: {
        name: 'Seminar', identifier: 'seminar', course_group: 'program', description: 'Description',
        seo_title: 'SEO', seo_description: 'SEO description', documentsState: 'unconfirmed',
      },
    });
    assert.equal(normalized.ok, true);
    assert.deepEqual(applyDocumentsStateNormalization(db), { updatedRows: 0, logicalDocuments: 0 });
    assert.deepEqual(seminarSnapshot(db), after);
  } finally {
    db.close();
  }
});

test('a null state with structured documents is reported and blocks the whole apply transaction', () => {
  const db = fixture({ contradiction: true });
  try {
    const before = seminarSnapshot(db);
    const plan = planDocumentsStateNormalization(db);
    assert.equal(plan.blocked, true);
    assert.deepEqual(plan.contradictions, [{
      documentId: 'doc-conflict',
      seminarRowId: 5,
      reason: 'structured documents are attached to a physical version',
    }]);
    assert.deepEqual(plan.candidateRows, []);
    assert.throws(() => applyDocumentsStateNormalization(db), /structured documents/);
    assert.deepEqual(seminarSnapshot(db), before);
  } finally {
    db.close();
  }
});
