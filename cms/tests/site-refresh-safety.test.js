import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import * as refresh from '../src/seminar-management/site-refresh.ts';
import { hostPublicationStatus, readStateFile, runLockedRestore, writeJsonAtomic } from '../src/seminar-management/site-refresh-operation.js';
const { registerSiteRefresh } = refresh;

test('missing protected marker directory blocks publication as unknown', () => {
 const path = join(mkdtempSync(join(tmpdir(), 'ikpk-marker-missing-')), 'not-installed', 'host-publication.json');
 assert.deepEqual(hostPublicationStatus(path), { status: 'unknown' });
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-refresh-safe-'));
  const old = { ...process.env };
  const state = join(root, 'state.json'); const webRoot = join(root, 'site'); const workspace = join(root, 'build');
  mkdirSync(join(webRoot, 'releases', 'current'), {recursive:true});
  symlinkSync('releases/current', join(webRoot, 'current'));
  for (const name of ['astro','tsx']) { const path=join(workspace,'web/node_modules',name); mkdirSync(path,{recursive:true}); writeFileSync(join(path,'package.json'),'{}'); }
  Object.assign(process.env, {IKPK_REFRESH_STATE:state, IKPK_WEB_ROOT:webRoot, IKPK_BUILD_WORKSPACE:workspace, IKPK_VERIFY_URL:'http://127.0.0.1/test', IKPK_INSTALLED_COMMIT:'a'.repeat(40)});
  const routes=[]; const app={admin:{routes:{admin:{routes}}},db:{query:()=>({findOne:async()=>({roles:[{code:'content-admin'}]})})}};
 registerSiteRefresh(app, { hostPublicationStatus: () => null });
  const post=routes.find(r=>r.method==='POST').handler;
  t.after(()=>{ for(const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env,old); rmSync(root,{recursive:true,force:true}); });
  return {root,state,webRoot,post};
}

test('corrupt bytes survive real POST launch and Restore', async (t) => {
 const f=fixture(t); const bad=Buffer.from('{"previousReleaseId": "releases/old", broken'); writeFileSync(f.state,bad);
 for(const action of [undefined,'restore']) {
  const ctx={state:{user:{id:1}},request:{body:action?{action}:{}}}; await f.post(ctx);
  assert.equal(ctx.body.status,'failed'); assert.deepEqual(readFileSync(f.state),bad);
  assert.equal(existsSync(`${f.state}.lock`),false);
 }
});

for(const code of ['ENOSPC','EACCES']) test(`intent write ${code} releases only own lock and does not mutate existing state`, (t) => {
 const f=fixture(t); const initial=Buffer.from('{"status":"succeeded","releaseId":"current","switched":true}'); writeFileSync(f.state,initial);
 assert.throws(()=>refresh.launchRefresh({hostPublicationStatus:()=>null,write:()=>{throw Object.assign(new Error(code),{code});}}),{code});
 assert.deepEqual(readFileSync(f.state),initial); assert.equal(existsSync(`${f.state}.lock`),false);
});

for(const kind of ['missing','other-commit']) test(`failed Restore (${kind}) keeps verification-failed recovery target`, async (t)=>{
 const f=fixture(t); const old={status:'verification-failed',phase:'verifying',releaseId:'current',previousReleaseId:'releases/previous',switched:true}; writeFileSync(f.state,JSON.stringify(old));
 if(kind==='other-commit'){const dir=join(f.webRoot,'releases/previous');mkdirSync(dir);writeFileSync(join(dir,'release.json'),JSON.stringify({commit:'b'.repeat(40),snapshotId:'snap'}));}
 const ctx={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(ctx);
 const saved=JSON.parse(readFileSync(f.state,'utf8'));
 assert.equal(saved.status,'verification-failed'); assert.equal(saved.releaseId,old.releaseId); assert.equal(saved.previousReleaseId,old.previousReleaseId); assert.equal(saved.switched,true);
});


test('real spawn failure reports failed and releases only its own lock', async (t) => {
 const f=fixture(t); writeFileSync(f.state,JSON.stringify({status:'succeeded',releaseId:'current',switched:true}));
 const result=refresh.launchRefresh({hostPublicationStatus:()=>null,workerPath:'/nonexistent/worker.js',spawnWorker:(_command,_args,options)=>spawn('/nonexistent/ikpk-worker',[],options)});
 assert.equal(result.status,'running');
 for(let i=0;i<100 && existsSync(`${f.state}.lock`);i++) await delay(10);
 assert.equal(existsSync(`${f.state}.lock`),false);
 assert.equal(JSON.parse(readFileSync(f.state,'utf8')).status,'failed');
});

for (const value of [{}, {status:'mystery'}, {status:'failed',switched:true,releaseId:'current'}, {status:'succeeded',switched:true,releaseId:'../../escape'}, {status:'running',phase:'mystery',pid:123,switched:false}]) test(`invalid state is preserved: ${JSON.stringify(value)}`, async (t) => {
 const f=fixture(t); const original=Buffer.from(JSON.stringify(value)); writeFileSync(f.state,original);
 for(const action of [undefined,'restore']) {
  const ctx={state:{user:{id:1}},request:{body:action?{action}:{}}}; await f.post(ctx);
  assert.equal(ctx.body.status,'failed'); assert.deepEqual(readFileSync(f.state),original); assert.equal(existsSync(`${f.state}.lock`),false);
 }
});

test('Restore preserves verification failure if the target disappears after precheck', async (t) => {
 const f=fixture(t); const old={status:'verification-failed',phase:'verifying',releaseId:'current',previousReleaseId:'releases/previous',switched:true};
 let stored=old; let calls=0; let switched=false;
 const {runLockedRestore}=await import('../src/seminar-management/site-refresh-operation.js');
 const result=await runLockedRestore({lock:`${f.state}.lock`,pid:process.pid,current:old,write:r=>{stored=r;},identityOf:()=>++calls===1?{commit:'a'.repeat(40),snapshotId:'snap'}:null,installedCommit:'a'.repeat(40),switchRelease:()=>{switched=true;},verify:async()=>({ok:true})});
 assert.equal(result.status,'failed'); assert.equal(switched,false); assert.deepEqual(stored,old);
});

test('wrapper exit before claim stays fail-closed and reports uncertainty', async (t) => {
 const f=fixture(t); writeFileSync(f.state,JSON.stringify({status:'succeeded',releaseId:'current',switched:true}));
 const reports=[];
 const result=refresh.launchRefresh({hostPublicationStatus:()=>null,workerPath:'/nonexistent/worker.js',report:message=>reports.push(message),spawnWorker:(_command,_args,options)=>spawn('/bin/sh',['-c','exit 1'],options)});
 assert.equal(result.status,'running');
 for(let i=0;i<100 && reports.length===0;i++) await delay(10);
 assert.equal(reports.length,1); assert.match(reports[0],/не подтверждён|неизвест/);
 assert.equal(existsSync(`${f.state}.lock`),true);
 assert.equal(JSON.parse(readFileSync(f.state,'utf8')).phase,'starting');
});

test('Restore accepts a saved absolute paired target with a matching current release', async (t) => {
 const f=fixture(t); const previous=join(f.webRoot,'releases/previous'); mkdirSync(previous);
 writeFileSync(join(previous,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap'}));
 writeFileSync(f.state,JSON.stringify({status:'verification-failed',phase:'verifying',releaseId:'current',previousReleaseId:previous,switched:true}));
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>({status:200,json:async()=>({commit:'a'.repeat(40),snapshotId:'snap'})});
 try {
  const ctx={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(ctx);
  assert.equal(ctx.body.status,'succeeded');
  assert.equal(readlinkSync(join(f.webRoot,'current')),'releases/previous');
 } finally { globalThis.fetch=originalFetch; }
});

test('Restore rejects a saved relative release that is a symlink outside releases', async (t) => {
 const f=fixture(t); const outside=join(f.root,'outside'); mkdirSync(outside);
 writeFileSync(join(outside,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap'}));
 symlinkSync(outside,join(f.webRoot,'releases/previous'));
 const original={status:'verification-failed',phase:'verifying',releaseId:'current',previousReleaseId:'releases/previous',switched:true};
 writeFileSync(f.state,JSON.stringify(original));
 const ctx={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(ctx);
 assert.equal(ctx.body.status,'failed');
 assert.equal(readlinkSync(join(f.webRoot,'current')),'releases/current');
 assert.deepEqual(JSON.parse(readFileSync(f.state,'utf8')),original);
});

test('Restore failure after switch keeps a readable state with the switched release identity', async (t) => {
 const f=fixture(t);
 const current={status:'succeeded',phase:'done',releaseId:'content-new',previousReleaseId:'releases/current',switched:true};
 let switched=false;
 const result=await runLockedRestore({
  lock:`${f.state}.lock`,pid:process.pid,current,write:record=>writeJsonAtomic(f.state,record),
  switchRelease:()=>{switched=true;},identityOf:()=>({commit:'a'.repeat(40),snapshotId:'snap'}),
  installedCommit:'a'.repeat(40),verify:async()=>{throw new Error('probe failed');},
 });
 assert.equal(switched,true);
 assert.equal(result.status,'verification-failed');
 assert.equal(result.releaseId,'current');
 const loaded=readStateFile(f.state,f.webRoot);
 assert.equal(loaded.readable,true);
 assert.equal(loaded.record.status,'verification-failed');
 assert.equal(loaded.record.releaseId,'current');
});
