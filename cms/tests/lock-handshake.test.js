import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { decideLock, transferLock, tryLock, lockPid } from '../src/seminar-management/site-refresh-operation.js';

const moduleUrl = new URL('../src/seminar-management/site-refresh-operation.js', import.meta.url).href;
const worker = `import {transferLock, unlock} from ${JSON.stringify(moduleUrl)};\nconst [path, owner, token] = process.argv.slice(1);\nconst ok = transferLock(path, +owner, process.pid, token);\nprocess.send({ok,pid:process.pid});\nprocess.on('message', () => { process.send({released:unlock(path, process.pid, token)}); process.exit(0); });`;

test('actual worker claims token and owns lock, including through a wrapper process', async () => {
  const dir=mkdtempSync(join(process.cwd(), '.handshake-')); const lock=join(dir,'lock');
  try {
    const token=randomUUID().replaceAll('-', '');
    assert.equal(tryLock(lock, process.pid, token), true);
    const child=spawn(process.execPath, ['--input-type=module','-e',worker,lock,String(process.pid),token], {stdio:['ignore','ignore','inherit','ipc']});
    const [claim]=await once(child,'message'); assert.equal(claim.ok,true);
    assert.equal(lockPid(lock), claim.pid); assert.match(readFileSync(lock,'utf8'),new RegExp(token));
    child.send('finish'); const [finish]=await once(child,'message'); assert.equal(finish.released,true);
    await once(child,'exit'); assert.equal(existsSync(lock),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('foreign token cannot claim a lock; unknown lock stays busy', () => {
  const dir=mkdtempSync(join(process.cwd(), '.handshake-')); const lock=join(dir,'lock');
  try {
    assert.equal(tryLock(lock, process.pid, 'd2e719621d2d4b0db5c0b1f967664bab'),true);
    assert.equal(transferLock(lock, process.pid, process.pid + 1, 'b'.repeat(32)), false);
    assert.equal(lockPid(lock), process.pid);
    const decision=decideLock({readable:true,lockPath:lock,record:null,pidAlive:()=>false});
    assert.equal(decision.releaseLock,false); assert.equal(decision.record.status,'running');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('missing lock with no record is idle while an empty lock is busy', () => {
  const dir=mkdtempSync(join(process.cwd(), '.handshake-')); const lock=join(dir,'lock');
  try {
    assert.equal(decideLock({readable:true,lockPath:lock,record:null,pidAlive:()=>false}).record,null);
    writeFileSync(lock,'');
    assert.equal(decideLock({readable:true,lockPath:lock,record:null,pidAlive:()=>false}).record.status,'running');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});


test('worker death after claim leaves the token lock busy for recovery', async () => {
  const dir=mkdtempSync(join(process.cwd(), '.handshake-')); const lock=join(dir,'lock');
  let child;
  try {
    const token='c'.repeat(32); assert.equal(tryLock(lock,process.pid,token),true);
    child=spawn(process.execPath,['--input-type=module','-e',worker,lock,String(process.pid),token],{stdio:['ignore','ignore','inherit','ipc']});
    const [claim]=await once(child,'message'); assert.equal(claim.ok,true);
    const ended=once(child,'exit'); child.kill('SIGKILL'); await ended;
    assert.equal(existsSync(lock),true);
    const state=decideLock({readable:true,lockPath:lock,record:{status:'running',pid:claim.pid},pidAlive:()=>false});
    assert.equal(state.releaseLock,false); assert.equal(state.persist,undefined);
    assert.equal(tryLock(lock,process.pid),false);
  } finally { if (child && child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); rmSync(dir,{recursive:true,force:true}); }
});

test('separate wrapper PID never becomes the lock owner', async () => {
  const dir=mkdtempSync(join(process.cwd(), '.handshake-')); const lock=join(dir,'lock');
  let wrapper;
  try {
    const token='e'.repeat(32); assert.equal(tryLock(lock,process.pid,token),true);
    const code=`const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['--input-type=module','-e',process.argv[1],process.argv[2],process.argv[3],process.argv[4]],{stdio:['ignore','ignore','inherit','ipc']}); child.on('message',m=>process.send({...m,wrapper:process.pid})); process.on('message',m=>child.send(m)); child.on('exit',()=>process.exit(0));`;
    wrapper=spawn(process.execPath,['-e',code,worker,lock,String(process.pid),token],{stdio:['ignore','ignore','inherit','ipc']});
    const [claim]=await once(wrapper,'message'); assert.equal(claim.ok,true); assert.notEqual(claim.pid,claim.wrapper); assert.equal(lockPid(lock),claim.pid);
    wrapper.send('finish'); const [done]=await once(wrapper,'message'); assert.equal(done.released,true);
    await once(wrapper,'exit'); assert.equal(existsSync(lock),false);
  } finally { if (wrapper && wrapper.exitCode === null && !wrapper.signalCode) wrapper.kill('SIGKILL'); rmSync(dir,{recursive:true,force:true}); }
});
