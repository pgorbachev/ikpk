import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as launcher from '../publication-launcher.mjs';
import { RELEASE_TEST_WORKFLOW, releaseTestManifest } from '../release-test-policy.mjs';
import { REQUIRED_TEST_REPORTS } from '../release-test-reports.mjs';
import { ciEvidenceProblem, publicationCiProblem, PUBLICATION_CI_POLICY } from '../../web/scripts/lib/publish-gate.ts';
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const demo = { sourceRef: 'dev', sourceProfile: 'demo-dev', deployMode: 'stand', paymentRole: 'ci',
  sshTarget: 'deploy@193.124.115.99', siteUrl: 'https://staging.ikpk.su' };
const reportFixtures = REQUIRED_TEST_REPORTS.map(({ suite, runner }) => ({ suite, runner,
  reportSha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, skipped: 0, todo: 0,
  flaky: 0, retried: 0, omissions: [], roleOmissions: [], acceptedDeviations: [] }));
function sourceProof(commit) {
  const directory = mkdtempSync('/tmp/ikpk-launcher-proof-');
  try {
    const manifest = releaseTestManifest({ RELEASE_SOURCE_PROFILE: 'source-default-ci-pinned', GITHUB_SHA: commit,
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev', GITHUB_RUN_ID: '19', GITHUB_RUN_ATTEMPT: '1' },
    Object.fromEntries(['identity', 'source-tests', 'supplemental', 'visual', 'provision'].map(name => [name, { result: 'success' }])), reportFixtures);
    writeFileSync(join(directory, 'release-source-tests.json'), JSON.stringify(manifest));
    const archive = join(directory, 'proof.zip');
    execFileSync('/usr/bin/zip', ['-q', archive, 'release-source-tests.json'], { cwd: directory });
    const bytes = readFileSync(archive);
    return { repository: 'pgorbachev/ikpk', workflow: RELEASE_TEST_WORKFLOW, sourceRef: 'dev', commit,
      runId: 19, runAttempt: 1, artifactDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      artifactZipBase64: bytes.toString('base64') };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function ciFixture(branch = 'dev', commit = SHA) {
  const run = { id: 9, head_sha: commit, head_branch: branch, event: 'push', status: 'completed', conclusion: 'success',
    path: PUBLICATION_CI_POLICY.workflow, repository: { full_name: 'pgorbachev/ikpk' }, head_repository: { full_name: 'pgorbachev/ikpk' } };
  const jobs = PUBLICATION_CI_POLICY.requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.ok(url.startsWith('https://api.github.com/repos/pgorbachev/ikpk/'));
    if (url.includes('/git/ref/heads/')) return Response.json({ ref: `refs/heads/${branch}`, object: { sha: commit } });
    const key = url.includes('/jobs?') ? 'jobs' : 'workflow_runs';
    const data = key === 'jobs' ? jobs : [run];
    return Response.json({ total_count: data.length, [key]: data });
  };
  return { run, jobs, fetch, calls };
}
test('source branch defaults main; dev needs the exact installed demo profile', () => {
  assert.deepEqual(launcher.SOURCE_CI_JOBS, PUBLICATION_CI_POLICY.requiredJobs);
  assert.equal(launcher.publicationSourceRef({ deployMode: 'prod' }), 'main');
  assert.equal(launcher.publicationSourceRef(demo), 'dev');
  for (const bad of [{ sourceRef: 'topic' }, { ...demo, deployMode: 'prod' }, { ...demo, paymentRole: 'prod' },
    { ...demo, sourceProfile: undefined }, { ...demo, sshTarget: 'deploy@other.invalid' },
    { ...demo, siteUrl: 'https://ikpk.su' }, { ...demo, sshTarget: 'root@193.124.115.99' }]) assert.throws(() => launcher.publicationSourceRef(bad));
});
test('installed CI gate accepts exact dev push SHA and checks every required job', async () => {
  const f = ciFixture();
  await launcher.verifySourceCi({ commit: SHA, sourceRef: 'dev', fetch: f.fetch });
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.some(c => c.url.includes(`branch=dev&head_sha=${SHA}`)));
});
test('installed gate refuses wrong branch/SHA/event/workflow/fork and skipped or absent jobs', async () => {
  for (const mutation of [{ head_branch: 'main' }, { head_sha: OTHER }, { event: 'pull_request' },
    { event: 'schedule' }, { path: 'other.yml' }, { head_repository: { full_name: 'fork/repo' } },
    { status: 'in_progress' }, { conclusion: 'cancelled' }]) {
    const f = ciFixture(); Object.assign(f.run, mutation);
    await assert.rejects(launcher.verifySourceCi({ commit: SHA, sourceRef: 'dev', fetch: f.fetch }));
  }
  for (const mutation of ['skipped', 'missing', 'duplicate']) {
    const f = ciFixture();
    if (mutation === 'missing') f.jobs.pop();
    else if (mutation === 'duplicate') f.jobs.push(f.jobs[0]);
    else f.jobs[0].conclusion = mutation;
    await assert.rejects(launcher.verifySourceCi({ commit: SHA, sourceRef: 'dev', fetch: f.fetch }));
  }
});
test('generic CI validator keeps main default and explicitly validates dev evidence', () => {
  const f = ciFixture();
  const evidence = { repository: 'pgorbachev/ikpk', workflow: PUBLICATION_CI_POLICY.workflow, branch: 'dev', commit: SHA,
    runId: 9, event: 'push', conclusion: 'success', executedTests: 1, jobs: f.jobs };
  assert.equal(ciEvidenceProblem(evidence, SHA), 'untrusted-ci-run');
  assert.equal(ciEvidenceProblem(evidence, SHA, PUBLICATION_CI_POLICY, 'dev'), undefined);
});
test('installed launcher rejects moved SHA and incomplete CI before calling the credential broker', async t => {
  const root = mkdtempSync('/tmp/ikpk-source-ci-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const author = join(root, 'author'), remote = join(root, 'canonical.git'), installed = join(root, 'protected');
  mkdirSync(author); mkdirSync(installed);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (dir, ...args) => execFileSync('/usr/bin/git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git(root, 'init', '--bare', '--initial-branch=dev', remote); git(author, 'init', '--initial-branch=dev');
  mkdirSync(join(author, 'scripts'));
  writeFileSync(join(author, 'scripts/deploy-web.sh'), `#!/bin/sh\nexec '${process.execPath}' scripts/worker.mjs\n`);
  writeFileSync(join(author, 'scripts/worker.mjs'), `import {writeFileSync} from 'node:fs';
if(process.env.GH_TOKEN)process.exit(91);
writeFileSync(3,JSON.stringify({version:1,status:'success',code:'published',commit:process.env.PUBLICATION_SOURCE_SHA,
snapshotId:'snap:'+'a'.repeat(64),treeDigest:'b'.repeat(64),publicationId:'fixture-publish',
observedEntry:1,revision:1,highWaterMark:1,localExecutedTests:1,ciExecutedTests:1}));`);
  git(author, 'add', '.'); git(author, 'commit', '-m', 'fixture'); git(author, 'push', remote, 'dev');
  const commit = git(author, 'rev-parse', 'HEAD');
  const entry = join(installed, 'publication-launcher.mjs'); copyFileSync(new URL('../publication-launcher.mjs', import.meta.url), entry); chmodSync(entry, 0o700);
  const marker = join(root, 'broker-called'), broker = join(installed, 'broker.mjs');
  writeFileSync(broker, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({ciToken:process.env.GH_TOKEN??null}));console.log('{"env":{}}');`);
  const config = join(installed, 'config.json');
  writeFileSync(config, JSON.stringify({ ...demo, canonicalRepository: remote, destinationId: 'demo-dev', credentialBroker: [process.execPath, broker] }), { mode: 0o600 });
  const module = await import(pathToFileURL(entry));
  const args = ['publish','--config',config,'--source-url',remote,'--source-ref','dev','--expected-sha'];
  // This fixture simulates the installed local launcher; keep the real hosted
  // prohibition covered before clearing only these flags for the isolated fixture.
  const ambient = new Map(['CI', 'GITHUB_ACTIONS'].map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of ambient) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  process.env.CI = 'true';
  await assert.rejects(module.launch([...args, commit], { fetch: ciFixture('dev', commit).fetch }), /hosted-publication-forbidden/);
  for (const key of ambient.keys()) delete process.env[key];
  await assert.rejects(module.launch([...args, OTHER], { fetch: ciFixture('dev', commit).fetch }), /source-sha-mismatch/);
  for (const mutation of [{ head_branch: 'main' }, { head_sha: OTHER }, { event: 'pull_request' }, { event: 'repository_dispatch' }]) {
    const bad = ciFixture('dev', commit); Object.assign(bad.run, mutation);
    await assert.rejects(module.launch([...args, commit], { fetch: bad.fetch }), /ci/);
    assert.equal(existsSync(marker), false);
  }
  for (const fault of ['skipped', 'missing', 'duplicate']) {
    const bad = ciFixture('dev', commit);
    if (fault === 'missing') bad.jobs.pop(); else if (fault === 'duplicate') bad.jobs.push(bad.jobs[0]);
    else bad.jobs[0].conclusion = fault;
    await assert.rejects(module.launch([...args, commit], { fetch: bad.fetch }), /ci/);
    assert.equal(existsSync(marker), false);
  }
  const tokenFile = join(installed, 'ci-token'); const token = 'fixture-read-only-ci-token';
  writeFileSync(tokenFile, token, { mode: 0o644 });
  const withToken = { ...demo, canonicalRepository: remote, destinationId: 'demo-dev', credentialBroker: [process.execPath, broker], ciTokenFile: tokenFile };
  writeFileSync(config, JSON.stringify(withToken));
  await assert.rejects(module.launch([...args, commit], { fetch: ciFixture('dev', commit).fetch }), /untrusted-config/);
  assert.equal(existsSync(marker), false);
  chmodSync(tokenFile, 0o600);
  const good = ciFixture('dev', commit);
  const result = await module.launch([...args, commit], { fetch: good.fetch });
  assert.equal(result.status, 'success');
  assert.ok(good.calls.every(call => call.options.headers.Authorization === `Bearer ${token}`));
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).ciToken, null);
});

test('installed publisher consumes bounded admitted proof offline and rejects legacy CI token config', async t => {
  const root = mkdtempSync('/tmp/ikpk-source-proof-handoff-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const author = join(root, 'author'), remote = join(root, 'canonical.git'), installed = join(root, 'protected');
  mkdirSync(author); mkdirSync(installed);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (dir, ...args) => execFileSync('/usr/bin/git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git(root, 'init', '--bare', '--initial-branch=dev', remote); git(author, 'init', '--initial-branch=dev');
  mkdirSync(join(author, 'scripts'));
  writeFileSync(join(author, 'scripts/deploy-web.sh'), `#!/bin/sh\nexec '${process.execPath}' scripts/worker.mjs\n`);
  writeFileSync(join(author, 'scripts/worker.mjs'), `import{writeFileSync}from'node:fs';
if(process.env.GH_TOKEN)process.exit(91);
writeFileSync(3,JSON.stringify({version:1,status:'success',code:'published',commit:process.env.PUBLICATION_SOURCE_SHA,
snapshotId:'snap:'+'a'.repeat(64),treeDigest:'b'.repeat(64),publicationId:'fixture-publish',
observedEntry:1,revision:1,highWaterMark:1,localExecutedTests:1,ciExecutedTests:1}));`);
  git(author, 'add', '.'); git(author, 'commit', '-m', 'fixture'); git(author, 'push', remote, 'dev');
  const commit = git(author, 'rev-parse', 'HEAD');
  const entry = join(installed, 'publication-launcher.mjs'); copyFileSync(new URL('../publication-launcher.mjs', import.meta.url), entry); chmodSync(entry, 0o700);
  const marker = join(root, 'broker-called'), broker = join(installed, 'broker.mjs');
  writeFileSync(broker, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({ciToken:process.env.GH_TOKEN??null}));console.log('{"env":{}}');`);
  const config = join(installed, 'config.json');
  const baseConfig = { ...demo, canonicalRepository: remote, destinationId: 'demo-dev', credentialBroker: [process.execPath, broker] };
  writeFileSync(config, JSON.stringify(baseConfig), { mode: 0o600 });
  const proofPath = join(installed, 'operations-request-proof.json');
  writeFileSync(proofPath, JSON.stringify(sourceProof(commit)), { mode: 0o600 });
  const module = await import(pathToFileURL(entry));
  const args = ['publish','--config',config,'--source-url',remote,'--source-ref','dev','--expected-sha',commit,'--source-proof-file',proofPath];
  const ambient = new Map(['CI', 'GITHUB_ACTIONS'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of ambient) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  delete process.env.CI; delete process.env.GITHUB_ACTIONS;
  let apiCalls = 0;
  const result = await module.launch(args, { fetch: async () => { apiCalls++; throw new Error('publisher must not call GitHub'); } });
  assert.equal(result.status, 'success');
  assert.equal(result.commit, commit, 'canonical clone/head/SHA checks remain required');
  assert.equal(apiCalls, 0, 'admitted proof must replace the legacy GitHub/token CI verifier');
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).ciToken, null, 'worker receives no CI token');

  const tokenFile = join(installed, 'legacy-ci-token'); writeFileSync(tokenFile, 'fixture-token', { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ ...baseConfig, ciTokenFile: tokenFile }), { mode: 0o600 });
  rmSync(marker, { force: true });
  await assert.rejects(module.launch(args, { fetch: async () => { apiCalls++; throw new Error('publisher must not call GitHub'); } }), /untrusted-config|ci-token/i);
  assert.equal(apiCalls, 0); assert.equal(existsSync(marker), false, 'legacy token config refuses before broker/worker');
});

test('record validation reads legacy main and admits dev records only as stand/ci demo-dev', () => {
  const f = ciFixture();
  const evidence = { repository: 'pgorbachev/ikpk', workflow: PUBLICATION_CI_POLICY.workflow, branch: 'main', commit: SHA,
    runId: 9, event: 'push', conclusion: 'success', executedTests: 1, jobs: f.jobs };
  const legacy = { ciEvidence: evidence, commit: SHA, deployMode: 'prod', paymentRole: 'prod' };
  assert.equal(publicationCiProblem(legacy), undefined);
  const devRecord = { ...legacy, deployMode: 'stand', paymentRole: 'ci', sourceRef: 'dev', sourceProfile: 'demo-dev',
    ciEvidence: { ...evidence, branch: 'dev' } };
  assert.equal(publicationCiProblem(devRecord), undefined);
  for (const bad of [{ ...devRecord, deployMode: 'prod' }, { ...devRecord, paymentRole: 'prod' },
    { ...devRecord, sourceProfile: undefined }, { ...devRecord, sourceRef: undefined },
    { ...devRecord, sourceRef: 'topic' }]) assert.ok(publicationCiProblem(bad));
});
