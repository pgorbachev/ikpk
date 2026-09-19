import type { LedgerEntry, Observation } from './provenance-ledger.ts';
import type { PublicationRecord, VerifiedPair } from './publish-gate.ts';

/** Contract-only RED stub. Production implementation belongs to the next delivery. */
export interface PublicationStateStoreOptions {
  remote: string;
  workDir: string;
  gitEnv?: Record<string, string>;
  maxPushAttempts?: number;
}
export interface PublicationStateSnapshot {
  head: string;
  observation: Observation;
  entries: readonly LedgerEntry[];
  publications: VerifiedPair[];
}
export interface PublicationStateStore {
  read(fingerprint: string): Promise<PublicationStateSnapshot>;
  appendPublication(record: PublicationRecord): Promise<{ head: string; changed: boolean }>;
  acceptState(input: { expectedObservedEntry: number; fingerprint: string; actor: string }):
    Promise<{ head: string; entry: LedgerEntry & { confirmedBy: string } }>;
}
export function createPublicationStateStore(options: PublicationStateStoreOptions): PublicationStateStore {
  void options;
  const missing = async (): Promise<never> => { throw new Error('publication-state-store-not-implemented'); };
  return { read: missing, appendPublication: missing, acceptState: missing };
}
