import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, copyFileSync, readFileSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planScheduleDataMigration } from '../scripts/migrate-schedule-data.mjs';
import { apply, readReviewedScheduleFile } from '../database/migrations/data-steps/reviewed-schedule.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => ({ immediate() { db.exec('BEGIN IMMEDIATE'); try { const r=fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } });
  db.exec(`CREATE TABLE seminars(id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, duration TEXT);
    CREATE TABLE schedule_entries(id INTEGER PRIMARY KEY, document_id TEXT, published_at TEXT, legacy_id TEXT, price REAL, is_free INTEGER, city TEXT, is_online INTEGER, duration TEXT);
    CREATE TABLE schedule_entries_seminar_lnk(seminar_id INTEGER, schedule_entry_id INTEGER);
    CREATE TABLE files_related_mph(id INTEGER);
    CREATE TABLE ledger(id TEXT);
    INSERT INTO seminars VALUES(1,'s',NULL,NULL);
    INSERT INTO schedule_entries VALUES(3,'e',NULL,'42',0,0,'Онлайн',NULL,'24');
    INSERT INTO schedule_entries_seminar_lnk VALUES(1,3);`);
  const decisions={paid:['e'],free:[],online:[{documentId:'e',legacyId:'42',city:'Онлайн'}],acceptedExceptions:[]};
  const plan=planScheduleDataMigration(db,{decisions});
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'reviewed-schedule-'));chmodSync(dir,0o700);
  const file=join(dir,'review.json'), bytes=Buffer.from(JSON.stringify({decisions,plan}));writeFileSync(file,bytes,{mode:0o600});
  return {db,dir,file,plan,decisions,expectedReviewFileSha256:sha(bytes),expectedPlanDigest:plan.planDigest,cleanup(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
const options=f=>({reviewFilePath:f.file,expectedReviewFileSha256:f.expectedReviewFileSha256,expectedPlanDigest:f.expectedPlanDigest});
test('approved file writes and ledger callback in the same transaction',()=>{const f=fixture();try{apply(f.db,{...options(f),onApplied(db){db.exec("INSERT INTO ledger VALUES('done')");}});assert.equal(f.db.prepare('SELECT price FROM schedule_entries').get().price,null);assert.equal(f.db.prepare('SELECT count(*) n FROM ledger').get().n,1);}finally{f.cleanup();}});
test('accepted paid-price conflicts preserve zero while independent offline and inherited duration fields migrate',()=>{const f=fixture();try{
  f.db.exec("INSERT INTO seminars VALUES(2,'s','date',NULL);INSERT INTO schedule_entries VALUES(4,'e','date','42',0,0,'Онлайн',NULL,'24');INSERT INTO schedule_entries_seminar_lnk VALUES(2,4)");
  f.db.exec("UPDATE schedule_entries SET city='Москва',price=0,is_online=NULL");
  f.decisions.paid=[];f.decisions.online=[];
  f.decisions.acceptedExceptions=[3,4].map(rowId=>({documentId:'e',rowId,error:'paid-price-conflict'}));
  f.plan=planScheduleDataMigration(f.db,{decisions:f.decisions});
  assert.deepEqual(f.plan.entries.map(entry=>entry.changes),[
    {is_online:0,duration:null},{is_online:0,duration:null},
  ]);
  assert.deepEqual(f.plan.seminars,[{rowId:1,documentId:'s',duration:'24 часа'},{rowId:2,documentId:'s',duration:'24 часа'}]);
  const bytes=Buffer.from(JSON.stringify({decisions:f.decisions,plan:f.plan}));
  writeFileSync(f.file,bytes,{mode:0o600});f.expectedReviewFileSha256=sha(bytes);f.expectedPlanDigest=f.plan.planDigest;
  apply(f.db,options(f));
  assert.deepEqual(f.db.prepare('SELECT price,is_free,city,is_online,duration FROM schedule_entries ORDER BY id').all().map(row=>({...row})),[
    {price:0,is_free:0,city:'Москва',is_online:0,duration:null},
    {price:0,is_free:0,city:'Москва',is_online:0,duration:null},
  ]);
  assert.deepEqual(f.db.prepare('SELECT duration FROM seminars ORDER BY id').all().map(row=>({...row})),[
    {duration:'24 часа'},{duration:'24 часа'},
  ]);
}finally{f.cleanup();}});
test('callback failure rolls back both ledger and migration',()=>{const f=fixture();try{assert.throws(()=>apply(f.db,{...options(f),onApplied(db){db.exec("INSERT INTO ledger VALUES('done')");throw Error('failure');}}),/failure/);assert.equal(f.db.prepare('SELECT price FROM schedule_entries').get().price,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ledger').get().n,0);}finally{f.cleanup();}});
test('refuses changed bytes, mismatched external digest and insecure permissions',()=>{const f=fixture();try{assert.throws(()=>readReviewedScheduleFile(f.file,'0'.repeat(64),f.expectedPlanDigest),/hash mismatch/);assert.throws(()=>readReviewedScheduleFile(f.file,f.expectedReviewFileSha256,'0'.repeat(64)),/approved plan/);chmodSync(f.file,0o644);assert.throws(()=>readReviewedScheduleFile(f.file,f.expectedReviewFileSha256,f.expectedPlanDigest),/owner-only/);chmodSync(f.file,0o600);writeFileSync(f.file,'{}');assert.throws(()=>readReviewedScheduleFile(f.file,f.expectedReviewFileSha256,f.expectedPlanDigest),/hash mismatch/);}finally{f.cleanup();}});
test('refuses symlink and source changes on resume',()=>{const f=fixture();try{const link=join(f.dir,'link.json');symlinkSync(f.file,link);assert.throws(()=>readReviewedScheduleFile(link,f.expectedReviewFileSha256,f.expectedPlanDigest));f.db.exec('UPDATE schedule_entries SET price=5');assert.throws(()=>apply(f.db,options(f)),/source/);}finally{f.cleanup();}});
test('reviewed schedule refuses changed bytes in its imported planner dependency',async()=>{const f=fixture();const artifact=mkdtempSync(join(realpathSync(tmpdir()),'reviewed-schedule-dependency-'));chmodSync(artifact,0o700);try{
  const helperDir=join(artifact,'database/migrations/data-steps'),scriptsDir=join(artifact,'scripts');
  mkdirSync(helperDir,{recursive:true,mode:0o700});mkdirSync(scriptsDir,{recursive:true,mode:0o700});
  const helper=join(helperDir,'reviewed-schedule.mjs'),planner=join(scriptsDir,'migrate-schedule-data.mjs');
  copyFileSync(new URL('../database/migrations/data-steps/reviewed-schedule.mjs',import.meta.url),helper);
  copyFileSync(new URL('../scripts/audit-schedule-business-rules.mjs',import.meta.url),join(scriptsDir,'audit-schedule-business-rules.mjs'));
  copyFileSync(new URL('../scripts/migrate-schedule-data.mjs',import.meta.url),planner);
  writeFileSync(planner,`${readFileSync(planner,'utf8')}\n// changed implementation bytes\n`);
  const reviewed=await import(`${pathToFileURL(helper).href}?test=${Date.now()}`);
  assert.throws(()=>reviewed.readReviewedScheduleFile(f.file,f.expectedReviewFileSha256,f.expectedPlanDigest),/implementation dependency hash mismatch: .*migrate-schedule-data/);
}finally{f.cleanup();rmSync(artifact,{recursive:true,force:true});}});
