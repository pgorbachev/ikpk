import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReleaseCi } from '../release-ci.mjs';
const API = 'https://api.github.com/repos/pgorbachev/ikpk';
const commit = 'a'.repeat(40);
const nativeRun = { id: 42, run_attempt: 1, repository: { full_name: 'pgorbachev/ikpk' }, head_repository: { full_name: 'pgorbachev/ikpk' },
  head_sha: commit, head_branch: 'dev', path: '.github/workflows/release-tests.yml', event: 'push', status: 'completed', conclusion: 'success' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ikpk-release-ci-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { config: { sourceRef: 'dev' }, receipt: { commit, directory, request: { id: randomUUID(), destination: 'demo' } } };
}
const json = (x) => new Response(JSON.stringify(x), { status: 200 });
test('rerun intent is durable before POST, attempt jobs endpoint is exact, superseded attempt cannot publish', async (t) => {
  const { config, receipt } = fixture(t); const calls = [];
  const run = createReleaseCi({ token: 'private-token', now: () => '2026-10-15T20:00:00Z', sleep: async () => {}, fetch: async (url, options) => {
    calls.push([url, options.method]); assert.equal(options.redirect, 'manual');
    if (url.includes('/workflows/')) return json({ total_count: 1, workflow_runs: [nativeRun] });
    if (options.method === 'POST') {
      const intent = JSON.parse(readFileSync(join(receipt.directory, 'ci-request.json')));
      assert.equal(intent.requestId, receipt.request.id); assert.equal(intent.previousAttempt, 1); assert.equal(intent.runAttempt, 2);
      return new Response(null, { status: 201 });
    }
    const afterPost = calls.some(([, method]) => method === 'POST');
    return json({ ...nativeRun, run_attempt: afterPost ? 3 : 1 });
  } });
  await assert.rejects(run(config, receipt), (e) => e.code === 'release-ci-attempt-superseded');
  assert.equal(calls.filter(([, method]) => method === 'POST').length, 1);
});
test('lost rerun acknowledgement cannot automatically trigger a second attempt', async (t) => {
  const { config, receipt } = fixture(t); let posts = 0;
  const run = createReleaseCi({ token: 'x', sleep: async () => {}, fetch: async (url, o) => {
    if (url.includes('/workflows/')) return json({ total_count: 1, workflow_runs: [nativeRun] });
    if (o.method === 'POST') { posts++; throw new Error('transport lost'); } return json(nativeRun);
  } });
  await assert.rejects(run(config, receipt)); await assert.rejects(run(config, receipt));
  assert.equal(posts, 1); assert.ok(existsSync(join(receipt.directory, 'ci-request.json')));
});
test('wrong repository, branch, SHA or workflow refuses before rerun', async (t) => {
  for (const override of [{ repository: { full_name: 'fork/ikpk' } }, { head_repository: { full_name: 'fork/ikpk' } },
    { head_branch: 'main' }, { head_sha: 'b'.repeat(40) }, { path: '.github/workflows/untrusted.yml' }, { event: 'pull_request' }]) {
    const { config, receipt } = fixture(t); let posts = 0;
    const run = createReleaseCi({ token: 'x', fetch: async (url, o) => {
      if (o.method === 'POST') posts++;
      if (url.includes('/workflows/')) return json({ total_count: 1, workflow_runs: [nativeRun] });
      return json({ ...nativeRun, ...override });
    } });
    await assert.rejects(run(config, receipt), (e) => e.code === 'release-ci-untrusted-run'); assert.equal(posts, 0);
  }
});
test('fresh failed run or missing manifest cannot be represented as source success', async (t) => {
  const { config, receipt } = fixture(t); let post = false;
  const run = createReleaseCi({ token: 'x', sleep: async () => {}, fetch: async (url, o) => {
    if (url.includes('/workflows/')) return json({ total_count: 1, workflow_runs: [nativeRun] });
    if (o.method === 'POST') { post = true; return new Response(null, { status: 201 }); }
    if (url.includes('/jobs')) { assert.ok(url.includes('/attempts/2/jobs')); return json({ total_count: 0, jobs: [] }); }
    if (url.includes('/artifacts')) return json({ total_count: 0, artifacts: [] });
    return json({ ...nativeRun, run_attempt: post ? 2 : 1, conclusion: post ? 'failure' : 'success' });
  } });
  await assert.rejects(run(config, receipt), (e) => e.code === 'release-ci-manifest-missing');
});
test('API redirects are refused, never forwarded with the Actions token', async (t) => {
  const { config, receipt } = fixture(t); let calls = 0;
  const run = createReleaseCi({ token: 'x', fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://outside.invalid' } }); } });
  await assert.rejects(run(config, receipt), (e) => e.code === 'release-ci-http-error'); assert.equal(calls, 1);
});

test('successful fresh native attempt is downloaded and bound to this operation and destination', async (t) => {
  const { config, receipt } = fixture(t);
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { REQUIRED_TEST_REPORTS } = await import('../release-test-reports.mjs');
  const reportFixtures = REQUIRED_TEST_REPORTS.map(({ suite, runner }) => ({ suite, runner, reportSha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, flaky: 0, retried: 0, omissions: [] }));
  const { releaseTestManifest, REQUIRED_SOURCE_JOBS } = await import('../release-test-policy.mjs');
  const timestamp = '2026-10-15T20:00:00Z';
  const manifest = releaseTestManifest({ GITHUB_SHA: commit, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev',
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' }, Object.fromEntries(['identity', 'source-tests', 'supplemental', 'visual', 'provision'].map((name) => [name, { result: 'success' }])), reportFixtures);
  writeFileSync(join(receipt.directory, 'release-source-tests.json'), JSON.stringify(manifest));
  const archive = join(receipt.directory, 'proof.zip'); execFileSync('/usr/bin/zip', ['-q', archive, 'release-source-tests.json'], { cwd: receipt.directory });
  let posted = false;
  const run = createReleaseCi({ token: 'x', now: () => timestamp, sleep: async () => {}, fetch: async (url, o) => {
    if (url.includes('/workflows/')) return json({ total_count: 1, workflow_runs: [nativeRun] });
    if (o.method === 'POST') { posted = true; return new Response(null, { status: 201 }); }
    if (url.includes('/attempts/2/jobs')) return json({ total_count: REQUIRED_SOURCE_JOBS.length, jobs: REQUIRED_SOURCE_JOBS.map((name) => ({
      name, run_id: 42, head_sha: commit, started_at: timestamp, status: 'completed', conclusion: 'success' })) });
    if (url.includes('/artifacts?')) return json({ total_count: 1, artifacts: [{ id: 9, name: 'release-source-tests-2', expired: false,
      created_at: timestamp, workflow_run: { id: 42, head_sha: commit }, archive_download_url: `${API}/actions/artifacts/9/zip` }] });
    if (url.endsWith('/artifacts/9/zip')) return new Response(readFileSync(archive), { status: 200 });
    return json({ ...nativeRun, run_attempt: posted ? 2 : 1, run_started_at: timestamp });
  } });
  const proof = await run(config, receipt);
  assert.equal(proof.runAttempt, 2); assert.equal(proof.requestId, receipt.request.id); assert.equal(proof.destinationId, 'demo');
  assert.equal(proof.subject, 'source-code'); assert.deepEqual(proof.pendingScope, []);
});
