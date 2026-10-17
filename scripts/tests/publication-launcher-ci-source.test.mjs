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
const SHA = 'a'.repeat(40);
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
test('source branch defaults main; dev needs the exact installed demo profile', () => {
  assert.equal(launcher.publicationSourceRef({ deployMode: 'prod' }), 'main');
  assert.equal(launcher.publicationSourceRef(demo), 'dev');
  for (const bad of [{ sourceRef: 'topic' }, { ...demo, deployMode: 'prod' }, { ...demo, paymentRole: 'prod' },
    { ...demo, sourceProfile: undefined }, { ...demo, sshTarget: 'deploy@other.invalid' },
    { ...demo, siteUrl: 'https://ikpk.su' }, { ...demo, sshTarget: 'root@193.124.115.99' }]) assert.throws(() => launcher.publicationSourceRef(bad));
});
test('generic CI validator keeps main default and explicitly validates dev evidence', () => {
  const jobs = PUBLICATION_CI_POLICY.requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const evidence = { repository: 'pgorbachev/ikpk', workflow: PUBLICATION_CI_POLICY.workflow, branch: 'dev', commit: SHA,
    runId: 9, event: 'push', conclusion: 'success', executedTests: 1, jobs };
  assert.equal(ciEvidenceProblem(evidence, SHA), 'untrusted-ci-run');
  assert.equal(ciEvidenceProblem(evidence, SHA, PUBLICATION_CI_POLICY, 'dev'), undefined);
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
  const requestDirectory = join(installed, 'operations', '123e4567-e89b-42d3-a456-426614174000');
  mkdirSync(join(installed, 'operations'), { mode: 0o700 }); chmodSync(join(installed, 'operations'), 0o700);
  mkdirSync(requestDirectory, { mode: 0o700 }); chmodSync(requestDirectory, 0o700);
  const proofPath = join(requestDirectory, 'tests.json');
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
  const jobs = PUBLICATION_CI_POLICY.requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const evidence = { repository: 'pgorbachev/ikpk', workflow: PUBLICATION_CI_POLICY.workflow, branch: 'main', commit: SHA,
    runId: 9, event: 'push', conclusion: 'success', executedTests: 1, jobs };
  const legacy = { ciEvidence: evidence, commit: SHA, deployMode: 'prod', paymentRole: 'prod' };
  assert.equal(publicationCiProblem(legacy), undefined);
  const devRecord = { ...legacy, deployMode: 'stand', paymentRole: 'ci', sourceRef: 'dev', sourceProfile: 'demo-dev',
    ciEvidence: { ...evidence, branch: 'dev' } };
  assert.equal(publicationCiProblem(devRecord), undefined);
  for (const bad of [{ ...devRecord, deployMode: 'prod' }, { ...devRecord, paymentRole: 'prod' },
    { ...devRecord, sourceProfile: undefined }, { ...devRecord, sourceRef: undefined },
    { ...devRecord, sourceRef: 'topic' }]) assert.ok(publicationCiProblem(bad));
});
