import { writeFileSync } from 'node:fs';
import {
  assertInitialProductionCaptureContract,
  assertProductionStaticCaptureContract,
  assertPrototypeDemo193SnapshotContract,
  assertSnapshotContract,
  SnapshotContractError,
  validOccurrenceId,
} from './content-contract.ts';
import { articleSeoDescriptionFallback } from './article-seo-fallback.ts';
import type { Snapshot } from './content-snapshot.ts';

/** The demo exception is available only to an explicitly pinned prototype capture. */
export function assertCaptureSnapshotContract(
  snapshot: Snapshot,
  demo193SourceSqlSha256?: string,
  profile?: 'initial-prod' | 'production-static',
): void {
  if (profile === 'initial-prod') {
    assertInitialProductionCaptureContract(snapshot);
    return;
  }
  if (profile === 'production-static') {
    assertProductionStaticCaptureContract(snapshot);
    return;
  }
  if (demo193SourceSqlSha256 === undefined) {
    assertSnapshotContract(snapshot);
    return;
  }
  assertPrototypeDemo193SnapshotContract(
    snapshot,
    demo193SourceSqlSha256,
    articleSeoDescriptionFallback,
  );
}

// The worker supplies a private file for the diagnostic. CLI output stays independent.
export function reportSnapshotContractError(error: unknown): never {
  const path = process.env.IKPK_REFRESH_DIAGNOSTIC_FILE;
  if (path && error instanceof SnapshotContractError && validOccurrenceId(error.unlinkedOccurrenceId)) {
    try { writeFileSync(path, String(error.unlinkedOccurrenceId), { flag: 'wx', mode: 0o600 }); }
    catch { /* A missing diagnostic must not replace the original failure. */ }
  }
  throw error;
}
