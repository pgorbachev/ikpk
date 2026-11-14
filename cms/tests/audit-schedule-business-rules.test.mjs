import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { auditScheduleBusinessRules } from '../scripts/audit-schedule-business-rules.mjs';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE seminars(id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, duration TEXT);
    CREATE TABLE schedule_entries(id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, legacy_id TEXT, price REAL, is_free INTEGER, city TEXT, is_online INTEGER, duration TEXT);
    CREATE TABLE schedule_entries_seminar_lnk(seminar_id INTEGER, schedule_entry_id INTEGER);
    CREATE TABLE files_related_mph(id INTEGER);
    INSERT INTO seminars VALUES(1,'s',NULL,NULL),(2,'s','date',NULL);
    INSERT INTO schedule_entries VALUES(3,'e',NULL,'42',0,0,'Онлайн',NULL,'24'),(4,'e','date','42',0,0,'Онлайн',NULL,'24');
    INSERT INTO schedule_entries_seminar_lnk VALUES(1,3),(2,4);`);
  const decisions = {paid:['e'], free:[], online:[{documentId:'e',legacyId:'42',city:'Онлайн'}], acceptedExceptions:[]};
  const source=Object.fromEntries(['seminars','schedule_entries','schedule_entries_seminar_lnk','files_related_mph'].map(t=>[t,db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(r=>({...r}))]));
  const payload={sourceDigest:sha(source),decisionDigest:sha(decisions),entries:[3,4].map((id,i)=>({documentId:'e',rowId:id,published:!!i,changes:{price:null,is_online:1,city:null,duration:null}})),seminars:[1,2].map(id=>({rowId:id,documentId:'s',duration:'24 часа'})),exceptions:[]};
  return {db,decisions,plan:{...payload,planDigest:sha(payload)}};
}
function reseal(plan) { const payload={...plan}; delete payload.planDigest; return {...payload,planDigest:sha(payload)}; }
const run = ({db,plan,decisions}) => auditScheduleBusinessRules(db,{plan,decisions,expectedPlanDigest:plan.planDigest});
test('accepts two independently checked physical versions',()=>{const f=fixture();try{assert.deepEqual(run(f),{passed:true,entryVersions:2,seminarVersions:2,exceptions:0});}finally{f.db.close();}});
for (const [name,alter] of [
  ['invented price',p=>p.entries[0].changes.price=1200],
  ['missing online change',p=>delete p.entries[0].changes.is_online],
  ['changed seminar duration',p=>p.seminars[0].duration='36 часов'],
  ['omitted seminar version',p=>p.seminars.pop()],
  ['invented exception',p=>p.exceptions.push({documentId:'e',rowId:3,errors:['duration-needs-review']})],
]) test(`rejects rehashed ${name}`,()=>{const f=fixture();try{alter(f.plan);f.plan=reseal(f.plan);assert.throws(()=>run(f),/independent schedule business audit/);}finally{f.db.close();}});
test('rejects decision tampering and source drift',()=>{const f=fixture();try{f.decisions.paid=[];assert.throws(()=>run(f),/decisions/);f.decisions.paid=['e'];f.db.exec("UPDATE schedule_entries SET price=1 WHERE id=3");assert.throws(()=>run(f),/source/);}finally{f.db.close();}});
function resealSource(f){const source=Object.fromEntries(['seminars','schedule_entries','schedule_entries_seminar_lnk','files_related_mph'].map(t=>[t,f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(r=>({...r}))]));f.plan.sourceDigest=sha(source);f.plan=reseal(f.plan);}
test('disagreeing versions preserve both overrides and forbid a seminar default',()=>{const f=fixture();try{f.db.exec("UPDATE schedule_entries SET duration='36' WHERE id=4");f.plan.seminars=[];for(const e of f.plan.entries)delete e.changes.duration;resealSource(f);assert.equal(run(f).passed,true);f.plan.entries[0].changes.duration=null;f.plan=reseal(f.plan);assert.throws(()=>run(f),/unjustified/)}finally{f.db.close();}});
test('an occurrence with only a draft cannot supply a default or lose its override',()=>{const f=fixture();try{f.db.exec('DELETE FROM schedule_entries_seminar_lnk WHERE schedule_entry_id=4;DELETE FROM schedule_entries WHERE id=4');f.plan.entries=f.plan.entries.filter(e=>e.rowId!==4);f.plan.seminars=[];delete f.plan.entries[0].changes.duration;resealSource(f);assert.equal(run(f).passed,true);f.plan.entries[0].changes.duration=null;f.plan=reseal(f.plan);assert.throws(()=>run(f),/unjustified/)}finally{f.db.close();}});
test('even an accepted exception prohibits moving any duration in its group',()=>{const f=fixture();try{f.db.exec('UPDATE schedule_entries SET price=-1 WHERE id=4');f.plan.entries[1].changes={};delete f.plan.entries[0].changes.duration;f.plan.seminars=[];f.plan.exceptions=[{documentId:'e',rowId:4,errors:['paid-price-conflict']}];f.decisions.acceptedExceptions=[{documentId:'e',rowId:4,error:'paid-price-conflict'}];f.plan.decisionDigest=sha(f.decisions);resealSource(f);assert.equal(run(f).passed,true);f.plan.entries[0].changes.duration=null;f.plan=reseal(f.plan);assert.throws(()=>run(f),/unjustified/)}finally{f.db.close();}});
for(const [name,sql] of [['cross-stage link','UPDATE schedule_entries_seminar_lnk SET seminar_id=1 WHERE schedule_entry_id=4'],['duplicate link','INSERT INTO schedule_entries_seminar_lnk VALUES(1,3)'],['existing default',"UPDATE seminars SET duration='24 часа' WHERE id=1"]])test(`${name} preserves occurrence overrides`,()=>{const f=fixture();try{f.db.exec(sql);f.plan.seminars=[];for(const e of f.plan.entries)delete e.changes.duration;resealSource(f);assert.equal(run(f).passed,true);f.plan.entries[0].changes.duration=null;f.plan=reseal(f.plan);assert.throws(()=>run(f),/unjustified/)}finally{f.db.close();}});
