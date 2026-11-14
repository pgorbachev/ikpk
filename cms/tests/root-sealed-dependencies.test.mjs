import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readRootSealedDependencyProvenance } from '../scripts/run-data-migrations.mjs';

function fixture(t) {
  const generation = mkdtempSync(join(process.cwd(), '.root-seal-test-'));
  chmodSync(generation, 0o755);
  const dependencyRoot = join(generation, 'node_modules'); mkdirSync(dependencyRoot, {mode:0o555});
  const info = lstatSync(dependencyRoot), marker = join(generation, '.ikpk-install-provenance-v3.json');
  const nodeBinary=realpathSync(process.execPath);
  const proof = { schemaVersion:3, installerUser:'ikpk-deps',installIsolation:'dedicated-uid-cgroup-drained-v1',
    installerUid:process.getuid()+1,installerGid:process.getgid()+1,nodeBinary,
    nodeBinarySha256:createHash('sha256').update(readFileSync(nodeBinary)).digest('hex'),
    npmCli:'/usr/share/nodejs/npm/bin/npm-cli.js',npmCliSha256:'d'.repeat(64), generation, dependencyRoot, dependencyDevice:info.dev, dependencyInode:info.ino,
    dependencyTreeSha256:'a'.repeat(64), packageLockSha256:'b'.repeat(64),packageJsonSha256:'f'.repeat(64), nodeAbi:process.versions.modules,
    nodeVersion:process.version, strapiVersion:'5.51.2', npmVersion:'10.9.8',
    installCommand:'npm ci --no-audit --no-fund', exitCode:0, completionObservedAt:'2026-11-14T00:00:00.000Z' };
  const save = value => { if (lstatSafe(marker)) chmodSync(marker,0o644);writeFileSync(marker,JSON.stringify(value),{mode:0o444});chmodSync(marker,0o444); };
  save(proof);
  t.after(()=>{chmodSync(dependencyRoot,0o755);rmSync(generation,{recursive:true,force:true});});
  const options = {dependencyRoot,expectedStrapiVersion:'5.51.2',packageLockSha256:'b'.repeat(64),packageJsonSha256:'f'.repeat(64),
    trustedUid:process.getuid(),platform:'linux',mountInfo:`42 25 8:1 / ${dependencyRoot} ro,relatime - ext4 /dev/test ro\n`};
  return {generation,dependencyRoot,marker,proof,save,options,read:()=>readRootSealedDependencyProvenance(options)};
}
function lstatSafe(path){try{return lstatSync(path)}catch{return null}}

test('service-readable protected proof is reusable and binds its exact bytes', t=>{
 const f=fixture(t), first=f.read(); assert.deepEqual(f.read(),first);
 f.save({...f.proof,dependencyTreeSha256:'c'.repeat(64)});
 assert.notEqual(f.read().proofSha256,first.proofSha256);
});
test('proof rejects drift in lock, ABI, install command, generation and dependency inode', t=>{
 const f=fixture(t);
 for(const [key,value] of [['packageJsonSha256','c'.repeat(64)],['packageLockSha256','c'.repeat(64)],['nodeAbi','wrong'],['nodeVersion','v0.0.0'],
  ['schemaVersion',2],['installerUid',process.getuid()],['installerUser','cms'],['installIsolation','cms-owned'],
  ['nodeBinary','/different/node'],['nodeBinarySha256','e'.repeat(64)],['installCommand','npm install'],['exitCode',1],['strapiVersion','0.0.0'],['generation','/unrelated'],
  ['dependencyInode',f.proof.dependencyInode+1],['dependencyTreeSha256','missing']]) {
  f.save({...f.proof,[key]:value});assert.throws(f.read,/root-sealed/,key);
 }
});
test('writable ancestors, writable proof and wrong owner fail closed',t=>{
 const f=fixture(t);
 chmodSync(f.generation,0o777);assert.throws(f.read,/ancestor/);chmodSync(f.generation,0o755);
 chmodSync(f.marker,0o666);assert.throws(f.read,/owner or mode/);chmodSync(f.marker,0o444);
 assert.throws(()=>readRootSealedDependencyProvenance({...f.options,trustedUid:process.getuid()+1}),/owner or mode/);
});
test('read-only ancestor, writable exact mount and wrong platform cannot attest sealed dependencies',t=>{
 const f=fixture(t);
 for(const changed of [{mountInfo:f.options.mountInfo.replace(f.dependencyRoot,f.generation)},
  {mountInfo:f.options.mountInfo.replace('ro,relatime','rw,relatime')},{platform:'darwin'}])
  assert.throws(()=>readRootSealedDependencyProvenance({...f.options,...changed}),/exact read-only Linux mountpoint/);
});
