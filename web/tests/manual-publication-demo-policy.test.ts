import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, type DestinationConfig } from '../scripts/publication-context.ts';
import { chooseManualPublication } from '../scripts/lib/publish-gate.ts';
import { runNewPublication } from '../scripts/lib/publication-runner.ts';
import { runPublicationRollback } from '../scripts/lib/publication-rollback.ts';
import { runnerFixture, SHA } from './helpers/publication-runner-fixture.ts';
import { rollbackFixture } from './helpers/publication-rollback-fixture.ts';

const POLICY = 'demo-publication-only' as const;
const fixtures: ReturnType<typeof runnerFixture>[] = [];
const temporary: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.clean();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const clean of cleanups.splice(0)) clean();
});

function demoRunnerFixture() {
  const f = fixture();
  Object.assign(f.input, { sourcePolicy: POLICY, origin: 'https://staging.ikpk.su' });
  delete f.snapshot.provenance;
  // Trusted fixture runChecks result; production obtains this proof from the
  // installed server capture adapter, never from operator JSON or REST reads.
  Object.assign(f.snapshot, { sourcePolicy: POLICY, sourceAge: 'untracked',
    origin: { kind: 'server-db', sourceId: 'demo193-cms', capturedAt: '2026-09-19T12:59:00.000Z' },
    captureProof: { version: 1, method: 'quiesced-sqlite-backup', sourceId: 'demo193-cms', captureId: f.input.publicationId,
      schemaDigest: '1'.repeat(64), databaseDigest: '2'.repeat(64), mediaManifestDigest: '3'.repeat(64), bundleDigest: '4'.repeat(64) } });
  writeFileSync(join(f.snapshotDir, 'snapshot.json'), JSON.stringify(f.snapshot));
  f.ports.state.read = async () => { throw new Error('DEMO must not invent a journal observation'); };
  return f;
}

describe('DEMO runner consumes the trusted immutable capture', () => {
  it('publishes once with explicit untracked discriminator and no synthesized journal fields', async () => {
    const f = demoRunnerFixture(); const before = readFileSync(join(f.snapshotDir, 'snapshot.json'));
    const history = structuredClone(f.state.provenance);
    const result = await runNewPublication(f.input, f.ports);
    expect(result).toMatchObject({ recordKind: 'publication-snapshot', sourcePolicy: POLICY, sourceAge: 'untracked',
      publicationId: f.input.publicationId, commit: SHA, snapshotId: f.snapshot.snapshotId, treeDigest: f.report.treeDigest,
      ciEvidence: f.ci, localChecks: f.report, captureProof: Reflect.get(f.snapshot, 'captureProof'), deployMode: 'stand', paymentRole: 'ci' });
    for (const key of ['revision', 'observedEntry', 'highWaterMark']) expect(result).not.toHaveProperty(key);
    expect(f.state.checks).toBe(1); expect(f.state.captures).toBe(1);
    expect(f.index).toEqual([result]); expect(f.current()).toBe(f.input.releaseId);
    expect(f.state.provenance).toEqual(history);
    expect(readFileSync(join(f.snapshotDir, 'snapshot.json'))).toEqual(before);
    const events = f.events.map(({ name }) => name);
    expect(events.indexOf('health-read')).toBeLessThan(events.indexOf('index'));
    expect(events).not.toContain('state'); expect(existsSync(f.pendingPath)).toBe(false);
  });

  it.each(['missing-proof', 'foreign-capture', 'foreign-source', 'journal-provenance'] as const)('rejects %s before transport', async (fault) => {
    const f = demoRunnerFixture();
    if (fault === 'missing-proof') Reflect.deleteProperty(f.snapshot, 'captureProof');
    if (fault === 'foreign-capture') Reflect.get(f.snapshot, 'captureProof').captureId = 'other-publication';
    if (fault === 'foreign-source') Reflect.get(f.snapshot, 'captureProof').sourceId = 'other-cms';
    if (fault === 'journal-provenance') f.snapshot.provenance = { observedEntry: 4, revision: 4, highWaterMark: 4 };
    await expect(runNewPublication(f.input, f.ports)).rejects.toThrow();
    expect(f.state.connections).toBe(0); expect(f.current()).toBe('old'); expect(f.index).toEqual([]);
  });

  it('rejects changed artifact bytes after the trusted checks before connecting', async () => {
    const f = demoRunnerFixture();
    const checks = f.ports.runChecks;
    f.ports.runChecks = async (input) => { const checked = await checks(input); writeFileSync(join(f.input.treeDir, 'index.html'), 'unchecked'); return checked; };
    await expect(runNewPublication(f.input, f.ports)).rejects.toThrow(/digest|mismatch/i);
    expect(f.state.connections).toBe(0); expect(f.current()).toBe('old'); expect(f.index).toEqual([]);
  });

  it.each(['serving', 'index'] as const)('%s failure after switching preserves original pending operation for recovery', async (fault) => {
    const f = demoRunnerFixture();
    if (fault === 'serving') f.state.healthStatus = 503;
    else f.state.appendFailure = true;
    await expect(runNewPublication(f.input, f.ports)).rejects.toMatchObject({ audit: { code: 'active-unindexed' },
      activeOperation: expect.objectContaining({ publicationId: f.input.publicationId, recordKind: 'publication-snapshot', sourceAge: 'untracked' }) });
    expect(f.current()).toBe(f.input.releaseId); expect(f.index).toEqual([]); expect(existsSync(f.pendingPath)).toBe(true);
    const pending = JSON.parse(readFileSync(f.pendingPath, 'utf8'));
    expect(pending.publicationId).toBe(f.input.publicationId); expect(pending).not.toHaveProperty('revision');
  });
});

describe('confirmed DEMO rollback keeps retained bytes and historical proof', () => {
  it('reuses a retained publication snapshot without requiring a fabricated journal revision', async () => {
    const f = rollbackFixture({ destinationId: 'stand', deployMode: 'stand', origin: 'https://staging.ikpk.su' }); cleanups.push(f.clean);
    delete (f.original as Partial<typeof f.original>).revision;
    Object.assign(f.original, { recordKind: 'publication-snapshot', sourcePolicy: POLICY, sourceAge: 'untracked' });
    const history = structuredClone(f.history);
    const result = await runPublicationRollback(f.input, f.ports);
    expect(result).toMatchObject({ rollbackOfPublicationId: f.original.publicationId, recordKind: 'publication-snapshot',
      sourcePolicy: POLICY, sourceAge: 'untracked', ciEvidence: f.original.ciEvidence, localChecks: f.original.localChecks });
    expect(result).not.toHaveProperty('revision'); expect(f.history).toEqual(history);
    expect(f.appended).toEqual([result]); expect(f.state.currentReleaseId).toBe(f.input.releaseId);
    expect(f.events.some(({ name }) => name === 'forbidden-live-source')).toBe(false);
  });
});
function fixture() { const f = runnerFixture(); fixtures.push(f); return f; }
function protectedConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-demo-policy-')); temporary.push(dir);
  const knownHostsFile = join(dir, 'known_hosts'); writeFileSync(knownHostsFile, 'fixture'); chmodSync(knownHostsFile, 0o600);
  const config: DestinationConfig & { sourcePolicy?: string } = {
    canonicalRepository: 'https://github.com/pgorbachev/ikpk.git', sshTarget: 'deploy@193.124.115.99',
    destinationId: 'stand', deployMode: 'stand', paymentRole: 'ci', siteUrl: 'https://staging.ikpk.su',
    actor: 'operator@example.invalid', webRoot: '/var/www/ikpk', knownHostsFile, keepReleases: 5, chatLoaderSrc: 'none',
    sourcePolicy: POLICY,
  };
  function read() { const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify(config)); chmodSync(path, 0o600); return readConfig(path); }
  return { config, read };
}

describe('protected DEMO source policy', () => {
  it('accepts the exact stand binding with main and retains the independent dev profile', () => {
    const f = protectedConfig(); expect(f.read()).toMatchObject({ sourcePolicy: POLICY });
    Object.assign(f.config, { sourceRef: 'dev', sourceProfile: 'demo-dev' });
    expect(f.read()).toMatchObject({ sourcePolicy: POLICY, sourceRef: 'dev', sourceProfile: 'demo-dev' });
  });

  it.each(['host', 'origin', 'mode', 'payment-stand', 'payment-prod', 'unknown-policy'] as const)('rejects %s despite otherwise valid configuration', (fault) => {
    const f = protectedConfig();
    if (fault === 'host') f.config.sshTarget = 'deploy@192.0.2.7';
    if (fault === 'origin') f.config.siteUrl = 'https://other.example.invalid';
    if (fault === 'mode') f.config.deployMode = 'prod';
    if (fault === 'unknown-policy') f.config.sourcePolicy = 'demo-if-journal-missing';
    if (fault === 'payment-stand' || fault === 'payment-prod') {
      f.config.paymentRole = fault === 'payment-stand' ? 'stand' : 'prod';
      // Valid payment configuration proves this is the DEMO policy refusal.
      f.config.payment = { endpoint: 'https://payments.example.invalid/api', siteOrigin: f.config.siteUrl,
        mode: fault === 'payment-stand' ? 'test' : 'prod', shopId: fault === 'payment-stand' ? '1440249' : '409285' };
    }
    expect(() => f.read()).toThrow();
  });

  it('omitted policy stays omitted even when every DEMO binding matches', () => {
    const f = protectedConfig(); delete f.config.sourcePolicy;
    expect(f.read()).not.toHaveProperty('sourcePolicy');
  });

  it('a DEMO source policy alone cannot authorize dev', () => {
    const f = protectedConfig(); f.config.sourceRef = 'dev';
    expect(() => f.read()).toThrow();
  });
});

// Public discriminator contract only: the capture proof is verified by the capture
// boundary; this pure decision receives the freshly checked publication pair.
function demoDecisionInput() {
  const f = fixture();
  const { revision: _revision, observedEntry: _observedEntry, highWaterMark: _highWaterMark, ...pair } = f.operation();
  void _revision; void _observedEntry; void _highWaterMark;
  return { headCommit: SHA, headAtLastCheck: SHA, verifiedPairs: [], highWaterMark: 3,
    actor: f.input.actor, now: f.ports.now(), retentionDays: 90,
    sourcePolicy: POLICY, freshPair: { ...pair, recordKind: 'publication-snapshot' as const, sourcePolicy: POLICY, sourceAge: 'untracked' as const },
    ciEvidence: f.ci, localChecks: f.report, destinationId: f.input.destinationId, treeDigest: f.report.treeDigest };
}
// The current type requires revision; the approved discriminator branch has none.
// Casting the existing seam keeps RED a runtime decision failure, not an import failure.
const choose = chooseManualPublication as unknown as (input: ReturnType<typeof demoDecisionInput>) => ReturnType<typeof chooseManualPublication>;
describe('DEMO checked pair has no journal age', () => {
  it('authorizes a freshly checked publication snapshot without inventing revision 4', () => {
    const input = demoDecisionInput();
    expect(choose(input)).toMatchObject({ action: 'publish', pair: input.freshPair });
    expect(input.freshPair).not.toHaveProperty('revision');
  });

  it('blocks a new DEMO publication while the destination has an unfinished index record', () => {
    const input = { ...demoDecisionInput(), pendingDestinations: ['stand'] };
    expect(choose(input)).toMatchObject({ action: 'refuse', reason: 'unfinished-publication-record' });
  });

  it('still rejects a moved code head', () => {
    const input = demoDecisionInput(); input.headAtLastCheck = 'b'.repeat(40);
    expect(choose(input)).toMatchObject({ action: 'refuse', reason: 'head-moved' });
  });

  it.each(['snapshot-provenance', 'build-content', 'destination-mode', 'browser-smoke', 'payment-destination'])('requires the existing %s local group', (name) => {
    const input = demoDecisionInput(); input.localChecks.groups = input.localChecks.groups.filter((group) => group.name !== name);
    expect(choose(input)).toMatchObject({ action: 'refuse', reason: `local-group:${name}:count=0` });
  });

  it.each(['missing', 'foreign-repository', 'wrong-sha', 'zero-tests', 'skipped-job'] as const)('retains mandatory CI refusal for %s', (fault) => {
    const input = demoDecisionInput();
    let reason = 'missing-ci-evidence';
    if (fault === 'missing') delete (input as Partial<typeof input>).ciEvidence;
    if (fault === 'foreign-repository') { input.ciEvidence.repository = 'fork/ikpk'; reason = 'untrusted-ci-run'; }
    if (fault === 'wrong-sha') { input.ciEvidence.commit = 'b'.repeat(40); reason = 'untrusted-ci-run'; }
    if (fault === 'zero-tests') { input.ciEvidence.executedTests = 0; reason = 'ci-executed-tests:0'; }
    if (fault === 'skipped-job') { input.ciEvidence.jobs[0].conclusion = 'skipped'; reason = `required-ci-job:${input.ciEvidence.jobs[0].name}`; }
    expect(choose(input)).toMatchObject({ action: 'refuse', reason });
  });

  it('requires the local report digest to match the bytes selected for publication', () => {
    const input = demoDecisionInput(); input.treeDigest = 'f'.repeat(64);
    expect(choose(input)).toMatchObject({ action: 'refuse', reason: 'local-report-treeDigest-mismatch' });
  });

  it('does not turn a DEMO record into a journal revision even if the caller supplies one', () => {
    const input = demoDecisionInput(); Object.assign(input.freshPair, { revision: 4, observedEntry: 4, highWaterMark: 4 });
    expect(choose(input).action).toBe('refuse');
  });

  it.each(['legacy', 'production'] as const)('%s without provenance never falls back to DEMO', async (profile) => {
    const f = fixture(); delete f.snapshot.provenance;
    Object.assign(f.snapshot, { sourcePolicy: POLICY, sourceAge: 'untracked' });
    // Matching the real DEMO origin must not select an implicit policy.
    f.input.origin = 'https://staging.ikpk.su';
    if (profile === 'production') f.input.deployMode = 'prod';
    f.ports.state.read = async () => { throw new Error('journal unavailable'); };
    await expect(runNewPublication(f.input, f.ports)).rejects.toThrow();
    expect(f.state.connections).toBe(0); expect(f.state.checks).toBe(1);
    expect(f.current()).toBe('old'); expect(f.index).toEqual([]);
  });
});
