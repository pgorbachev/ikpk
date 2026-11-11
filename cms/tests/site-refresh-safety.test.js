import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import * as refresh from '../src/seminar-management/site-refresh.ts';
import { hostPublicationStatus, readStateFile, runRestoreTransaction, writeJsonAtomic } from '../src/seminar-management/site-refresh-operation.js';
const { registerSiteRefresh } = refresh;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function waitUntil(predicate, message) {
 const deadline=Date.now()+5000;
 while(Date.now()<deadline) { if(predicate()) return; await delay(2); }
 assert.fail(message);
}

function destinationFlock(path) {
 const result=spawnSync('python3',['-c',["import fcntl, os, sys","fd=os.open(sys.argv[1],os.O_RDWR)","try:"," fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)","except BlockingIOError:"," sys.exit(73)","fcntl.flock(fd,fcntl.LOCK_UN)"].join('\n'),path],{encoding:'utf8'});
 assert.equal(result.stderr,'',`destination flock helper failed: ${result.stderr}`);
 return result.status;
}

function holdDestinationFlock(path, ready, release) {
 const script=["import fcntl, os, sys, time","fd=os.open(sys.argv[1],os.O_RDWR)","fcntl.flock(fd,fcntl.LOCK_EX)","open(sys.argv[2],'w').write('locked')","while not os.path.exists(sys.argv[3]): time.sleep(0.005)"].join('\n');
 return spawn('python3',['-c',script,path,ready,release],{stdio:'ignore'});
}

test('missing protected marker directory blocks publication as unknown', () => {
 const path = join(mkdtempSync(join(tmpdir(), 'ikpk-marker-missing-')), 'not-installed', 'host-publication.json');
 assert.deepEqual(hostPublicationStatus(path), { status: 'unknown' });
});


function assertDestinationLock(path, held=false) {
 assert.equal(destinationFlock(path),held?73:0,held?'destination flock should remain owned':'destination flock should be released');
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-refresh-safe-'));
  const old = { ...process.env };
  const webRoot = join(root, 'site'); const state = join(webRoot, 'shared/site-refresh/state.json'); const workspace = join(root, 'build');
  const destinationLock = join(webRoot, '.publication.lock');
  mkdirSync(dirname(state), {recursive:true});
  mkdirSync(join(webRoot, 'releases', 'current'), {recursive:true});
  writeFileSync(destinationLock,''); chmodSync(destinationLock,0o600);
  symlinkSync('releases/current', join(webRoot, 'current'));
  for (const name of ['astro','tsx']) { const path=join(workspace,'web/node_modules',name); mkdirSync(path,{recursive:true}); writeFileSync(join(path,'package.json'),'{}'); }
  Object.assign(process.env, {IKPK_REFRESH_STATE:state, IKPK_WEB_ROOT:webRoot, IKPK_BUILD_WORKSPACE:workspace, IKPK_VERIFY_URL:'http://127.0.0.1/test', IKPK_INSTALLED_COMMIT:'a'.repeat(40)});
  const routes=[]; const app={admin:{routes:{admin:{routes}}},db:{query:()=>({findOne:async()=>({roles:[{code:'content-admin'}]})})}};
 registerSiteRefresh(app, { hostPublicationStatus: () => null });
  const post=routes.find(r=>r.method==='POST').handler;
  t.after(()=>{ for(const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env,old); rmSync(root,{recursive:true,force:true}); });
  return {root,state,webRoot,destinationLock,post};
}

test('corrupt bytes survive real POST launch and Restore', async (t) => {
 const f=fixture(t); const bad=Buffer.from('{"previousReleaseId": "releases/old", broken'); writeFileSync(f.state,bad);
 for(const action of [undefined,'restore']) {
  const ctx={state:{user:{id:1}},request:{body:action?{action}:{}}}; await f.post(ctx);
  assert.equal(ctx.body.status,'failed'); assert.deepEqual(readFileSync(f.state),bad);
  assertDestinationLock(f.destinationLock);
 }
});

for(const code of ['ENOSPC','EACCES']) test(`intent write ${code} releases only own lock and does not mutate existing state`, async (t) => {
 const f=fixture(t); const initial=Buffer.from('{"status":"succeeded","releaseId":"current","switched":true}'); writeFileSync(f.state,initial);
 await assert.rejects(refresh.launchRefresh({hostPublicationStatus:()=>null,write:()=>{throw Object.assign(new Error(code),{code});}}),{code});
 assert.deepEqual(readFileSync(f.state),initial); assertDestinationLock(f.destinationLock);
});

for(const kind of ['missing','other-commit']) test(`failed Restore (${kind}) keeps verification-failed recovery target`, async (t)=>{
 const f=fixture(t); const old={status:'verification-failed',phase:'verifying',releaseId:'current',previousReleaseId:'releases/previous',switched:true}; writeFileSync(f.state,JSON.stringify(old));
 if(kind==='other-commit'){const dir=join(f.webRoot,'releases/previous');mkdirSync(dir);writeFileSync(join(dir,'release.json'),JSON.stringify({commit:'b'.repeat(40),snapshotId:'snap'}));}
 const ctx={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(ctx);
 const saved=JSON.parse(readFileSync(f.state,'utf8'));
 assert.equal(saved.status,'verification-failed'); assert.equal(saved.releaseId,old.releaseId); assert.equal(saved.previousReleaseId,old.previousReleaseId); assert.equal(saved.switched,true);
 assertDestinationLock(f.destinationLock);
});


test('real spawn failure reports failed and releases only its own lock', async (t) => {
 const f=fixture(t); writeFileSync(f.state,JSON.stringify({status:'succeeded',releaseId:'current',switched:true}));
 const result=await refresh.launchRefresh({hostPublicationStatus:()=>null,workerPath:'/nonexistent/worker.js',spawnWorker:(_command,_args,options)=>spawn('/nonexistent/ikpk-worker',[],options)});
 assert.equal(result.status,'failed');
 for(let i=0;i<100 && JSON.parse(readFileSync(f.state,'utf8')).status!=='failed';i++) await delay(10);
 assert.equal(JSON.parse(readFileSync(f.state,'utf8')).status,'failed');
 assertDestinationLock(f.destinationLock);
});

test('controller retains the destination flock until delayed spawn error is handled', async (t) => {
 const f=fixture(t); writeFileSync(f.state,JSON.stringify({status:'succeeded',releaseId:'current',switched:true}));
 let child;
 const launching=refresh.launchRefresh({hostPublicationStatus:()=>null,workerPath:'/unused/worker.js',
  spawnWorker:()=>{ child=new EventEmitter(); child.unref=()=>{}; return child; }});
 await waitUntil(()=>child!==undefined,'controller did not reach spawn');
 await delay(20);
 assertDestinationLock(f.destinationLock,true);
 child.emit('error',Object.assign(new Error('delayed missing worker'),{code:'ENOENT'}));
 const result=await launching;
 assert.equal(result.status,'failed');
 assert.equal(JSON.parse(readFileSync(f.state,'utf8')).status,'failed');
 assertDestinationLock(f.destinationLock);
});

for (const value of [{}, {status:'mystery'}, {status:'failed',switched:true,releaseId:'current'}, {status:'succeeded',switched:true,releaseId:'../../escape'}, {status:'running',phase:'mystery',pid:123,switched:false}]) test(`invalid state is preserved: ${JSON.stringify(value)}`, async (t) => {
 const f=fixture(t); const original=Buffer.from(JSON.stringify(value)); writeFileSync(f.state,original);
 for(const action of [undefined,'restore']) {
  const ctx={state:{user:{id:1}},request:{body:action?{action}:{}}}; await f.post(ctx);
  assert.equal(ctx.body.status,'failed'); assert.deepEqual(readFileSync(f.state),original); assertDestinationLock(f.destinationLock);
 }
});

test('public Restore refuses the shared flock without changing the recovery target', async (t) => {
 const f=fixture(t); const previous=join(f.webRoot,'releases/previous'); mkdirSync(previous);
 writeFileSync(join(previous,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:previous'}));
 const state={status:'verification-failed',phase:'verifying',releaseId:'current',previousReleaseId:'releases/previous',switched:true};
 writeFileSync(f.state,JSON.stringify(state));
 const bytes=readFileSync(f.state); const ready=join(f.root,'host-lock-ready'); const release=join(f.root,'host-lock-release');
 const holder=holdDestinationFlock(f.destinationLock,ready,release); const exited=once(holder,'exit');
 try {
  await waitUntil(()=>existsSync(ready),'host flock holder did not acquire destination inode');
  const ctx={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(ctx);
  assert.equal(ctx.body.status,'running');
  assert.deepEqual(readFileSync(f.state),bytes);
  assert.equal(readlinkSync(join(f.webRoot,'current')),'releases/current');
  assert.equal(destinationFlock(f.destinationLock),73);
 } finally {
  writeFileSync(release,'release'); await exited;
 }
 assert.equal(destinationFlock(f.destinationLock),0);
});

test('crashed pre-switch Restore retries the same target through the public action', async (t) => {
 const f=fixture(t); const previous=join(f.webRoot,'releases/previous'); mkdirSync(previous);
 writeFileSync(join(previous,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:previous'}));
 mkdirSync(join(f.webRoot,'releases/content-new'));
 writeFileSync(join(f.webRoot,'releases/content-new','release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:new'}));
 unlinkSync(join(f.webRoot,'current')); symlinkSync('releases/content-new',join(f.webRoot,'current'));
 const crashed={status:'running',phase:'switching',pid:2147483000,releaseId:'content-new',previousReleaseId:'releases/previous',switched:false};
 writeFileSync(f.state,JSON.stringify(crashed));
 const server=createServer((_request,response)=>{
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:previous'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address(); process.env.IKPK_VERIFY_URL=`http://127.0.0.1:${address.port}/release.json`;
 try {
  const ctx={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(ctx);
  assert.equal(ctx.body.status,'succeeded');
  assert.equal(readlinkSync(join(f.webRoot,'current')),'releases/previous');
  assert.equal(JSON.parse(readFileSync(f.state,'utf8')).releaseId,'previous');
  assert.equal(destinationFlock(f.destinationLock),0);
 } finally {
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
 }
});

test('failed pre-switch Restore keeps the original public recovery intent', async (t) => {
 const f=fixture(t); const candidate=join(f.webRoot,'releases/content-new'); mkdirSync(candidate);
 writeFileSync(join(candidate,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:new'}));
 unlinkSync(join(f.webRoot,'current')); symlinkSync('releases/content-new',join(f.webRoot,'current'));
 const intent={status:'running',phase:'switching',pid:2147483000,releaseId:'content-new',
   previousReleaseId:'releases/missing',switched:false};
 writeFileSync(f.state,JSON.stringify(intent)); const bytes=readFileSync(f.state);
 const ctx={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(ctx);
 assert.equal(ctx.body.status,'failed');
 assert.deepEqual(readFileSync(f.state),bytes);
 assert.equal(readlinkSync(join(f.webRoot,'current')),'releases/content-new');
 assert.equal(destinationFlock(f.destinationLock),0);
});

test('temporary verification failure at the Restore target preserves retry evidence', async (t) => {
 const f=fixture(t); const previous=join(f.webRoot,'releases/previous'); mkdirSync(previous);
 writeFileSync(join(previous,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:previous'}));
 mkdirSync(join(f.webRoot,'releases/content-new'));
 writeFileSync(join(f.webRoot,'releases/content-new','release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:new'}));
 unlinkSync(join(f.webRoot,'current')); symlinkSync('releases/previous',join(f.webRoot,'current'));
 const intent={status:'running',phase:'switching',pid:2147483000,releaseId:'content-new',
   previousReleaseId:'releases/previous',switched:false};
 writeFileSync(f.state,JSON.stringify(intent));
 let attempts=0;
 const server=createServer((_request,response)=>{
  attempts += 1;
  response.writeHead(attempts===1?503:200,{'content-type':'application/json'});
  response.end(JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:previous'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address(); process.env.IKPK_VERIFY_URL=`http://127.0.0.1:${address.port}/release.json`;
 try {
  const first={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(first);
  assert.equal(first.body.status,'verification-failed');
  const saved=JSON.parse(readFileSync(f.state,'utf8'));
  assert.equal(saved.status,intent.status);
  assert.equal(saved.phase,intent.phase);
  assert.equal(saved.releaseId,intent.releaseId);
  assert.equal(saved.previousReleaseId,intent.previousReleaseId,
    'failed verify must retain the original Restore intent so the operator can retry');
  assert.equal(saved.switched,intent.switched);
  assert.equal(readlinkSync(join(f.webRoot,'current')),'releases/previous');
  assert.equal(destinationFlock(f.destinationLock),0);

  const retry={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(retry);
  assert.equal(retry.body.status,'succeeded');
  assert.equal(attempts,2);
  assert.equal(JSON.parse(readFileSync(f.state,'utf8')).releaseId,'previous');
  assert.equal(destinationFlock(f.destinationLock),0);
 } finally {
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
 }
});

test('a crashed public Restore after switch releases flock and keeps the durable recovery state', async (t) => {
 const f=fixture(t); const previous=join(f.webRoot,'releases/previous'); mkdirSync(previous);
 writeFileSync(join(previous,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:previous'}));
 const candidate=join(f.webRoot,'releases/content-new'); mkdirSync(candidate);
 writeFileSync(join(candidate,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:new'}));
 unlinkSync(join(f.webRoot,'current')); symlinkSync('releases/content-new',join(f.webRoot,'current'));
 writeFileSync(f.state,JSON.stringify({status:'succeeded',phase:'done',releaseId:'content-new',
   previousReleaseId:'releases/previous',switched:true}));
 const barrier=join(f.root,'restore-verification-started');
 let releaseVerification; const verificationReleased=new Promise(resolve=>{releaseVerification=resolve;});
 const server=createServer(async (_request,response)=>{
  writeFileSync(barrier,'entered');
  await verificationReleased;
  if(!response.destroyed) {
   response.writeHead(200,{'content-type':'application/json'});
   response.end(JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:previous'}));
  }
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 process.env.IKPK_VERIFY_URL=`http://127.0.0.1:${address.port}/release.json`;
 const siteModule=pathToFileURL(join(repoRoot,'cms/src/seminar-management/site-refresh.ts')).href;
 const loader=join(repoRoot,'cms/scripts/ts-extension-loader.mjs');
 const code=`import(${JSON.stringify(siteModule)}).then(({registerSiteRefresh})=>{const routes=[];const app={admin:{routes:{admin:{routes}}},db:{query:()=>({findOne:async()=>({roles:[{code:'content-admin'}]})})}};registerSiteRefresh(app,{hostPublicationStatus:()=>null});return routes.find(r=>r.method==='POST').handler({state:{user:{id:1}},request:{body:{action:'restore'}}});}).then(()=>process.exit(0),error=>{process.stderr.write(String(error));process.exit(1)})`;
 const child=spawn(process.execPath,['--experimental-strip-types',`--experimental-loader=${loader}`,'--input-type=module','-e',code],{
  cwd:join(repoRoot,'cms'),stdio:'ignore',env:{...process.env,IKPK_REFRESH_STATE:f.state,IKPK_WEB_ROOT:f.webRoot,
    IKPK_INSTALLED_COMMIT:'a'.repeat(40),IKPK_VERIFY_URL:`http://127.0.0.1:${address.port}/release.json`},
 });
 const exited=once(child,'exit'); let killed=false;
 try {
  await waitUntil(()=>readlinkSync(join(f.webRoot,'current'))==='releases/previous' && existsSync(barrier),
    'public Restore child did not switch current and enter verification');
  const active=JSON.parse(readFileSync(f.state,'utf8'));
  assert.equal(active.status,'running'); assert.equal(active.phase,'switching'); assert.equal(active.pid,child.pid);
  assert.equal(destinationFlock(f.destinationLock),73);
  child.kill('SIGKILL'); killed=true; await exited;
  assert.equal(destinationFlock(f.destinationLock),0);
  assert.equal(existsSync(`${f.state}.lock`),false);
  releaseVerification();
  const retry={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(retry);
  assert.equal(retry.body.status,'succeeded');
  assert.equal(JSON.parse(readFileSync(f.state,'utf8')).releaseId,'previous');
  assert.equal(readlinkSync(join(f.webRoot,'current')),'releases/previous');
  assert.equal(destinationFlock(f.destinationLock),0);
 } finally {
  releaseVerification();
  if(!killed && child.exitCode===null && child.signalCode===null) { child.kill('SIGKILL'); await exited; }
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
 }
});

test('explicit Restore remains available for a cleanup-pending published release', async (t) => {
 const f=fixture(t); const previous=join(f.webRoot,'releases/previous'); mkdirSync(previous);
 writeFileSync(join(previous,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:previous'}));
 const candidate=join(f.webRoot,'releases/content-new'); mkdirSync(candidate);
 writeFileSync(join(candidate,'release.json'),JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:new'}));
 unlinkSync(join(f.webRoot,'current')); symlinkSync('releases/content-new',join(f.webRoot,'current'));
 writeFileSync(f.state,JSON.stringify({status:'succeeded',phase:'done',releaseId:'content-new',
   previousReleaseId:'releases/previous',switched:true,cleanupPending:true}));
 const server=createServer((_request,response)=>{
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify({commit:'a'.repeat(40),snapshotId:'snap:previous'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address(); process.env.IKPK_VERIFY_URL=`http://127.0.0.1:${address.port}/release.json`;
 try {
  const ctx={state:{user:{id:1}},request:{body:{action:'restore'}}}; await f.post(ctx);
  assert.equal(ctx.body.status,'succeeded');
  assert.equal(readlinkSync(join(f.webRoot,'current')),'releases/previous');
  assert.equal(JSON.parse(readFileSync(f.state,'utf8')).releaseId,'previous');
  assert.equal(destinationFlock(f.destinationLock),0);
 } finally {
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
 }
});

test('Restore preserves verification failure if the target disappears after precheck', async () => {
 const old={status:'verification-failed',phase:'verifying',releaseId:'current',previousReleaseId:'releases/previous',switched:true};
 let stored=old; let calls=0; let switched=false;
 const result=await runRestoreTransaction({pid:process.pid,current:old,write:r=>{stored=r;},identityOf:()=>++calls===1?{commit:'a'.repeat(40),snapshotId:'snap'}:null,installedCommit:'a'.repeat(40),switchRelease:()=>{switched=true;},verify:async()=>({ok:true})});
 assert.equal(result.status,'failed'); assert.equal(switched,false); assert.deepEqual(stored,old);
});

test('wrapper exit before claim stays fail-closed and reports uncertainty', async (t) => {
 const f=fixture(t); writeFileSync(f.state,JSON.stringify({status:'succeeded',releaseId:'current',switched:true}));
 const reports=[];
 const result=await refresh.launchRefresh({hostPublicationStatus:()=>null,workerPath:'/nonexistent/worker.js',report:message=>reports.push(message),spawnWorker:(_command,_args,options)=>spawn('/bin/sh',['-c','exit 1'],options)});
 assert.equal(result.status,'running');
 for(let i=0;i<100 && reports.length===0;i++) await delay(10);
 assert.equal(reports.length,1); assert.match(reports[0],/не подтверждён|неизвест/);
 assertDestinationLock(f.destinationLock);
 const starting = JSON.parse(readFileSync(f.state,'utf8'));
 assert.equal(starting.phase,'starting');
 const retry={state:{user:{id:1}},request:{body:{}}};
 await f.post(retry);
 assert.equal(retry.body.status,'running');
 assert.deepEqual(JSON.parse(readFileSync(f.state,'utf8')),starting, 'durable starting state must block a second writer after flock release');
 assertDestinationLock(f.destinationLock);
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
  assertDestinationLock(f.destinationLock);
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
 assertDestinationLock(f.destinationLock);
});

test('Restore failure after switch keeps a readable state with the switched release identity', async (t) => {
 const f=fixture(t);
 const current={status:'succeeded',phase:'done',releaseId:'content-new',previousReleaseId:'releases/current',switched:true};
 let switched=false;
 const result=await runRestoreTransaction({
  pid:process.pid,current,write:record=>writeJsonAtomic(f.state,record),
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
