// Contract tests for the proposed after-sync data step. No implementation lives here.
// Run with: node --test scripts/tests/schedule-data-migration-red.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// The handler uses the better-sqlite3 prepare/transaction surface already used by
// the existing data steps. Node's built-in SQLite supplies an isolated real DB.
function database() {
  const db = new DatabaseSync(':memory:');
  db.transaction = (fn) => ({ immediate: () => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } });
  db.exec(`
    CREATE TABLE seminars (id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, duration TEXT, name TEXT, description TEXT);
    CREATE TABLE schedule_entries (id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, legacy_id TEXT, is_free INTEGER, price REAL, city TEXT, is_online INTEGER, duration TEXT, description TEXT, registration_form_link TEXT, entry_status TEXT);
    CREATE TABLE schedule_entries_seminar_lnk (schedule_entry_id INTEGER, seminar_id INTEGER);
    CREATE TABLE files_related_mph (file_id INTEGER, related_id INTEGER, related_type TEXT, field TEXT);
    INSERT INTO seminars VALUES (1,'sem-a',NULL,NULL,'Draft name','Draft text'),(2,'sem-a','2026-01-01',NULL,'Published name','Published text'),(3,'sem-b',NULL,NULL,'Other','Other text');
    INSERT INTO schedule_entries VALUES
      (11,'entry-one',NULL,'SER-1',0,0,'Онлайн',NULL,'16 часов','Draft text','https://example.test/draft','active'),
      (12,'entry-one','2026-01-01','SER-1',0,0,'Онлайн',NULL,'16 часов','Published text','https://example.test/published','completed'),
      (21,'entry-two',NULL,'SER-2',0,0,'Москва',NULL,'16 часов','Second text','https://example.test/second','active'),
      (31,'entry-free',NULL,'FREE',0,NULL,'Казань',NULL,'8 часов','Free text','https://example.test/free','active'),
      (41,'entry-unknown',NULL,'UNKNOWN',0,0,'Онлайн ',NULL,NULL,'Unknown','https://example.test/unknown','cancelled');
    INSERT INTO schedule_entries_seminar_lnk VALUES (11,1),(12,2),(21,1),(31,3),(41,3);
    INSERT INTO files_related_mph VALUES (7,11,'api::schedule-entry.schedule-entry','image'),(8,12,'api::schedule-entry.schedule-entry','image');
  `);
  return db;
}
const decisions = {
  paid: ['entry-one', 'entry-two'], free: ['entry-free'],
  online: [{ documentId: 'entry-one', legacyId: 'SER-1', city: 'Онлайн' }],
};
async function handler() {
  return import('../../cms/scripts/migrate-schedule-data.mjs');
}
function rows(db, table) { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r })); }
function snapshot(db) {
  return Object.fromEntries(['seminars', 'schedule_entries', 'schedule_entries_seminar_lnk', 'files_related_mph'].map((t) => [t, rows(db, t)]));
}
function row(db, id) { return { ...db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(id) }; }


test('unresolved schedule exceptions prevent every write and callback', async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const db = database(), before = snapshot(db); let called = false;
  const p = plan(db, { decisions }); assert.ok(p.exceptions.length);
  assert.throws(() => apply(db, { decisions, plan: p, expectedPlanDigest: p.planDigest, onApplied() { called = true; } }), /exception|review|unresolved/i);
  assert.equal(called, false); assert.deepEqual(snapshot(db), before); db.close();
});

for (const mode of ['throw', 'promise']) test(`schedule runner callback ${mode} rolls back all writes and permits retry`, async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const db = database(); db.exec('DELETE FROM schedule_entries_seminar_lnk WHERE schedule_entry_id=41; DELETE FROM schedule_entries WHERE id=41; CREATE TABLE runner_ledger (id TEXT)');
  const before = snapshot(db), p = plan(db, { decisions }); assert.deepEqual(p.exceptions, []);
  let called = false;
  assert.throws(() => apply(db, { decisions, plan: p, expectedPlanDigest: p.planDigest, onApplied(connection, result) {
    called = true; assert.equal(connection, db); assert.ok(result);
    connection.prepare('INSERT INTO runner_ledger VALUES (?)').run('step');
    if (mode === 'throw') throw new Error('injected runner failure');
    return Promise.resolve();
  }}));
  assert.equal(called, true); assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM runner_ledger').get().n, 0);
  apply(db, { decisions, plan: p, expectedPlanDigest: p.planDigest, onApplied(connection) { connection.prepare('INSERT INTO runner_ledger VALUES (?)').run('step'); } });
  assert.equal(db.prepare('SELECT count(*) AS n FROM runner_ledger').get().n, 1);
  assert.equal(row(db, 11).is_online, 1); assert.equal(row(db, 12).is_online, 1); db.close();
});

test('schedule rejects a plan not bound to the reviewed external digest', async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const db = database(); db.exec('DELETE FROM schedule_entries_seminar_lnk WHERE schedule_entry_id=41; DELETE FROM schedule_entries WHERE id=41');
  const before = snapshot(db), p = plan(db, { decisions });
  assert.throws(() => apply(db, { decisions, plan: p, expectedPlanDigest: '0'.repeat(64) }), /digest|plan|bound/i);
  assert.deepEqual(snapshot(db), before); db.close();
});
