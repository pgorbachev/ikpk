import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyContentPlan, rollbackContentPlan, sealContentPlan } from '../scripts/content-migration-writer.mjs';
import { auditContentMigration } from '../scripts/audit-content-migration.mjs';
import { apply as applyStep } from '../database/migrations/data-steps/reviewed-content.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = row => ({ ...row });
function transactions(db, beforeBegin = () => {}) {
  db.transaction = fn => ({ immediate() {
    beforeBegin(); db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } });
}
function snapshot(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all().map(plain);
  const data = Object.fromEntries(schema.filter(row => row.type === 'table').map(row => [row.name,
    db.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(plain)]));
  return { schema, data };
}
function fixture({ plainContent = false, setup = () => {} } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'content-adversarial-')); chmodSync(dir, 0o700);
  const sourcePath = join(dir, 'source.sqlite'), candidatePath = join(dir, 'candidate.sqlite'), proofPath = join(dir, 'proof.json');
  const child = spawnSync(process.execPath, [join(root, 'web/scripts/seminar-migration/content-proof-fixture.mjs'), sourcePath, proofPath], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  const seed = new DatabaseSync(sourcePath);
  if (plainContent) seed.exec("UPDATE seminars SET full_text=NULL; DELETE FROM seminars_cmps; DELETE FROM components_seminar_document_records_cmps; DELETE FROM components_seminar_document_records; DELETE FROM components_seminar_registry_facts; DELETE FROM components_seminar_nmo_facts; DELETE FROM ikpk_documents_migration_ledger");
  setup(seed); seed.close(); copyFileSync(sourcePath, candidatePath);
  const source = new DatabaseSync(sourcePath, { readOnly: true }), db = new DatabaseSync(candidatePath); transactions(db);
  const rows = db.prepare('SELECT * FROM seminars WHERE id IN (1,2) ORDER BY id').all().map(plain);
  const sources = rows.map(row => ({ id: row.id, document_id: row.document_id, locale: row.locale,
    description: row.description, full_text: row.full_text, learning_plan: row.learning_plan,
    learning_mode: row.learning_mode, recommendations: row.recommendations,
    version: row.published_at ? 'published' : 'draft', path: '/inst/course/slug' }));
  const renderer = 'a'.repeat(64), path = '/inst/course/slug';
  const report = { id: 2, document_id: 'doc', version: 'published', path, source_sha256: sha(JSON.stringify(sources[1])),
    sections: plainContent ? [] : ['documents'], ids: plainContent ? {} : { documents: 'documents-section' },
    aliases: plainContent ? {} : { documents: [] }, fields: { description: '<p>Text</p>' }, reasons: [] };
  const reviewEvidence = { id: 2, path, errors: [], entry: report, rendererSha256: renderer,
    documentProposal: plainContent ? null : proof.item.proposal };
  const post = { content_format: 'structured', content_section_anchors: JSON.stringify(plainContent ? {} : { documents: ['documents-section'] }),
    description: '<p>Text</p>', full_text: null, audience: null, learning_plan: null, learning_mode: null, recommendations: null };
  const entries = rows.map((row, index) => ({ id: row.id, document_id: row.document_id, version: sources[index].version,
    path, source: sources[index], preimage: row, post: { ...post }, separate: false, reviewEvidence: structuredClone(reviewEvidence) }));
  const plan = sealContentPlan({ version: 1, entries, rendererSha256: renderer,
    ...(plainContent ? {} : { documentsReceiptDigest: proof.receipt.digest, documentsPlanDigest: proof.receipt.payload.planDigest }), inputSha256: {} });
  // Keep approvals outside the mutable object being tested.
  const approvedDigest = plan.digest, file = join(dir, 'plan.json'), bytes = Buffer.from(JSON.stringify(plan));
  writeFileSync(file, bytes, { mode: 0o600 });
  return { db, source, plan, approvedDigest, file, fileSha: sha(bytes), candidatePath,
    close() { db.close(); source.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const apply = (f, extra = {}) => applyContentPlan(f.db, f.plan, { expectedPlanDigest: f.approvedDigest, ...extra });
const audit = f => auditContentMigration(f.source, f.db, { plan: f.plan, expectedPlanDigest: f.approvedDigest });

test('unmodified approved plan passes full audit and rollback restores every source table', () => {
  const f = fixture();
  try {
    const before = snapshot(f.db), receipt = apply(f);
    assert.deepEqual(audit(f), { passed: true, versions: 2, seminars: 1, documents: 1 });
    rollbackContentPlan(f.db, receipt);
    const after = snapshot(f.db);
    delete after.data.ikpk_content_migration_ledger;
    after.schema = after.schema.filter(row => row.tbl_name !== 'ikpk_content_migration_ledger');
    assert.deepEqual(after, before);
  } finally { f.close(); }
});

test('re-sealing changed targets cannot replace the independently held plan pin', () => {
  const f = fixture();
  try {
    const before = snapshot(f.db);
    for (const entry of f.plan.payload.entries) {
      entry.post.description = '<p>Unreviewed</p>';
      entry.reviewEvidence.entry.fields.description = entry.post.description;
    }
    f.plan.digest = sha(JSON.stringify(f.plan.payload));
    assert.throws(() => apply(f), /digest/); assert.deepEqual(snapshot(f.db), before);
  } finally { f.close(); }
});

test('file pin catches changed bytes even when parsed plan and its digest are unchanged', () => {
  const f = fixture();
  try {
    const before = snapshot(f.db); writeFileSync(f.file, `${JSON.stringify(f.plan)}\n`);
    assert.throws(() => applyStep(f.db, { reviewFilePath: f.file, expectedReviewFileSha256: f.fileSha, expectedPlanDigest: f.approvedDigest }), /hash mismatch/);
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.close(); }
});

for (const id of [1, 2]) test(`concurrent edit after preflight is preserved and refuses the transaction: row ${id}`, () => {
  const f = fixture();
  try {
    let expected;
    transactions(f.db, () => {
      const editor = new DatabaseSync(f.candidatePath);
      editor.prepare('UPDATE seminars SET description=? WHERE id=?').run('Concurrent edit', id);
      editor.close(); expected = snapshot(f.db);
    });
    assert.throws(() => apply(f), /changed|mismatch/);
    assert.deepEqual(snapshot(f.db), expected);
  } finally { f.close(); }
});

for (const [name, sql] of [
  ['document relation', "DELETE FROM seminars_cmps WHERE entity_id=2 AND field='documents'"],
  ['nested registry URL', "UPDATE components_seminar_registry_facts SET url='https://example.test/unreviewed'"],
  ['document ledger', "UPDATE ikpk_documents_migration_ledger SET status='rolled_back'"],
]) test(`document proof is checked again after preflight: ${name}`, () => {
  const f = fixture();
  try {
    let expected;
    transactions(f.db, () => {
      const editor = new DatabaseSync(f.candidatePath); editor.exec(sql); editor.close(); expected = snapshot(f.db);
    });
    assert.throws(() => apply(f)); assert.deepEqual(snapshot(f.db), expected);
  } finally { f.close(); }
});

for (const mode of ['throw', 'promise']) test(`runner ${mode} rolls back content, graph, DDL and ledger together and permits retry`, () => {
  const f = fixture();
  try {
    const before = snapshot(f.db);
    assert.throws(() => apply(f, { onApplied(db) {
      db.exec("CREATE TABLE runner_probe(id TEXT); INSERT INTO runner_probe VALUES('step'); UPDATE components_seminar_document_records SET issuer='callback edit'");
      if (mode === 'throw') throw new Error('runner failed');
      return Promise.resolve();
    } }), /runner failed|synchronous/);
    assert.deepEqual(snapshot(f.db), before);
    apply(f); assert.equal(audit(f).passed, true);
    const applied = snapshot(f.db);
    assert.throws(() => apply(f)); assert.deepEqual(snapshot(f.db), applied);
  } finally { f.close(); }
});

for (const [name, sql] of [
  ['duplicate plan entry', plan => plan.payload.entries.push(structuredClone(plan.payload.entries[0]))],
  ['duplicate version within a pair', plan => { plan.payload.entries[1].version = 'draft'; }],
  ['unsupported hidden field', plan => { plan.payload.entries[0].post.documents_owner_verified = 1; }],
  ['duplicate anchor alias', plan => {
    for (const entry of plan.payload.entries) {
      entry.reviewEvidence.entry.aliases.documents = ['documents-section'];
      entry.post.content_section_anchors = JSON.stringify({ documents: ['documents-section', 'documents-section'] });
    }
  }],
]) test(`malformed approved plan still refuses atomically: ${name}`, () => {
  const f = fixture();
  try {
    sql(f.plan); f.plan.digest = sha(JSON.stringify(f.plan.payload)); const before = snapshot(f.db);
    assert.throws(() => applyContentPlan(f.db, f.plan, { expectedPlanDigest: f.plan.digest }));
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.close(); }
});

for (const [name, triggerBody] of [
  ['already checked seminar row', "UPDATE seminars SET description='trigger edit' WHERE id=1;"],
  ['reviewed document graph', "UPDATE components_seminar_registry_facts SET url='https://example.test/trigger';"],
]) test(`final apply readback refuses trigger changes to ${name} and rolls everything back`, () => {
  const f = fixture({ setup(db) {
    db.exec(`CREATE TRIGGER late_side_effect AFTER UPDATE OF content_format ON seminars WHEN NEW.id=2 AND NEW.content_format='structured' BEGIN ${triggerBody} END`);
  } });
  try {
    const before = snapshot(f.db);
    assert.throws(() => apply(f), /postimage|graph|changed|audit|readback/i);
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.close(); }
});

test('rollback rechecks all restored rows after the final update, not only each row immediately', () => {
  const f = fixture({ setup(db) {
    db.exec("CREATE TRIGGER rollback_side_effect AFTER UPDATE OF content_format ON seminars WHEN OLD.content_format='structured' AND NEW.content_format IS NULL AND NEW.id=2 BEGIN UPDATE seminars SET description='late rollback edit' WHERE id=1; END");
  } });
  try {
    const receipt = apply(f), before = snapshot(f.db);
    assert.throws(() => rollbackContentPlan(f.db, receipt), /readback|changed|preimage|postimage/i);
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.close(); }
});

function duplicatePhysicalVersion(db) {
  db.exec("INSERT INTO seminars SELECT 3,document_id,locale,slug,legacy_id,description,full_text,learning_plan,learning_mode,recommendations,published_at,content_format,audience,content_section_anchors,documents_state,documents_confirmation_date,documents_confirmation_source,documents_confirmation_author,documents_owner_verified FROM seminars WHERE id=2; INSERT INTO seminars_course_group_lnk VALUES(3,3,1)");
}

test('plain-content plan cannot migrate two selected rows while an unreviewed third version exists', () => {
  const f = fixture({ plainContent: true, setup: duplicatePhysicalVersion });
  try {
    const before = snapshot(f.db);
    assert.throws(() => apply(f), /version|duplicate|physical|identity|inventory/i);
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.close(); }
});

test('independent audit rejects omitted physical versions even if writer and receipt agree', () => {
  const f = fixture({ plainContent: true, setup: duplicatePhysicalVersion });
  try {
    // Apply the two declared rows manually: audit must not depend on the writer's validation.
    const entries = f.plan.payload.entries.map(item => {
      const keys = Object.keys(item.post);
      f.db.prepare(`UPDATE seminars SET ${keys.map(key => `"${key}"=?`).join(',')} WHERE id=?`).run(...keys.map(key => item.post[key]), item.id);
      return { id: item.id, preimage: item.preimage, postimage: plain(f.db.prepare('SELECT * FROM seminars WHERE id=?').get(item.id)) };
    });
    const payload = { version: 1, planDigest: f.approvedDigest, entries, documentIds: [] };
    const receipt = { payload, digest: sha(JSON.stringify(payload)) };
    f.db.exec('CREATE TABLE ikpk_content_migration_ledger (plan_digest TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, status TEXT NOT NULL)');
    f.db.prepare('INSERT INTO ikpk_content_migration_ledger VALUES(?,?,?)').run(f.approvedDigest, JSON.stringify(receipt), 'applied');
    assert.throws(() => audit(f), /version|duplicate|physical|identity|inventory/i);
  } finally { f.close(); }
});

for (const [name, sql] of [
  ['hidden unrelated table', "CREATE TABLE hidden_data(id INTEGER, value TEXT); INSERT INTO hidden_data VALUES(1,'new')"],
  ['changed source link', 'UPDATE seminars_course_group_lnk SET course_group_id=999 WHERE seminar_id=1'],
  ['changed registry link', "UPDATE components_seminar_registry_facts SET url='https://example.test/substituted'"],
  ['deleted physical row', 'DELETE FROM seminars WHERE id=2'],
  ['modified receipt', "UPDATE ikpk_content_migration_ledger SET receipt_json='{}'"],
  ['hidden ledger trigger', 'CREATE TRIGGER hidden_ledger AFTER INSERT ON ikpk_content_migration_ledger BEGIN SELECT 1; END'],
]) test(`independent audit rejects ${name} without changing either database`, () => {
  const f = fixture();
  try {
    apply(f); f.db.exec(sql); const before = snapshot(f.db), sourceBefore = snapshot(f.source);
    assert.throws(() => audit(f));
    assert.deepEqual(snapshot(f.db), before); assert.deepEqual(snapshot(f.source), sourceBefore);
  } finally { f.close(); }
});

test('successful callback cannot replace the final expected postimage by mutating its receipt', () => {
  const f = fixture();
  try {
    const before = snapshot(f.db);
    assert.throws(() => apply(f, { onApplied(db, receipt) {
      db.exec("UPDATE seminars SET description='callback substitution' WHERE id=1");
      receipt.payload.entries.find(entry => entry.id === 1).postimage.description = 'callback substitution';
      receipt.digest = sha(JSON.stringify(receipt.payload));
      db.prepare('UPDATE ikpk_content_migration_ledger SET receipt_json=? WHERE plan_digest=?')
        .run(JSON.stringify(receipt), receipt.payload.planDigest);
    } }), /postimage|receipt|changed|review/i);
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.close(); }
});

for (const phase of ['apply', 'rollback']) test(`plain-content ${phase} refuses route changes caused by its last UPDATE`, () => {
  const f = fixture({ plainContent: true, setup(db) {
    const condition = phase === 'apply' ? "NEW.content_format='structured'" : "OLD.content_format='structured' AND NEW.content_format IS NULL";
    db.exec(`CREATE TRIGGER route_side_effect AFTER UPDATE OF content_format ON seminars WHEN NEW.id=2 AND ${condition} BEGIN UPDATE course_groups SET slug='unreviewed-route' WHERE id=1; END`);
  } });
  try {
    const receipt = phase === 'rollback' ? apply(f) : null;
    const before = snapshot(f.db);
    assert.throws(() => phase === 'apply' ? apply(f) : rollbackContentPlan(f.db, receipt), /route|link|changed|postimage|readback/i);
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.close(); }
});

test('independent audit enforces the writer rule against document components shared with another seminar', () => {
  const f = fixture({ setup(db) {
    db.exec("INSERT INTO seminars SELECT 3,'other-doc',locale,'other','/inst/course/other',description,full_text,learning_plan,learning_mode,recommendations,NULL,content_format,audience,content_section_anchors,documents_state,documents_confirmation_date,documents_confirmation_source,documents_confirmation_author,documents_owner_verified FROM seminars WHERE id=1; INSERT INTO seminars_course_group_lnk VALUES(3,3,1)");
    db.exec("INSERT INTO seminars_cmps(entity_id,cmp_id,component_type,field,\"order\") SELECT 3,cmp_id,component_type,field,\"order\" FROM seminars_cmps WHERE entity_id=1 AND field='documents'");
  } });
  try {
    const before = snapshot(f.db);
    assert.throws(() => apply(f), /shared/);
    assert.deepEqual(snapshot(f.db), before);
    // Bypass the writer deliberately: independent audit must detect the same invalid graph.
    const entries = f.plan.payload.entries.map(item => {
      const keys = Object.keys(item.post);
      f.db.prepare(`UPDATE seminars SET ${keys.map(key => `"${key}"=?`).join(',')} WHERE id=?`).run(...keys.map(key => item.post[key]), item.id);
      return { id: item.id, preimage: item.preimage, postimage: plain(f.db.prepare('SELECT * FROM seminars WHERE id=?').get(item.id)) };
    });
    const payload = { version: 1, planDigest: f.approvedDigest, entries, documentIds: ['doc'],
      documentsReceiptDigest: f.plan.payload.documentsReceiptDigest, documentsPlanDigest: f.plan.payload.documentsPlanDigest };
    const receipt = { payload, digest: sha(JSON.stringify(payload)) };
    f.db.exec('CREATE TABLE ikpk_content_migration_ledger (plan_digest TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, status TEXT NOT NULL)');
    f.db.prepare('INSERT INTO ikpk_content_migration_ledger VALUES(?,?,?)').run(f.approvedDigest, JSON.stringify(receipt), 'applied');
    assert.throws(() => audit(f), /shared|exclusive|graph/i);
  } finally { f.close(); }
});
