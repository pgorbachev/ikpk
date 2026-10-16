/** Source-code checks only. Candidate acceptance and deployment have separate evidence. */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REPORT_POLICY_VERSION, SOURCE_REPORT_PROFILE, NON_TEST_CHECKS, collectTestReportSummaries, validateReportSummaries } from './release-test-reports.mjs';

export const RELEASE_TEST_WORKFLOW = '.github/workflows/release-tests.yml';
export const RELEASE_TEST_POLICY_VERSION = 4;
export const RELEASE_TEST_ARTIFACT = 'release-source-tests';
export const releaseTestArtifactName = (attempt) => `${RELEASE_TEST_ARTIFACT}-${integer(attempt, 'run attempt')}`;

export class ReleaseTestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseTestError';
    this.code = code;
  }
}
const refuse = (code, message) => { throw new ReleaseTestError(code, message); };

// Each command is executed by Tests or by the supplemental release workflow, not by
// this inventory. Keep the two subjects explicit: a probe build is not the candidate.
export const SOURCE_SUITES = Object.freeze([
  'web-unit', 'web-render', 'web-build', 'web-demo-build', 'web-stand-build',
  'scripts-unit', 'publication-transport', 'dependency-invariants',
  'e2e-smoke-desktop-mobile', 'e2e-a11y-desktop-mobile', 'e2e-catalog-desktop',
  'e2e-seminar-desktop', 'e2e-footer-desktop-tablet-mobile', 'e2e-schedule-month',
  'e2e-payment-preview', 'e2e-payment-stand', 'e2e-widgets-probe-and-repeat',
  'e2e-section-titles-desktop-mobile', 'e2e-compat-seven-projects',
  'cms-unit', 'cms-build', 'cms-to-site-isolated',
  'visual-darwin-desktop-mobile', 'provisioning-isolated-docker',
]);

// Owner decision 2026-10-15: the old site no longer exists and production data will
// change regularly. These historical comparison suites are outside the release
// gate. Source suites use the pinned fixture; candidate checks use its own current
// snapshot, never today's production content as a permanent reference.
export const EXCLUDED_HISTORICAL = Object.freeze([
  'web/tests/compare.spec.ts',
  'web/tests/course-group-parity.spec.ts',
  'web/tests/institute-parity.spec.ts',
  'web/tests/parity-audit.spec.ts',
  'web/tests/schedule-parity.spec.ts',
  'web/tests/seminar-parity.spec.ts',
  'web/tests/parity-compare.test.ts',
].map((file) => Object.freeze({ file, reason: 'old-site-absent', decision: 'owner-2026-10-15' })));
export const PENDING_SCOPE = Object.freeze([]);

export const REQUIRED_SOURCE_JOBS = Object.freeze([
  'Release identity',
  'Source tests / Capture content snapshot',
  'Source tests / Unit and build tests',
  'Source tests / Dependency update invariants',
  'Source tests / Scripts unit tests',
  'Source tests / Playwright smoke (desktop + mobile)',
  'Release supplemental',
  'Release visual (macOS)',
  'Release provisioning (isolated Docker)',
  'Release test manifest',
]);

const text = (value, pattern, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) refuse('release-test-invalid-identity', `invalid ${label}`);
  return value;
};
const sha = (value) => text(value, /^[0-9a-f]{40}$/, 'commit');
const id = (value, label) => text(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, label);
const integer = (value, label) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) refuse('release-test-invalid-identity', `invalid ${label}`);
  return result;
};
const same = (a, b, label) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) refuse('release-test-evidence-mismatch', `release tests ${label} mismatch`);
};

export function releaseTestIdentity(env) {
  const commit = sha(env.GITHUB_SHA);
  if (!['workflow_dispatch', 'push'].includes(env.GITHUB_EVENT_NAME)) refuse('release-test-invalid-identity', 'invalid release test event');
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') same(commit, sha(env.EXPECTED_SHA), 'commit');
  if (env.GITHUB_EVENT_NAME === 'push' && !['refs/heads/dev', 'refs/heads/main'].includes(env.GITHUB_REF)) {
    refuse('release-test-invalid-identity', 'invalid release test push ref');
  }
  return {
    commit,
    event: env.GITHUB_EVENT_NAME,
    runId: integer(env.GITHUB_RUN_ID, 'run ID'),
    runAttempt: integer(env.GITHUB_RUN_ATTEMPT, 'run attempt'),
  };
}

export function releaseTestManifest(env, needs, reports) {
  const identity = releaseTestIdentity(env);
  same(env.RELEASE_SOURCE_PROFILE, SOURCE_REPORT_PROFILE, 'source report profile');
  for (const name of ['identity', 'source-tests', 'supplemental', 'visual', 'provision']) {
    same(needs?.[name]?.result, 'success', `${name} result`);
  }
  return {
    schemaVersion: RELEASE_TEST_POLICY_VERSION,
    workflow: RELEASE_TEST_WORKFLOW,
    ...identity,
    suites: [...SOURCE_SUITES],
    reportPolicyVersion: REPORT_POLICY_VERSION,
    sourceProfile: SOURCE_REPORT_PROFILE,
    reports: validateReportSummaries(reports, { profile: SOURCE_REPORT_PROFILE }),
    nonTestChecks: [...NON_TEST_CHECKS],
    pendingScope: [...PENDING_SCOPE],
    excludedHistorical: EXCLUDED_HISTORICAL.map((entry) => ({ ...entry })),
    // This record intentionally cannot claim candidate acceptance or overall release readiness.
    subject: 'source-code',
    results: Object.fromEntries(Object.entries(needs).map(([key, value]) => [key, value.result])),
  };
}

/**
 * Public installed-policy interface for scripts/release-ci.mjs.
 * run: native GitHub GET actions/runs/{id}, including run_attempt/run_started_at.
 * jobs: ALL pages of GET actions/runs/{id}/attempts/{attempt}/jobs (not an old attempt).
 * artifact: native artifact metadata from this run; name releaseTestArtifactName(attempt).
 * manifest: JSON downloaded from that artifact (not an operator-supplied pathname).
 * expected: protected operation context, not fields received from the CLI:
 *   {commit, sourceRef, runId, previousAttempt, runAttempt, requestedAt, destinationId, requestId}.
 * requestedAt is the server's time just before POST re-run; runAttempt must be the
 * newly observed attempt > previousAttempt. The protected loader selects repository,
 * branch, workflow, and run, retains that receipt, and never accepts caller reports.
 * Success is source evidence only; historical exclusions are explicit owner decisions
 * and candidate acceptance still needs its own evidence. Failure throws
 * ReleaseTestError with a stable code.
 */
export function validateReleaseTestEvidence({ run, jobs, artifact, manifest, expected }) {
  sha(expected?.commit);
  id(expected?.destinationId, 'destination');
  id(expected?.requestId, 'request');
  const requestedAt = Date.parse(expected?.requestedAt);
  const startedAt = Date.parse(run?.run_started_at);
  // GitHub timestamps have second precision. Attempt identity is exact; floor the
  // local dispatch timestamp rather than inventing subsecond native precision.
  const earliest = Math.floor(requestedAt / 1000) * 1000;
  if (!Number.isFinite(requestedAt) || !Number.isFinite(startedAt) || startedAt < earliest) {
    refuse('release-test-stale-attempt', 'release tests run predates this operation');
  }
  if (!['workflow_dispatch', 'push'].includes(run.event)) refuse('release-test-invalid-identity', 'invalid release test event');
  same(integer(run.id, 'run ID'), integer(expected.runId, 'expected run ID'), 'selected run');
  same(integer(run.run_attempt, 'run attempt'), integer(expected.runAttempt, 'expected attempt'), 'selected attempt');
  if (integer(expected.runAttempt, 'expected attempt') <= integer(expected.previousAttempt, 'previous attempt')) {
    refuse('release-test-stale-attempt', 'release tests require a fresh attempt for this operation');
  }
  same(run.repository?.full_name, 'pgorbachev/ikpk', 'repository');
  same(run.head_repository?.full_name, 'pgorbachev/ikpk', 'source repository');
  if (!['main', 'dev'].includes(expected.sourceRef)) refuse('release-test-invalid-identity', 'invalid source branch');
  same(run.head_branch, expected.sourceRef, 'source branch');
  same(run.path, RELEASE_TEST_WORKFLOW, 'workflow');
  same(run.head_sha, expected.commit, 'commit');
  same(run.status, 'completed', 'run status');
  same(run.conclusion, 'success', 'run conclusion');
  same(manifest?.schemaVersion, RELEASE_TEST_POLICY_VERSION, 'policy');
  same(manifest?.workflow, RELEASE_TEST_WORKFLOW, 'manifest workflow');
  same(manifest?.subject, 'source-code', 'subject');
  same(manifest?.commit, expected.commit, 'manifest commit');
  same(manifest?.event, run.event, 'manifest event');
  same(integer(manifest?.runId, 'manifest run ID'), integer(run.id, 'run ID'), 'run ID');
  same(integer(manifest?.runAttempt, 'manifest attempt'), integer(run.run_attempt, 'run attempt'), 'run attempt');
  same(manifest?.suites, [...SOURCE_SUITES], 'suite inventory');
  same(manifest?.reportPolicyVersion, REPORT_POLICY_VERSION, 'report policy');
  same(manifest?.sourceProfile, SOURCE_REPORT_PROFILE, 'source report profile');
  same(manifest?.nonTestChecks, [...NON_TEST_CHECKS], 'non-test checks');
  const reports = validateReportSummaries(manifest?.reports, { profile: SOURCE_REPORT_PROFILE });
  same(manifest?.pendingScope, [...PENDING_SCOPE], 'pending inventory');
  same(manifest?.excludedHistorical, [...EXCLUDED_HISTORICAL], 'historical exclusion inventory');
  same(artifact?.name, releaseTestArtifactName(run.run_attempt), 'artifact name');
  same(artifact?.expired, false, 'artifact retention');
  same(integer(artifact?.workflow_run?.id, 'artifact run ID'), integer(run.id, 'run ID'), 'artifact run ID');
  same(artifact?.workflow_run?.head_sha, expected.commit, 'artifact commit');
  if (!Number.isFinite(Date.parse(artifact?.created_at)) || Date.parse(artifact.created_at) < earliest) {
    refuse('release-test-stale-artifact', 'release tests artifact predates this operation');
  }
  for (const name of ['identity', 'source-tests', 'supplemental', 'visual', 'provision']) {
    same(manifest?.results?.[name], 'success', `${name} result`);
  }
  if (!Array.isArray(jobs)) refuse('release-test-jobs-missing', 'release tests jobs missing');
  for (const name of REQUIRED_SOURCE_JOBS) {
    const matching = jobs.filter((job) => job.name === name);
    if (matching.length !== 1) refuse('release-test-jobs-missing', `release tests job missing or duplicated: ${name}`);
    const job = matching[0];
    same(integer(job.run_id, 'job run ID'), integer(run.id, 'run ID'), 'job run ID');
    same(job.head_sha, expected.commit, 'job commit');
    if (!Number.isFinite(Date.parse(job.started_at)) || Date.parse(job.started_at) < earliest) {
      refuse('release-test-stale-attempt', `release tests job predates this operation: ${name}`);
    }
    same(job.status, 'completed', 'job status');
    same(job.conclusion, 'success', `job ${name}`);
  }
  return { policyVersion: RELEASE_TEST_POLICY_VERSION, repository: run.repository.full_name,
    workflow: run.path, sourceRef: run.head_branch, runId: run.id, runAttempt: run.run_attempt, commit: expected.commit,
    requestedAt: expected.requestedAt, startedAt: run.run_started_at, conclusion: run.conclusion,
    suites: [...SOURCE_SUITES], results: { ...manifest.results },
    reportPolicyVersion: REPORT_POLICY_VERSION, sourceProfile: SOURCE_REPORT_PROFILE, reports, nonTestChecks: [...NON_TEST_CHECKS],
    jobs: REQUIRED_SOURCE_JOBS.map((name) => { const job = jobs.find((entry) => entry.name === name);
      return { name, runId: job.run_id, commit: job.head_sha, startedAt: job.started_at, conclusion: job.conclusion }; }),
    destinationId: expected.destinationId, requestId: expected.requestId,
    subject: 'source-code', pendingScope: [...PENDING_SCOPE],
    excludedHistorical: EXCLUDED_HISTORICAL.map((entry) => ({ ...entry })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === 'identity') releaseTestIdentity(process.env);
  else if (command === 'manifest' && process.argv.length === 4) {
    writeFileSync(process.argv[3], `${JSON.stringify(releaseTestManifest(process.env, JSON.parse(process.env.RELEASE_NEEDS), collectTestReportSummaries(process.env.RELEASE_REPORTS_DIR, { profile: process.env.RELEASE_SOURCE_PROFILE })), null, 2)}\n`, { flag: 'wx' });
  } else throw new Error('usage: release-test-policy.mjs identity | manifest OUTPUT');
}
