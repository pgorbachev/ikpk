import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { inspectVersions,capturePlan,applyPlan } from '../scripts/documents-migration-writer.mjs';
import { auditDocumentsMigration } from '../scripts/audit-documents-migration.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
function db(){const d=new DatabaseSync(':memory:');d.exec(`
 CREATE TABLE seminars(id INTEGER PRIMARY KEY,document_id TEXT,slug TEXT,legacy_id TEXT,name TEXT,published_at TEXT,documents_state TEXT,documents_confirmation_date TEXT,documents_confirmation_source TEXT,documents_confirmation_author TEXT,documents_owner_verified BOOLEAN);
 CREATE TABLE institutes(id INTEGER PRIMARY KEY,slug TEXT);CREATE TABLE course_groups(id INTEGER PRIMARY KEY,slug TEXT);
 CREATE TABLE seminars_course_group_lnk(id INTEGER PRIMARY KEY,seminar_id INTEGER,course_group_id INTEGER);CREATE TABLE course_groups_institute_lnk(id INTEGER PRIMARY KEY,course_group_id INTEGER,institute_id INTEGER);
 CREATE TABLE seminars_cmps(id INTEGER PRIMARY KEY,entity_id INTEGER,cmp_id INTEGER,component_type TEXT,field TEXT,"order" REAL);
 CREATE TABLE components_seminar_document_records(id INTEGER PRIMARY KEY,document TEXT,issuer TEXT,issuer_unknown BOOLEAN,prior_education TEXT,prior_education_note TEXT,outcome TEXT,basis TEXT,completion_scope TEXT,other_seminar_href TEXT,other_seminar_label TEXT,signed_by TEXT,qualification_topic TEXT,hours_mode TEXT,includes_completed_level BOOLEAN,completion_required BOOLEAN,completion_after_seminar_number INTEGER,completion_cycle_name TEXT,hours_may_vary BOOLEAN,regulation_url TEXT,document_type_unspecified BOOLEAN,regulation_issuer TEXT,document_on_template BOOLEAN);
 CREATE TABLE components_seminar_document_records_cmps(id INTEGER PRIMARY KEY,entity_id INTEGER,cmp_id INTEGER,component_type TEXT,field TEXT,"order" REAL);
 CREATE TABLE components_seminar_registry_facts(id INTEGER PRIMARY KEY,name TEXT,international BOOLEAN,subject TEXT,url TEXT,basis TEXT);
 CREATE TABLE components_seminar_nmo_facts(id INTEGER PRIMARY KEY,status TEXT,audience TEXT,awarded_for TEXT,url TEXT,completion_required BOOLEAN,purpose TEXT);
 INSERT INTO seminars VALUES(1,'s','slug','/i/c/slug','draft',NULL,'unconfirmed',NULL,NULL,NULL,0),(2,'s','slug','/i/c/slug','published','date','unconfirmed',NULL,NULL,NULL,0);
 INSERT INTO institutes VALUES(1,'i');INSERT INTO course_groups VALUES(1,'c');INSERT INTO seminars_course_group_lnk VALUES(1,1,1),(2,2,1);INSERT INTO course_groups_institute_lnk VALUES(1,1,1);
 `);return d;}
function fixture(){const source=db(),candidate=db();const html='<p>source</p>';const item={documentId:'s',route:'/i/c/slug',sourceHtml:html,sourceSha256:sha(html),snapshotSha256:'a'.repeat(64),sourceLinks:[],rulesVersion:'v1',approved:true,eligibleForAutomaticWrite:true,readyForReviewOnly:false,migrationDate:'2026-11-13',migrationAuthor:'editor',proposal:{documents_state:'issued',documents:[{document:'Certificate',registry:[{name:'Registry',subject:'document'}]}],training_registries:[{name:'Training',subject:'training'}],nmo:{status:'possible',audience:'Doctors'}}};item.reviewedPreimages=inspectVersions(source,'s');const plan=capturePlan(source,[item]);applyPlan(candidate,plan,{expectedPlanDigest:plan.digest});return{source,candidate,plan,run(){return auditDocumentsMigration(source,candidate,{plan,expectedPlanDigest:plan.digest});},close(){source.close();candidate.close();}};}
test('verifies every proposed field, graph and source version',()=>{const f=fixture();try{const r=f.run();assert.equal(r.passed,true);assert.equal(r.versions,2)}finally{f.close()}});
for(const [label,sql] of [
 ['document field',"UPDATE components_seminar_document_records SET document='wrong' WHERE id=1"],
 ['provenance',"UPDATE seminars SET documents_confirmation_author='wrong' WHERE id=1"],
 ['nested link order','UPDATE components_seminar_document_records_cmps SET "order"=3 WHERE id=1'],
 ['nested registry value',"UPDATE components_seminar_registry_facts SET name='wrong' WHERE id=1"],
 ['orphan registry',"INSERT INTO components_seminar_registry_facts(id,name) VALUES(900,'orphan')"],
 ['shared component',"INSERT INTO seminars_cmps VALUES(900,2,1,'seminar.document-record','documents',2)"],
 ['unrelated content',"UPDATE seminars SET name='wrong' WHERE id=1"],
 ['unrelated schema','CREATE INDEX surprise ON seminars(name)'],
 ['ledger identity',"UPDATE ikpk_documents_migration_ledger SET plan_digest='wrong'"],
])test(`refuses ${label}`,()=>{const f=fixture();try{f.candidate.exec(sql);assert.throws(()=>f.run(),/independent documents audit/)}finally{f.close()}});
test('refuses externally unreviewed plan',()=>{const f=fixture();try{assert.throws(()=>auditDocumentsMigration(f.source,f.candidate,{plan:f.plan,expectedPlanDigest:'0'.repeat(64)}),/digest/)}finally{f.close()}});
test('rejects rehashed receipt with forged rollback preimage',()=>{const f=fixture();try{const receipt=JSON.parse(f.candidate.prepare('SELECT receipt_json FROM ikpk_documents_migration_ledger').get().receipt_json);receipt.payload.entries[0].preimage[0].row.name='forged';receipt.digest=sha(JSON.stringify(receipt.payload));f.candidate.prepare('UPDATE ikpk_documents_migration_ledger SET receipt_json=?').run(JSON.stringify(receipt));assert.throws(()=>f.run(),/preimage or postimage/)}finally{f.close()}});
