import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { contentFingerprint, snapshotId, type Snapshot } from '../../scripts/lib/content-snapshot.ts';
import { PUBLICATION_CI_POLICY, PUBLICATION_GROUPS, type CiEvidence, type LocalChecks } from '../../scripts/lib/publish-gate.ts';
import type { NewPublicationInput, NewPublicationPorts, PublishedOperation, PublicationAuthorizer } from '../../scripts/lib/publication-runner.ts';
import type { PublicationStateSnapshot } from '../../scripts/lib/publication-state-store.ts';
import { fixtureDigest } from './publication-readers-fixtures.ts';

export const SHA = 'a'.repeat(40);
export const OTHER_SHA = 'b'.repeat(40);
export const NOW = '2026-09-19T13:00:00.000Z';
export function runnerFixture() {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-publication-runner-'));
  const treeDir = join(temp, 'web', 'dist');
  const remote = join(temp, 'remote');
  const snapshotDir = join(temp, 'snapshot');
  for (const path of [treeDir, snapshotDir, join(remote, 'releases', 'old')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(remote, 'releases', 'old', 'index.html'), '<main>previous release</main>');
  symlinkSync('releases/old', join(remote, 'current'));
  const input: NewPublicationInput = {
    publicationId: 'publication-42', releaseId: 'release-42', actor: 'operator@example.invalid',
    origin: 'https://stand.test.invalid', commit: SHA, destinationId: 'stand',
    deployMode: 'stand', paymentRole: 'ci', treeDir, reportPath: join(temp, 'local-report.json'),
  };
  const content = { types: { articles: [{ slug: 'captured-article', title: 'Captured once' }] }, media: [] };
  const fingerprint = contentFingerprint(content);
  const snapshot: Snapshot = {
    content, fingerprint, referenceDate: '2026-09-19',
    snapshotId: snapshotId({ fingerprint, referenceDate: '2026-09-19' }),
    origin: { kind: 'live', url: 'https://cms.test.invalid', capturedAt: '2026-09-19T12:59:00.000Z' },
    provenance: { observedEntry: 4, revision: 4, highWaterMark: 4 },
  };
  const ci: CiEvidence = {
    repository: PUBLICATION_CI_POLICY.repository, workflow: PUBLICATION_CI_POLICY.workflow,
    event: 'push', branch: 'main', commit: SHA, runId: 991, conclusion: 'success', executedTests: 57,
    jobs: PUBLICATION_CI_POLICY.requiredJobs.map((name) => ({ name, conclusion: 'success' })),
  };
  writeFileSync(join(treeDir, 'index.html'), '<main>fixture checked bytes</main>');
  writeFileSync(join(treeDir, 'release.json'), JSON.stringify({ commit: SHA, snapshotId: snapshot.snapshotId }));
  writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot));
  const report: LocalChecks = {
    commit: SHA, snapshotId: snapshot.snapshotId!, destinationId: 'stand', treeDigest: fixtureDigest(treeDir),
    groups: PUBLICATION_GROUPS.map((name, i) => ({ name, conclusion: 'success', executedTests: i + 1 })),
  };
  const provenance: PublicationStateSnapshot = {
    head: 'c'.repeat(40), observation: { observedEntry: 4, revision: 4, highWaterMark: 4, requiresConfirmation: false },
    entries: [1, 2, 3, 4].map((number) => ({ number, previous: number === 1 ? null : number - 1,
      fingerprint: number === 4 ? fingerprint : `earlier-fingerprint-${number}`, marker: 'edit' })),
    publications: [],
  };
  const events: { name: string; locked: boolean }[] = [];
  const index: PublishedOperation[] = [];
  const pendingPath = join(remote, '.publication-pending.json');
  const state = {
    ci: ci as CiEvidence | undefined, report: report as LocalChecks | undefined,
    snapshot, main: SHA, provenance, locked: false, connections: 0, checks: 0, captures: 0,
    authorize: undefined as PublicationAuthorizer | undefined,
    stageFailure: false, switchFailure: false, appendFailure: false, fetchFailure: false,
    releaseStatus: 200, healthStatus: 200, releaseBody: { commit: SHA, snapshotId: snapshot.snapshotId } as unknown,
    redirectRelease: undefined as string | undefined, redirectHealth: undefined as string | undefined,
    requests: [] as { url: string; init?: RequestInit }[],
  };
  const hooks: { afterStage?: () => void; afterFinal?: () => void; afterSwitch?: () => void } = {};
  const event = (name: string) => events.push({ name, locked: state.locked });
  const current = () => basename(realpathSync(join(remote, 'current')));
  function changedEvent() {
    const next = state.provenance.entries.at(-1)!.number + 1;
    state.provenance = {
      ...state.provenance, head: 'd'.repeat(40),
      entries: [...state.provenance.entries, { number: next, previous: next - 1, fingerprint: 'new-cms-content', marker: 'edit' }],
      observation: { observedEntry: next, revision: next, highWaterMark: next, requiresConfirmation: false },
    };
  }
  const ports: NewPublicationPorts = {
    async readCiEvidence(commit) { event('ci'); assert.equal(commit, SHA); return state.ci as CiEvidence; },
    async runChecks(checkInput) {
      event('checks'); state.checks++; state.captures++;
      assert.equal(checkInput.treeDir, input.treeDir);
      if (state.report !== undefined) writeFileSync(input.reportPath, JSON.stringify(state.report));
      return { report: state.report as LocalChecks, snapshot: state.snapshot };
    },
    async readMain() { event('main'); return state.main; },
    state: {
      async read(observedFingerprint) { event('state'); assert.equal(observedFingerprint, state.snapshot.fingerprint); return structuredClone(state.provenance); },
      async appendPublication(record) {
        event('index'); assert.equal(state.locked, true, 'index write must remain inside host lock');
        assert.equal(current(), input.releaseId, 'cannot record publication before actual activation');
        assert.equal(existsSync(pendingPath), true, 'pending must survive until index acknowledgement');
        if (state.appendFailure) throw new Error('index push refused');
        index.push(structuredClone(record) as PublishedOperation);
        return { head: 'e'.repeat(40), changed: true };
      },
    },
    async digest(path) { event('digest'); return fixtureDigest(path); },
    createTransport({ authorize }) {
      event('create-transport'); state.authorize = authorize;
      return {
        async withLock(callback) {
          event('authorize-connect');
          const proof = await authorize({ action: 'connect', destinationId: input.destinationId });
          assert.deepEqual(proof, { commit: SHA, snapshotId: report.snapshotId, destinationId: 'stand', treeDigest: report.treeDigest });
          state.connections++; state.locked = true; event('lock');
          try {
            return await callback({
              async stage(request) {
                event('stage'); assert.equal(state.locked, true);
                await authorize({ action: 'stage', destinationId: input.destinationId, expectedDigest: request.expectedDigest });
                if (state.stageFailure) throw new Error('remote checksum mismatch');
                assert.equal(fixtureDigest(request.sourceDir), request.expectedDigest);
                cpSync(request.sourceDir, join(remote, 'releases', request.releaseId), { recursive: true });
                hooks.afterStage?.();
              },
              async activate(request) {
                assert.equal(request.redirectsPath, 'deploy/nginx-redirects.conf', 'checked redirect fragment must accompany activation');
                event('prepare'); assert.equal(state.locked, true);
                await authorize({ action: 'activate', destinationId: input.destinationId, operation: request.operation });
                writeFileSync(pendingPath, JSON.stringify(request.operation));
                try { await request.beforeActivate(); }
                catch (error) { unlinkSync(pendingPath); event('cancel'); throw error; }
                event('final-complete'); hooks.afterFinal?.();
                if (state.switchFailure) throw new Error('atomic switch failed');
                const next = join(remote, 'current.next'); symlinkSync(`releases/${request.releaseId}`, next); renameSync(next, join(remote, 'current'));
                event('switch'); hooks.afterSwitch?.();
                try { await request.recordIndex(request.operation); }
                catch (error) {
                  const failure = new Error(`post-switch failure; active release=${request.operation.releaseId} commit=${request.operation.commit} snapshotId=${request.operation.snapshotId}`, { cause: error });
                  Object.assign(failure, { activeOperation: request.operation }); throw failure;
                }
                unlinkSync(pendingPath); event('finish');
              },
            });
          } finally { event('unlock'); state.locked = false; }
        },
      };
    },
    async fetch(resource, init) {
      const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
      state.requests.push({ url, init }); event(new URL(url).pathname === '/release.json' ? 'release-read' : 'health-read');
      assert.equal(state.locked, true, 'post-switch HTTP checks must hold the host lock');
      assert.equal(current(), input.releaseId, 'health cannot run before switch');
      assert.equal(init?.method ?? 'GET', 'GET');
      if (state.fetchFailure) throw new Error('serving unavailable');
      const release = new URL(url).pathname === '/release.json';
      const redirect = release ? state.redirectRelease : state.redirectHealth;
      if (redirect && url !== redirect) return new Response(null, { status: 302, headers: { location: redirect } });
      return new Response(release ? JSON.stringify(state.releaseBody) : '<html>served site</html>', {
        status: release ? state.releaseStatus : state.healthStatus,
        headers: { 'content-type': release ? 'application/json' : 'text/html' },
      });
    },
    now: () => NOW,
  };
  function operation(): PublishedOperation {
    return { commit: report.commit, snapshotId: report.snapshotId, destinationId: report.destinationId, treeDigest: report.treeDigest, publicationId: input.publicationId, releaseId: input.releaseId, actor: input.actor,
      revision: 4, observedEntry: 4, highWaterMark: 4, headAtLastCheck: SHA,
      referenceDate: snapshot.referenceDate, capturedAt: snapshot.origin!.capturedAt!, publishedAt: NOW,
      testRunConclusion: 'success', ciEvidence: structuredClone(ci), localChecks: structuredClone(report),
      deployMode: input.deployMode, paymentRole: input.paymentRole,
    };
  }
  return { temp, input, snapshotDir, state, hooks, ci, report, snapshot, ports, events, index, current,
    pendingPath, remote, changedEvent, operation, clean() { rmSync(temp, { recursive: true, force: true }); } };
}
