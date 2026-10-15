import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  PENDING_SCOPE, REQUIRED_SOURCE_JOBS, RELEASE_TEST_WORKFLOW, SOURCE_SUITES, ReleaseTestError,
  releaseTestIdentity, releaseTestManifest, validateReleaseTestEvidence,
} from '../release-test-policy.mjs';
import { REQUIRED_TEST_REPORTS, NON_TEST_CHECKS } from '../release-test-reports.mjs';
const reportFixtures = () => REQUIRED_TEST_REPORTS.map(({ suite, runner }) => ({ suite, runner, reportSha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, flaky: 0, retried: 0, omissions: [], roleOmissions: [], acceptedDeviations: [] }));

const commit = 'a'.repeat(40);
const started = '2026-10-15T10:00:01Z';
const env = {
  RELEASE_SOURCE_PROFILE: 'source-default-ci-pinned',
  GITHUB_SHA: commit, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
};
const needs = Object.fromEntries(['identity', 'source-tests', 'supplemental', 'visual', 'provision']
  .map((key) => [key, { result: 'success' }]));

function evidence() {
  return {
    run: { id: 123, run_attempt: 2, head_sha: commit, event: 'push', head_branch: 'dev',
      repository: { full_name: 'pgorbachev/ikpk' }, head_repository: { full_name: 'pgorbachev/ikpk' },
      path: RELEASE_TEST_WORKFLOW, status: 'completed', conclusion: 'success',
      created_at: '2026-10-14T10:00:00Z', run_started_at: started },
    jobs: REQUIRED_SOURCE_JOBS.map((name) => ({ name, run_id: 123, head_sha: commit,
      status: 'completed', conclusion: 'success', started_at: started })),
    artifact: { name: 'release-source-tests-2', expired: false, created_at: started,
      workflow_run: { id: 123, head_sha: commit } },
    manifest: releaseTestManifest(env, needs, reportFixtures()),
    // Protected server operation receipt; never read from a caller-provided report.
    expected: { commit, sourceRef: 'dev', runId: 123, previousAttempt: 1, runAttempt: 2,
      destinationId: 'demo-193', requestId: 'request-unique-1', requestedAt: '2026-10-15T10:00:00.100Z' },
  };
}

test('push manifest records native identity without inventing a destination or request', () => {
  const manifest = releaseTestManifest(env, needs, reportFixtures());
  assert.equal(manifest.runId, 123);
  assert.equal(manifest.runAttempt, 2);
  assert.equal(manifest.commit, commit);
  assert.equal(Object.hasOwn(manifest, 'destinationId'), false);
  assert.equal(Object.hasOwn(manifest, 'requestId'), false);
  assert.deepEqual(manifest.pendingScope, PENDING_SCOPE);
  assert.throws(() => releaseTestIdentity({ ...env, GITHUB_REF: 'refs/heads/feature' }), /push ref/);
  assert.throws(() => releaseTestIdentity({ ...env, GITHUB_EVENT_NAME: 'pull_request' }), /event/);
});

test('owner excludes obsolete historical parity explicitly without treating production data as a fixture', () => {
  const manifest = releaseTestManifest(env, needs, reportFixtures());
  assert.equal(manifest.schemaVersion, 4);
  assert.deepEqual(manifest.pendingScope, []);
  assert.deepEqual(manifest.excludedHistorical, [
    'web/tests/compare.spec.ts',
    'web/tests/course-group-parity.spec.ts',
    'web/tests/institute-parity.spec.ts',
    'web/tests/parity-audit.spec.ts',
    'web/tests/schedule-parity.spec.ts',
    'web/tests/seminar-parity.spec.ts',
    'web/tests/parity-compare.test.ts',
  ].map((file) => ({ file, reason: 'old-site-absent', decision: 'owner-2026-10-15' })));
  assert.deepEqual(validateReleaseTestEvidence(evidence()).excludedHistorical, manifest.excludedHistorical);
});

test('dispatch SHA must equal the native checkout and every required job must succeed', () => {
  assert.equal(releaseTestIdentity({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', EXPECTED_SHA: commit }).commit, commit);
  assert.throws(() => releaseTestIdentity({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', EXPECTED_SHA: 'b'.repeat(40) }), /commit mismatch/);
  for (const name of Object.keys(needs)) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      assert.throws(() => releaseTestManifest(env, { ...needs, [name]: { result } }, reportFixtures()), /result mismatch/);
    }
  }
});

test('a fresh attempt of an older push run binds to this private destination and operation', () => {
  const result = validateReleaseTestEvidence(evidence());
  assert.equal(result.runId, 123); assert.equal(result.runAttempt, 2); assert.equal(result.commit, commit);
  assert.equal(result.destinationId, 'demo-193'); assert.equal(result.requestId, 'request-unique-1');
  assert.equal(result.subject, 'source-code'); assert.deepEqual(result.pendingScope, []);
  assert.equal(result.repository, 'pgorbachev/ikpk'); assert.equal(result.workflow, RELEASE_TEST_WORKFLOW);
  assert.equal(result.sourceRef, 'dev'); assert.equal(result.policyVersion, 4);
  assert.deepEqual(result.reports, reportFixtures());
  assert.deepEqual(result.nonTestChecks, NON_TEST_CHECKS);
  assert.deepEqual(result.suites, SOURCE_SUITES); assert.deepEqual(result.results, evidence().manifest.results);
  assert.deepEqual(result.jobs.map((job) => job.name), REQUIRED_SOURCE_JOBS);
  assert.ok(result.jobs.every((job) => job.conclusion === 'success' && job.commit === commit && job.runId === 123));
  assert.deepEqual(result.excludedHistorical, evidence().manifest.excludedHistorical);
});

test('refusals expose a stable code and no native output', () => {
  const proof = evidence();
  proof.run.run_started_at = '2026-10-14T10:00:00Z';
  assert.throws(() => validateReleaseTestEvidence(proof), (error) =>
    error instanceof ReleaseTestError && error.code === 'release-test-stale-attempt');
});

test('rejects historical success, wrong SHA, changed policy, stale or missing native evidence', () => {
  const mutations = [
    (proof) => { proof.run.run_started_at = '2026-10-14T10:00:00Z'; },
    (proof) => { proof.expected.previousAttempt = 2; },
    (proof) => { proof.run.run_attempt = 1; },
    (proof) => { proof.run.id = 999; },
    (proof) => { proof.run.head_sha = 'b'.repeat(40); },
    (proof) => { proof.run.repository.full_name = 'fork/ikpk'; },
    (proof) => { proof.run.head_repository.full_name = 'fork/ikpk'; },
    (proof) => { proof.run.head_branch = 'main'; },
    (proof) => { proof.run.path = '.github/workflows/test.yml'; },
    (proof) => { proof.run.status = 'in_progress'; },
    (proof) => { proof.run.conclusion = 'failure'; },
    (proof) => { proof.manifest.runAttempt = 1; },
    (proof) => { proof.manifest.commit = 'b'.repeat(40); },
    (proof) => { proof.manifest.suites.pop(); },
    (proof) => { proof.manifest.reports.pop(); },
    (proof) => { proof.manifest.reports[0].passed = 0; },
    (proof) => { proof.manifest.reports[0].skipped = 1; },
    (proof) => { proof.manifest.reportPolicyVersion = 0; },
    (proof) => { proof.manifest.sourceProfile = 'preview-role'; },
    (proof) => { proof.manifest.pendingScope = ['unexpected-pending-suite']; },
    (proof) => { proof.manifest.schemaVersion = 1; },
    (proof) => { proof.manifest.excludedHistorical = []; },
    (proof) => { proof.manifest.excludedHistorical = [{ file: 'web/tests/compare.spec.ts', reason: 'arbitrary-omission' }]; },
    (proof) => { proof.manifest.results.supplemental = 'skipped'; },
    (proof) => { proof.artifact.workflow_run.id = 999; },
    (proof) => { proof.artifact.workflow_run.head_sha = 'b'.repeat(40); },
    (proof) => { proof.artifact.expired = true; },
    (proof) => { proof.artifact.created_at = '2026-10-14T10:00:00Z'; },
    (proof) => { proof.jobs.pop(); },
    (proof) => { proof.jobs.push({ ...proof.jobs[0] }); },
    (proof) => { proof.jobs[0].run_id = 999; },
    (proof) => { proof.jobs[0].head_sha = 'b'.repeat(40); },
    (proof) => { proof.jobs[0].conclusion = 'skipped'; },
    (proof) => { proof.jobs[0].started_at = '2026-10-14T10:00:00Z'; },
    (proof) => { proof.expected.destinationId = ''; },
    (proof) => { proof.expected.requestId = ''; },
  ];
  for (const mutate of mutations) {
    const proof = evidence();
    mutate(proof);
    assert.throws(() => validateReleaseTestEvidence(proof), undefined, mutate.toString());
  }
});

test('candidate acceptance cannot be inferred from source coverage', () => {
  const manifest = releaseTestManifest(env, needs, reportFixtures());
  assert.equal(manifest.subject, 'source-code');
  assert.equal(Object.hasOwn(manifest, 'ready'), false);
  assert.equal(Object.hasOwn(manifest, 'candidateAccepted'), false);
});

test('workflow preserves existing Tests and all supplemental subjects without deployment authority', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release-tests.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \[dev, main\]/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/test\.yml/);
  assert.match(workflow, /artifact_suffix: -release-\$\{\{ github.run_attempt \}\}/);
  for (const command of ['npm run test:e2e:compat', 'npm test', 'npm run build',
    'npm run test:e2e', 'npm run test:e2e:visual', 'vitest.provision.config.ts']) {
    assert.ok(workflow.includes(command), command);
  }
  assert.match(workflow, /runs-on: macos-14/);
  const reusable = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(reusable, /group:.*inputs.artifact_suffix != '' && format\('release-source-\{0\}-\{1\}', github.run_id, github.run_attempt\)/);
  assert.match(reusable, /cancel-in-progress:.*inputs.artifact_suffix == ''/);
  assert.match(reusable, /if \[ "\$RELEASE_STRICT_REPORTS" = true \]; then\n\s+export PAYMENT_ROLE=ci\n\s+historical_args\+=\(--exclude tests\/parity-compare\.test\.ts\)\n\s+fi\n\s+npm run build/);
  assert.match(workflow, /RELEASE_SOURCE_PROFILE: source-default-ci-pinned/);
  assert.doesNotMatch(workflow, /secrets\.|secrets: inherit|--update-snapshots|continue-on-error: true|ssh |deploy\.sh/);
  assert.equal(new Set(SOURCE_SUITES).size, SOURCE_SUITES.length);
  const snapshots = readdirSync(new URL('../../web/tests/visual-baseline.spec.ts-snapshots/', import.meta.url));
  assert.equal(snapshots.filter((name) => name.endsWith('-darwin.png')).length, 12);
});
