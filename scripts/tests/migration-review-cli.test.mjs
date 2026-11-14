import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const sha = b => createHash('sha256').update(b).digest('hex');
const cli = 'cms/scripts/migration-review-cli.mjs';
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {encoding:'utf8'});
test('schedule review requires pinned inputs and independent verification of exact postimage', async () => {
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'ikpk-review-test-')); chmodSync(dir,0o700);
 try {
  const dbpath=join(dir,'source.db'); const db=new DatabaseSync(dbpath);
  db.exec(`CREATE TABLE seminars(id INTEGER PRIMARY KEY,document_id TEXT,published_at TEXT,duration TEXT);
  CREATE TABLE schedule_entries(id INTEGER PRIMARY KEY,document_id TEXT,published_at TEXT,legacy_id TEXT,is_free INTEGER,price REAL,city TEXT,is_online INTEGER,duration TEXT);
  CREATE TABLE schedule_entries_seminar_lnk(schedule_entry_id INTEGER,seminar_id INTEGER);
  CREATE TABLE files_related_mph(file_id INTEGER,related_id INTEGER,related_type TEXT,field TEXT);`); db.close(); chmodSync(dbpath,0o600);
  const sourceHash=sha(readFileSync(dbpath)); const decisions=join(dir,'decisions.json'); writeFileSync(decisions,JSON.stringify({paid:[],free:[],online:[],acceptedExceptions:[]}),{mode:0o600});
  const decisionsHash=sha(readFileSync(decisions)); const out=join(dir,'out');
  const commit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  const args=['prepare','schedule','--source',dbpath,'--source-sha256',sourceHash,'--input',decisions,'--input-sha256',decisionsHash,'--source-commit',commit,'--output-dir',out];
  const result=run(...args); assert.equal(result.status,0,result.stderr); assert.ok(existsSync(join(out,'review.json'))); assert.equal(sha(readFileSync(dbpath)),sourceHash);
  assert.notEqual(run(...args).status,0); assert.notEqual(run(...args.slice(0,-1),join(dir,'bad'),'--extra','x').status,0);
  const review=JSON.parse(readFileSync(join(out,'review.json'))); const reviewHash=sha(readFileSync(join(out,'review.json')));
  const audit=run('audit','schedule','--source',dbpath,'--source-sha256',sourceHash,'--candidate',dbpath,'--candidate-sha256',sourceHash,'--review',join(out,'review.json'),'--review-sha256',reviewHash,'--plan-digest',review.plan.planDigest,'--source-commit',commit);
  assert.equal(audit.status,0,audit.stderr);
  chmodSync(decisions,0o644); assert.notEqual(run(...args.slice(0,-1),join(dir,'insecure')).status,0); chmodSync(decisions,0o600);
  const altered=join(dir,'altered.db'); const {copyFileSync}=await import('node:fs'); copyFileSync(dbpath,altered); chmodSync(altered,0o600); const changed=new DatabaseSync(altered); changed.exec("INSERT INTO seminars VALUES (1,'unexpected',NULL,NULL)"); changed.close();
  const alteredResult=run('audit','schedule','--source',dbpath,'--source-sha256',sourceHash,'--candidate',altered,'--candidate-sha256',sha(readFileSync(altered)),'--review',join(out,'review.json'),'--review-sha256',reviewHash,'--plan-digest',review.plan.planDigest,'--source-commit',commit); assert.notEqual(alteredResult.status,0);
  const bad=run('audit','schedule','--source',dbpath,'--source-sha256',sourceHash,'--candidate',dbpath,'--candidate-sha256','0'.repeat(64),'--review',join(out,'review.json'),'--review-sha256',reviewHash,'--plan-digest',review.plan.planDigest,'--source-commit',commit);
  assert.notEqual(bad.status,0);
  writeFileSync(`${dbpath}-wal`,'uncheckpointed'); assert.notEqual(run(...args.slice(0,-1),join(dir,'wal-out')).status,0);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('documents require reviewed physical preimages and audit the exact candidate', async () => {
 const {database,proposal}=await import('./migration-review-documents-fixture.mjs');
 const {inspectVersions,applyPlan}=await import('../../cms/scripts/documents-migration-writer.mjs');
 const {createRequire}=await import('node:module'); const {copyFileSync}=await import('node:fs');
 const Database=createRequire(new URL('../../cms/scripts/migration-review-cli.mjs',import.meta.url))('better-sqlite3');
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'ikpk-review-doc-')); chmodSync(dir,0o700);
 try {
  const source=join(dir,'source.db'), candidate=join(dir,'candidate.db'); const original=database(source); original.close(); chmodSync(source,0o600);
  const sourceHash=sha(readFileSync(source)); const item=proposal(); const db=new Database(source,{readonly:true}); item.reviewedPreimages=inspectVersions(db,item.documentId); db.close();
  const input=join(dir,'input.json'); writeFileSync(input,JSON.stringify([item]),{mode:0o600}); const inputHash=sha(readFileSync(input)); const out=join(dir,'out');
  const commit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  const prep=run('prepare','documents','--source',source,'--source-sha256',sourceHash,'--input',input,'--input-sha256',inputHash,'--source-commit',commit,'--output-dir',out); assert.equal(prep.status,0,prep.stderr);
  const review=join(out,'review.json'), reviewHash=sha(readFileSync(review)), plan=JSON.parse(readFileSync(review));
  copyFileSync(source,candidate); chmodSync(candidate,0o600); const target=new Database(candidate); applyPlan(target,plan,{expectedPlanDigest:plan.digest}); target.close(); const candidateHash=sha(readFileSync(candidate));
  const args=['audit','documents','--source',source,'--source-sha256',sourceHash,'--candidate',candidate,'--candidate-sha256',candidateHash,'--review',review,'--review-sha256',reviewHash,'--plan-digest',plan.digest,'--source-commit',commit];
  assert.equal(run(...args).status,0); assert.notEqual(run(...args.slice(0,-3),'0'.repeat(64),'--source-commit',commit).status,0);
  const bad={...item,reviewedPreimages:[]}; writeFileSync(input,JSON.stringify([bad])); const invalid=run('prepare','documents','--source',source,'--source-sha256',sourceHash,'--input',input,'--input-sha256',sha(readFileSync(input)),'--source-commit',commit,'--output-dir',join(dir,'bad')); assert.notEqual(invalid.status,0); assert.equal(existsSync(join(dir,'bad')),false);
  assert.equal(sha(readFileSync(source)),sourceHash);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('WAL-mode SQLite is refused before opening and no sidecars appear', () => {
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'ikpk-review-wal-')); chmodSync(dir,0o700);
 try {
  const source=join(dir,'source.db'); const db=new DatabaseSync(source); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sample(id INTEGER)'); db.close(); chmodSync(source,0o600);
  const input=join(dir,'decisions.json'); writeFileSync(input,'{}',{mode:0o600}); const out=join(dir,'out');
  const commit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  const sourceHash=sha(readFileSync(source)); const result=run('prepare','schedule','--source',source,'--source-sha256',sourceHash,'--input',input,'--input-sha256',sha(readFileSync(input)),'--source-commit',commit,'--output-dir',out);
  assert.notEqual(result.status,0); assert.equal(existsSync(`${source}-wal`),false); assert.equal(existsSync(`${source}-shm`),false); assert.equal(existsSync(out),false); assert.equal(sha(readFileSync(source)),sourceHash);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('oversized schedule review is refused before creating output directory', () => {
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'ikpk-review-size-')); chmodSync(dir,0o700);
 try {
  const source=join(dir,'source.db'); const db=new DatabaseSync(source); db.exec(`CREATE TABLE seminars(id INTEGER PRIMARY KEY,document_id TEXT,published_at TEXT,duration TEXT); CREATE TABLE schedule_entries(id INTEGER PRIMARY KEY,document_id TEXT,published_at TEXT,legacy_id TEXT,is_free INTEGER,price REAL,city TEXT,is_online INTEGER,duration TEXT); CREATE TABLE schedule_entries_seminar_lnk(schedule_entry_id INTEGER,seminar_id INTEGER); CREATE TABLE files_related_mph(file_id INTEGER,related_id INTEGER,related_type TEXT,field TEXT);`); db.close(); chmodSync(source,0o600);
  const input=join(dir,'decisions.json'); writeFileSync(input,JSON.stringify({paid:[],free:[],online:[],acceptedExceptions:[],padding:'x'.repeat(20_000_000)}),{mode:0o600}); const out=join(dir,'out');
  const commit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  const result=run('prepare','schedule','--source',source,'--source-sha256',sha(readFileSync(source)),'--input',input,'--input-sha256',sha(readFileSync(input)),'--source-commit',commit,'--output-dir',out);
  assert.notEqual(result.status,0); assert.equal(existsSync(out),false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('oversized documents review is refused before creating output directory', async () => {
 const {database,proposal}=await import('./migration-review-documents-fixture.mjs');
 const {inspectVersions}=await import('../../cms/scripts/documents-migration-writer.mjs');
 const {createRequire}=await import('node:module'); const Database=createRequire(new URL('../../cms/scripts/migration-review-cli.mjs',import.meta.url))('better-sqlite3');
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'ikpk-review-doc-size-')); chmodSync(dir,0o700);
 try {
  const source=join(dir,'source.db'); const db=database(source); db.close(); chmodSync(source,0o600);
  const item=proposal(); const read=new Database(source,{readonly:true}); item.reviewedPreimages=inspectVersions(read,item.documentId); read.close(); item.padding='x'.repeat(50_000_000);
  const input=join(dir,'input.json'); writeFileSync(input,JSON.stringify([item]),{mode:0o600}); const out=join(dir,'out');
  const commit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  const result=run('prepare','documents','--source',source,'--source-sha256',sha(readFileSync(source)),'--input',input,'--input-sha256',sha(readFileSync(input)),'--source-commit',commit,'--output-dir',out);
  assert.notEqual(result.status,0); assert.equal(existsSync(out),false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
