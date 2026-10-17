import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReleaseCi } from '../release-ci.mjs';
import { RELEASE_TEST_WORKFLOW, REQUIRED_SOURCE_JOBS, releaseTestArtifactName, releaseTestManifest } from '../release-test-policy.mjs';
import { REQUIRED_TEST_REPORTS } from '../release-test-reports.mjs';

const API = 'https://api.github.com/repos/pgorbachev/ikpk';
const commit = 'a'.repeat(40);
const runId = 42;
const attempt = 1;
const timestamp = '2026-10-15T20:00:00Z';
const nativeRun = { id: runId, run_attempt: attempt, repository: { full_name: 'pgorbachev/ikpk' },
  head_repository: { full_name: 'pgorbachev/ikpk' }, head_sha: commit, head_branch: 'dev',
  path: RELEASE_TEST_WORKFLOW, event: 'push', status: 'completed', conclusion: 'success', run_started_at: timestamp };
const fixture = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ikpk-release-ci-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { config: { sourceRef: 'dev' }, receipt: { commit, directory,
    request: { id: randomUUID(), destination: 'demo' } } };
};
const json = (value) => new Response(JSON.stringify(value), { status: 200 });
const reportFixtures = REQUIRED_TEST_REPORTS.map(({ suite, runner }) => ({ suite, runner,
  reportSha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, skipped: 0, todo: 0,
  flaky: 0, retried: 0, omissions: [], roleOmissions: [], acceptedDeviations: [] }));

function evidenceFiles(directory, { run = nativeRun, jobStartedAt = timestamp, manifestMutator } = {}) {
  const manifest = releaseTestManifest({ RELEASE_SOURCE_PROFILE: 'source-default-ci-pinned', GITHUB_SHA: commit,
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/heads/${run.head_branch}`, GITHUB_RUN_ID: String(run.id),
    GITHUB_RUN_ATTEMPT: String(run.run_attempt) },
  Object.fromEntries(['identity', 'source-tests', 'supplemental', 'visual', 'provision'].map((name) => [name, { result: 'success' }])), reportFixtures);
  manifestMutator?.(manifest);
  writeFileSync(join(directory, 'release-source-tests.json'), JSON.stringify(manifest));
  const archive = join(directory, 'proof.zip');
  execFileSync('/usr/bin/zip', ['-q', archive, 'release-source-tests.json'], { cwd: directory });
  const archiveDigest = `sha256:${createHash('sha256').update(readFileSync(archive)).digest('hex')}`;
  const jobs = REQUIRED_SOURCE_JOBS.map((name) => ({ name, run_id: run.id, head_sha: commit,
    started_at: jobStartedAt, status: 'completed', conclusion: 'success' }));
  const artifact = { id: 9, name: releaseTestArtifactName(run.run_attempt), expired: false,
    created_at: timestamp, workflow_run: { id: run.id, head_sha: commit },
    archive_download_url: `${API}/actions/artifacts/9/zip`, digest: archiveDigest };
  return { archive, jobs, artifact };
}

function api({ run = nativeRun, runs = [run], statuses, jobs, artifact = evidenceFilesPlaceholder, archive } = {}) {
  return async (url, options = {}) => {
    assert.equal(options.method ?? 'GET', 'GET', 'source CI inspection must be read-only');
    assert.equal(options.redirect, 'manual');
    if (url.includes('/workflows/')) return json({ total_count: runs.length, workflow_runs: runs });
    if (url.includes('/attempts/')) return json({ total_count: jobs.length, jobs });
    if (url.includes('/artifacts?')) return json({ total_count: artifact ? 1 : 0, artifacts: artifact ? [artifact] : [] });
    if (url.endsWith('/artifacts/9/zip')) return new Response(readFileSync(archive), { status: 200 });
    if (url.endsWith(`/actions/runs/${run.id}`)) {
      const next = statuses?.shift();
      return json(next ?? run);
    }
    throw new Error(`unexpected API URL: ${url}`);
  };
}

const evidenceFilesPlaceholder = null;

test('reuses a completed canonical full Release source run for the exact SHA without any write request', async (t) => {
  const { config, receipt } = fixture(t);
  const { archive, jobs, artifact } = evidenceFiles(receipt.directory);
  const calls = [];
  const run = createReleaseCi({ token: 'read-only-token', fetch: async (url, options) => {
    calls.push([url, options.method ?? 'GET']);
    return api({ jobs, artifact, archive })(url, options);
  } });

  const proof = await run(config, receipt);

  assert.match(proof.commit, /^[a-f0-9]{40}$/);
  assert.equal(proof.runId, runId);
  assert.equal(proof.runAttempt, attempt);
  assert.equal(proof.requestId, receipt.request.id);
  assert.equal(proof.destinationId, 'demo');
  assert.equal(proof.subject, 'source-code');
  assert.deepEqual(proof.pendingScope, []);
  assert.ok(calls.every(([, method]) => method === 'GET'));
  assert.equal(calls.some(([url]) => url.includes('/rerun')), false);
});

test('waits for the selected exact-SHA Release run, then validates that attempt evidence', async (t) => {
  const { config, receipt } = fixture(t);
  const pending = { ...nativeRun, status: 'in_progress', conclusion: null };
  const { archive, jobs, artifact } = evidenceFiles(receipt.directory);
  let sleeps = 0;
  const fetch = api({ run: pending, statuses: [pending, nativeRun, nativeRun], jobs, artifact, archive });
  const run = createReleaseCi({ token: 'read-only-token', sleep: async (ms) => { assert.equal(ms, 10000); sleeps++; }, fetch });

  const proof = await run(config, receipt);

  assert.equal(proof.runId, runId);
  assert.equal(proof.runAttempt, attempt);
  assert.equal(sleeps, 1);
});

test('refuses if a newer attempt replaces the successful attempt while its evidence is being read', async (t) => {
  const { config, receipt } = fixture(t);
  const newerFailure = { ...nativeRun, run_attempt: 2, conclusion: 'failure' };
  const { archive, jobs, artifact } = evidenceFiles(receipt.directory);
  const fetch = api({ jobs, artifact, archive, statuses: [nativeRun, newerFailure] });

  await assert.rejects(createReleaseCi({ token: 'read-only-token', fetch })(config, receipt),
    (error) => error.code === 'release-ci-attempt-changed');
});

test('refuses when the protected source ref advances during otherwise successful CI admission', async (t) => {
  const { config, receipt } = fixture(t);
  config.sourceRef = 'main'; receipt.commit = commit;
  receipt.request.destination = 'prod';
  const selected = { ...nativeRun, head_branch: 'main' };
  const { archive, jobs, artifact } = evidenceFiles(receipt.directory, { run: selected });
  const events = [];
  const fetch = async (url, options) => {
    events.push(url.endsWith(`/actions/runs/${runId}`) ? 'run' : url.includes('/artifacts/9/zip') ? 'artifact-bytes' : 'api');
    return api({ run: selected, jobs, artifact, archive })(url, options);
  };
  await assert.rejects(createReleaseCi({ token: 'read-only-token', fetch,
    resolveSourceRef: async ({ sourceRef }) => { events.push(`ref:${sourceRef}`); return 'b'.repeat(40); },
  })(config, receipt), (error) => error.code === 'release-ci-source-ref-changed');
  assert.equal(events.at(-1), 'ref:main', 'protected ref is checked after final run and artifact evidence');
});

test('missing run and completed unsuccessful run both fail closed without starting a run', async (t) => {
  for (const { runs, expectedCode } of [
    { runs: [], expectedCode: 'release-ci-run-not-found' },
    { runs: [{ ...nativeRun, conclusion: 'failure' }], expectedCode: 'release-ci-run-failed' },
    { runs: [{ ...nativeRun, conclusion: 'cancelled' }], expectedCode: 'release-ci-run-failed' },
  ]) {
    const { config, receipt } = fixture(t);
    let requests = 0;
    const fetch = async (url, options = {}) => {
      assert.equal(options.method ?? 'GET', 'GET'); requests++;
      if (url.includes('/workflows/')) return json({ total_count: runs.length, workflow_runs: runs });
      return json(runs[0]);
    };
    await assert.rejects(createReleaseCi({ token: 'read-only-token', fetch })(config, receipt), (error) => error.code === expectedCode);
    assert.ok(requests >= 1);
  }
});

test('a newer failed canonical run prevents fallback to an older successful run', async (t) => {
  const { config, receipt } = fixture(t);
  const olderSuccess = { ...nativeRun, id: 41 };
  const newerFailure = { ...nativeRun, id: 43, conclusion: 'failure' };
  const fetch = api({ run: newerFailure, runs: [olderSuccess, newerFailure] });

  await assert.rejects(createReleaseCi({ token: 'read-only-token', fetch })(config, receipt),
    (error) => error.code === 'release-ci-run-failed');
});

test('wrong repository, source, SHA, workflow, event, or invalid attempt is rejected', async (t) => {
  for (const override of [
    { repository: { full_name: 'fork/ikpk' } }, { head_repository: { full_name: 'fork/ikpk' } },
    { head_branch: 'main' }, { head_sha: 'b'.repeat(40) }, { path: '.github/workflows/untrusted.yml' },
    { event: 'pull_request' },
  ]) {
    const { config, receipt } = fixture(t); const selected = { ...nativeRun, ...override };
    const { archive, jobs, artifact } = evidenceFiles(receipt.directory, { run: selected });
    await assert.rejects(createReleaseCi({ token: 'read-only-token', fetch: api({ run: selected, jobs, artifact, archive }) })(config, receipt));
  }
  const { config, receipt } = fixture(t); const selected = { ...nativeRun, run_attempt: 0 };
  const { archive, jobs, artifact } = evidenceFiles(receipt.directory);
  await assert.rejects(createReleaseCi({ token: 'read-only-token', fetch: api({ run: selected, jobs, artifact, archive }) })(config, receipt),
    (error) => error.code === 'release-ci-untrusted-run');
});

test('missing artifacts and mismatched GitHub artifact digest are refused', async (t) => {
  const { config, receipt } = fixture(t);
  const missing = createReleaseCi({ token: 'read-only-token', fetch: api({ jobs: [], artifact: null, archive: '' }) });
  await assert.rejects(missing(config, receipt), (error) => error.code === 'release-ci-manifest-missing');

  const { archive, jobs, artifact } = evidenceFiles(receipt.directory);
  artifact.digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(createReleaseCi({ token: 'read-only-token', fetch: api({ jobs, artifact, archive }) })(config, receipt),
    (error) => error.code === 'release-ci-artifact-digest-mismatch');
});

test('wrong report policy and job timestamps predating the selected attempt are refused', async (t) => {
  const { config, receipt } = fixture(t);
  for (const evidenceOptions of [
    { manifestMutator: (manifest) => { manifest.reportPolicyVersion -= 1; } },
    { jobStartedAt: '2026-10-15T19:59:59Z' },
  ]) {
    const { archive, jobs, artifact } = evidenceFiles(receipt.directory, evidenceOptions);
    await assert.rejects(createReleaseCi({ token: 'read-only-token', fetch: api({ jobs, artifact, archive }) })(config, receipt));
  }
});

test('API redirects are refused and never followed with the Actions read token', async (t) => {
  const { config, receipt } = fixture(t); let calls = 0;
  const run = createReleaseCi({ token: 'read-only-token', fetch: async () => { calls++; return new Response(null, { status: 302,
    headers: { location: 'https://outside.invalid' } }); } });
  await assert.rejects(run(config, receipt), (error) => error.code === 'release-ci-http-error');
  assert.equal(calls, 1);
});
