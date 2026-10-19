import { describe, expect, it } from 'vitest';
import { assertCaptureSnapshotContract } from '../scripts/lib/capture-snapshot-contract.ts';
import { assertSnapshotContract } from '../scripts/lib/content-contract.ts';
import type { Snapshot } from '../scripts/lib/content-snapshot.ts';

const snapshot = (): Snapshot => ({
  content: { types: {}, media: [] },
  referenceDate: '2026-10-19',
  origin: { kind: 'server-db', sourceId: 'initial-prod-server-db', capturedAt: '2026-10-19T10:00:00.000Z' },
  sourcePolicy: 'initial-production',
  sourceAge: 'source-bound',
  captureProof: {
    version: 1,
    method: 'quiesced-sqlite-backup',
    targetHost: '89.111.184.196',
    siteUrl: 'https://ikpk.su',
    sourceSha: 'a'.repeat(40),
    runId: 12345,
    attempt: 2,
    captureId: 'initial-prod-20261019-A-01',
    schemaDigest: 'b'.repeat(64),
    databaseDigest: 'c'.repeat(64),
    mediaManifestDigest: 'd'.repeat(64),
    bundleDigest: 'e'.repeat(64),
  },
});

describe('initial production capture proof', () => {
  it('accepts only the explicit source-bound capture path', () => {
    expect(() => assertCaptureSnapshotContract(snapshot(), undefined, 'initial-prod')).not.toThrow();
  });

  it('keeps ordinary snapshot readers strict about the one-off proof', () => {
    expect(() => assertSnapshotContract(snapshot())).toThrow(/staging193 publication snapshot/);
  });

  it('rejects a proof for another operation, target, or source run', () => {
    for (const changed of [
      { ...snapshot(), captureProof: { ...snapshot().captureProof, captureId: 'another-op' } },
      { ...snapshot(), captureProof: { ...snapshot().captureProof, targetHost: '194.226.99.10' } },
      { ...snapshot(), captureProof: { ...snapshot().captureProof, runId: 0 } },
      { ...snapshot(), captureProof: { ...snapshot().captureProof, attempt: 0 } },
    ]) {
      expect(() => assertCaptureSnapshotContract(changed as Snapshot, undefined, 'initial-prod')).toThrow(/source-bound server-DB proof/);
    }
  });
});
