import { isDeepStrictEqual } from 'node:util';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DestinationConfig } from '../publication-context.ts';
import type { PublicationRecord } from './publish-gate.ts';
import { readFromStore } from './content-media-store.ts';
import { readPublicationSnapshot } from './publication-snapshot.ts';

export function demoEvidencePaths(config: Pick<DestinationConfig, 'captureBundleRoot' | 'publicationEvidenceRoot'> & { webRoot?: string }, id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('invalid evidence operation');
  for (const root of [config.captureBundleRoot, config.publicationEvidenceRoot]) {
    if (!root || !isAbsolute(root) || resolve(root) !== root || root === '/') throw new Error('missing protected durable evidence root');
    if (config.webRoot && (root === resolve(config.webRoot) || root.startsWith(`${resolve(config.webRoot)}/`))) throw new Error('private evidence inside serving root');
    for (let path = root; ; path = dirname(path)) {
      const st = lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) ||
          (st.uid !== 0 && st.uid !== process.getuid?.())) throw new Error('unsafe durable evidence root');
      if (path === '/') break;
    }
  }
  const root = join(config.publicationEvidenceRoot!, id);
  return { root, bundle: join(config.captureBundleRoot!, id), snapshot: join(root, 'snapshot'), reports: join(root, 'reports') };
}
/** Flush closed evidence files and directory entries before any release can activate. */
function syncEvidence(root: string) {
  function sync(path: string, descend: boolean) {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || (!before.isDirectory() && (!before.isFile() || before.nlink !== 1))) {
      throw new Error('evidence member must be regular and cannot be a symlink or hardlink');
    }
    // NONBLOCK prevents a replaced regular file becoming a blocking FIFO open.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW |
      (before.isDirectory() ? constants.O_DIRECTORY : constants.O_NONBLOCK));
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode) throw new Error('evidence member changed during sync');
      if (descend && before.isDirectory()) for (const name of readdirSync(path).sort()) sync(join(path, name), true);
      const after = lstatSync(path);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.mode !== opened.mode) throw new Error('evidence member changed during sync');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  sync(root, true);
  // Persist newly created operation/evidence-directory entries, up to the root.
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    sync(parent, false);
    if (parent === '/') break;
  }
}
export function saveDemoOperation(root: string, operation: PublicationRecord) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'operation.json'), `${JSON.stringify(operation, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  syncEvidence(root);
}
/** Recovery consumes only the sealed original bundle and the exact saved operation. No recapture. */
export async function verifyDemoRecoveryEvidence(config: DestinationConfig, operation: PublicationRecord) {
  if (operation.sourcePolicy !== 'demo-publication-only' || config.sourcePolicy !== operation.sourcePolicy ||
      operation.deployMode !== 'stand' || operation.paymentRole !== 'ci') throw new Error('recovery source policy mismatch');
  const current = demoEvidencePaths(config, operation.publicationId);
  const saved = JSON.parse(readFileSync(join(current.root, 'operation.json'), 'utf8'));
  if (!isDeepStrictEqual(saved, operation)) throw new Error('durable recovery operation mismatch');
  const original = demoEvidencePaths(config, operation.captureProof.captureId);
  const { verifyBundle } = await import('../../../scripts/lib/server-capture-bundle.mjs');
  const bundle = await verifyBundle(original.bundle);
  if (!isDeepStrictEqual(bundle.proof, operation.captureProof)) throw new Error('durable capture proof mismatch');
  const snapshot = readPublicationSnapshot(original.snapshot, 'demo-publication-only');
  const report = JSON.parse(readFileSync(join(original.reports, 'publication.json'), 'utf8'));
  if (snapshot.snapshotId !== operation.snapshotId || snapshot.referenceDate !== operation.referenceDate ||
      snapshot.origin?.capturedAt !== operation.capturedAt || !isDeepStrictEqual(snapshot.captureProof, operation.captureProof) ||
      !isDeepStrictEqual(report, operation.localChecks)) throw new Error('durable recovery evidence mismatch');
  for (const media of snapshot.content.media) {
    if (!readFromStore({ storeDir: join(original.snapshot, 'media'), contentId: media.contentId }).ok) throw new Error('durable snapshot media mismatch');
  }
  if ('rollbackChecks' in operation) {
    const rollback = JSON.parse(readFileSync(join(current.reports, 'rollback.json'), 'utf8'));
    if (!isDeepStrictEqual(rollback, operation.rollbackChecks)) throw new Error('durable rollback evidence mismatch');
  }
}
