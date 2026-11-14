import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { applyPlan } from '../../../scripts/documents-migration-writer.mjs';

const HASH=/^[a-f0-9]{64}$/;
function fail(message){throw new Error(`reviewed documents migration: ${message}`);}
function ownerOnly(info,label){if((info.mode&0o077)||(typeof process.getuid==='function'&&info.uid!==process.getuid()))fail(`${label} must be owner-only and owned by the current user`);}
/** The runner obtains both expected hashes from its independently reviewed
 * operation receipt and verifies them again on every resumed attempt. */
export function readReviewedDocumentsFile(path,expectedFileSha256,expectedPlanDigest){
 if(typeof path!=='string'||!isAbsolute(path)||path!==resolve(path))fail('review file must be a canonical absolute path');
 if(!HASH.test(expectedFileSha256??'')||!HASH.test(expectedPlanDigest??''))fail('independent file and plan digests are required');
 const parent=dirname(path),dir=lstatSync(parent);if(!dir.isDirectory()||dir.isSymbolicLink()||realpathSync(parent)!==parent)fail('review directory must not traverse symlinks');ownerOnly(dir,'review directory');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.size>50_000_000)fail('review file must be a bounded regular file without hard links');ownerOnly(info,'review file');
  const bytes=readFileSync(fd);if(createHash('sha256').update(bytes).digest('hex')!==expectedFileSha256)fail('review file hash mismatch');
  let plan;try{plan=JSON.parse(bytes.toString('utf8'));}catch{fail('invalid review JSON');}
  if(!plan||plan.digest!==expectedPlanDigest)fail('review file does not contain the approved plan');
  return plan;
 }finally{closeSync(fd);}
}
/** The document writer verifies each version's preimage and commits its own
 * receipt with onApplied, allowing the runner ledger to share that transaction. */
export function apply(db,{reviewFilePath,expectedReviewFileSha256,expectedPlanDigest,onApplied}={}){
 const plan=readReviewedDocumentsFile(reviewFilePath,expectedReviewFileSha256,expectedPlanDigest);
 return applyPlan(db,plan,{expectedPlanDigest,onApplied});
}
