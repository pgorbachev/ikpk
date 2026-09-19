import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PUBLICATION_CI_POLICY, PUBLICATION_GROUPS, ROLLBACK_GROUPS, type LocalChecks, type PublicationRecord, type VerifiedPair } from '../../scripts/lib/publish-gate.ts';
import type { PublicationAuthorizationRequest, PublicationProof } from '../../scripts/lib/publication-runner.ts';
import { fixtureDigest } from './publication-readers-fixtures.ts';

export type RollbackAuthorizer = (request: PublicationAuthorizationRequest | { action: 'read-retained'; destinationId: string; releaseId: string }) => Promise<PublicationProof & { releaseId?: string }>;

// Proposed installed coordinator API; this fixture implements effects, never the decision.
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
export interface RollbackPorts {
  state: {
    readHistory(): Promise<{ head: string; publications: VerifiedPair[] }>;
    appendPublication(record: PublicationRecord): Promise<{ head: string; changed: boolean }>;
  };
  digest(path: string): Promise<string>;
  runChecks(input: RollbackCheckInput): Promise<LocalChecks>;
  createTransport(input: { authorize: RollbackAuthorizer }): {
    withLock<T>(callback: (session: {
      readRetained(input: { releaseId: string }): Promise<{ releaseId: string; destinationId: string; currentReleaseId: string; treeDir: string }>;
      rollback(input: { redirectsPath: 'deploy/nginx-redirects.conf'; releaseId: string; expectedDigest: string; operation: RollbackOperation;
        recordIndex(operation: RollbackOperation): Promise<void> }): Promise<void>;
    }) => Promise<T>): Promise<T>;
  };
  fetch: typeof globalThis.fetch; now(): string;
}
export const SHA = 'a'.repeat(40);
export const NOW = '2026-09-19T12:00:00.000Z';
export function rollbackFixture() {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-rollback-'));
  const treeDir = join(temp, 'retained-release'); mkdirSync(treeDir);
  writeFileSync(join(treeDir, 'index.html'), '<main>previous checked bytes</main>');
  writeFileSync(join(treeDir, 'release.json'), JSON.stringify({ commit: SHA, snapshotId: 'snapshot-old' }));
  const identity = { commit: SHA, snapshotId: 'snapshot-old', destinationId: 'prod', treeDigest: fixtureDigest(treeDir) };
  const original: PublicationRecord = {
    ...identity, publicationId: 'original-operation', releaseId: 'old-release', actor: 'original-operator',
    publishedAt: '2026-09-17T12:00:00.000Z', revision: 7, referenceDate: '2026-09-17',
    capturedAt: '2026-09-17T11:50:00.000Z', testRunConclusion: 'success', deployMode: 'prod', paymentRole: 'ci',
    ciEvidence: { repository: PUBLICATION_CI_POLICY.repository, workflow: PUBLICATION_CI_POLICY.workflow,
      commit: SHA, branch: 'main', event: 'push', runId: 42, conclusion: 'success', executedTests: 51,
      jobs: PUBLICATION_CI_POLICY.requiredJobs.map((name) => ({ name, conclusion: 'success' })) },
    localChecks: { ...identity, groups: PUBLICATION_GROUPS.map((name) => ({ name, conclusion: 'success', executedTests: 2 })) },
  };
  const newer = { ...structuredClone(original), publicationId: 'newer-operation', releaseId: 'current-release', publishedAt: '2026-09-18T12:00:00.000Z' };
  const history: VerifiedPair[] = [original, newer];
  const input: RollbackInput = { publicationId: 'rollback-operation', releaseId: original.releaseId, destinationId: 'prod',
    actor: 'rollback-operator', confirmed: true, reason: 'Broken navigation in current release', origin: 'https://site.test.invalid' };
  const report: LocalChecks = { ...identity, groups: ROLLBACK_GROUPS.map((name) => ({ name, conclusion: 'success', executedTests: 3 })) };
  const state = { locked: false, currentReleaseId: newer.releaseId, retained: true, pending: undefined as RollbackOperation | undefined,
    retainedDestination: 'prod', retainedReleaseId: original.releaseId, report: report as LocalChecks | undefined,
    appendFailure: false, healthStatus: 200, releaseBody: undefined as unknown, redirect: undefined as string | undefined,
    authorize: undefined as RollbackAuthorizer | undefined, checks: [] as RollbackCheckInput[], requests: [] as string[] };
  const events: { name: string; locked: boolean }[] = [];
  const appended: RollbackOperation[] = [];
  const hooks: { afterChecks?: () => void; beforeRollback?: () => Promise<void>; afterSwitch?: () => void; indexOperation?: (value: RollbackOperation) => RollbackOperation } = {};
  const event = (name: string) => events.push({ name, locked: state.locked });
  const forbidden = async () => { event('forbidden-live-source'); throw new Error('CMS/current main/old CI/snapshot unavailable'); };
  const ports: RollbackPorts & { readMain: typeof forbidden; readCiEvidence: typeof forbidden; capture: typeof forbidden; build: typeof forbidden } = {
    readMain: forbidden, readCiEvidence: forbidden, capture: forbidden, build: forbidden,
    state: {
      async readHistory() { event('history'); return { head: 'c'.repeat(40), publications: history }; },
      async appendPublication(record) {
        event('index'); assert.equal(state.locked, true); assert.equal(state.currentReleaseId, input.releaseId);
        assert.ok(state.pending, 'index append requires switched pending operation');
        if (state.appendFailure) throw new Error('index unavailable');
        appended.push(structuredClone(record) as RollbackOperation); return { head: 'd'.repeat(40), changed: true };
      },
    },
    async digest(path) { event('digest'); return fixtureDigest(path); },
    async runChecks(checkInput) {
      event('checks'); assert.equal(state.locked, true); state.checks.push(structuredClone(checkInput));
      assert.equal(checkInput.treeDir, treeDir); hooks.afterChecks?.(); return state.report as LocalChecks;
    },
    createTransport({ authorize }) {
      event('create-transport'); state.authorize = authorize;
      return { async withLock(callback) {
        await authorize({ action: 'connect', destinationId: input.destinationId });
        state.locked = true; event('lock');
        try {
          if (state.pending) throw new Error('unfinished-publication-record');
          return await callback({
            async readRetained(request) {
              event('retained'); assert.equal(request.releaseId, input.releaseId);
              const proof = await authorize({ action: 'read-retained', destinationId: input.destinationId, releaseId: request.releaseId });
              assert.equal(proof.releaseId, request.releaseId, 'retained read requires release-scoped proof');
              if (!state.retained) throw new Error('release-beyond-retention');
              return { releaseId: state.retainedReleaseId, destinationId: state.retainedDestination, currentReleaseId: state.currentReleaseId, treeDir };
            },
            async rollback(request) {
                assert.equal(request.redirectsPath, 'deploy/nginx-redirects.conf', 'checked redirect fragment must accompany activation');
              event('rollback'); await hooks.beforeRollback?.();
              await authorize({ action: 'rollback', destinationId: input.destinationId, operation: request.operation });
              assert.equal(request.releaseId, input.releaseId); assert.equal(request.expectedDigest, fixtureDigest(treeDir));
              state.pending = structuredClone(request.operation); state.currentReleaseId = request.releaseId; event('switch'); hooks.afterSwitch?.();
              try { await request.recordIndex(hooks.indexOperation?.(request.operation) ?? request.operation); }
              catch (cause) { throw Object.assign(new Error('active rollback could not be recorded', { cause }), { activeOperation: state.pending }); }
              state.pending = undefined; event('finish');
            },
          });
        } finally { event('unlock'); state.locked = false; }
      } };
    },
    async fetch(resource, init) {
      const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url);
      state.requests.push(url.href); event(url.pathname === '/release.json' ? 'release-read' : 'health-read');
      assert.equal(state.locked, true); assert.equal(state.currentReleaseId, input.releaseId);
      assert.equal(init?.redirect, 'manual');
      if (state.redirect) return new Response(null, { status: 302, headers: { location: state.redirect } });
      return new Response(url.pathname === '/release.json' ? JSON.stringify(state.releaseBody ?? JSON.parse(readFileSync(join(treeDir, 'release.json'), 'utf8'))) : 'ok',
        { status: url.pathname === '/release.json' ? 200 : state.healthStatus });
    },
    now: () => NOW,
  };
  // Legacy/live state effects are intentionally unavailable; history is sufficient.
  Object.assign(ports.state, { read: forbidden, acceptState: forbidden });
  return { input, ports, original, newer, history, report, state, events, appended, treeDir, temp, hooks,
    clean() { rmSync(temp, { recursive: true, force: true }); } };
}
