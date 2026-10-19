import {
  assertInitialProductionCaptureContract,
  assertPrototypeDemo193SnapshotContract,
  assertSnapshotContract,
} from './content-contract.ts';
import type { Snapshot } from './content-snapshot.ts';

/** The demo exception is available only to an explicitly pinned prototype capture. */
export function assertCaptureSnapshotContract(
  snapshot: Snapshot,
  demo193SourceSqlSha256?: string,
  profile?: 'initial-prod',
): void {
  if (profile === 'initial-prod') {
    assertInitialProductionCaptureContract(snapshot);
    return;
  }
  if (demo193SourceSqlSha256 === undefined) {
    assertSnapshotContract(snapshot);
    return;
  }
  assertPrototypeDemo193SnapshotContract(snapshot, demo193SourceSqlSha256);
}
