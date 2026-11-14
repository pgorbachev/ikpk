import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditMigrationStageLedger } from './audit-migration-stage-ledger.mjs';
import { auditSeminarSchemaSync } from './audit-seminar-schema-sync.mjs';
import { auditScheduleBusinessRules } from './audit-schedule-business-rules.mjs';
import { auditScheduleMigration } from './audit-schedule-migration.mjs';
import { auditDocumentsMigration } from './audit-documents-migration.mjs';
import { auditContentMigration } from './audit-content-migration.mjs';

const Database=createRequire(import.meta.url)('better-sqlite3');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const jsonHash=value=>hash(JSON.stringify(value));
function fail(message){throw new Error(`seminar migration composition: ${message}`);}
function fingerprint(path){return jsonHash([path,`${path}-wal`].map((file,index)=>{try{return hash(readFileSync(file));}catch(error){if(index===1&&error.code==='ENOENT')return null;throw error;}}));}

/** Fail-closed composition of independently approved, stable stage snapshots.
 * expectedContractDigest must be stored separately in the operation receipt;
 * a contract constructed from these inputs is not evidence of review.
 * This remains a rehearsal-only partial result until registry cohort binding exists.
 */
export function auditSeminarMigrationComposition({paths,contract,expectedContractDigest}){
 if(!/^[a-f0-9]{64}$/.test(expectedContractDigest??'')||jsonHash(contract)!==expectedContractDigest||contract?.version!==1)fail('reviewed composition contract digest mismatch');
 const names=['source','schema','schedule','documents','content'];
 if(!paths||new Set(names.map(name=>paths[name])).size!==names.length||names.some(name=>typeof paths[name]!=='string'))fail('distinct snapshot paths are required');
 const inodes=new Set();
 for(const name of names){const path=paths[name];if(!isAbsolute(path)||path!==resolve(path)||realpathSync(path)!==path)fail(`snapshot path is not canonical: ${name}`);const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)fail(`snapshot must be an unlinked regular file: ${name}`);const id=`${info.dev}:${info.ino}`;if(inodes.has(id))fail('snapshot inodes must be distinct');inodes.add(id);}
 const fingerprints=Object.fromEntries(names.map(name=>[name,fingerprint(paths[name])]));
 for(const name of names)if(fingerprints[name]!==contract.snapshots?.[name])fail(`snapshot differs from approval: ${name}`);
 const dbs={};
 try{
  for(const name of names){dbs[name]=new Database(paths[name],{readonly:true,fileMustExist:true,timeout:5000});dbs[name].pragma('query_only=ON');dbs[name].exec('BEGIN');}
  const ledger=auditMigrationStageLedger(dbs.source,{...contract.ledger,stages:[{db:dbs.schema,newSteps:[contract.steps?.permissions]},{db:dbs.schedule,newSteps:[contract.steps?.schedule]},{db:dbs.documents,newSteps:[contract.steps?.documents]},{db:dbs.content,newSteps:[contract.steps?.content]}]});
  const schema=auditSeminarSchemaSync(dbs.source,dbs.schema,{contract:contract.schemaContract,expectedContractDigest:contract.schemaContractDigest,includeRunnerMetadata:true});
  const business=auditScheduleBusinessRules(dbs.schema,{plan:contract.schedule.plan,decisions:contract.schedule.decisions,expectedPlanDigest:contract.schedule.expectedPlanDigest});
  const schedule=auditScheduleMigration({sourceDbPath:paths.schema,candidateDbPath:paths.schedule,plan:contract.schedule.plan,acceptedExceptions:contract.schedule.decisions.acceptedExceptions,expectedPlanDigest:contract.schedule.expectedPlanDigest,includeRunnerMetadata:true});
  if(!schedule.passed)fail('schedule preservation audit did not pass');
  const documents=auditDocumentsMigration(dbs.schedule,dbs.documents,{plan:contract.documents.plan,expectedPlanDigest:contract.documents.expectedPlanDigest,includeRunnerMetadata:true});
  if(contract.content?.plan?.payload?.documentsPlanDigest!==contract.documents.expectedPlanDigest)fail('content is not bound to the reviewed documents plan');
  if(!/^[a-f0-9]{64}$/.test(contract.rendererSha256??'')||contract.content?.plan?.payload?.rendererSha256!==contract.rendererSha256)fail('content renderer does not match the independently reviewed fingerprint');
  const proof=contract.proofArtifact;
  if(!proof||!isAbsolute(proof.path??'')||!/^[a-f0-9]{64}$/.test(proof.sha256??'')||!/^[a-f0-9]{40}$/.test(contract.sourceCommitSha??''))fail('proof artifact and reviewed source commit are required');
  const verifier=join(dirname(fileURLToPath(import.meta.url)),'verify-seminar-proof-artifact.py');
  const checked=spawnSync('python3',[verifier,proof.path,proof.sha256,contract.sourceCommitSha,contract.rendererSha256],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  if(checked.error||checked.status!==0)fail(`independent proof artifact verification failed: ${checked.error?.message??checked.stderr?.trim()??'unknown error'}`);
  let proofResult;try{proofResult=JSON.parse(checked.stdout);}catch{fail('proof verifier returned invalid JSON');}
  if(proofResult.passed!==true||proofResult.sourceCommitSha!==contract.sourceCommitSha||proofResult.archiveSha256!==proof.sha256||proofResult.rendererSha256!==contract.rendererSha256)fail('proof verifier result mismatch');
  const content=auditContentMigration(dbs.documents,dbs.content,{plan:contract.content.plan,expectedPlanDigest:contract.content.expectedPlanDigest,includeRunnerMetadata:true});
  for(const name of names)if(fingerprint(paths[name])!==fingerprints[name])fail(`snapshot changed during audit: ${name}`);
  return {passed:false,partial:true,blockedOn:'registry-cohort-binding',ledger,schema,business,schedule,documents,content,proof:proofResult};
 }finally{for(const db of Object.values(dbs))db.close();}
}
