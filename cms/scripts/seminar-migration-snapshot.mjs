import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, linkSync, lstatSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
const Database=createRequire(import.meta.url)('better-sqlite3');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fail(message){throw new Error(`seminar stage snapshot: ${message}`);}
export function snapshotFingerprint(path){return hash(JSON.stringify([path,`${path}-wal`].map((file,i)=>{try{return hash(readFileSync(file));}catch(error){if(i===1&&error.code==='ENOENT')return null;throw error;}})));}
/** Capture a closed candidate once, preserving a private checkpoint for later
 * independent audit. No live CMS source or target is opened writable. */
export async function captureSeminarStageSnapshot(candidatePath,snapshotPath){
 for(const path of [candidatePath,snapshotPath])if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)fail('absolute canonical paths are required');
 const parent=dirname(snapshotPath),dir=lstatSync(parent);
 if(!dir.isDirectory()||dir.isSymbolicLink()||realpathSync(parent)!==parent||(dir.mode&0o077)||(typeof process.getuid==='function'&&dir.uid!==process.getuid()))fail('snapshot directory must be canonical, private and owned');
 const candidate=lstatSync(candidatePath);if(!candidate.isFile()||candidate.isSymbolicLink()||candidate.nlink!==1||realpathSync(candidatePath)!==candidatePath)fail('candidate must be a canonical regular file without hard links');
 try{lstatSync(snapshotPath);fail('snapshot path already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
 const before=snapshotFingerprint(candidatePath),temp=join(parent,`.${basename(snapshotPath)}.${randomUUID()}.tmp`),db=new Database(candidatePath,{readonly:true,fileMustExist:true,timeout:5000});
 try{
  db.pragma('query_only=ON');await db.backup(temp);
  if(snapshotFingerprint(candidatePath)!==before)fail('candidate changed during snapshot');
  const info=lstatSync(temp);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)fail('invalid temporary snapshot');
  chmodSync(temp,0o400);
  // Hard-link publication gives create-only semantics: rename() could overwrite a racing path.
  linkSync(temp,snapshotPath);unlinkSync(temp);
  const result={path:snapshotPath,candidateFingerprint:before,snapshotFingerprint:snapshotFingerprint(snapshotPath)};
  return result;
 }finally{db.close();rmSync(temp,{force:true});}
}
