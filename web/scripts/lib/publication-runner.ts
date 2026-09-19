import { isDeepStrictEqual } from 'node:util';
import { verifyServedPublication } from './published-state.ts';
import { contentFingerprint, snapshotId } from './content-snapshot.ts';
import { chooseManualPublication, ciEvidenceProblem, localChecksProblem } from './publish-gate.ts';
import type { PublicationCheckInput } from './publication-checks.ts';
import type { Snapshot } from './content-snapshot.ts';
import type { CiEvidence, LocalChecks, PublicationRecord } from './publish-gate.ts';
import type { PublicationStateStore } from './publication-state-store.ts';
import type { WorkerAudit } from '../publication-worker.ts';
import { PUBLICATION_GROUPS } from './publish-gate.ts';
import { PublicationProvenanceMismatchError } from './publication-state-store.ts';

export interface NewPublicationInput extends PublicationCheckInput {
  publicationId: string; releaseId: string; actor: string; origin: string;
}
export interface PublishedOperation extends PublicationRecord {
  observedEntry: number; highWaterMark: number; headAtLastCheck: string;
}
export interface PublicationProof {
  destinationId: string; treeDigest: string; commit: string; snapshotId: string; releaseId?: string;
}
export interface PublicationAuthorizationRequest {
  action: 'connect' | 'stage' | 'activate' | 'rollback' | 'recover' | 'read-retained';
  destinationId: string; expectedDigest?: string; releaseId?: string;
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
  const audit: WorkerAudit = { version: 1, status: 'refused', code: 'publication-failed', commit: input.commit, publicationId: input.publicationId };
  let selectedOperation: PublishedOperation | undefined;
  try {
    if (!/^[a-f0-9]{40}$/.test(input.commit) || !input.actor?.trim() || !input.destinationId?.trim() ||
        ![input.publicationId, input.releaseId].every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) ||
        !['stand', 'prod'].includes(input.deployMode) || !['ci', 'stand', 'prod'].includes(input.paymentRole)) throw new Error('invalid publication input');
    const origin = new URL(input.origin);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid publication origin');
    audit.code = 'ci-failed';
    const ci = await ports.readCiEvidence(input.commit);
    audit.ciExecutedTests = ci?.executedTests;
    const ciProblem = ciEvidenceProblem(ci, input.commit);
    if (ciProblem) throw new Error(ciProblem);
    // Producer-owned objects must never remain aliases of durable publication evidence.
    const ciEvidence = structuredClone(ci);
    audit.code = 'checks-failed';
    const checked = await ports.runChecks(input);
    audit.code = 'publication-failed';
    const snapshot = structuredClone(checked.snapshot);
    const report = structuredClone(checked.report);
    if (Array.isArray(report?.groups) && report.groups.length && report.groups.every((group) => Number.isSafeInteger(group.executedTests) && group.executedTests >= 0)) {
      audit.localExecutedTests = report.groups.reduce((sum, group) => sum + group.executedTests, 0);
    }
    audit.snapshotId = snapshot?.snapshotId;
    if (!snapshot || snapshot.origin?.kind !== 'live' || !snapshot.origin.url || !snapshot.origin.capturedAt ||
        !Number.isFinite(Date.parse(snapshot.origin.capturedAt)) || !snapshot.fingerprint ||
        contentFingerprint(snapshot.content) !== snapshot.fingerprint ||
        snapshotId({ fingerprint: snapshot.fingerprint, referenceDate: snapshot.referenceDate }) !== snapshot.snapshotId) {
      throw new Error('unverified live snapshot identity');
    }
    const provenance = snapshot.provenance;
    Object.assign(audit, { observedEntry: provenance?.observedEntry, revision: provenance?.revision, highWaterMark: provenance?.highWaterMark });
    const capturedProvenance = `observedEntry=${provenance?.observedEntry ?? 'missing'} revision=${provenance?.revision ?? 'missing'}`;
    if (!provenance || ![provenance.observedEntry, provenance.revision, provenance.highWaterMark]
      .every((value) => Number.isSafeInteger(value) && Number(value) > 0) ||
      provenance.revision! < provenance.highWaterMark) {
      audit.code = 'provenance-changed';
      throw new Error(`snapshot provenance requires accepted current state: ${capturedProvenance} highWaterMark=${provenance?.highWaterMark ?? 'missing'}`);
    }
    const treeDigest = await ports.digest(input.treeDir);
    const identity = { commit: input.commit, snapshotId: snapshot.snapshotId!, destinationId: input.destinationId, treeDigest };
    if (!/^[a-f0-9]{64}$/.test(treeDigest)) throw new Error('invalid artifact digest');
    const reportProblem = localChecksProblem(report, identity);
    audit.treeDigest = treeDigest;
    if (reportProblem) {
      audit.code = 'checks-failed';
      audit.check = PUBLICATION_GROUPS.find((name) => {
        const matches = report.groups?.filter((group) => group.name === name) ?? [];
        return matches.length !== 1 || !Number.isSafeInteger(matches[0].executedTests) || matches[0].executedTests <= 0 || matches[0].conclusion !== 'success';
      });
      throw new Error(reportProblem);
    }
    async function checkState() {
      const state = await ports.state.read(snapshot.fingerprint!).catch((error: unknown) => {
        if (error instanceof PublicationProvenanceMismatchError) {
          Object.assign(audit, { code: 'provenance-changed', latestEntry: error.latestEntry, highWaterMark: error.highWaterMark });
          throw new Error(`publication provenance changed: ${capturedProvenance} latestEntry=${error.latestEntry} highWaterMark=${error.highWaterMark}`);
        }
        throw error;
      });
      const last = state.entries.at(-1);
      if (!last || last.fingerprint !== snapshot.fingerprint || last.number !== provenance!.observedEntry ||
          state.observation.requiresConfirmation || state.observation.observedEntry !== provenance!.observedEntry ||
          state.observation.revision !== provenance!.revision || state.observation.highWaterMark !== provenance!.highWaterMark) {
        Object.assign(audit, { code: 'provenance-changed', latestEntry: last?.number, highWaterMark: state.observation.highWaterMark });
        throw new Error(`publication provenance changed or requires confirmation: ${capturedProvenance} latestEntry=${last?.number ?? 'missing'} highWaterMark=${state.observation.highWaterMark}`);
      }
      return state;
    }
    const state = await checkState();
    const publishedAt = ports.now();
    if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('invalid publication timestamp');
    const operation: PublishedOperation = {
      ...identity, publicationId: input.publicationId, releaseId: input.releaseId, actor: input.actor,
      revision: provenance.revision!, observedEntry: provenance.observedEntry, highWaterMark: provenance.highWaterMark,
      headAtLastCheck: input.commit, referenceDate: snapshot.referenceDate, capturedAt: snapshot.origin.capturedAt,
      publishedAt, testRunConclusion: 'success', ciEvidence, localChecks: report,
      deployMode: input.deployMode, paymentRole: input.paymentRole,
    };
    selectedOperation = operation;
    const decision = chooseManualPublication({ headCommit: input.commit, headAtLastCheck: input.commit,
      highWaterMark: provenance.highWaterMark, actor: input.actor, now: publishedAt, retentionDays: 0,
      freshPair: operation, verifiedPairs: state.publications, ciEvidence, localChecks: report,
      destinationId: input.destinationId, treeDigest });
    if (decision.action !== 'publish') throw new Error(decision.reason ?? 'publication refused');
    let usable = true;
    const authorize: PublicationAuthorizer = async (request) => {
      if (!usable || request.destinationId !== operation.destinationId) throw new Error('publication authorization destination mismatch');
      if (request.action === 'stage') {
        if (request.expectedDigest !== operation.treeDigest) throw new Error('publication authorization digest mismatch');
      } else if (request.action === 'activate') {
        if (!isDeepStrictEqual(request.operation, operation)) throw new Error('publication authorization operation mismatch');
      } else if (request.action !== 'connect') throw new Error('publication action not authorized');
      return { ...identity };
    };
    const transport = ports.createTransport({ authorize });
    try {
      await transport.withLock(async (session) => {
        await session.stage({ releaseId: operation.releaseId, sourceDir: input.treeDir, expectedDigest: treeDigest });
        await session.activate({ releaseId: operation.releaseId, operation: structuredClone(operation),
          beforeActivate: async () => {
            if (await ports.readMain() !== input.commit) { audit.code = 'main-changed'; throw new Error('main changed before activation'); }
            await checkState();
          },
          recordIndex: async (active) => {
            if (!isDeepStrictEqual(active, operation)) throw new Error('active publication operation mismatch');
            await verifyServedPublication(operation, origin, ports.fetch);
            await ports.state.appendPublication(structuredClone(operation));
          },
        });
      });
      return structuredClone(operation);
    } finally { usable = false; }
  } catch (error) {
    // Only typed metadata from the fixed check runner crosses the audit boundary.
    if (error instanceof Error && 'audit' in error && error.audit && typeof error.audit === 'object') {
      const detail = error.audit as Partial<WorkerAudit>;
      if (detail.code === 'checks-failed') Object.assign(audit, { code: detail.code, check: detail.check, localExecutedTests: detail.localExecutedTests });
    }
    if (selectedOperation && error instanceof Error && 'activeOperation' in error && isDeepStrictEqual(error.activeOperation, selectedOperation)) {
      audit.code = 'active-unindexed';
      audit.activePair = { commit: selectedOperation.commit, snapshotId: selectedOperation.snapshotId, releaseId: selectedOperation.releaseId };
    }
    const failure = error instanceof Error ? error : new Error('publication failed');
    Object.assign(failure, { audit });
    throw failure;
  }
}

