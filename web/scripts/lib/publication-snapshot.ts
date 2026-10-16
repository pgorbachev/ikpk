import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentFingerprint, snapshotId, type Snapshot } from './content-snapshot.ts';
import { validCaptureProof } from './publish-gate.ts';
import { createLedger } from './provenance-ledger.ts';

export function readPublicationSnapshot(dir: string, sourcePolicy?: 'demo-publication-only'): Snapshot {
  const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as Snapshot;
  if (!snapshot.content?.types || !Array.isArray(snapshot.content.media) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.referenceDate) || !Number.isFinite(Date.parse(snapshot.referenceDate)) ||
      (sourcePolicy === 'demo-publication-only' ? snapshot.sourcePolicy !== sourcePolicy || snapshot.sourceAge !== 'untracked' ||
        snapshot.origin?.kind !== 'server-db' || snapshot.origin.sourceId !== 'demo193-cms' || ['provenance', 'revision', 'observedEntry', 'highWaterMark'].some((key) => key in snapshot) || !validCaptureProof(snapshot.captureProof) :
        snapshot.origin?.kind !== 'live' || !snapshot.origin.url || snapshot.sourcePolicy !== undefined || snapshot.sourceAge !== undefined || snapshot.captureProof !== undefined) || snapshot.pinned ||
      !snapshot.origin?.capturedAt || !Number.isFinite(Date.parse(snapshot.origin.capturedAt))) throw new Error('invalid live snapshot');
  const fingerprint = contentFingerprint(snapshot.content);
  if (snapshot.fingerprint !== fingerprint || snapshot.snapshotId !== snapshotId({ fingerprint, referenceDate: snapshot.referenceDate })) {
    throw new Error('snapshot identity mismatch');
  }
  return snapshot;
}

export async function publicationObservation(snapshot: Snapshot, ledgerDir: string) {
  const ledger = createLedger({ dir: ledgerDir, initialize: false, hasPublicationHistory: true });
  const entries = await ledger.entries();
  const latest = entries.at(-1);
  if (!latest || latest.fingerprint !== snapshot.fingerprint) throw new Error('snapshot does not match latest journal entry');
  const observation = await ledger.observe({ fingerprint: snapshot.fingerprint! });
  if (observation.requiresConfirmation || observation.revision === null || observation.revision < observation.highWaterMark ||
      observation.observedEntry !== observation.highWaterMark || observation.observedEntry !== latest.number) {
    throw new Error('snapshot provenance requires accepted current state');
  }
  return { observedEntry: observation.observedEntry, revision: observation.revision, highWaterMark: observation.highWaterMark };
}
