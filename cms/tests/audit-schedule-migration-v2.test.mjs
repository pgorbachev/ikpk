import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditScheduleMigration } from '../scripts/audit-schedule-migration-v2.mjs';
import { auditScheduleCompositionStage } from '../scripts/audit-seminar-migration-composition.mjs';
import { planScheduleDataMigration } from '../scripts/migrate-schedule-data-v2.mjs';

const Database=createRequire(import.meta.url)('better-sqlite3');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'ikpk-audit-v2-'));
  const source=join(dir,'source.db'), candidate=join(dir,'candidate.db');
  const db=new Database(source);
  db.exec(`CREATE TABLE seminars(id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, duration TEXT, title TEXT);
    CREATE TABLE schedule_entries(id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, price INTEGER, is_free INTEGER, city TEXT, is_online INTEGER, duration TEXT);
    CREATE TABLE schedule_entries_seminar_lnk(id INTEGER PRIMARY KEY, seminar_id INTEGER, schedule_entry_id INTEGER);
    CREATE TABLE files_related_mph(id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO seminars VALUES(1,'s',NULL,NULL,'name');
    INSERT INTO schedule_entries VALUES(3,'e',NULL,500,0,'Москва',0,'');
    INSERT INTO schedule_entries_seminar_lnk VALUES(1,1,3);
    INSERT INTO files_related_mph VALUES(1,'x');`);
  const tables=['seminars','schedule_entries','schedule_entries_seminar_lnk','files_related_mph'];
  const sourceRows=Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  db.close(); copyFileSync(source,candidate);
  const payload={sourceDigest:digest(sourceRows),decisionDigest:digest({}),entries:[{documentId:'e',rowId:3,published:false,changes:{}}],seminars:[],exceptions:[],durationMapping:[]};
  const plan={...payload,planDigest:digest(payload)};
  return {dir,source,candidate,plan,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
const run=f=>auditScheduleMigration({sourceDbPath:f.source,candidateDbPath:f.candidate,plan:f.plan,expectedPlanDigest:f.plan.planDigest,acceptedExceptions:[]});

test('v2 closed-world audit accepts unchanged SQL NULL and blank duration values',()=>{
  const f=fixture();try{assert.equal(run(f).passed,true);}finally{f.cleanup();}
});

test('v2 closed-world audit still rejects an unreviewed duration write',()=>{
  const f=fixture();try{const db=new Database(f.candidate);db.exec("UPDATE schedule_entries SET duration='24 часа'");db.close();assert.equal(run(f).passed,false);}finally{f.cleanup();}
});

test('the composition schedule stage selects v2 auditors for the current blank-duration plan',()=>{
  const f=fixture(),db=new Database(f.source);
  try{
    const decisions={paid:[],free:[],online:[],acceptedExceptions:[],durationMapping:[]};
    const plan=planScheduleDataMigration(db,{decisions});
    const result=auditScheduleCompositionStage({version:2,sourceDb:db,sourceDbPath:f.source,candidateDbPath:f.candidate,schedule:{plan,decisions,expectedPlanDigest:plan.planDigest}});
    assert.equal(result.business.passed,true);
    assert.equal(result.schedule.passed,true);
  }finally{db.close();f.cleanup();}
});
