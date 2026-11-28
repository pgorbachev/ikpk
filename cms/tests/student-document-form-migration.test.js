import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const Database = createRequire(import.meta.url)('better-sqlite3');
const URL = 'https://b24-cbqwqo.bitrix24site.ru/crm_form_k5ush/?telemetry_sign=v1%3A6%3Adirect_link.2b373ae14476af8c466795c40598e242f26f55b15de21454f4c9dcb4d5acb8c4';
const makeDb = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, document_id TEXT, slug TEXT, legacy_id TEXT,
    published_at TEXT, student_document_form_url TEXT);
    INSERT INTO pages VALUES (11,'payment-doc','oplata','oplata',NULL,NULL),
      (12,'payment-doc','oplata','oplata','2026-01-01',NULL),
      (13,'other-doc','other','other','2026-01-01',NULL);`);
  return db;
};

test('seeds only missing addresses on the published/draft /oplata pair; replay preserves edits', async () => {
  const { apply } = await import('../database/migrations/data-steps/student-document-form.mjs');
  const db = makeDb();
  try {
    assert.deepEqual(apply(db), { updatedRows: 2 });
    assert.deepEqual(db.prepare('SELECT id, student_document_form_url AS url FROM pages ORDER BY id').all(), [
      { id: 11, url: URL }, { id: 12, url: URL }, { id: 13, url: null },
    ]);
    db.prepare('UPDATE pages SET student_document_form_url=? WHERE id=11').run('https://custom.invalid/kept');
    assert.deepEqual(apply(db), { updatedRows: 0 });
    assert.equal(db.prepare('SELECT student_document_form_url FROM pages WHERE id=11').get().student_document_form_url, 'https://custom.invalid/kept');
  } finally { db.close(); }
});

test('fills one missing version without replacing the other and rolls back with ledger failure', async () => {
  const { apply } = await import('../database/migrations/data-steps/student-document-form.mjs');
  const db = makeDb();
  try {
    db.prepare('UPDATE pages SET student_document_form_url=? WHERE id=11').run('https://custom.invalid/draft');
    assert.throws(() => apply(db, { onApplied() { throw new Error('ledger failure'); } }), /ledger failure/);
    assert.equal(db.prepare('SELECT student_document_form_url FROM pages WHERE id=12').get().student_document_form_url, null);
    assert.deepEqual(apply(db), { updatedRows: 1 });
    assert.equal(db.prepare('SELECT student_document_form_url FROM pages WHERE id=11').get().student_document_form_url, 'https://custom.invalid/draft');
    assert.equal(db.prepare('SELECT student_document_form_url FROM pages WHERE id=12').get().student_document_form_url, URL);
  } finally { db.close(); }
});

test('refuses missing columns, ambiguous documents, or a missing version', async () => {
  const { apply } = await import('../database/migrations/data-steps/student-document-form.mjs');
  const missingColumn = new Database(':memory:');
  try {
    missingColumn.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, document_id TEXT, slug TEXT, legacy_id TEXT, published_at TEXT);
      INSERT INTO pages VALUES (1,'doc','oplata','oplata',NULL),(2,'doc','oplata','oplata','2026');`);
    assert.throws(() => apply(missingColumn), /no such column/i);
  } finally { missingColumn.close(); }
  const ambiguous = makeDb();
  try {
    ambiguous.exec("INSERT INTO pages VALUES (14,'other-doc','oplata','oplata','2026',NULL)");
    assert.throws(() => apply(ambiguous), /one published version and one matching draft/i);
  } finally { ambiguous.close(); }
});
