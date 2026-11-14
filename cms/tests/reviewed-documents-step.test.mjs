import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readReviewedDocumentsFile} from '../database/migrations/data-steps/reviewed-documents.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(){const dir=mkdtempSync(join(realpathSync(tmpdir()),'reviewed-docs-'));chmodSync(dir,0o700);const file=join(dir,'plan.json'),plan={digest:'a'.repeat(64),payload:{version:1}},bytes=Buffer.from(JSON.stringify(plan));writeFileSync(file,bytes,{mode:0o600});return{dir,file,plan,fileHash:sha(bytes),close(){rmSync(dir,{recursive:true,force:true})}};}
test('reads only exact externally bound plan bytes',()=>{const f=fixture();try{assert.deepEqual(readReviewedDocumentsFile(f.file,f.fileHash,f.plan.digest),f.plan);assert.throws(()=>readReviewedDocumentsFile(f.file,'0'.repeat(64),f.plan.digest),/hash mismatch/);assert.throws(()=>readReviewedDocumentsFile(f.file,f.fileHash,'0'.repeat(64)),/approved plan/);writeFileSync(f.file,'{}');assert.throws(()=>readReviewedDocumentsFile(f.file,f.fileHash,f.plan.digest),/hash mismatch/)}finally{f.close()}});
test('refuses symlinks and insecure permissions',()=>{const f=fixture();try{symlinkSync(f.file,join(f.dir,'link'));assert.throws(()=>readReviewedDocumentsFile(join(f.dir,'link'),f.fileHash,f.plan.digest));chmodSync(f.file,0o644);assert.throws(()=>readReviewedDocumentsFile(f.file,f.fileHash,f.plan.digest),/owner-only/)}finally{f.close()}});
