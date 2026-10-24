import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [captureRoot, snapshotRoot, schemaRoot, operationId, sourceSha, expectedSnapshotId] = process.argv.slice(2);
if (!captureRoot || !snapshotRoot || !schemaRoot || !operationId || !sourceSha || !expectedSnapshotId) {
  throw new Error('reused snapshot verifier requires capture, snapshot, schema, and operation identity');
}

const { contentFingerprint, snapshotId } = await import(new URL(
  '../../web/scripts/lib/content-snapshot.ts', import.meta.url).href);
const { verifyStaging193Bundle } = await import(new URL('./staging193-capture-bundle.mjs', import.meta.url).href);
const verified = verifyStaging193Bundle(captureRoot, schemaRoot);
const manifestBytes = readFileSync(join(captureRoot, 'manifest.json'));
const manifest = verified.manifest;
const snapshot = JSON.parse(readFileSync(join(snapshotRoot, 'snapshot.json'), 'utf8'));
const proof = snapshot.captureProof;
const media = snapshot.content?.media;
const proofMatches = proof && verified.proof
  && Object.keys(proof).sort().join(',') === Object.keys(verified.proof).sort().join(',')
  && Object.entries(verified.proof).every(([key, value]) => (proof as Record<string, unknown>)[key] === value);
const safeTree = (path: string): void => {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw new Error('reused snapshot contains an unsafe filesystem object');
  }
  if (info.isFile()) {
    if (info.nlink !== 1) throw new Error('reused snapshot contains a multiply-linked file');
    return;
  }
  for (const child of readdirSync(path)) safeTree(join(path, child));
};
safeTree(snapshotRoot);

if (manifest.operationId !== operationId || manifest.sourceSha !== sourceSha
    || manifest.host !== '194.226.99.10' || manifest.siteUrl !== 'https://194.226.99.10'
    || manifest.sourceId !== 'demo193-cms'
    || snapshot.sourcePolicy !== 'demo-publication-only' || snapshot.sourceAge !== 'untracked'
    || snapshot.origin?.kind !== 'server-db' || snapshot.origin?.sourceId !== 'demo193-cms'
    || snapshot.origin?.capturedAt !== manifest.capturedAt || snapshot.pinned
    || typeof snapshot.referenceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.referenceDate)
    || !Array.isArray(media) || media.length === 0
    || snapshot.fingerprint !== contentFingerprint(snapshot.content)
    || snapshot.snapshotId !== snapshotId({ fingerprint: snapshot.fingerprint, referenceDate: snapshot.referenceDate })
    || snapshot.snapshotId !== expectedSnapshotId
    || !proofMatches) {
  throw new Error('reused snapshot identity or capture proof differs from its verified sealed capture');
}

for (const item of media) {
  if (!item || typeof item.ref !== 'string' || typeof item.contentId !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(item.contentId)) {
    throw new Error('reused snapshot media identity is invalid');
  }
  const path = join(snapshotRoot, 'media', item.contentId);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== item.contentId.slice(7)) {
    throw new Error('reused snapshot media bytes do not match their content ID');
  }
}

process.stdout.write(JSON.stringify({ snapshotId: snapshot.snapshotId, referenceDate: snapshot.referenceDate,
  bundleDigest: createHash('sha256').update(manifestBytes).digest('hex') }));
