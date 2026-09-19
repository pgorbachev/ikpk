import { isDeepStrictEqual } from 'node:util';
import { chooseManualPublication, ciEvidenceProblem, isPublicationRecord, localChecksProblem, ROLLBACK_GROUPS } from './publish-gate.ts';
import type { WorkerAudit } from '../publication-audit.ts';
import type { LocalChecks, PublicationRecord } from './publish-gate.ts';
import type { PublicationAuthorizer } from './publication-runner.ts';
import type { PublicationStateStore } from './publication-state-store.ts';
import { verifyServedPublication } from './published-state.ts';

export interface RollbackInput {
  publicationId: string; releaseId: string; destinationId: string; actor: string;
  confirmed: boolean; reason: string; origin: string;
}
export interface RollbackOperation extends PublicationRecord {
  rollbackOfPublicationId: string; reason: string; rollbackChecks: LocalChecks;
}
export interface RollbackCheckInput {
  treeDir: string; commit: string; snapshotId: string; destinationId: string;
  deployMode: 'stand' | 'prod'; paymentRole: 'ci' | 'stand' | 'prod';
}
export interface RollbackReadiness {
  paymentReadiness(): Promise<{ status: number; contentType: string; body: unknown }>;
}
export interface RollbackPorts {
  state: Pick<PublicationStateStore, 'readHistory' | 'appendPublication'>;
  digest(treeDir: string): Promise<string>;
  runChecks(input: RollbackCheckInput, readiness: RollbackReadiness): Promise<LocalChecks>;
  createTransport(input: { authorize: PublicationAuthorizer }): {
    withLock<T>(callback: (session: {
      paymentReadiness?: RollbackReadiness['paymentReadiness'];
      readRetained(input: { releaseId: string }): Promise<{
        releaseId: string; destinationId: string; currentReleaseId: string; treeDir: string;
      }>;
      rollback(input: { redirectsPath: 'deploy/nginx-redirects.conf'; releaseId: string; expectedDigest: string; operation: RollbackOperation;
        recordIndex(operation: RollbackOperation): Promise<void> }): Promise<void>;
    }) => Promise<T>): Promise<T>;
  };
  fetch: typeof globalThis.fetch;
  now(): string;
}

/** Installed code only: this path neither loads main nor reads CMS or old Actions runs. */
export async function runPublicationRollback(input: RollbackInput, ports: RollbackPorts): Promise<RollbackOperation> {
  if (input.confirmed !== true || !input.actor?.trim() || !input.reason?.trim() || !input.destinationId?.trim() ||
      ![input.publicationId, input.releaseId].every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) {
    throw new Error('rollback requires confirmed input, actor and reason');
  }
  const origin = new URL(input.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid rollback origin');
  const { publications } = structuredClone(await ports.state.readHistory());
  const original = publications.find((record) => isPublicationRecord(record) && record.releaseId === input.releaseId && record.destinationId === input.destinationId);
  if (!original || !isPublicationRecord(original) || !Number.isSafeInteger(original.revision) || original.revision <= 0 ||
      original.testRunConclusion !== 'success' ||
      ciEvidenceProblem(original.ciEvidence, original.commit) || localChecksProblem(original.localChecks, original)) {
    throw new Error('no verified original retained publication');
  }
  if (publications.some((record) => isPublicationRecord(record) && record.publicationId === input.publicationId)) {
    throw new Error('rollback publication ID already exists');
  }
  const audit: WorkerAudit = { version: 1, status: 'refused', code: 'rollback-failed', commit: original.commit,
    releaseId: original.releaseId, snapshotId: original.snapshotId, treeDigest: original.treeDigest,
    publicationId: input.publicationId, revision: original.revision, ciExecutedTests: original.ciEvidence.executedTests };
  let checking = false;
  let usable = true;
  let operation: RollbackOperation | undefined;
  const authorize: PublicationAuthorizer = async (request) => {
    if (!usable || request.destinationId !== input.destinationId) throw new Error('rollback authorization destination mismatch');
    if (request.action === 'read-retained') {
      if (request.releaseId !== input.releaseId) throw new Error('rollback retained release mismatch');
    } else if (request.action === 'payment-readiness') {
      if (!checking || original.paymentRole === 'ci') throw new Error('rollback readiness not authorized');
    } else if (request.action === 'rollback') {
      if (!operation || !isDeepStrictEqual(request.operation, operation)) throw new Error('rollback authorization operation mismatch');
    } else if (request.action !== 'connect') throw new Error('rollback action not authorized');
    return { destinationId: original.destinationId, treeDigest: original.treeDigest,
      commit: original.commit, snapshotId: original.snapshotId, releaseId: original.releaseId };
  };
  try {
    return await ports.createTransport({ authorize }).withLock(async (session) => {
      const retained = await session.readRetained({ releaseId: input.releaseId });
      if (retained.releaseId !== input.releaseId || retained.destinationId !== input.destinationId ||
          !retained.currentReleaseId || retained.currentReleaseId === input.releaseId) throw new Error('rollback requires previous retained release in this destination');
      if (await ports.digest(retained.treeDir) !== original.treeDigest) throw new Error('retained release tree digest mismatch');
      let checks: LocalChecks;
      checking = true;
      try {
        checks = structuredClone(await ports.runChecks({ treeDir: retained.treeDir, commit: original.commit,
          snapshotId: original.snapshotId, destinationId: original.destinationId, deployMode: original.deployMode, paymentRole: original.paymentRole }, {
          async paymentReadiness() {
            if (!usable || !checking || original.paymentRole === 'ci' || !session.paymentReadiness) throw new Error('rollback readiness unavailable');
            return session.paymentReadiness();
          },
        }));
      } finally { checking = false; }
      if (Array.isArray(checks?.groups) && checks.groups.every((group) => Number.isSafeInteger(group.executedTests) && group.executedTests >= 0)) {
        audit.localExecutedTests = checks.groups.reduce((total, group) => total + group.executedTests, 0);
      }
      const problem = localChecksProblem(checks, original, ROLLBACK_GROUPS);
      if (problem) throw new Error(problem);
      if (await ports.digest(retained.treeDir) !== original.treeDigest) throw new Error('retained tree digest changed during checks');
      const publishedAt = ports.now();
      if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('invalid rollback timestamp');
      const decision = chooseManualPublication({ headCommit: '', highWaterMark: 0, verifiedPairs: publications,
        actor: input.actor, now: publishedAt, retentionDays: 0, destinationId: input.destinationId, treeDigest: original.treeDigest,
        localChecks: checks, retainedReleases: [original], rollback: { snapshotId: original.snapshotId,
          releaseId: input.releaseId, confirmed: input.confirmed, reason: input.reason } });
      if (decision.action !== 'publish') throw new Error(decision.reason ?? 'rollback refused');
      operation = { ...original, publicationId: input.publicationId, actor: input.actor, publishedAt,
        rollbackOfPublicationId: original.publicationId, reason: input.reason, rollbackChecks: checks };
      await session.rollback({ redirectsPath: 'deploy/nginx-redirects.conf', releaseId: input.releaseId, expectedDigest: original.treeDigest, operation: structuredClone(operation),
        async recordIndex(active) {
          if (!isDeepStrictEqual(active, operation)) throw new Error('active rollback operation mismatch');
          await verifyServedPublication(operation!, origin, ports.fetch);
          await ports.state.appendPublication(structuredClone(operation!));
        },
      });
      return structuredClone(operation);
    });
  } catch (error) {
    if (error instanceof Error && 'audit' in error && error.audit && typeof error.audit === 'object') {
      const detail = error.audit as Partial<WorkerAudit>;
      if (detail.code === 'checks-failed') Object.assign(audit, { code: detail.code, check: detail.check, localExecutedTests: detail.localExecutedTests });
    }
    if (operation && error instanceof Error && 'activeOperation' in error && isDeepStrictEqual(error.activeOperation, operation)) {
      audit.code = 'active-unindexed';
      audit.activePair = { commit: operation.commit, snapshotId: operation.snapshotId, releaseId: operation.releaseId };
    }
    const failure = error instanceof Error ? error : new Error('rollback failed');
    Object.assign(failure, { audit });
    throw failure;
  } finally { usable = false; }
}
