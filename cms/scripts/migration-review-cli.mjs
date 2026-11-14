// Offline only. File and plan digests supplied to audit must be independently reviewed.
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { planScheduleDataMigration } from './migrate-schedule-data.mjs';
import { auditScheduleBusinessRules } from './audit-schedule-business-rules.mjs';
import { auditScheduleMigration } from './audit-schedule-migration.mjs';
import { capturePlan } from './documents-migration-writer.mjs';
import { auditDocumentsMigration } from './audit-documents-migration.mjs';
import { readReviewedScheduleFile } from '../database/migrations/data-steps/reviewed-schedule.mjs';
import { readReviewedDocumentsFile } from '../database/migrations/data-steps/reviewed-documents.mjs';
const Database = createRequire(import.meta.url)('better-sqlite3');
const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = b => createHash('sha256').update(b).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
function fail() { throw new Error('Input, identity, or audit check failed'); }
function canonical(path) { if (!path || !isAbsolute(path) || path !== resolve(path) || realpathSync(path) !== path) fail(); }
function privateOwner(s) { if ((s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) fail(); }
function bytes(path, expected, limit = 100_000_000) {
 if (!HASH.test(expected ?? '')) fail(); canonical(path); canonical(dirname(path));
 const dir=lstatSync(dirname(path)); if (!dir.isDirectory()) fail(); privateOwner(dir);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try { const s=fstatSync(fd); privateOwner(s); if(!s.isFile() || s.nlink!==1 || s.size>limit) fail(); const b=readFileSync(fd); if(hash(b)!==expected) fail(); return b; } finally {closeSync(fd);}
}
function snapshot(path, expected) {
 if(existsSync(path+'-wal') || existsSync(path+'-journal') || existsSync(path+'-shm')) fail();
 const image=bytes(path,expected,2_000_000_000);
 // SQLite header bytes 18 and 19 describe write/read format; 2 means WAL.
 // Read-only SQLite can create WAL sidecars even if none exist at startup.
 if(image.length<100 || !image.subarray(0,16).equals(Buffer.from('SQLite format 3\0')) || image[18]!==1 || image[19]!==1) fail();
}
function open(path) { const db=new Database(path,{readonly:true,fileMustExist:true}); db.pragma('query_only = ON'); return db; }
function checkVersion(commit) {
 if (!/^[a-f0-9]{40}$/.test(commit ?? '')) fail();
 if (execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==commit) fail();
 execFileSync('git',['diff','--quiet','HEAD','--','cms/scripts','cms/database/migrations/data-steps','cms/package.json','cms/package-lock.json'],{cwd:root,stdio:'ignore'});
}
function parse(argv) {
 const [action, kind, ...rest]=argv; if (!['prepare','audit'].includes(action)||!['schedule','documents'].includes(kind)||rest.length%2) fail();
 const permitted=action==='prepare'?['source','source-sha256','input','input-sha256','source-commit','output-dir']:['source','source-sha256','candidate','candidate-sha256','review','review-sha256','plan-digest','source-commit'];
 const o={}; for(let i=0;i<rest.length;i+=2) { const k=rest[i].startsWith('--')?rest[i].slice(2):''; if(!permitted.includes(k)||Object.hasOwn(o,k)||!rest[i+1]||rest[i+1].startsWith('--')) fail(); o[k]=rest[i+1]; }
 if(permitted.some(k=>!o[k])) fail(); return {action,kind,o};
}
function main() {
 const {action,kind,o}=parse(process.argv.slice(2)); checkVersion(o['source-commit']); snapshot(o.source,o['source-sha256']);
 if(action==='prepare') {
  const input=JSON.parse(bytes(o.input,o['input-sha256']).toString('utf8')); const db=open(o.source); let plan;
  try { plan=kind==='schedule'?planScheduleDataMigration(db,{decisions:input}):capturePlan(db,input); } finally {db.close();}
  snapshot(o.source,o['source-sha256']); bytes(o.input,o['input-sha256']);
  const target=o['output-dir']; if(!isAbsolute(target)||target!==resolve(target)) fail(); const parent=dirname(target); canonical(parent); const p=lstatSync(parent); if(!p.isDirectory()) fail(); privateOwner(p);
  const review=kind==='schedule'?{decisions:input,plan}:plan; const content=Buffer.from(JSON.stringify(review)+'\n');
  if(content.length>(kind==='schedule'?20_000_000:50_000_000)) fail();
  mkdirSync(target,{mode:0o700}); writeFileSync(`${target}/review.json`,content,{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({reviewFileSha256:hash(content),planDigest:kind==='schedule'?plan.planDigest:plan.digest,entries:kind==='schedule'?plan.entries.length:plan.payload.entries.length,exceptions:kind==='schedule'?plan.exceptions.length:0}));
 } else {
  snapshot(o.candidate,o['candidate-sha256']);
  const review=kind==='schedule'?readReviewedScheduleFile(o.review,o['review-sha256'],o['plan-digest']):readReviewedDocumentsFile(o.review,o['review-sha256'],o['plan-digest']);
  let result;
  if(kind==='schedule') { const source=open(o.source); try {auditScheduleBusinessRules(source,{...review,expectedPlanDigest:o['plan-digest']});} finally {source.close();} result=auditScheduleMigration({sourceDbPath:o.source,candidateDbPath:o.candidate,plan:review.plan,expectedPlanDigest:o['plan-digest'],acceptedExceptions:review.decisions.acceptedExceptions ?? [],includeRunnerMetadata:true}); }
  else {const source=open(o.source), candidate=open(o.candidate); try {result=auditDocumentsMigration(source,candidate,{plan:review,expectedPlanDigest:o['plan-digest'],includeRunnerMetadata:true});} finally {source.close();candidate.close();}}
  if(!result.passed) fail(); snapshot(o.source,o['source-sha256']); snapshot(o.candidate,o['candidate-sha256']); bytes(o.review,o['review-sha256'],50_000_000);
  console.log(JSON.stringify({passed:true,partial:true,sourceSha256:o['source-sha256'],candidateSha256:o['candidate-sha256'],planDigest:o['plan-digest']}));
 }
}
try {main();} catch {console.error('Migration review refused; verify private paths, independently pinned hashes, source revision, and inputs.'); process.exitCode=1;}
