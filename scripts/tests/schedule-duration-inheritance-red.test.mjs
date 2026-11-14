import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { planScheduleDataMigration, applyScheduleDataMigration } from '../../cms/scripts/migrate-schedule-data.mjs';

// Complete physical draft/published pairs; no unrelated price or online exceptions.
function database() {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => ({ immediate() {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } });
  db.exec(`
    CREATE TABLE seminars (id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, duration TEXT);
    CREATE TABLE schedule_entries (id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, legacy_id TEXT, is_free INTEGER, price REAL, city TEXT, is_online INTEGER, duration TEXT);
    CREATE TABLE schedule_entries_seminar_lnk (schedule_entry_id INTEGER, seminar_id INTEGER);
    CREATE TABLE files_related_mph (file_id INTEGER, related_id INTEGER, related_type TEXT, field TEXT);
    INSERT INTO seminars VALUES (1,'ПК-2',NULL,NULL),(2,'ПК-2','2026-01-01',NULL),(3,'ПК-1',NULL,NULL),(4,'ПК-1','2026-01-01',NULL),(5,'ПК-5',NULL,NULL),(6,'ПК-5','2026-01-01',NULL);
    INSERT INTO schedule_entries VALUES
      (11,'a',NULL,'A',0,100,'Москва',0,'36'),(12,'a','2026-01-01','A',0,100,'Москва',0,'36'),
      (21,'b',NULL,'B',0,100,'Москва',0,'36'),(22,'b','2026-01-01','B',0,100,'Москва',0,'36'),
      (31,'c',NULL,'C',0,100,'Москва',0,'16 часов'),(32,'c','2026-01-01','C',0,100,'Москва',0,'24 часа'),
      (41,'d',NULL,'D',0,100,'Москва',0,NULL),(42,'d','2026-01-01','D',0,100,'Москва',0,'8 часов');
    INSERT INTO schedule_entries_seminar_lnk VALUES (11,1),(12,2),(21,1),(22,2),(31,3),(32,4),(41,5),(42,6);
  `);
  return db;
}
const durations = db => ({
  seminars: db.prepare('SELECT id,duration FROM seminars ORDER BY id').all().map(r => ({ ...r })),
  entries: db.prepare('SELECT id,duration FROM schedule_entries ORDER BY id').all().map(r => ({ ...r })),
});
function migrate(db) {
  const decisions = { acceptedExceptions: [{ documentId: 'd', rowId: 41, error: 'duration-needs-review' }] };
  const plan = planScheduleDataMigration(db, { decisions });
  applyScheduleDataMigration(db, { decisions, plan, expectedPlanDigest: plan.planDigest });
  return plan;
}

test('agreed numeric duration becomes an explicit seminar default and equal overrides inherit', () => {
  const db = database();
  try {
    const before = durations(db); const plan = migrate(db);
    assert.deepEqual(durations(db).seminars.slice(0, 2), [{ id: 1, duration: '36 часов' }, { id: 2, duration: '36 часов' }]);
    assert.deepEqual(durations(db).entries.slice(0, 4).map(r => r.duration), [null, null, null, null]);
    assert.ok(plan.sourceDigest, 'the reviewed plan binds the original legacy values');
    assert.deepEqual(durations(db).seminars.slice(2), before.seminars.slice(2), 'ПК-1 / ПК-5 ambiguity never invents defaults');
    assert.deepEqual(durations(db).entries.slice(4), before.entries.slice(4), 'divergent and missing values retain original overrides');
  } finally { db.close(); }
});

test('a shared textual default also removes only the proven equal overrides', () => {
  const db = database();
  try {
    db.exec("UPDATE schedule_entries SET duration='две учебные недели' WHERE id IN (11,12,21,22)"); migrate(db);
    assert.equal(db.prepare('SELECT duration FROM seminars WHERE id=2').get().duration, 'две учебные недели');
    assert.deepEqual(durations(db).entries.slice(0, 4).map(r => r.duration), [null, null, null, null]);
  } finally { db.close(); }
});

test('ПК-1 divergent and ПК-5 empty durations stay unchanged pending owner decisions', () => {
  const db = database();
  try {
    const before = durations(db); migrate(db);
    assert.deepEqual(durations(db).seminars.slice(2), before.seminars.slice(2));
    assert.deepEqual(durations(db).entries.slice(4), before.entries.slice(4));
  } finally { db.close(); }
});

for (const [name, sql] of [
  ['an occurrence belongs to two logical seminars', 'INSERT INTO schedule_entries_seminar_lnk VALUES (11,3)'],
  ['duplicate relation rows make linkage ambiguous', 'INSERT INTO schedule_entries_seminar_lnk VALUES (11,1)'],
  ['a logical occurrence has two draft versions', "INSERT INTO schedule_entries SELECT 13,document_id,published_at,legacy_id,is_free,price,city,is_online,duration FROM schedule_entries WHERE id=11; INSERT INTO schedule_entries_seminar_lnk VALUES (13,1)"],
  ['one logical occurrence has no published partner', 'DELETE FROM schedule_entries_seminar_lnk WHERE schedule_entry_id=22; DELETE FROM schedule_entries WHERE id=22'],
  ['a published relation points at a draft seminar', 'UPDATE schedule_entries_seminar_lnk SET seminar_id=1 WHERE schedule_entry_id=12'],
  ['draft duration differs from published duration', "UPDATE schedule_entries SET duration='99' WHERE id=11"],
]) test(`unsafe duration linkage is refused or preserved: ${name}`, () => {
  const db = database();
  try {
    db.exec(sql); const before = durations(db);
    try { migrate(db); } catch (error) { assert.match(error.message, /duration|relation|version|ambig|duplicate|review/i); }
    assert.deepEqual(durations(db), before);
  } finally { db.close(); }
});
