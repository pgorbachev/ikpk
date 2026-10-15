/** Installed trusted adapter: re-run exact source CI, bind its new attempt to a receipt. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_TEST_WORKFLOW, releaseTestArtifactName, validateReleaseTestEvidence } from './release-test-policy.mjs';

const API = 'https://api.github.com/repos/pgorbachev/ikpk';
const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
async function bytes(response, limit) {
  if (!response.ok || !response.body) fail('release-ci-http-error');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) fail('release-ci-response-too-large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function createReleaseCi({ token, fetch: fetcher = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date().toISOString(), maxPolls = 1080 } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) fail('release-ci-token-missing');
  async function request(path, method = 'GET') {
    if (typeof path !== 'string' || !path.startsWith(`${API}/`)) fail('release-ci-untrusted-url');
    const response = await fetcher(path, { method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (!response.ok) fail('release-ci-http-error');
    if (method === 'POST') return {};
    return JSON.parse((await bytes(response, 4 * 1024 * 1024)).toString('utf8'));
  }
  async function list(path, key) {
    const found = [];
    for (let page = 1; page <= 100; page++) {
      const data = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(data[key]) || !Number.isSafeInteger(data.total_count)) fail('release-ci-invalid-page');
      found.push(...data[key]);
      if (found.length === data.total_count) return found;
      if (found.length > data.total_count || !data[key].length) fail('release-ci-incomplete-page');
    }
    fail('release-ci-pagination-limit');
  }
  function identity(run, receipt, branch) {
    if (run.repository?.full_name !== 'pgorbachev/ikpk' || run.head_repository?.full_name !== 'pgorbachev/ikpk' ||
      run.path !== RELEASE_TEST_WORKFLOW || run.head_sha !== receipt.commit || run.head_branch !== branch ||
      !['push', 'workflow_dispatch'].includes(run.event) || !Number.isSafeInteger(run.id) || run.id < 1 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) fail('release-ci-untrusted-run');
  }
  async function manifest(artifact, directory) {
    if (artifact.archive_download_url !== `${API}/actions/artifacts/${artifact.id}/zip`) fail('release-ci-untrusted-artifact');
    let response = await fetcher(artifact.archive_download_url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (response.status === 302) {
      const url = new URL(response.headers.get('location'));
      if (url.protocol !== 'https:' || url.username || url.password ||
          !(url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.githubusercontent.com'))) fail('release-ci-untrusted-artifact');
      response = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    }
    const buffer = await bytes(response, 4 * 1024 * 1024);
    const scratch = mkdtempSync(join(directory, 'ci-artifact-'));
    try {
      const archive = join(scratch, 'artifact.zip'); writeFileSync(archive, buffer, { mode: 0o600, flag: 'wx' });
      const names = execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 16384 }).trim().split('\n');
      if (names.length !== 1 || names[0] !== 'release-source-tests.json') fail('release-ci-untrusted-artifact');
      return JSON.parse(execFileSync('/usr/bin/unzip', ['-p', archive, names[0]], { encoding: 'utf8', maxBuffer: 65536 }));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  return async function run(config, receipt) {
    const runs = await list(`${API}/actions/workflows/release-tests.yml/runs?branch=${config.sourceRef}&head_sha=${receipt.commit}`, 'workflow_runs');
    const selected = runs.filter((r) => r.head_sha === receipt.commit && r.head_branch === config.sourceRef &&
      r.path === RELEASE_TEST_WORKFLOW && ['push', 'workflow_dispatch'].includes(r.event)).sort((a, b) => b.id - a.id)[0];
    if (!selected) fail('release-ci-run-not-found');
    if (!Number.isSafeInteger(selected.id) || selected.id < 1) fail('release-ci-untrusted-run');
    let current = await request(`${API}/actions/runs/${selected.id}`); identity(current, receipt, config.sourceRef);
    // Wait for a push-triggered run to finish, then make a fresh attempt for this operation.
    let polls = 0;
    while (current.status !== 'completed') {
      if (++polls > maxPolls) fail('release-ci-wait-timeout'); await sleep(10000);
      current = await request(`${API}/actions/runs/${selected.id}`); identity(current, receipt, config.sourceRef);
    }
    const expected = { commit: receipt.commit, runId: current.id, previousAttempt: current.run_attempt,
      runAttempt: current.run_attempt + 1, requestedAt: now(), destinationId: receipt.request.destination, requestId: receipt.request.id };
    // Persist BEFORE the non-idempotent POST. A lost acknowledgement never causes an automatic re-run.
    writeFileSync(join(receipt.directory, 'ci-request.json'), `${JSON.stringify(expected)}\n`, { mode: 0o600, flag: 'wx' });
    await request(`${API}/actions/runs/${current.id}/rerun`, 'POST');
    for (;;) {
      if (++polls > maxPolls) fail('release-ci-wait-timeout'); await sleep(10000);
      current = await request(`${API}/actions/runs/${expected.runId}`); identity(current, receipt, config.sourceRef);
      if (current.run_attempt > expected.runAttempt) fail('release-ci-attempt-superseded');
      if (current.run_attempt === expected.runAttempt && current.status === 'completed') break;
    }
    const jobs = await list(`${API}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs`, 'jobs');
    const artifacts = await list(`${API}/actions/runs/${expected.runId}/artifacts`, 'artifacts');
    const named = artifacts.filter((a) => a.name === releaseTestArtifactName(expected.runAttempt));
    if (named.length !== 1) fail('release-ci-manifest-missing');
    const evidence = validateReleaseTestEvidence({ run: current, jobs, artifact: named[0], manifest: await manifest(named[0], receipt.directory), expected });
    if (evidence.pendingScope.length) fail('release-ci-scope-not-approved');
    return evidence;
  };
}
export async function runReleaseCi(config, receipt) {
  const token = readFileSync(config.releaseCiTokenFile, 'utf8').trim();
  return createReleaseCi({ token })(config, receipt);
}
