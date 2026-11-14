import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, chmodSync, readFileSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { childEnvironment, historicalRegistryEnvironment, siteBuildEnv } from '../src/seminar-management/site-refresh-operation.js';
const sha = s => createHash('sha256').update(s).digest('hex');
function fixture() {
  const directory = mkdtempSync(join(process.cwd(), '.registry-test-'));
  chmodSync(directory, 0o755);
  const bytes = '[{"documentId":"a"}]'; const digest = sha(bytes);
  const file = join(directory, `registry-${digest}.json`); writeFileSync(file, bytes, { mode: 0o444 });
  const manifest = join(directory, 'current.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, registrySha256: digest, migrationPlanDigest: '1'.repeat(64), sourceDatabaseSha256: '2'.repeat(64), sourceCommit: '3'.repeat(40) }), { mode: 0o444 });
  return { directory, file, manifest, digest, bytes, read: () => historicalRegistryEnvironment({ directory, trustedUid: process.getuid() }) };
}
test('approved registry supplies immutable file and separate pin to build', () => {
 const f=fixture();try { const env=f.read(); assert.deepEqual(env,{CONTENT_HISTORICAL_EXCEPTIONS_FILE:f.file,CONTENT_HISTORICAL_EXCEPTIONS_SHA256:f.digest,IKPK_HISTORICAL_REGISTRY_MANIFEST_SHA256:sha(readFileSync(f.manifest))});
  assert.equal(siteBuildEnv('/tmp/work',true,false,{},env).CONTENT_HISTORICAL_EXCEPTIONS_SHA256,f.digest);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
test('tampering, writable manifest or registry, and symlink are rejected', () => {
 for(const kind of ['tamper','writable-manifest','writable-registry','writable-directory','symlink','hardlink']) { const f=fixture(); try {
  if(kind==='tamper'){chmodSync(f.file,0o644);writeFileSync(f.file,'[]');chmodSync(f.file,0o444)}
  if(kind==='writable-manifest')chmodSync(f.manifest,0o666);
  if(kind==='writable-registry')chmodSync(f.file,0o666);
  if(kind==='writable-directory')chmodSync(f.directory,0o777);
  if(kind==='symlink'){rmSync(f.file);symlinkSync(f.manifest,f.file)}
  if(kind==='hardlink')linkSync(f.file,join(f.directory,'additional-link'));
  assert.throws(f.read,/registry|manifest|ownership|digest/i,kind);
 }finally{rmSync(f.directory,{recursive:true,force:true});}}
});
test('an untrusted CMS process environment cannot supply its own registry authority', () => {
 const env=childEnvironment({CONTENT_HISTORICAL_EXCEPTIONS_FILE:'/tmp/forged',CONTENT_HISTORICAL_EXCEPTIONS_SHA256:'f'.repeat(64)});
 assert.equal(env.CONTENT_HISTORICAL_EXCEPTIONS_FILE,undefined);
 assert.equal(env.CONTENT_HISTORICAL_EXCEPTIONS_SHA256,undefined);
});
test('changing cohort metadata is detected even when registry bytes are identical', () => {
 const f=fixture();try {
  const before=f.read();const manifest=JSON.parse(readFileSync(f.manifest,'utf8'));
  manifest.sourceCommit='4'.repeat(40);chmodSync(f.manifest,0o644);writeFileSync(f.manifest,JSON.stringify(manifest));chmodSync(f.manifest,0o444);
  const after=f.read();assert.equal(before.CONTENT_HISTORICAL_EXCEPTIONS_SHA256,after.CONTENT_HISTORICAL_EXCEPTIONS_SHA256);
  assert.notEqual(before.IKPK_HISTORICAL_REGISTRY_MANIFEST_SHA256,after.IKPK_HISTORICAL_REGISTRY_MANIFEST_SHA256);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
test('required production registry fails closed when absent', () => {
 const directory=mkdtempSync(join(process.cwd(),'.registry-empty-'));try{
  chmodSync(directory,0o755);assert.throws(()=>historicalRegistryEnvironment({directory,trustedUid:process.getuid(),required:true}),/manifest/i);
  assert.deepEqual(historicalRegistryEnvironment({directory,trustedUid:process.getuid(),required:false}),{});
  writeFileSync(join(directory,'current.json'),'{}',{mode:0o444});assert.throws(()=>historicalRegistryEnvironment({directory,trustedUid:process.getuid()}),/manifest/i);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('active cohort check rejects legacy manifests even with matching registry bytes', () => {
 const f=fixture();try {
  assert.throws(() => historicalRegistryEnvironment({directory:f.directory,trustedUid:process.getuid(),requireCohort:true,sourceCommit:'3'.repeat(40)}),/sealed CMS\/database cohort/);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
