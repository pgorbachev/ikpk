import type { DemoCaptureProof } from './content-snapshot.ts';

export type PublicationAction = 'publish' | 'cancel-stale' | 'require-confirmation' | 'refuse';

export interface PublicationDecision {
  action: PublicationAction;
  reason?: string;
  recorded?: boolean;
  runScheduledForLatestEntry?: boolean;
}

interface PairIdentity {
  commit: string;
  snapshotId: string;
  referenceDate: string;
  capturedAt: string;
  testRunConclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'missing';
}

export interface JournalPair extends PairIdentity {
  recordKind?: undefined; sourcePolicy?: undefined; sourceAge?: undefined; captureProof?: undefined;
  revision: number;
}
export interface PublicationSnapshotPair extends PairIdentity {
  recordKind: 'publication-snapshot'; sourcePolicy: 'demo-publication-only'; sourceAge: 'untracked';
  captureProof: DemoCaptureProof; revision?: never; observedEntry?: never; highWaterMark?: never;
}
export type VerifiedPair = JournalPair | PublicationSnapshotPair;

export function isDemoPublication(pair: { sourcePolicy?: unknown; recordKind?: unknown }): pair is PublicationSnapshotPair {
  return pair.sourcePolicy === 'demo-publication-only' && pair.recordKind === 'publication-snapshot';
}
export function demoMetadataProblem(value: object): string | undefined {
  const record = value as PublicationSnapshotPair;
  if (!isDemoPublication(record) || record.sourceAge !== 'untracked' ||
      ['revision', 'observedEntry', 'highWaterMark', 'provenance'].some((key) => key in record)) return 'invalid-demo-publication-metadata';
}
export function validCaptureProof(value: unknown, captureId?: string): value is DemoCaptureProof {
  if (!value || typeof value !== 'object') return false;
  const proof = value as DemoCaptureProof;
  return proof.version === 1 && proof.method === 'quiesced-sqlite-backup' && proof.sourceId === 'demo193-cms' &&
    typeof proof.captureId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proof.captureId) &&
    (captureId === undefined || proof.captureId === captureId) &&
    [proof.schemaDigest, proof.databaseDigest, proof.mediaManifestDigest, proof.bundleDigest].every((v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v));
}
export function publicationAgeProblem(record: VerifiedPair): string | undefined {
  if (isDemoPublication(record)) return demoMetadataProblem(record) ?? (validCaptureProof(record.captureProof) ? undefined : 'invalid-capture-proof');
  if (record.sourcePolicy !== undefined || record.recordKind !== undefined || record.sourceAge !== undefined || record.captureProof !== undefined || !positiveCount(record.revision)) return 'invalid-journal-revision';
}

export type CheckConclusion = VerifiedPair['testRunConclusion'];
export interface CiEvidence {
  repository: string; workflow: string; event: string; branch: string; commit: string;
  runId: number; conclusion: CheckConclusion; executedTests: number;
  jobs: { name: string; conclusion: CheckConclusion }[];
}
export interface LocalChecks {
  commit: string; snapshotId: string; destinationId: string; treeDigest: string;
  groups: { name: string; conclusion: CheckConclusion; executedTests: number }[];
}
export type PublicationRecord = VerifiedPair & {
  publicationId: string; releaseId: string; destinationId: string; treeDigest: string;
  publishedAt: string; actor: string; ciEvidence: CiEvidence; localChecks: LocalChecks;
  paymentRole: 'ci' | 'stand' | 'prod'; deployMode: 'stand' | 'prod';
  sourceRef?: 'main' | 'dev'; sourceProfile?: 'demo-dev';
}
export interface CiPolicy { repository: string; workflow: string; requiredJobs: readonly string[] }
export const PUBLICATION_CI_POLICY: CiPolicy = {
  repository: 'pgorbachev/ikpk', workflow: '.github/workflows/test.yml',
  requiredJobs: ['Capture content snapshot', 'Unit and build tests', 'Dependency update invariants',
    'Scripts unit tests', 'Playwright smoke (desktop + mobile)'],
};
export const PUBLICATION_GROUPS = ['snapshot-provenance', 'build-content', 'destination-mode',
  'browser-smoke', 'payment-destination'] as const;
export const ROLLBACK_GROUPS = ['destination-mode', 'browser-smoke', 'payment-destination'] as const;

export interface ManualPublicationDecision {
  action: 'publish' | 'refuse'; pair?: VerifiedPair; reason?: string;
  rollbackRecord?: { actor: string; commit: string; snapshotId: string; releaseId: string;
    reason: string; reasonHeadNotPublished: string };
  writesProvenanceEntry?: boolean;
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function positiveCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

/** Pure validator. Production callers use the fixed policy, never a policy read from a report. */
export function ciEvidenceProblem(evidence: CiEvidence | undefined, commit: string,
  policy: CiPolicy = PUBLICATION_CI_POLICY, sourceRef: 'main' | 'dev' = 'main'): string | undefined {
  if (!evidence) return 'missing-ci-evidence';
  if (!nonempty(policy.repository) || !nonempty(policy.workflow) || !policy.requiredJobs.length) return 'empty-ci-policy';
  if (evidence.repository !== policy.repository || evidence.workflow !== policy.workflow ||
    !['main', 'dev'].includes(sourceRef) || evidence.branch !== sourceRef || evidence.commit !== commit ||
    !(evidence.event === 'push' || (sourceRef === 'main' && evidence.event === 'schedule'))) return 'untrusted-ci-run';
  if (!positiveCount(evidence.runId) || evidence.conclusion !== 'success') return 'unsuccessful-ci-run';
  if (!positiveCount(evidence.executedTests)) return `ci-executed-tests:${evidence.executedTests ?? 0}`;
  if (!Array.isArray(evidence.jobs)) return 'missing-ci-jobs';
  for (const name of policy.requiredJobs) {
    const matching = evidence.jobs.filter((job) => job.name === name);
    if (matching.length !== 1 || matching[0].conclusion !== 'success') return `required-ci-job:${name}`;
  }
}

/** Legacy records have no source fields and continue to mean main. */
export function publicationCiProblem(record: Pick<PublicationRecord, 'ciEvidence' | 'commit' | 'deployMode' | 'paymentRole' | 'sourceRef' | 'sourceProfile' | 'sourcePolicy'>,
  policy: CiPolicy = PUBLICATION_CI_POLICY): string | undefined {
  if (record.sourcePolicy !== undefined && (record.sourcePolicy !== 'demo-publication-only' || record.deployMode !== 'stand' || record.paymentRole !== 'ci')) return 'untrusted-publication-source';
  const sourceRef = record.sourceRef ?? 'main';
  if (sourceRef === 'dev' ? record.sourceProfile !== 'demo-dev' || record.deployMode !== 'stand' || record.paymentRole !== 'ci' :
      sourceRef !== 'main' || record.sourceProfile !== undefined) return 'untrusted-publication-source';
  return ciEvidenceProblem(record.ciEvidence, record.commit, policy, sourceRef);
}

export function localChecksProblem(report: LocalChecks | undefined,
  expected: { commit: string; snapshotId: string; destinationId: string; treeDigest: string },
  groups: readonly string[] = PUBLICATION_GROUPS): string | undefined {
  if (!report || !Array.isArray(report.groups)) return 'missing-local-report';
  for (const field of ['commit', 'snapshotId', 'destinationId', 'treeDigest'] as const) {
    if (!nonempty(expected[field]) || report[field] !== expected[field]) return `local-report-${field}-mismatch`;
  }
  for (const name of groups) {
    const matches = report.groups.filter((group) => group.name === name);
    if (matches.length !== 1) return `local-group:${name}:count=${matches.length}`;
    if (!positiveCount(matches[0].executedTests)) return `local-group:${name}:executed=${matches[0].executedTests ?? 0}`;
    if (matches[0].conclusion !== 'success') return `local-group:${name}:${matches[0].conclusion}`;
  }
  if (report.groups.some((group) => !groups.includes(group.name))) return 'unexpected-local-group';
}

export function isPublicationRecord(pair: VerifiedPair): pair is PublicationRecord {
  const record = pair as Partial<PublicationRecord>;
  return [record.publicationId, record.releaseId, record.destinationId, record.treeDigest, record.publishedAt,
    record.actor].every(nonempty) && Number.isFinite(Date.parse(record.publishedAt!)) &&
    ['ci', 'stand', 'prod'].includes(record.paymentRole ?? '') && ['stand', 'prod'].includes(record.deployMode ?? '') &&
    !!record.ciEvidence && !!record.localChecks;
}

/** A rollback retains original checks and also carries its own fresh three-group report. */
export function rollbackEvidenceProblem(record: PublicationRecord & {
  rollbackOfPublicationId?: unknown; reason?: unknown; rollbackChecks?: LocalChecks;
}): string | undefined {
  if (!('rollbackOfPublicationId' in record || 'reason' in record || 'rollbackChecks' in record)) return;
  if (!nonempty(record.rollbackOfPublicationId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.rollbackOfPublicationId) ||
      record.rollbackOfPublicationId === record.publicationId || !nonempty(record.reason)) return 'invalid-rollback-identity';
  return localChecksProblem(record.rollbackChecks, record, ROLLBACK_GROUPS);
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
    return { action: 'cancel-stale', recorded: true, runScheduledForLatestEntry: false };
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
  return { action: 'refuse', reason: 'manual-publication-required' };
}

export function chooseManualPublication(input: {
  headCommit: string; headAtLastCheck?: string; verifiedPairs: VerifiedPair[];
  highWaterMark: number; now: string; retentionDays: number; actor: string;
  freshPair?: VerifiedPair; ciEvidence?: CiEvidence; localChecks?: LocalChecks;
  destinationId?: string; treeDigest?: string; expectedCi?: CiPolicy;
  sourceRef?: 'main' | 'dev'; sourcePolicy?: 'demo-publication-only';
  pendingDestinations?: string[];
  retainedReleases?: { releaseId: string; destinationId: string; treeDigest: string }[];
  rollback?: { snapshotId: string; releaseId?: string; confirmed: boolean; reason?: string; reasonHeadNotPublished?: string };
}): ManualPublicationDecision {
  const refuse = (reason: string): ManualPublicationDecision => ({ action: 'refuse', reason });
  const destinationId = input.destinationId;
  const treeDigest = input.treeDigest;
  if (!nonempty(destinationId) || !nonempty(treeDigest) || !nonempty(input.actor)) return refuse('missing-publication-identity');
  if (input.pendingDestinations?.includes(destinationId)) return refuse('unfinished-publication-record');
  const policy = input.expectedCi ?? PUBLICATION_CI_POLICY;

  if (input.rollback) {
    const request = input.rollback;
    if (!request.confirmed) return refuse('rollback-not-confirmed');
    const reason = request.reason ?? request.reasonHeadNotPublished;
    if (!nonempty(reason)) return refuse('rollback-reason-required');
    const pair = input.verifiedPairs.find((candidate) => isPublicationRecord(candidate) &&
      candidate.releaseId === request.releaseId && candidate.destinationId === destinationId &&
      candidate.snapshotId === request.snapshotId);
    if (!pair || !isPublicationRecord(pair)) return refuse('no-verified-retained-release');
    const retained = input.retainedReleases?.find((release) => release.releaseId === pair.releaseId &&
      release.destinationId === destinationId);
    if (!retained) return refuse('release-beyond-retention');
    if (retained.treeDigest !== pair.treeDigest || treeDigest !== pair.treeDigest) return refuse('retained-release-digest-mismatch');
    if (pair.testRunConclusion !== 'success') return refuse('original-pair-unsuccessful');
    const problem = publicationCiProblem(pair, policy) ??
      localChecksProblem(pair.localChecks, pair) ?? localChecksProblem(input.localChecks, pair, ROLLBACK_GROUPS);
    if (problem) return refuse(problem);
    return { action: 'publish', pair, writesProvenanceEntry: false,
      rollbackRecord: { actor: input.actor, commit: pair.commit, snapshotId: pair.snapshotId,
        releaseId: pair.releaseId, reason, reasonHeadNotPublished: reason } };
  }

  if (input.headCommit !== input.headAtLastCheck) return refuse('head-moved');
  const pair = input.freshPair;
  if (!pair || pair.commit !== input.headCommit || pair.testRunConclusion !== 'success') return refuse('no-fresh-verified-pair-for-head');
  if (input.sourceRef === 'dev' && (!isPublicationRecord(pair) || publicationCiProblem(pair, policy))) return refuse('untrusted-publication-source');
  if (input.sourcePolicy === 'demo-publication-only') {
    const metadata = demoMetadataProblem(pair);
    if (metadata || !isPublicationRecord(pair) || pair.deployMode !== 'stand' || pair.paymentRole !== 'ci') return refuse(metadata ?? 'invalid-demo-destination');
  } else if (pair.sourcePolicy !== undefined || !positiveCount(pair.revision) || !Number.isSafeInteger(input.highWaterMark) ||
    input.highWaterMark < 0 || pair.revision! < input.highWaterMark) return refuse('content-newer-than-verified-pair');
  const problem = ciEvidenceProblem(input.ciEvidence, pair.commit, policy, input.sourceRef) ??
    localChecksProblem(input.localChecks, { ...pair, destinationId, treeDigest });
  if (problem) return refuse(problem);
  return { action: 'publish', pair };
}
