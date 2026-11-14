import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { describeSeminarSchemaSync, auditSeminarSchemaSync } from '../scripts/audit-seminar-schema-sync.mjs';
const sha = x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const additions={schedule_entries:['is_online'],seminars:['audience','content_format','content_section_anchors','documents_owner_verified','duration'],components_seminar_document_records:['completion_after_seminar_number','completion_cycle_name','completion_required','completion_scope','document_on_template','document_type_unspecified','hours_may_vary','hours_mode','includes_completed_level','issuer_unknown','other_seminar_href','other_seminar_label','qualification_topic','regulation_issuer','regulation_url','signed_by']};
const managed=['admin_permissions','admin_permissions_role_lnk','strapi_core_store_settings','strapi_database_schema'];
function fixture() {
  const source=new DatabaseSync(':memory:'),candidate=new DatabaseSync(':memory:');
  for (const db of [source,candidate]) {
    for (const t of [...Object.keys(additions),...managed,'other']) db.exec(`CREATE TABLE ${t}(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO ${t} VALUES(1,'original')`);
  }
  for (const [t,cols] of Object.entries(additions)) for (const c of cols) candidate.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`);
  for(const t of ['components_seminar_document_records_cmps','components_seminar_nmo_facts','components_seminar_registry_facts'])candidate.exec(`CREATE TABLE ${t}(id INTEGER PRIMARY KEY)`);
  candidate.exec("UPDATE admin_permissions SET value='reviewed change'");
  const contract=describeSeminarSchemaSync(source,candidate),digest=sha(contract);
  return {source,candidate,contract,digest,run(){return auditSeminarSchemaSync(source,candidate,{contract,expectedContractDigest:digest})},close(){source.close();candidate.close();}};
}
test('checks reviewed schema and every ordinary row',()=>{const f=fixture();try{assert.equal(f.run().passed,true)}finally{f.close()}});
for (const [name,sql] of [
  ['unreviewed managed row',"UPDATE admin_permissions SET value='other'"],
  ['ordinary row',"UPDATE other SET value='other'"],
  ['populated added field',"UPDATE seminars SET duration='16'"],
  ['unexpected table','CREATE TABLE surprise(id INTEGER)'],
  ['unexpected extra column','ALTER TABLE other ADD COLUMN surprise TEXT'],
  ['nonempty new component','INSERT INTO components_seminar_nmo_facts VALUES(1)'],
]) test(`refuses ${name}`,()=>{const f=fixture();try{f.candidate.exec(sql);assert.throws(()=>f.run(),/seminar schema audit/)}finally{f.close()}});
test('cannot authorize a modified contract by its self-declared digest',()=>{const f=fixture();try{f.contract.sourceSchema='x';assert.throws(()=>f.run(),/digest/)}finally{f.close()}});
