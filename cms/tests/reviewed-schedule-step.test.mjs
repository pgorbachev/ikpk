import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, chmodSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  return {db,dir,file,plan,expectedReviewFileSha256:sha(bytes),expectedPlanDigest:plan.planDigest,cleanup(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
const options=f=>({reviewFilePath:f.file,expectedReviewFileSha256:f.expectedReviewFileSha256,expectedPlanDigest:f.expectedPlanDigest});
test('approved file writes and ledger callback in the same transaction',()=>{const f=fixture();try{apply(f.db,{...options(f),onApplied(db){db.exec("INSERT INTO ledger VALUES('done')");}});assert.equal(f.db.prepare('SELECT price FROM schedule_entries').get().price,null);assert.equal(f.db.prepare('SELECT count(*) n FROM ledger').get().n,1);}finally{f.cleanup();}});
test('callback failure rolls back both ledger and migration',()=>{const f=fixture();try{assert.throws(()=>apply(f.db,{...options(f),onApplied(db){db.exec("INSERT INTO ledger VALUES('done')");throw Error('failure');}}),/failure/);assert.equal(f.db.prepare('SELECT price FROM schedule_entries').get().price,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ledger').get().n,0);}finally{f.cleanup();}});
test('refuses changed bytes, mismatched external digest and insecure permissions',()=>{const f=fixture();try{assert.throws(()=>readReviewedScheduleFile(f.file,'0'.repeat(64),f.expectedPlanDigest),/hash mismatch/);assert.throws(()=>readReviewedScheduleFile(f.file,f.expectedReviewFileSha256,'0'.repeat(64)),/approved plan/);chmodSync(f.file,0o644);assert.throws(()=>readReviewedScheduleFile(f.file,f.expectedReviewFileSha256,f.expectedPlanDigest),/owner-only/);chmodSync(f.file,0o600);writeFileSync(f.file,'{}');assert.throws(()=>readReviewedScheduleFile(f.file,f.expectedReviewFileSha256,f.expectedPlanDigest),/hash mismatch/);}finally{f.cleanup();}});
test('refuses symlink and source changes on resume',()=>{const f=fixture();try{const link=join(f.dir,'link.json');symlinkSync(f.file,link);assert.throws(()=>readReviewedScheduleFile(link,f.expectedReviewFileSha256,f.expectedPlanDigest));f.db.exec('UPDATE schedule_entries SET price=5');assert.throws(()=>apply(f.db,options(f)),/source/);}finally{f.cleanup();}});
