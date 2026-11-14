import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildReview} from '../seminar-review-builder.mjs';
import {verifyRegistryBinding} from '../../cms/scripts/run-data-migrations.mjs';
import {proposeHistoricalExceptions, activeHistoricalExceptions} from '../../web/scripts/lib/historical-exceptions.ts';
const h=x=>createHash('sha256').update(x).digest('hex');
const j=x=>h(JSON.stringify(x));
test('binds five distinct snapshots, exact candidate and supplied registry to a single operation',()=>{
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'review-builder-'));try{
 const names=['source','schema','schedule','documents','content'];const paths={};for(const n of names){paths[n]=join(dir,n);writeFileSync(paths[n],n)}
 const candidate=join(dir,'candidate.db');writeFileSync(candidate,'candidate'); const reg=Buffer.from('[]');
 const ids={schema:'permission',schedule:'schedule',documents:'documents',content:'content'};
 const stages=Object.fromEntries(Object.entries(ids).map(([k,id])=>[id,{snapshotFingerprint:j([h(k),null])}]));
 stages.content.candidateFingerprint=j([h('candidate'),null]);
 const receipt={operationId:'op',sourceCommitSha:'a'.repeat(40),candidateDbPath:'/remote/candidate.db',planSha256:'b'.repeat(64),artifactSha256:'c'.repeat(64),sourceDbPath:paths.source,source:{snapshotSha256:'d'.repeat(64),schemaFingerprint:'e'.repeat(64),sourceFileFingerprint:j([{file:'source',sha256:h('source')},{file:'source-wal',absent:true}])},stageSnapshots:stages,reviewedSteps:{schedule:{expectedPlanDigest:'1'.repeat(64)},documents:{expectedPlanDigest:'2'.repeat(64)},content:{expectedPlanDigest:'3'.repeat(64)}}};
 receipt.steps=Object.values(ids).map(id=>({id,sha256:'a'.repeat(64)}));
 const base={version:1,ledger:{lineageId:'f'.repeat(64)},steps:{permissions:{id:'permission',sha256:'a'.repeat(64)},schedule:{id:'schedule',sha256:'a'.repeat(64)},documents:{id:'documents',sha256:'a'.repeat(64)},content:{id:'content',sha256:'a'.repeat(64)}},schedule:{expectedPlanDigest:'1'.repeat(64)},documents:{expectedPlanDigest:'2'.repeat(64)},content:{expectedPlanDigest:'3'.repeat(64)},proofArtifact:{path:'/remote/proof',sha256:'4'.repeat(64)}};
 const decision={acceptedExceptions:[]}, schedulePayload={sourceDigest:'a',decisionDigest:j(decision),entries:[],seminars:[],exceptions:[]};
 base.schedule={plan:{...schedulePayload,planDigest:j(schedulePayload)},decisions:decision,expectedPlanDigest:j(schedulePayload)};
 base.documents={plan:{payload:{version:1},digest:j({version:1})},expectedPlanDigest:j({version:1})};
 const contentPayload={documentsPlanDigest:base.documents.expectedPlanDigest,rendererSha256:'5'.repeat(64)};
 base.content={plan:{payload:contentPayload,digest:j(contentPayload)},expectedPlanDigest:j(contentPayload)};
 base.schemaContract={version:1};base.schemaContractDigest=j(base.schemaContract);base.rendererSha256='5'.repeat(64);
 for(const id of ['schedule','documents','content'])receipt.reviewedSteps[id].expectedPlanDigest=base[id].expectedPlanDigest;
 const result=buildReview({receipt,base,paths,candidate,registry:reg,remoteReceipt:'/remote/receipt.json'});
 assert.equal(result.contract.snapshots.source,j([h('source'),null]));assert.equal(result.contract.snapshots.content,j([h('content'),null]));assert.equal(result.binding.candidateDatabaseSha256,h('candidate'));assert.equal(result.binding.registrySha256,h(reg));assert.equal(result.binding.registryPath,`/remote/reviews/registry-${h(reg)}.json`);
 base.schedule.plan.entries.push({id:1});assert.throws(()=>buildReview({receipt,base,paths,candidate,registry:reg,remoteReceipt:'/remote/receipt.json'}),/schedule plan bytes/);base.schedule.plan.entries.pop();
 writeFileSync(paths.source,'changed');assert.throws(()=>buildReview({receipt,base,paths,candidate,registry:reg,remoteReceipt:'/remote/receipt.json'}),/source file fingerprint/);writeFileSync(paths.source,'source');
 writeFileSync(candidate,'changed');assert.throws(()=>buildReview({receipt,base,paths,candidate,registry:reg,remoteReceipt:'/remote/receipt.json'}),/candidate differs/);writeFileSync(candidate,'candidate');
 assert.throws(()=>buildReview({receipt,base,paths,candidate,registry:Buffer.from('[{}]'),remoteReceipt:'/remote/receipt.json'}),/invalid registry/);
 const event={id:23,documentId:'doc',name:'Occurrence',publishedAt:'2026-01-01',updatedAt:'2026-01-01',seminar:{id:12,slug:'seminar-a'},isFree:false,price:null,duration:null,teachers:[]};
 const content={types:{seminars:[{id:12,slug:'seminar-a',publishedAt:'2026-01-01',duration:null}],schedule_entries:[event]},media:[]};
 const entries=proposeHistoricalExceptions(content);assert.equal(entries.length,1);assert.equal(activeHistoricalExceptions(content,entries).length,1);
 const row=entries[0], registry=Buffer.from(JSON.stringify(entries)), localRegistry=join(dir,'registry.json');writeFileSync(localRegistry,registry);
 const real=buildReview({receipt,base,paths,candidate,registry,remoteReceipt:'/remote/receipt.json'});
 verifyRegistryBinding({receipt,contract:real.contract,candidateDbPath:candidate,binding:{...real.binding,registryPath:localRegistry}});
 for(const bad of ['a'.repeat(64),'sha256:xyz']) { row.recordFingerprint=bad; assert.throws(()=>buildReview({receipt,base,paths,candidate,registry:Buffer.from(JSON.stringify([row])),remoteReceipt:'/remote/receipt.json'}),/invalid registry/); }

 writeFileSync(paths.content,'changed');assert.throws(()=>buildReview({receipt,base,paths,candidate,registry:reg,remoteReceipt:'/remote/receipt.json'}),/snapshot/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
