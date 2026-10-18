import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseManualPublication, type VerifiedPair } from '../scripts/lib/publish-gate.ts';
import { comparePublishedState } from '../scripts/lib/published-state.ts';
import { mergeVerifiedPairs, readVerifiedPairs, upsertVerifiedPair, writeVerifiedPairs } from '../scripts/lib/verified-pairs.ts';

// Contract from manual-publication-only, tasks 2.3/2.3a/2.6/2.11a/5.2a/5.3.
// These test-local types let the RED run exercise the existing implementation:
// missing exports are not the reason these tests fail.
type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'missing';
type CiEvidence = {
  repository: string; workflow: string; event: string; branch: string; commit: string;
  runId: number; conclusion: Conclusion; executedTests: number;
  jobs: { name: string; conclusion: Conclusion }[];
};
type Group = { name: string; conclusion: Conclusion; executedTests: number };
type LocalChecks = {
  commit: string; snapshotId: string; destinationId: string; treeDigest: string; groups: Group[];
};
type Publication = VerifiedPair & {
  publicationId: string; releaseId: string; destinationId: string; treeDigest: string;
  publishedAt: string; actor: string; ciEvidence: CiEvidence; localChecks: LocalChecks;
  paymentRole: 'ci' | 'stand' | 'prod'; deployMode: 'stand' | 'prod';
};
type Input = {
  headCommit: string; headAtLastCheck: string; highWaterMark: number;
  actor: string; now: string; retentionDays: number; verifiedPairs: Publication[];
  freshPair?: VerifiedPair; ciEvidence?: CiEvidence; localChecks?: LocalChecks;
  destinationId: string; treeDigest: string;
  expectedCi: { repository: string; workflow: string; requiredJobs: string[] };
  pendingDestinations: string[];
  retainedReleases: { releaseId: string; destinationId: string; treeDigest: string }[];
  rollback?: { releaseId: string; snapshotId: string; confirmed: boolean; reason?: string; reasonHeadNotPublished?: string };
};
type Decision = {
  action: string; reason?: string; pair?: VerifiedPair; writesProvenanceEntry?: boolean;
  rollbackRecord?: { actor: string; commit: string; snapshotId: string; releaseId: string; reason?: string; reasonHeadNotPublished?: string };
};
const choose = chooseManualPublication as unknown as (input: Input) => Decision;
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const DIGEST = '1'.repeat(64);
const GROUPS = ['snapshot-provenance', 'build-content', 'destination-mode', 'browser-smoke', 'payment-destination'];
const ROLLBACK_GROUPS = ['destination-mode', 'browser-smoke', 'payment-destination'];
const ci = (): CiEvidence => ({
  repository: 'pgorbachev/ikpk', workflow: '.github/workflows/test.yml', event: 'push',
  branch: 'main', commit: SHA, runId: 123, conclusion: 'success', executedTests: 27,
  jobs: [{ name: 'Tests', conclusion: 'success' }, { name: 'Browser tests', conclusion: 'success' }],
});
const checks = (snapshotId = 'snapshot-current', names = GROUPS): LocalChecks => ({
  commit: SHA, snapshotId, destinationId: 'production', treeDigest: DIGEST,
  groups: names.map((name) => ({ name, conclusion: 'success', executedTests: 2 })),
});
const pair = (snapshotId = 'snapshot-current'): VerifiedPair => ({
  commit: SHA, snapshotId, revision: 5, referenceDate: '2026-09-19',
  capturedAt: '2026-09-19T00:00:00Z', testRunConclusion: 'success',
});
const publication = (overrides: Partial<Publication> = {}): Publication => ({
  ...pair(), publicationId: 'publication-1', releaseId: 'release-1', destinationId: 'production',
  treeDigest: DIGEST, publishedAt: '2026-09-19T01:00:00Z', actor: 'operator',
  ciEvidence: ci(), localChecks: checks(), paymentRole: 'ci', deployMode: 'prod', ...overrides,
});
const input = (): Input => ({
  headCommit: SHA, headAtLastCheck: SHA, highWaterMark: 5, actor: 'operator',
  now: '2026-09-19T12:00:00Z', retentionDays: 90, verifiedPairs: [publication()],
  freshPair: pair(), ciEvidence: ci(), localChecks: checks(), destinationId: 'production', treeDigest: DIGEST,
  expectedCi: { repository: 'pgorbachev/ikpk', workflow: '.github/workflows/test.yml', requiredJobs: ['Tests', 'Browser tests'] },
  pendingDestinations: [], retainedReleases: [{ releaseId: 'release-1', destinationId: 'production', treeDigest: DIGEST }],
});
const rollbackInput = (): Input => ({
  ...input(), freshPair: undefined, ciEvidence: undefined,
  localChecks: checks('snapshot-current', ROLLBACK_GROUPS),
  rollback: { releaseId: 'release-1', snapshotId: 'snapshot-current', confirmed: true,
    reason: 'regression in the latest release', reasonHeadNotPublished: 'regression in the latest release' },
});
const refuse = (request: Input) => {
  const decision = choose(request);
  expect(decision.action).toBe('refuse');
  expect(decision.reason, 'refusal must name its reason').toBeTruthy();
  return decision;
};

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const store = () => { const dir = mkdtempSync(join(tmpdir(), 'ikpk-publication-core-')); temporary.push(dir); return dir; };

describe('new publication requires current CI and the freshly tested pair', () => {
  it('positive control: complete evidence authorizes production with independent payment role ci', () => {
    expect(choose(input())).toMatchObject({ action: 'publish', pair: pair() });
  });
  it('first publication uses its freshly tested pair without a historical entry', () => {
    expect(choose({ ...input(), verifiedPairs: [] })).toMatchObject({ action: 'publish', pair: pair() });
  });
  it('does not substitute a historical pair with a newer reference date', () => {
    const request = input();
    request.freshPair = pair('snapshot-fresh');
    request.localChecks = checks('snapshot-fresh');
    request.verifiedPairs = [publication({ referenceDate: '2026-09-20' })];
    expect(choose(request)).toMatchObject({ action: 'publish', pair: { snapshotId: 'snapshot-fresh' } });
  });
  it('historical success does not authorize a call without a freshly tested pair', () => {
    refuse({ ...input(), freshPair: undefined });
  });
  it('new publication refuses a moved head', () => { refuse({ ...input(), headAtLastCheck: OTHER }); });
  it('new publication refuses content older than the high-water mark', () => { refuse({ ...input(), highWaterMark: 6 }); });
  it('missing CI verdict does not inherit success from publication history', () => { refuse({ ...input(), ciEvidence: undefined }); });
  it.each([
    ['repository', 'outsider/ikpk'], ['workflow', '.github/workflows/lint.yml'],
    ['event', 'pull_request'], ['event', 'workflow_dispatch'], ['branch', 'feature'], ['commit', OTHER],
  ])('rejects inappropriate CI %s=%s even for a successful run', (field, value) => {
    const request = input();
    Object.assign(request.ciEvidence!, { [field]: value });
    refuse(request);
  });
  it('positive control: a successful schedule on main is valid evidence', () => {
    const request = input(); request.ciEvidence!.event = 'schedule';
    expect(choose(request).action).toBe('publish');
  });
  it.each(['failure', 'cancelled', 'skipped', 'missing'] as const)('refuses CI conclusion %s', (conclusion) => {
    const request = input(); request.ciEvidence!.conclusion = conclusion; refuse(request);
  });
  it.each(['failure', 'cancelled', 'skipped', 'missing'] as const)('refuses required job conclusion %s', (conclusion) => {
    const request = input(); request.ciEvidence!.jobs[1].conclusion = conclusion; refuse(request);
  });
  it('a missing required job is not a successful job', () => {
    const request = input(); request.ciEvidence!.jobs.pop(); refuse(request);
  });
  it('a missing run identity cannot become rollback evidence', () => {
    const request = input(); request.ciEvidence!.runId = 0; refuse(request);
  });
  it('zero executed CI tests refuses and reports the count', () => {
    const request = input(); request.ciEvidence!.executedTests = 0;
    expect(JSON.stringify(refuse(request))).toMatch(/0/);
  });
  it.each(['commit', 'snapshotId', 'destinationId', 'treeDigest'] as const)('local report for another %s is refused', (field) => {
    const request = input(); request.localChecks![field] = 'wrong'; refuse(request);
  });
  it('missing local report is refused', () => { refuse({ ...input(), localChecks: undefined }); });
  it.each(GROUPS)('omitting fixed group %s is refused even with other successful tests', (name) => {
    const request = input(); request.localChecks!.groups = request.localChecks!.groups.filter((g) => g.name !== name);
    expect(JSON.stringify(refuse(request))).toContain(name);
  });
  it.each(GROUPS)('zero executed tests in %s refuses and reports the group and count', (name) => {
    const request = input(); request.localChecks!.groups.find((g) => g.name === name)!.executedTests = 0;
    const decision = JSON.stringify(refuse(request)); expect(decision).toContain(name); expect(decision).toMatch(/0/);
  });
  it.each(['failure', 'cancelled', 'skipped', 'missing'] as const)('local group with %s is not a successful check', (conclusion) => {
    const request = input(); request.localChecks!.groups[0].conclusion = conclusion; refuse(request);
  });
  it('an unresolved index write blocks the same destination', () => { refuse({ ...input(), pendingDestinations: ['production'] }); });
  it('positive control: an unresolved stand write does not block production', () => {
    expect(choose({ ...input(), pendingDestinations: ['stand'] }).action).toBe('publish');
  });
});

describe('rollback authorization uses a retained release and its full original evidence', () => {
  it('positive control: explicit confirmed rollback uses retained bytes and does not request a provenance entry', () => {
    expect(choose(rollbackInput())).toMatchObject({ action: 'publish', writesProvenanceEntry: false });
  });
  it('retained old release works without fresh CI, a fresh snapshot, or a stable current head', () => {
    const request = rollbackInput();
    request.headCommit = OTHER; request.headAtLastCheck = 'c'.repeat(40);
    request.verifiedPairs[0].capturedAt = '2020-01-01T00:00:00Z';
    expect(choose(request)).toMatchObject({ action: 'publish', pair: { commit: SHA }, writesProvenanceEntry: false });
  });
  it('snapshot age alone cannot disqualify an intact retained release', () => {
    const request = rollbackInput(); request.verifiedPairs[0].capturedAt = '2020-01-01T00:00:00Z';
    expect(choose(request).action).toBe('publish');
  });
  it('a release evicted from retention is refused even while its snapshot is young', () => {
    const decision = refuse({ ...rollbackInput(), retainedReleases: [] });
    expect(decision.reason).toMatch(/release|retai|релиз|хран/);
  });
  it('a retained directory without a publication record is not a verified target', () => {
    refuse({ ...rollbackInput(), verifiedPairs: [] });
  });
  it('a target in another destination cannot authorize production', () => {
    const request = rollbackInput(); request.verifiedPairs[0].destinationId = 'stand'; refuse(request);
  });
  it('retained release location must belong to the selected destination', () => {
    const request = rollbackInput(); request.retainedReleases[0].destinationId = 'stand'; refuse(request);
  });
  it('the retained tree must match its recorded digest', () => {
    const request = rollbackInput(); request.retainedReleases[0].treeDigest = '2'.repeat(64); refuse(request);
  });
  it('release identity selects a complete commit+snapshot pair, not the first matching snapshot', () => {
    const request = rollbackInput();
    const original = request.verifiedPairs[0];
    request.verifiedPairs = [publication({ publicationId: 'unrelated', releaseId: 'other-release', commit: OTHER }), original];
    expect(choose(request)).toMatchObject({ action: 'publish', pair: { commit: SHA, snapshotId: original.snapshotId } });
  });
  it('confirmation is an explicit input', () => {
    const request = rollbackInput(); request.rollback!.confirmed = false; refuse(request);
  });
  it.each([undefined, '', '   '])('rollback requires a nonempty explicit reason: %s', (reason) => {
    const request = rollbackInput(); request.rollback!.reason = reason; request.rollback!.reasonHeadNotPublished = reason; refuse(request);
  });
  it('records the actor, full pair, release and reason', () => {
    const request = rollbackInput(); const decision = choose(request);
    expect(decision.rollbackRecord).toMatchObject({ actor: 'operator', commit: SHA,
      snapshotId: 'snapshot-current', releaseId: 'release-1' });
    expect(JSON.stringify(decision.rollbackRecord)).toContain(request.rollback!.reason!);
  });
  it('pending operation blocks rollback only in its destination', () => { refuse({ ...rollbackInput(), pendingDestinations: ['production'] }); });
  it.each(['ciEvidence', 'localChecks', 'paymentRole', 'deployMode', 'treeDigest'] as const)('incomplete original evidence without %s cannot authorize rollback', (key) => {
    const request = rollbackInput(); Reflect.deleteProperty(request.verifiedPairs[0], key); refuse(request);
  });
  it('unsuccessful original CI cannot be laundered by a successful pair flag', () => {
    const request = rollbackInput(); request.verifiedPairs[0].ciEvidence.conclusion = 'failure'; refuse(request);
  });
  it('incomplete original local groups cannot be laundered by a successful pair flag', () => {
    const request = rollbackInput(); request.verifiedPairs[0].localChecks.groups.pop(); refuse(request);
  });
  it.each(ROLLBACK_GROUPS)('rollback requires fresh successful nonzero %s checks on saved bytes', (name) => {
    const request = rollbackInput(); request.localChecks!.groups.find((g) => g.name === name)!.executedTests = 0; refuse(request);
  });
  it('rollback report must name the retained tree', () => {
    const request = rollbackInput(); request.localChecks!.treeDigest = '2'.repeat(64); refuse(request);
  });
});

describe('publication history is append-only and destination scoped', () => {
  it('publishing the same pair twice retains both operation records', () => {
    const original = publication(); const repeated = publication({ publicationId: 'publication-2', releaseId: 'release-2', publishedAt: '2026-09-19T02:00:00Z' });
    expect(upsertVerifiedPair([original], repeated)).toEqual([original, repeated]);
  });
  it('equal pairs in production and stand retain their distinct destination and digest', () => {
    const production = publication(); const stand = publication({ publicationId: 'stand-1', destinationId: 'stand', treeDigest: '2'.repeat(64) });
    expect(mergeVerifiedPairs([production], [stand])).toEqual([production, stand]);
  });
  it('positive control: retrying the exact operation is idempotent', () => {
    const record = publication(); expect(mergeVerifiedPairs([record], [structuredClone(record)])).toEqual([record]);
  });
  it('a conflicting reuse of an operation identity cannot rewrite earlier evidence', () => {
    const record = publication();
    const conflicting = { ...record, treeDigest: '2'.repeat(64) };
    expect(() => mergeVerifiedPairs([record], [conflicting])).toThrow();
  });
  it('persistent history keeps complete pair, count, group outcomes, destination and publication timestamp', () => {
    const dir = store(); const record = publication(); writeVerifiedPairs(dir, [record]);
    expect(readVerifiedPairs(dir)).toEqual([record]);
  });
  it('persistent history refuses deletion of an existing record', () => {
    const dir = store(); const record = publication(); writeVerifiedPairs(dir, [record]);
    expect(() => writeVerifiedPairs(dir, [])).toThrow();
    expect(readVerifiedPairs(dir)).toEqual([record]);
  });
  it('persistent history refuses replacement and preserves the original file bytes', () => {
    const dir = store(); const record = publication(); writeVerifiedPairs(dir, [record]);
    const before = readFileSync(join(dir, 'verified-pairs.json'), 'utf8');
    const conflicting = { ...record, actor: 'someone-else' };
    expect(() => writeVerifiedPairs(dir, [conflicting])).toThrow();
    expect(readFileSync(join(dir, 'verified-pairs.json'), 'utf8')).toBe(before);
  });
});

describe('observing production uses its last recorded pair, not current main or stand', () => {
  type ObservationInput = {
    expected: { commit: string; snapshotId: string }; observed: { commit: string; snapshotId: string } | null;
    publications: Publication[]; destinationId: string; pendingDestinations: string[];
  };
  const compare = comparePublishedState as unknown as (input: ObservationInput) => { status: string; reason?: string };
  const observe = (over: Partial<ObservationInput> = {}): ObservationInput => ({
    expected: pair(), observed: pair(), publications: [publication()], destinationId: 'production', pendingDestinations: [], ...over,
  });
  it('positive control: declared pair matches the record', () => { expect(compare(observe()).status).toBe('match'); });
  it('newer main is not the expected pair when publication history exists', () => {
    expect(compare(observe({ expected: { commit: OTHER, snapshotId: 'not-published' } })).status).toBe('match');
  });
  it('a later stand record does not change production observation', () => {
    const stand = publication({ publicationId: 'stand-1', destinationId: 'stand', commit: OTHER, snapshotId: 'stand-snapshot', publishedAt: '2026-09-19T03:00:00Z' });
    expect(compare(observe({ publications: [publication(), stand], expected: stand })).status).toBe('match');
  });
  it('a different served snapshot is a mismatch even for the same commit', () => {
    expect(compare(observe({ observed: { commit: SHA, snapshotId: 'other' } })).status).toBe('mismatch');
  });
  it('an unreadable release declaration is a failed observation', () => {
    expect(compare(observe({ observed: null })).status).toBe('unreadable');
  });
  it('a pending record explains the mismatch without calling it an out-of-band replacement', () => {
    const result = compare(observe({ observed: { commit: OTHER, snapshotId: 'new' }, pendingDestinations: ['production'] }));
    expect(result.status).not.toBe('match'); expect(result.reason).toMatch(/pending|unfinished|незаверш/);
  });
  it('pending stand operation does not explain a production mismatch', () => {
    const result = compare(observe({ observed: { commit: OTHER, snapshotId: 'new' }, pendingDestinations: ['stand'] }));
    expect(result.status).toBe('mismatch'); expect(result.reason ?? '').not.toMatch(/pending|unfinished|незаверш/);
  });
});

describe('review probes at 838eb7b4', () => {
  it('REVIEW: persisted append-only history cannot reorder past operations', () => {
    const dir = store(); const first = publication();
    const second = publication({ publicationId: 'publication-2', releaseId: 'release-2', snapshotId: 'new', publishedAt: '2026-09-19T02:00:00Z' });
    writeVerifiedPairs(dir, [first, second]);
    expect(() => writeVerifiedPairs(dir, [second, first])).toThrow();
  });
});
