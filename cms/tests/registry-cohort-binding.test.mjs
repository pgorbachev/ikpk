import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyRegistryBinding } from '../scripts/run-data-migrations.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'registry-binding-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const candidateDbPath=join(dir,'candidate.db'), registryPath=join(dir,'registry.json');writeFileSync(candidateDbPath,'candidate');writeFileSync(registryPath,'[]');
 const receipt={operationId:'op',sourceCommitSha:'a'.repeat(40),planSha256:'b'.repeat(64),source:{snapshotSha256:'c'.repeat(64)},artifactSha256:'d'.repeat(64),sourceDbPath:join(dir,'source.db')};
 const contract={proofArtifact:{sha256:'e'.repeat(64)}};
 const binding={version:1,operationId:'op',sourceCommit:receipt.sourceCommitSha,migrationPlanDigest:receipt.planSha256,sourceDatabaseSha256:receipt.source.snapshotSha256,cmsArtifactSha256:receipt.artifactSha256,proofArtifactSha256:contract.proofArtifact.sha256,candidateDatabaseSha256:hash('candidate'),registrySha256:hash('[]'),registryPath};
 return {candidateDbPath,receipt,contract,binding};
}
test('exact independent registry approval binds checkpointed candidate',t=>{verifyRegistryBinding(fixture(t));});
for(const field of ['operationId','sourceCommit','migrationPlanDigest','sourceDatabaseSha256','cmsArtifactSha256','proofArtifactSha256','candidateDatabaseSha256','registrySha256'])test(`registry binding rejects changed ${field}`,t=>{const f=fixture(t);f.binding[field]='f'.repeat(64);assert.throws(()=>verifyRegistryBinding(f),/differs|mismatch/);});
test('registry binding refuses pending WAL',t=>{const f=fixture(t);writeFileSync(f.candidateDbPath+'-wal','pending');assert.throws(()=>verifyRegistryBinding(f),/pending WAL/);});
test('registry binding refuses malformed or duplicate exception rows even with matching bytes hash',t=>{const f=fixture(t);const raw='[{}]';writeFileSync(f.binding.registryPath,raw);f.binding.registrySha256=hash(raw);assert.throws(()=>verifyRegistryBinding(f),/invalid reviewed/);});

test('registry binding accepts the site fingerprint format and rejects unprefixed or malformed fingerprints',t=>{
 const f=fixture(t);const row={documentId:'doc',publishedAt:'2026-01-01',updatedAt:'2026-01-01',condition:'missing-duration',recordFingerprint:'sha256:'+'a'.repeat(64)};
 const set=()=>{const raw=JSON.stringify([row]);writeFileSync(f.binding.registryPath,raw);f.binding.registrySha256=hash(raw)};
 set();assert.doesNotThrow(()=>verifyRegistryBinding(f));
 for(const bad of ['a'.repeat(64),'sha256:xyz']){row.recordFingerprint=bad;set();assert.throws(()=>verifyRegistryBinding(f),/invalid reviewed/)}
});
