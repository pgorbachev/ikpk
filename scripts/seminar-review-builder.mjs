#!/usr/bin/env node
// Assemble review candidates only. The returned files are not approvals or audits.
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const hash=x=>createHash('sha256').update(x).digest('hex');
const jsonHash=x=>hash(JSON.stringify(x));
const fail=m=>{throw new Error(m)};
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function file(path){
 if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path)fail('path must be canonical');
 const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('file is unsafe');return readFileSync(path);
}
function snapshot(path){const db=file(path);const wal=path+'-wal';return jsonHash([hash(db),existsSync(wal)?hash(file(wal)):null]);}
export function buildReview({receipt,base,paths,candidate,registry,remoteReceipt}){
 if(!receipt||!base||base.version!==1||typeof receipt.operationId!=='string'||!/^[a-f0-9]{40}$/.test(receipt.sourceCommitSha??'')||![receipt.planSha256,receipt.artifactSha256,receipt.source?.snapshotSha256,receipt.source?.schemaFingerprint,receipt.source?.sourceFileFingerprint,base.ledger?.lineageId,base.proofArtifact?.sha256].every(digest))fail('receipt or reviewed inputs are invalid');
 if(!isAbsolute(remoteReceipt??'')||resolve(remoteReceipt)!==remoteReceipt||remoteReceipt!==join(dirname(receipt.candidateDbPath??remoteReceipt),'receipt.json'))fail('remote receipt path mismatch');
 if(!isAbsolute(base.proofArtifact.path??'')||resolve(base.proofArtifact.path)!==base.proofArtifact.path)fail('invalid remote proof path');
 const labels=['source','schema','schedule','documents','content'];const identities=labels.map(n=>realpathSync(paths[n]));if(new Set(identities).size!==5)fail('distinct snapshots required');
 const snapshots=Object.fromEntries(labels.map(n=>[n,snapshot(paths[n])]));
 const sourceName=basename(receipt.sourceDbPath), sourceWal=paths.source+'-wal';
 const sourceParts=[{file:sourceName,sha256:hash(file(paths.source))},existsSync(sourceWal)?{file:sourceName+'-wal',sha256:hash(file(sourceWal))}:{file:sourceName+'-wal',absent:true}];
 if(jsonHash(sourceParts)!==receipt.source.sourceFileFingerprint)fail('source file fingerprint mismatch');
 for(const [label,key] of [['schema','permissions'],['schedule','schedule'],['documents','documents'],['content','content']]){
  const step=base.steps?.[key],id=step?.id;if(typeof id!=='string'||!digest(step.sha256)||!receipt.steps?.some(x=>x.id===id&&x.sha256===step.sha256)||receipt.stageSnapshots?.[id]?.snapshotFingerprint!==snapshots[label])fail(`snapshot or step ${label} mismatch`);
  if(key!=='permissions'&&receipt.reviewedSteps?.[id]?.expectedPlanDigest!==base[key]?.expectedPlanDigest)fail(`${key} plan mismatch`);
 }
 const schedule=base.schedule?.plan, {planDigest,...schedulePayload}=schedule??{};
 if(!schedule||planDigest!==base.schedule.expectedPlanDigest||jsonHash(schedulePayload)!==planDigest||schedule.decisionDigest!==jsonHash(base.schedule.decisions))fail('schedule plan bytes mismatch');
 for(const name of ['documents','content']){const plan=base[name]?.plan;if(!plan?.payload||plan.digest!==base[name].expectedPlanDigest||jsonHash(plan.payload)!==plan.digest)fail(`${name} plan bytes mismatch`)}
 if(!base.schemaContract||jsonHash(base.schemaContract)!==base.schemaContractDigest)fail('schema contract digest mismatch');
 if(base.content.plan.payload.documentsPlanDigest!==base.documents.expectedPlanDigest||!digest(base.rendererSha256)||base.content.plan.payload.rendererSha256!==base.rendererSha256)fail('content provenance mismatch');
 if(snapshot(candidate)!==receipt.stageSnapshots[base.steps.content.id].candidateFingerprint)fail('candidate differs from final snapshot');
 if(existsSync(candidate+'-wal')&&file(candidate+'-wal').length)fail('candidate has WAL');
 const entries=JSON.parse(registry.toString('utf8'));if(!Array.isArray(entries))fail('registry must be an array');const seen=new Set();
 for(const e of entries){if(!e||typeof e.documentId!=='string'||!e.documentId||typeof e.publishedAt!=='string'||!e.publishedAt||typeof e.updatedAt!=='string'||!e.updatedAt||!['paid-zero-price','missing-duration'].includes(e.condition)||!/^sha256:[a-f0-9]{64}$/.test(e.recordFingerprint ?? ''))fail('invalid registry entry');const k=JSON.stringify([e.documentId,e.condition]);if(seen.has(k))fail('duplicate registry entry');seen.add(k)}
 const contract={...base,snapshots,ledger:{...base.ledger,operationId:receipt.operationId,sourceSnapshotSha256:receipt.source.snapshotSha256,sourceSchemaSha256:receipt.source.schemaFingerprint},sourceCommitSha:receipt.sourceCommitSha,cmsArtifactSha256:receipt.artifactSha256};
 const registrySha256=hash(registry);const binding={version:1,operationId:receipt.operationId,sourceCommit:receipt.sourceCommitSha,migrationPlanDigest:receipt.planSha256,sourceDatabaseSha256:receipt.source.snapshotSha256,cmsArtifactSha256:receipt.artifactSha256,proofArtifactSha256:base.proofArtifact.sha256,candidateDatabaseSha256:hash(file(candidate)),registrySha256,registryPath:join(dirname(remoteReceipt),'reviews',`registry-${registrySha256}.json`)};
 return {contract,binding,contractDigest:jsonHash(contract)};
}
function main(){
 const [configPath,expectedConfigHash,outDir]=process.argv.slice(2);if(!configPath||!digest(expectedConfigHash)||!outDir)fail('usage: node scripts/seminar-review-builder.mjs /absolute/config.json <independent-config-sha256> /absolute/private-output-directory');
 const raw=file(configPath);if(hash(raw)!==expectedConfigHash)fail('config digest mismatch');const c=JSON.parse(raw);
 const dir=lstatSync(outDir);if(!isAbsolute(outDir)||realpathSync(outDir)!==outDir||!dir.isDirectory()||(dir.mode&0o077)||dir.uid!==process.getuid())fail('output directory must be private and owned');
 const readPinned=(path,expected)=>{const bytes=file(path);if(!digest(expected)||hash(bytes)!==expected)fail('independent input digest mismatch');return bytes};
 const receipt=JSON.parse(readPinned(c.receiptPath,c.receiptSha256)),base=JSON.parse(readPinned(c.templatePath,c.templateSha256));const registry=readPinned(c.registryPath,c.registrySha256);if(hash(file(c.proofPath))!==base.proofArtifact?.sha256)fail('proof bytes mismatch');
 if(base.proofArtifact?.path!==c.remoteProofPath)fail('remote proof path mismatch');
 const result=buildReview({receipt,base,paths:c.paths,candidate:c.candidatePath,registry,remoteReceipt:c.remoteReceipt});
 for(const [name,value] of [['composition.json',result.contract],['registry-binding.json',result.binding]])writeFileSync(join(outDir,name),JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({compositionFileSha256:hash(readFileSync(join(outDir,'composition.json'))),compositionContractDigest:result.contractDigest,registryBindingFileSha256:hash(readFileSync(join(outDir,'registry-binding.json'))),registrySha256:hash(registry),status:'CANDIDATES_REQUIRE_INDEPENDENT_REVIEW'}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{main()}catch(e){console.error(`seminar review builder: ${e.message}`);process.exitCode=1}}
