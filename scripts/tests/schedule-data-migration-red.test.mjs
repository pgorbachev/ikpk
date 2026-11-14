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
      (22,'entry-two','2026-01-01','SER-2',0,0,'Москва',NULL,'16 часов','Second text','https://example.test/second','active'),
      (31,'entry-free',NULL,'FREE',0,NULL,'Казань',NULL,'8 часов','Free text','https://example.test/free','active'),
      (41,'entry-unknown',NULL,'UNKNOWN',0,0,'Онлайн ',NULL,NULL,'Unknown','https://example.test/unknown','cancelled');
    INSERT INTO schedule_entries_seminar_lnk VALUES (11,1),(12,2),(21,1),(22,2),(31,3),(41,3);
    INSERT INTO files_related_mph VALUES (7,11,'api::schedule-entry.schedule-entry','image'),(8,12,'api::schedule-entry.schedule-entry','image');
  `);
  return db;
}
const decisions = {
  paid: ['entry-one', 'entry-two'], free: ['entry-free'],
  online: [{ documentId: 'entry-one', legacyId: 'SER-1', city: 'Онлайн' }],
  acceptedExceptions: ['paid-price-conflict', 'online-requires-confirmation', 'duration-needs-review'].map((error) => ({ documentId: 'entry-unknown', rowId: 41, error })),
};
async function handler() {
  const mod = await import('../../cms/scripts/migrate-schedule-data.mjs');
  return { ...mod, applyScheduleDataMigration: (db, args) => mod.applyScheduleDataMigration(db, { ...args, expectedPlanDigest: args.plan.planDigest }) };
}
function rows(db, table) { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r })); }
function snapshot(db) {
  return Object.fromEntries(['seminars', 'schedule_entries', 'schedule_entries_seminar_lnk', 'files_related_mph'].map((t) => [t, rows(db, t)]));
}
function row(db, id) { return { ...db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(id) }; }

test('free occurrences with missing price require an explicit reviewed decision for both versions', async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const { auditScheduleBusinessRules } = await import('../../cms/scripts/audit-schedule-business-rules.mjs');
  const db = database();
  db.prepare('UPDATE schedule_entries SET is_free = 1, price = NULL WHERE id IN (21, 22)').run();
  const unresolved = { ...decisions, paid: ['entry-one'] };
  const pending = plan(db, { decisions: unresolved });
  assert.deepEqual(pending.exceptions.filter(x => x.documentId === 'entry-two').map(x => x.errors), [['free-price-missing'], ['free-price-missing']]);
  const choices = { ...unresolved, free: [...unresolved.free, 'entry-two'] };
  const proposal = plan(db, { decisions: choices });
  assert.deepEqual(proposal.entries.filter(x => x.documentId === 'entry-two').map(x => x.changes.price), [0, 0]);
  auditScheduleBusinessRules(db, { plan: proposal, decisions: choices, expectedPlanDigest: proposal.planDigest });
  apply(db, { decisions: choices, plan: proposal });
  assert.deepEqual([row(db, 21).price, row(db, 22).price], [0, 0]);
  db.close();
});

test('dry-run enumerates physical draft/published identities and exceptions without writes', async () => {
  const { planScheduleDataMigration: plan } = await handler();
  const db = database(); const before = snapshot(db);
  const result = plan(db, { decisions });
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(result.entries.filter((x) => x.documentId === 'entry-one').map((x) => [x.rowId, x.published]).sort(), [[11, false], [12, true]]);
  assert.ok(result.exceptions.some((x) => x.documentId === 'entry-unknown'));
  assert.ok(result.exceptions.some((x) => x.documentId === 'entry-unknown' && x.errors.includes('duration-needs-review')));
  db.close();
});

test('confirmed paid, free and exact online decisions affect each physical version only', async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const db = database(); const before = snapshot(db); const proposal = plan(db, { decisions });
  apply(db, { decisions, plan: proposal });
  for (const id of [11, 12]) assert.deepEqual([row(db, id).is_free, row(db, id).price, row(db, id).city, row(db, id).is_online], [0, null, null, 1]);
  assert.deepEqual([row(db, 21).is_free, row(db, 21).price, row(db, 21).city], [0, null, 'Москва']);
  assert.deepEqual([row(db, 31).is_free, row(db, 31).price], [1, 0]);
  assert.deepEqual(row(db, 41), before.schedule_entries.find((x) => x.id === 41));
  for (const id of [11, 12, 21, 31]) {
    const previous = before.schedule_entries.find((x) => x.id === id); const current = row(db, id);
    for (const column of ['document_id', 'published_at', 'legacy_id', 'description', 'registration_form_link', 'entry_status']) assert.equal(current[column], previous[column]);
  }
  assert.deepEqual(rows(db, 'files_related_mph'), before.files_related_mph);
  assert.deepEqual(rows(db, 'schedule_entries_seminar_lnk'), before.schedule_entries_seminar_lnk);
  db.close();
});

test('duration moves only where versions and related entries agree; ambiguity keeps overrides', async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const db = database();
  // The sem-b rows disagree (one missing); no invented common duration.
  apply(db, { decisions, plan: plan(db, { decisions }) });
  assert.deepEqual(rows(db, 'seminars').map((s) => [s.id, s.duration]), [[1, '16 часов'], [2, '16 часов'], [3, null]]);
  assert.equal(row(db, 31).duration, '8 часов');
  assert.equal(row(db, 41).duration, null);
  db.close();
});

test('duration from a draft-only occurrence never populates a published seminar', async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const db = database();
  db.prepare('DELETE FROM schedule_entries_seminar_lnk WHERE schedule_entry_id = ?').run(12);
  db.prepare('DELETE FROM schedule_entries WHERE id = ?').run(12);
  apply(db, { decisions, plan: plan(db, { decisions }) });
  assert.equal(db.prepare('SELECT duration FROM seminars WHERE id = 2').get().duration, null);
  db.close();
});

test('numeric legacy duration becomes an explicit default and equal overrides inherit', async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const db = database();
  db.prepare('UPDATE schedule_entries SET duration = ? WHERE id IN (11, 12, 21, 22)').run('36');
  apply(db, { decisions, plan: plan(db, { decisions }) });
  assert.equal(db.prepare('SELECT duration FROM seminars WHERE id = 2').get().duration, '36 часов');
  assert.equal(row(db, 12).duration, null);
  db.close();
});

test('source changes after dry-run refuse the whole transaction', async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const db = database(); const proposal = plan(db, { decisions });
  db.prepare('UPDATE schedule_entries SET price = 42 WHERE id = 12').run();
  const changed = snapshot(db);
  assert.throws(() => apply(db, { decisions, plan: proposal }), /source|changed|stale|исходн/i);
  assert.deepEqual(snapshot(db), changed);
  db.close();
});

test('rerun cannot overwrite edits made after successful migration', async () => {
  const { planScheduleDataMigration: plan, applyScheduleDataMigration: apply } = await handler();
  const db = database(); const proposal = plan(db, { decisions });
  apply(db, { decisions, plan: proposal });
  db.prepare('UPDATE schedule_entries SET price = 99, city = ? WHERE id = 11').run('Новый город');
  const changed = snapshot(db);
  // Either a ledger-backed no-op or a stale-plan refusal is safe.
  try { apply(db, { decisions, plan: proposal }); } catch (e) { assert.match(e.message, /source|changed|stale|already|исходн/i); }
  assert.deepEqual(snapshot(db), changed);
  db.close();
});
