// RED contract only. The new-publication coordinator is not implemented.
import type { PublicationCheckInput } from './publication-checks.ts';
import type { Snapshot } from './content-snapshot.ts';
import type { CiEvidence, LocalChecks, PublicationRecord } from './publish-gate.ts';
import type { PublicationStateStore } from './publication-state-store.ts';

export interface NewPublicationInput extends PublicationCheckInput {
  publicationId: string; releaseId: string; actor: string; origin: string;
}
export interface PublishedOperation extends PublicationRecord {
  observedEntry: number; highWaterMark: number; headAtLastCheck: string;
}
export interface PublicationProof {
  destinationId: string; treeDigest: string; commit: string; snapshotId: string;
}
export interface PublicationAuthorizationRequest {
  action: 'connect' | 'stage' | 'activate' | 'rollback' | 'recover';
  destinationId: string; expectedDigest?: string;
  operation?: PublicationProof & { publicationId: string; releaseId: string };
}
export type PublicationAuthorizer = (request: PublicationAuthorizationRequest) => Promise<PublicationProof>;
export interface NewPublicationSession {
  stage(input: { releaseId: string; sourceDir: string; expectedDigest: string }): Promise<void>;
  activate(input: {
    releaseId: string; operation: PublishedOperation;
    beforeActivate(): Promise<void>;
    recordIndex(operation: PublishedOperation): Promise<void>;
  }): Promise<void>;
}
export interface NewPublicationTransport {
  withLock<T>(callback: (session: NewPublicationSession) => Promise<T>): Promise<T>;
}
export interface NewPublicationPorts {
  readCiEvidence(commit: string): Promise<CiEvidence>;
  runChecks(input: PublicationCheckInput): Promise<{ report: LocalChecks; snapshot: Snapshot }>;
  readMain(): Promise<string>;
  state: Pick<PublicationStateStore, 'read' | 'appendPublication'>;
  digest(treeDir: string): Promise<string>;
  createTransport(input: { authorize: PublicationAuthorizer }): NewPublicationTransport;
  fetch: typeof globalThis.fetch;
  now(): string;
}

/** Called only by the installed worker with fixed real ports; no operator callbacks/reports. */
export async function runNewPublication(input: NewPublicationInput, ports: NewPublicationPorts): Promise<PublishedOperation> {
  void input; void ports;
  return undefined as never;
}
