export type PublicationAction = 'publish' | 'cancel-stale' | 'require-confirmation' | 'refuse';

export interface PublicationDecision {
  action: PublicationAction;
  reason?: string;
  recorded?: boolean;
  runScheduledForLatestEntry?: boolean;
}

export interface VerifiedPair {
  commit: string;
  snapshotId: string;
  revision: number;
  referenceDate: string;
  capturedAt: string;
  testRunConclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'missing';
}

export interface ManualPublicationDecision {
  action: 'publish' | 'refuse';
  pair?: VerifiedPair;
  reason?:
    | 'no-verified-pair-for-head'
    | 'content-newer-than-verified-pair'
    | 'rollback-not-confirmed'
    | 'snapshot-beyond-retention'
    | 'head-moved';
  rollbackRecord?: { actor: string; snapshotId: string; reasonHeadNotPublished: string };
  writesProvenanceEntry?: boolean;
}

/** Срок хранения снимка и медиа — граница обещания повторной выкладки. */
export const SNAPSHOT_RETENTION_DAYS = 90;

export function classifySnapshotForPublication(input: {
  observedEntry: number;
  latestEntry: number;
  revision: number | null;
  highWaterMark: number;
  confirmedBy?: string;
}): PublicationDecision {
  if (input.observedEntry < input.latestEntry) {
    return { action: 'cancel-stale', recorded: true, runScheduledForLatestEntry: true };
  }
  if (input.revision === null || input.revision < input.highWaterMark) {
    if (input.confirmedBy) return { action: 'publish', recorded: true };
    return { action: 'require-confirmation' };
  }
  return { action: 'publish' };
}

export function classifyEventDrivenPublication(input: {
  verifiedCommit: string;
  headAtLastCheck: string;
  testRunConclusion: VerifiedPair['testRunConclusion'];
}): PublicationDecision {
  if (input.testRunConclusion !== 'success') {
    return { action: 'refuse', reason: input.testRunConclusion };
  }
  if (input.verifiedCommit !== input.headAtLastCheck) {
    return { action: 'refuse', reason: 'head-moved' };
  }
  return { action: 'publish' };
}

function isExpired(capturedAt: string, now: string, retentionDays: number): boolean {
  const ageMs = Date.parse(now) - Date.parse(capturedAt);
  return ageMs > retentionDays * 86_400_000;
}

function newerPair(left: VerifiedPair, right: VerifiedPair): VerifiedPair {
  if (left.revision !== right.revision) return left.revision > right.revision ? left : right;
  return left.referenceDate >= right.referenceDate ? left : right;
}

export function chooseManualPublication(input: {
  headCommit: string;
  headAtLastCheck?: string;
  verifiedPairs: VerifiedPair[];
  highWaterMark: number;
  now: string;
  retentionDays: number;
  actor: string;
  rollback?: { snapshotId: string; confirmed: boolean; reasonHeadNotPublished?: string };
}): ManualPublicationDecision {
  if (input.headAtLastCheck !== undefined && input.headCommit !== input.headAtLastCheck) {
    return { action: 'refuse', reason: 'head-moved' };
  }

  if (input.rollback) {
    if (!input.rollback.confirmed) {
      return { action: 'refuse', reason: 'rollback-not-confirmed' };
    }
    const pair = input.verifiedPairs.find(
      (candidate) => candidate.snapshotId === input.rollback!.snapshotId && candidate.testRunConclusion === 'success',
    );
    if (!pair) return { action: 'refuse', reason: 'no-verified-pair-for-head' };
    if (isExpired(pair.capturedAt, input.now, input.retentionDays)) {
      return { action: 'refuse', reason: 'snapshot-beyond-retention' };
    }
    return {
      action: 'publish',
      pair,
      writesProvenanceEntry: false,
      rollbackRecord: {
        actor: input.actor,
        snapshotId: pair.snapshotId,
        reasonHeadNotPublished: input.rollback.reasonHeadNotPublished ?? 'head is not the published pair',
      },
    };
  }

  const forHead = input.verifiedPairs.filter(
    (pair) => pair.commit === input.headCommit && pair.testRunConclusion === 'success',
  );
  if (forHead.length === 0) {
    return { action: 'refuse', reason: 'no-verified-pair-for-head' };
  }
  const newest = forHead.reduce(newerPair);
  if (newest.revision < input.highWaterMark) {
    return { action: 'refuse', reason: 'content-newer-than-verified-pair' };
  }
  if (isExpired(newest.capturedAt, input.now, input.retentionDays)) {
    return { action: 'refuse', reason: 'snapshot-beyond-retention' };
  }
  return { action: 'publish', pair: newest };
}
