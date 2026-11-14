// Contract tests for a proposed migration writer; use only an isolated SQLite database.
// node --test scripts/tests/documents-migration-writer-red.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const handler = async () => { const mod = await import('../../cms/scripts/documents-migration-writer.mjs'); return {...mod, capturePlan: (db, items) => mod.capturePlan(db, items.map(item => ({...item, reviewedPreimages: mod.inspectVersions(db, item.documentId)}))), applyPlan: (db, plan) => mod.applyPlan(db, plan, { expectedPlanDigest: plan.digest })}; };
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

test('capture is read-only and apply preserves version-local graphs, order, links and provenance', async () => {
  const { capturePlan, applyPlan } = await handler(); const db = database();
  const before = snapshot(db); const input = proposal(); const plan = capturePlan(db, [input]);
  assert.deepEqual(snapshot(db), before);
  const receipt = applyPlan(db, plan); assert.ok(receipt);
  for (const id of [11,12]) {
    const g = graph(db,id);
    assert.deepEqual(g.docRows.map(x => x.document), ['Первый','Второй']);
    assert.deepEqual(g.registryRows.map(x => [x.name,x.url]), [['Обучение 1','https://example.test/training'],['Обучение 2',null]]);
    assert.deepEqual(g.nested[0].map(x => [x.name,x.url]), [['Реестр документа','https://example.test/cert'],['Второй реестр','https://example.test/second']]);
    assert.equal(g.nmoRows[0].url,'https://example.test/nmo');
    const actual = {...db.prepare('SELECT * FROM seminars WHERE id=?').get(id)};
    const original = before.seminars.find(x => x.id === id);
    for (const key of ['document_id','slug','legacy_id','name','full_text','published_at','documents_owner_verified']) assert.equal(actual[key], original[key], key);
    assert.equal(actual.documents_confirmation_date, '2026-11-13');
    assert.equal(actual.documents_confirmation_author, 'Миграция контента');
    assert.match(actual.documents_confirmation_source, /Перенесено из опубликованной панели/);
    assert.match(actual.documents_confirmation_source, new RegExp(sha(sourceHtml)));
    assert.equal(actual.documents_state,'issued');
  }
  for (const key of ['docs','registries','nmo']) assert.ok(graph(db,11)[key].every(x => !graph(db,12)[key].some(y => y.cmp_id === x.cmp_id)), `${key}: physical versions must not share mutable components`);
  const draftRegistryIds = [...graph(db,11).registries.map(x => x.cmp_id), ...graph(db,11).nested.flat().map(x => x.cmp_id)];
  const publishedRegistryIds = [...graph(db,12).registries.map(x => x.cmp_id), ...graph(db,12).nested.flat().map(x => x.cmp_id)];
  assert.ok(draftRegistryIds.every(id => !publishedRegistryIds.includes(id)));
  assert.deepEqual(rows(db,'components_shared_seos'),before.components_shared_seos);
  assert.deepEqual(linked(db,11,'seo'),before.seminars_cmps.filter(x => x.entity_id === 11 && x.field === 'seo'));
  db.close();
});

test('both physical versions are compared with the captured pre-image atomically', async () => {
  const { capturePlan, applyPlan } = await handler();
  for (const id of [11,12]) {
    const db=database(), plan=capturePlan(db,[proposal()]);
    db.prepare('UPDATE seminars SET name=? WHERE id=?').run('editor changed',id);
    const changed=snapshot(db); assert.throws(() => applyPlan(db,plan)); assert.deepEqual(snapshot(db),changed); db.close();
  }
});

test('a changed existing component graph is also an editor conflict', async () => {
  const { capturePlan, applyPlan } = await handler(); const db=database();
  db.exec("INSERT INTO components_seminar_document_records (id,document) VALUES (50,'старый'); INSERT INTO seminars_cmps VALUES (50,12,50,'seminar.document-record','documents',1)");
  const plan=capturePlan(db,[proposal()]); db.exec("UPDATE components_seminar_document_records SET document='правка' WHERE id=50");
  const changed=snapshot(db); assert.throws(() => applyPlan(db,plan)); assert.deepEqual(snapshot(db),changed); db.close();
});

test('repeat is a no-op or refusal and never overwrites a later edit', async () => {
  const { capturePlan, applyPlan } = await handler(); const db=database(); const plan=capturePlan(db,[proposal()]);
  applyPlan(db,plan); let state=snapshot(db); try { applyPlan(db,plan); } catch {} assert.deepEqual(snapshot(db),state);
  db.exec("UPDATE seminars SET name='поздняя правка' WHERE id=11"); state=snapshot(db);
  try { applyPlan(db,plan); } catch {} assert.deepEqual(snapshot(db),state); db.close();
});

test('rollback restores captured pre-image and refuses if post-image has changed', async () => {
  const { capturePlan, applyPlan, rollbackPlan } = await handler();
  { const db=database(), before=snapshot(db), plan=capturePlan(db,[proposal()]), receipt=applyPlan(db,plan); rollbackPlan(db,receipt); assert.deepEqual(snapshot(db),before); db.close(); }
  { const db=database(), plan=capturePlan(db,[proposal()]), receipt=applyPlan(db,plan);
    db.exec("UPDATE components_seminar_nmo_facts SET audience='поздняя правка' WHERE id=(SELECT cmp_id FROM seminars_cmps WHERE entity_id=12 AND field='nmo')");
    const changed=snapshot(db); assert.throws(() => rollbackPlan(db,receipt)); assert.deepEqual(snapshot(db),changed); db.close(); }
});

test('review-only or unapproved proposals cannot be written even when other flags are changed', async () => {
  const { capturePlan, applyPlan } = await handler();
  for (const overrides of [{readyForReviewOnly:true}, {approved:false}, {eligibleForAutomaticWrite:false}, {approved:undefined}]) {
    const db=database(), before=snapshot(db), item={...proposal(),...overrides};
    assert.throws(() => { const plan=capturePlan(db,[item]); applyPlan(db,plan); });
    assert.deepEqual(snapshot(db),before); db.close();
  }
});

test('captured source hash must match exact source HTML and cannot be swapped after capture', async () => {
  const { capturePlan, applyPlan } = await handler(); const db=database(), before=snapshot(db);
  assert.throws(() => capturePlan(db,[{...proposal(),sourceSha256:sha('other')}])); assert.deepEqual(snapshot(db),before);
  const plan=capturePlan(db,[proposal()]);
  // A changed plan must not be allowed to impersonate the captured source or approval.
  const altered=structuredClone(plan); const text=JSON.stringify(altered).replaceAll(sha(sourceHtml),sha('other'));
  assert.notEqual(text,JSON.stringify(plan)); assert.throws(() => applyPlan(db,JSON.parse(text))); assert.deepEqual(snapshot(db),before); db.close();
});


test('existing structured graph is never overwritten', async () => {
  const { capturePlan, applyPlan, rollbackPlan } = await handler(); const db=database();
  db.exec("INSERT INTO components_seminar_document_records (id,document) VALUES (50,'до переноса'); INSERT INTO seminars_cmps VALUES (50,12,50,'seminar.document-record','documents',1); INSERT INTO components_seminar_registry_facts (id,name,url) VALUES (51,'старый реестр','https://example.test/old'); INSERT INTO components_seminar_document_records_cmps VALUES (51,50,51,'seminar.registry-fact','registry',1)");
  const before=snapshot(db); assert.throws(() => applyPlan(db,capturePlan(db,[proposal()]))); assert.deepEqual(snapshot(db),before); db.close();
});


test('each physical version must be explicitly reviewed before capture', async () => {
  const {inspectVersions,capturePlan}=await import('../../cms/scripts/documents-migration-writer.mjs'); const db=database(), item=proposal();
  assert.throws(()=>capturePlan(db,[item]));
  const versions=inspectVersions(db,item.documentId);
  assert.throws(()=>capturePlan(db,[{...item,reviewedPreimages:versions.slice(0,1)}]));
  db.exec("UPDATE seminars SET name='new draft' WHERE id=11");
  assert.throws(()=>capturePlan(db,[{...item,reviewedPreimages:versions}])); db.close();
});

test('source route cannot silently refer to another seminar', async () => {
  const { capturePlan } = await handler(); const db = database();
  assert.throws(() => capturePlan(db, [{ ...proposal(), route: '/section/other' }]), /route|identity/i);
  db.close();
});

test('changing a parent route after review blocks the whole transaction', async () => {
  const { capturePlan, applyPlan } = await handler(); const db = database();
  const plan = capturePlan(db, [proposal()]);
  db.exec("UPDATE course_groups SET slug='renamed' WHERE id=1");
  const changed = snapshot(db);
  assert.throws(() => applyPlan(db, plan), /preimage|route|changed/i);
  assert.deepEqual(snapshot(db), changed);
  db.close();
});

test('failure after first physical version rolls back every write', async () => {
  const {capturePlan,applyPlan}=await handler(); const db=database(), before=snapshot(db);
  const plan=capturePlan(db,[proposal()]);
  db.exec("CREATE TRIGGER fail_second BEFORE UPDATE OF documents_state ON seminars WHEN NEW.id=12 BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  assert.throws(()=>applyPlan(db,plan)); assert.deepEqual(snapshot(db),before); db.close();
});

test('rollback refuses to remove components linked from another seminar', async () => {
  const {capturePlan,applyPlan,rollbackPlan}=await handler(); const db=database(), receipt=applyPlan(db,capturePlan(db,[proposal()]));
  db.exec("INSERT INTO seminars_cmps (entity_id,cmp_id,component_type,field,\"order\") SELECT 21,cmp_id,component_type,field,1 FROM seminars_cmps WHERE entity_id=11 AND field='nmo'");
  const changed=snapshot(db); assert.throws(()=>rollbackPlan(db,receipt)); assert.deepEqual(snapshot(db),changed); db.close();
});
