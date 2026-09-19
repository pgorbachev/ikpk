import { isDeepStrictEqual } from 'node:util';
import { contentFingerprint, snapshotId } from './content-snapshot.ts';
import { chooseManualPublication, ciEvidenceProblem, localChecksProblem } from './publish-gate.ts';
import type { PublicationCheckInput } from './publication-checks.ts';
import type { Snapshot } from './content-snapshot.ts';
import type { CiEvidence, LocalChecks, PublicationRecord } from './publish-gate.ts';
import type { PublicationStateStore } from './publication-state-store.ts';
import { PublicationProvenanceMismatchError } from './publication-state-store.ts';

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
  if (!/^[a-f0-9]{40}$/.test(input.commit) || !input.actor?.trim() || !input.destinationId?.trim() ||
      ![input.publicationId, input.releaseId].every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) ||
      !['stand', 'prod'].includes(input.deployMode) || !['ci', 'stand', 'prod'].includes(input.paymentRole)) throw new Error('invalid publication input');
  const origin = new URL(input.origin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid publication origin');
  const ci = await ports.readCiEvidence(input.commit);
  const ciProblem = ciEvidenceProblem(ci, input.commit);
  if (ciProblem) throw new Error(ciProblem);
  // Producer-owned objects must never remain aliases of durable publication evidence.
  const ciEvidence = structuredClone(ci);
  const checked = await ports.runChecks(input);
  const snapshot = structuredClone(checked.snapshot);
  const report = structuredClone(checked.report);
  if (!snapshot || snapshot.origin?.kind !== 'live' || !snapshot.origin.url || !snapshot.origin.capturedAt ||
      !Number.isFinite(Date.parse(snapshot.origin.capturedAt)) || !snapshot.fingerprint ||
      contentFingerprint(snapshot.content) !== snapshot.fingerprint ||
      snapshotId({ fingerprint: snapshot.fingerprint, referenceDate: snapshot.referenceDate }) !== snapshot.snapshotId) {
    throw new Error('unverified live snapshot identity');
  }
  const provenance = snapshot.provenance;
  const capturedProvenance = `observedEntry=${provenance?.observedEntry ?? 'missing'} revision=${provenance?.revision ?? 'missing'}`;
  if (!provenance || ![provenance.observedEntry, provenance.revision, provenance.highWaterMark]
    .every((value) => Number.isSafeInteger(value) && Number(value) > 0) ||
    provenance.revision! < provenance.highWaterMark) {
    throw new Error(`snapshot provenance requires accepted current state: ${capturedProvenance} highWaterMark=${provenance?.highWaterMark ?? 'missing'}`);
  }
  const treeDigest = await ports.digest(input.treeDir);
  const identity = { commit: input.commit, snapshotId: snapshot.snapshotId!, destinationId: input.destinationId, treeDigest };
  if (!/^[a-f0-9]{64}$/.test(treeDigest)) throw new Error('invalid artifact digest');
  const reportProblem = localChecksProblem(report, identity);
  if (reportProblem) throw new Error(reportProblem);
  async function checkState() {
    const state = await ports.state.read(snapshot.fingerprint!).catch((error: unknown) => {
      if (error instanceof PublicationProvenanceMismatchError) {
        throw new Error(`publication provenance changed: ${capturedProvenance} latestEntry=${error.latestEntry} highWaterMark=${error.highWaterMark}`);
      }
      throw error;
    });
    const last = state.entries.at(-1);
    if (!last || last.fingerprint !== snapshot.fingerprint || last.number !== provenance!.observedEntry ||
        state.observation.requiresConfirmation || state.observation.observedEntry !== provenance!.observedEntry ||
        state.observation.revision !== provenance!.revision || state.observation.highWaterMark !== provenance!.highWaterMark) {
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
          if (await ports.readMain() !== input.commit) throw new Error('main changed before activation');
          await checkState();
        },
        recordIndex: async (active) => {
          if (!isDeepStrictEqual(active, operation)) throw new Error('active publication operation mismatch');
          const release = await servingResponse('/release.json', origin, ports.fetch);
          const body = await boundedReleaseJson(release);
          if (!body || body.commit !== operation.commit || body.snapshotId !== operation.snapshotId) throw new Error('served release identity mismatch');
          const health = await servingResponse('/', origin, ports.fetch);
          await health.body?.cancel();
          await ports.state.appendPublication(structuredClone(operation));
        },
      });
    });
    return structuredClone(operation);
  } finally { usable = false; }
}

/** Follow redirects explicitly so a foreign host is never contacted. */
async function servingResponse(path: string, origin: URL, fetch: typeof globalThis.fetch): Promise<Response> {
  let url = new URL(path, origin); const seen = new Set<string>();
  for (let count = 0; count < 6; count++) {
    if (url.hostname !== origin.hostname || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) {
      throw new Error('unsafe serving redirect');
    }
    seen.add(url.href);
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
    if (response.url && new URL(response.url).hostname !== origin.hostname) {
      await response.body?.cancel(); throw new Error('serving host mismatch');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('serving redirect missing location');
      url = new URL(location, url); continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`serving HTTP ${response.status}`); }
    return response;
  }
  throw new Error('too many serving redirects');
}

async function boundedReleaseJson(response: Response): Promise<{ commit?: unknown; snapshotId?: unknown } | null> {
  if (!response.body) throw new Error('missing release response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 32_768) throw new Error('release response too large'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}
