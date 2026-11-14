// Contract tests for a proposed migration writer; use only an isolated SQLite database.
// node --test scripts/tests/documents-migration-writer-red.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const handler = async () => { const mod = await import('../../cms/scripts/documents-migration-writer.mjs'); return {...mod, capturePlan: (db, items) => mod.capturePlan(db, items.map(item => ({...item, reviewedPreimages: mod.inspectVersions(db, item.documentId)})))}; };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sourceHtml = '<p>Сертификат <a href="https://example.test/cert">реестр</a></p>';
const proposal = () => ({
  documentId: 'sem-a', route: '/institute/section/example', sourceHtml,
  sourceSha256: sha(sourceHtml), sourceLinks: ['https://example.test/cert'],
  snapshotSha256: 'a'.repeat(64), rulesVersion: 'documents-test-v1',
  approved: true, eligibleForAutomaticWrite: true, readyForReviewOnly: false,
  migrationDate: '2026-11-13', migrationAuthor: 'Миграция контента',
  proposal: { documents_state: 'issued', documents: [
    { document: 'Первый', issuer: 'Институт', prior_education: 'medical', registry: [
      { name: 'Реестр документа', subject: 'document', url: 'https://example.test/cert' },
      { name: 'Второй реестр', subject: 'document', url: 'https://example.test/second' },
    ] },
    { document: 'Второй', issuer: 'Организация', prior_education: 'unspecified' },
  ], training_registries: [
    { name: 'Обучение 1', subject: 'training', international: true, url: 'https://example.test/training' },
    { name: 'Обучение 2', subject: 'training', international: false },
  ], nmo: { status: 'possible', audience: 'Врачи', url: 'https://example.test/nmo' } },
});
function database() {
  const db = new DatabaseSync(':memory:');
  db.transaction = (fn) => ({ immediate: () => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  } });
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE seminars (id INTEGER PRIMARY KEY, document_id TEXT, slug TEXT, legacy_id TEXT, name TEXT, full_text TEXT, published_at TEXT, documents_state TEXT, documents_confirmation_date TEXT, documents_confirmation_source TEXT, documents_confirmation_author TEXT, documents_owner_verified BOOLEAN);
    CREATE TABLE institutes (id INTEGER PRIMARY KEY, slug TEXT);
    CREATE TABLE course_groups (id INTEGER PRIMARY KEY, slug TEXT);
    CREATE TABLE seminars_course_group_lnk (id INTEGER PRIMARY KEY, seminar_id INTEGER, course_group_id INTEGER);
    CREATE TABLE course_groups_institute_lnk (id INTEGER PRIMARY KEY, course_group_id INTEGER, institute_id INTEGER);
    CREATE TABLE seminars_cmps (id INTEGER PRIMARY KEY, entity_id INTEGER, cmp_id INTEGER, component_type TEXT, field TEXT, "order" REAL);
    CREATE TABLE components_seminar_document_records (id INTEGER PRIMARY KEY, document TEXT, issuer TEXT, issuer_unknown BOOLEAN, prior_education TEXT, prior_education_note TEXT, outcome TEXT, basis TEXT, completion_scope TEXT, other_seminar_href TEXT, other_seminar_label TEXT, signed_by TEXT, qualification_topic TEXT, hours_mode TEXT, includes_completed_level BOOLEAN, completion_required BOOLEAN, completion_after_seminar_number INTEGER, completion_cycle_name TEXT, hours_may_vary BOOLEAN, regulation_url TEXT, document_type_unspecified BOOLEAN, regulation_issuer TEXT, document_on_template BOOLEAN);
    CREATE TABLE components_seminar_document_records_cmps (id INTEGER PRIMARY KEY, entity_id INTEGER, cmp_id INTEGER, component_type TEXT, field TEXT, "order" REAL);
    CREATE TABLE components_seminar_registry_facts (id INTEGER PRIMARY KEY, name TEXT, international BOOLEAN, subject TEXT, url TEXT, basis TEXT);
    CREATE TABLE components_seminar_nmo_facts (id INTEGER PRIMARY KEY, status TEXT, audience TEXT, awarded_for TEXT, url TEXT, completion_required BOOLEAN, purpose TEXT);
    CREATE TABLE components_shared_seos (id INTEGER PRIMARY KEY, seo_title TEXT);
    INSERT INTO seminars VALUES (11,'sem-a','example','/institute/section/example','Draft name','${sourceHtml}',NULL,'unconfirmed',NULL,NULL,NULL,0), (12,'sem-a','example','/institute/section/example','Published name','${sourceHtml}','2026-01-01','unconfirmed',NULL,NULL,NULL,0), (21,'sem-b','other','/institute/section/other','Other','keep',NULL,NULL,NULL,NULL,NULL,0);
    INSERT INTO institutes VALUES (1,'institute'); INSERT INTO course_groups VALUES (1,'section');
    INSERT INTO seminars_course_group_lnk VALUES (1,11,1),(2,12,1),(3,21,1); INSERT INTO course_groups_institute_lnk VALUES (1,1,1);
    INSERT INTO components_shared_seos VALUES (9,'SEO stays');
    INSERT INTO seminars_cmps VALUES (1,11,9,'shared.seo','seo',1), (2,12,9,'shared.seo','seo',1);
  `);
  return db;
}
const tables = ['seminars','seminars_cmps','components_seminar_document_records','components_seminar_document_records_cmps','components_seminar_registry_facts','components_seminar_nmo_facts','components_shared_seos'];
const rows = (db, table) => db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all().map((r) => ({...r}));
const snapshot = (db) => Object.fromEntries(tables.map((table) => [table, rows(db, table)]));
function linked(db, entity, field) {
  return db.prepare('SELECT * FROM seminars_cmps WHERE entity_id=? AND field=? ORDER BY "order"').all(entity, field).map(x => ({...x}));
}
function graph(db, id) {
  const docs = linked(db, id, 'documents');
  const registries = linked(db, id, 'training_registries');
  const nmo = linked(db, id, 'nmo');
  return { docs, registries, nmo,
    docRows: docs.map(x => ({...db.prepare('SELECT * FROM components_seminar_document_records WHERE id=?').get(x.cmp_id)})),
    registryRows: registries.map(x => ({...db.prepare('SELECT * FROM components_seminar_registry_facts WHERE id=?').get(x.cmp_id)})),
    nmoRows: nmo.map(x => ({...db.prepare('SELECT * FROM components_seminar_nmo_facts WHERE id=?').get(x.cmp_id)})),
    nested: docs.map(x => db.prepare('SELECT c.*, r.name, r.url FROM components_seminar_document_records_cmps c JOIN components_seminar_registry_facts r ON r.id=c.cmp_id WHERE c.entity_id=? AND c.field=? ORDER BY c."order"').all(x.cmp_id, 'registry').map(y => ({...y}))) };
}


for (const mode of ['throw', 'promise']) test(`documents runner callback ${mode} rolls back graph and ledger and permits retry`, async () => {
  const { capturePlan, applyPlan } = await handler(); const db = database();
  db.exec('CREATE TABLE runner_ledger (id TEXT)');
  const before = snapshot(db), plan = capturePlan(db, [proposal()]); let called = false;
  assert.throws(() => applyPlan(db, plan, { expectedPlanDigest: plan.digest, onApplied(connection, result) {
    called = true; assert.equal(connection, db); assert.ok(result);
    connection.prepare('INSERT INTO runner_ledger VALUES (?)').run('step');
    if (mode === 'throw') throw new Error('injected runner failure');
    return Promise.resolve();
  }}));
  assert.equal(called, true); assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM runner_ledger').get().n, 0);
  const receipt = applyPlan(db, plan, { expectedPlanDigest: plan.digest, onApplied(connection) { connection.prepare('INSERT INTO runner_ledger VALUES (?)').run('step'); } });
  assert.ok(receipt); assert.equal(db.prepare('SELECT count(*) AS n FROM runner_ledger').get().n, 1);
  const draft = graph(db,11), published = graph(db,12);
  assert.ok(draft.docs.length > 0 && published.docs.length > 0);
  assert.ok(draft.docs.every(x => published.docs.every(y => x.cmp_id !== y.cmp_id)));
  assert.deepEqual(rows(db,'components_shared_seos'), before.components_shared_seos);
  assert.deepEqual(rows(db,'seminars').find(x => x.id === 21), before.seminars.find(x => x.id === 21)); db.close();
});

test('documents rejects a plan not bound to the reviewed external digest', async () => {
  const { capturePlan, applyPlan } = await handler(); const db = database();
  const before = snapshot(db), plan = capturePlan(db, [proposal()]);
  assert.throws(() => applyPlan(db, plan, { expectedPlanDigest: '0'.repeat(64) }), /digest|plan|bound/i);
  assert.deepEqual(snapshot(db), before); db.close();
});
