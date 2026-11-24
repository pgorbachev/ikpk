import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const Database = createRequire(import.meta.url)('better-sqlite3');
const root = new URL('../database/migrations/', import.meta.url);
const plan = JSON.parse(readFileSync(new URL('plan.json', root), 'utf8'));

async function migration() {
  const step = plan.steps.find(({ id }) => id === 'site-contact-phones-v1');
  assert.ok(step, 'release plan must include the contacts data migration');
  assert.equal(step.phase, 'after-sync');
  return (await import(new URL(step.path, root))).apply;
}

function database(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, document_id TEXT, slug TEXT, legacy_id TEXT,
    title TEXT, body TEXT, published_at TEXT, center_phone TEXT, manager_phone TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO pages VALUES
      (41, 'doc-c', 'kontakty', 'kontakty', 'Контакты', 'Опубликованный текст', '2026-10-01', NULL, NULL, '2026-01-01', '2026-10-01'),
      (57, 'doc-c', 'kontakty', 'kontakty', 'Рабочий заголовок', 'Новый текст', NULL, '+78125550101', NULL, '2026-01-01', '2026-11-01'),
      (73, 'doc-x', 'oplata', 'oplata', 'Контакты', 'Другая страница', '2026-09-01', NULL, NULL, '2026-01-01', '2026-09-01')`);
  return db;
}

const rows = (db) => db.prepare('SELECT * FROM pages ORDER BY id').all();
const digits = (value) => value.replace(/[ ()-]/g, '');

test('first release fills missing phones and a replay preserves each physical version', async (t) => {
  const apply = await migration();
  const db = database(t);
  const [published, draft, other] = rows(db);
  apply(db, { onApplied() {} });
  const [p, d, unrelated] = rows(db);
  assert.equal(digits(p.center_phone), '+78126465450');
  assert.equal(digits(p.manager_phone), '+79810387797');
  assert.equal(digits(d.manager_phone), '+79810387797');
  assert.deepEqual(p, { ...published, center_phone: p.center_phone, manager_phone: p.manager_phone });
  assert.deepEqual(d, { ...draft, manager_phone: d.manager_phone });
  assert.deepEqual(unrelated, other);

  db.prepare('UPDATE pages SET manager_phone=? WHERE id=?').run('+79815550202', published.id);
  const beforeReplay = rows(db);
  apply(db, { onApplied() {} });
  assert.deepEqual(rows(db), beforeReplay);
});

test('missing contacts or a failed transaction leaves the preimage intact', async (t) => {
  const apply = await migration();
  const db = database(t);
  const before = rows(db);
  assert.throws(() => apply(db, { onApplied: () => { throw new Error('simulated ledger write failure'); } }), /ledger/);
  assert.deepEqual(rows(db), before);
  db.exec("DELETE FROM pages WHERE slug = 'kontakty'");
  const absent = rows(db);
  assert.throws(() => apply(db, { onApplied() {} }), /контакт|kontakty|contact/i);
  assert.deepEqual(rows(db), absent);
});
