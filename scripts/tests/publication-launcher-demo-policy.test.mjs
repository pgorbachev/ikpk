import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicationSourceRef } from '../publication-launcher.mjs';
import { RELEASE_TEST_WORKFLOW, releaseTestManifest } from '../release-test-policy.mjs';
import { REQUIRED_TEST_REPORTS } from '../release-test-reports.mjs';
const demo = { sourcePolicy: 'demo-publication-only', deployMode: 'stand', paymentRole: 'ci',
  sshTarget: 'deploy@193.124.115.99', siteUrl: 'https://staging.ikpk.su' };
const faults = [{ sourcePolicy: 'demo-if-missing' }, { sshTarget: 'deploy@192.0.2.1' }, { sshTarget: 'root@193.124.115.99' },
  { siteUrl: 'https://ikpk.su' }, { deployMode: 'prod' }, { paymentRole: 'stand' }, { paymentRole: 'prod' }];
test('explicit source policy is separate from source ref and fails closed on every binding', () => {
  assert.equal(publicationSourceRef(demo), 'main');
  assert.equal(publicationSourceRef({ ...demo, sourceRef: 'dev', sourceProfile: 'demo-dev' }), 'dev');
  assert.equal(publicationSourceRef({ deployMode: 'prod' }), 'main');
  for (const fault of faults) assert.throws(() => publicationSourceRef({ ...demo, ...fault }), /source-policy/);
});
for (const command of ['publish', 'recover', 'rollback']) test(`${command} rejects invalid DEMO binding before credential broker`, async t => {
  const root = mkdtempSync('/tmp/ikpk-demo-launcher-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, 'publication-launcher.mjs'); copyFileSync(new URL('../publication-launcher.mjs', import.meta.url), entry); chmodSync(entry, 0o700);
  const marker = join(root, 'broker-called'), broker = join(root, 'broker.mjs');
  writeFileSync(broker, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'called');console.log('{"env":{}}');`);
  const config = join(root, 'config.json'); const installed = await import(pathToFileURL(entry));
  const requestDirectory = join(root, 'operations', '123e4567-e89b-42d3-a456-426614174000');
  mkdirSync(join(root, 'operations'), { mode: 0o700 }); chmodSync(join(root, 'operations'), 0o700);
  mkdirSync(requestDirectory, { mode: 0o700 }); chmodSync(requestDirectory, 0o700);
  const reports = REQUIRED_TEST_REPORTS.map(({ suite, runner }) => ({ suite, runner,
    reportSha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, skipped: 0, todo: 0,
    flaky: 0, retried: 0, omissions: [], roleOmissions: [], acceptedDeviations: [] }));
  const commit = 'a'.repeat(40), manifest = releaseTestManifest({ RELEASE_SOURCE_PROFILE: 'source-default-ci-pinned',
    GITHUB_SHA: commit, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' },
  Object.fromEntries(['identity', 'source-tests', 'supplemental', 'visual', 'provision'].map(name => [name, { result: 'success' }])), reports);
  const manifestDirectory = join(root, 'manifest'); mkdirSync(manifestDirectory);
  writeFileSync(join(manifestDirectory, 'release-source-tests.json'), JSON.stringify(manifest));
  const archive = join(root, 'source-proof.zip'); execFileSync('/usr/bin/zip', ['-q', archive, 'release-source-tests.json'], { cwd: manifestDirectory });
  const archiveBytes = readFileSync(archive), proofPath = join(requestDirectory, 'tests.json');
  writeFileSync(proofPath, JSON.stringify({ repository: 'pgorbachev/ikpk', workflow: RELEASE_TEST_WORKFLOW,
    sourceRef: 'main', commit, runId: 1, runAttempt: 1,
    artifactDigest: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`,
    artifactZipBase64: archiveBytes.toString('base64') }), { mode: 0o600 });
  const ambient = new Map(['CI', 'GITHUB_ACTIONS'].map(key => [key, process.env[key]]));
  for (const key of ambient.keys()) delete process.env[key];
  t.after(() => { for (const [key, value] of ambient) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  for (const fault of faults) {
    writeFileSync(config, JSON.stringify({ ...demo, ...fault, destinationId: 'stand', canonicalRepository: 'https://github.com/pgorbachev/ikpk.git', credentialBroker: [process.execPath, broker] }), { mode: 0o600 });
    const args = [command, '--config', config,
      ...(command === 'publish' ? ['--source-proof-file', proofPath] : []),
      ...(command === 'rollback' ? ['--release-id', 'previous', '--confirm', '--reason', 'fixture'] : [])];
    await assert.rejects(installed.launch(args), /source-policy/);
    assert.equal(existsSync(marker), false);
  }
});

test('installed audit accepts untracked publication and recovery only under explicit DEMO policy', async () => {
  const { workerAudit } = await import('../publication-launcher.mjs');
  const audit = { version: 1, status: 'success', code: 'published', commit: 'a'.repeat(40),
    snapshotId: `snap:${'b'.repeat(64)}`, publicationId: 'demo', treeDigest: 'c'.repeat(64),
    sourcePolicy: 'demo-publication-only', sourceAge: 'untracked', localExecutedTests: 5, ciExecutedTests: 7 };
  assert.deepEqual(workerAudit(JSON.stringify(audit), audit.commit, 0, undefined, undefined, demo.sourcePolicy), audit);
  assert.throws(() => workerAudit(JSON.stringify(audit), audit.commit, 0), /invalid-worker-audit/);
  const recovered = { ...audit, code: 'recovered', releaseId: 'demo' };
  assert.deepEqual(workerAudit(JSON.stringify(recovered), undefined, 0, undefined, { command: 'recover' }, demo.sourcePolicy), recovered);
  for (const field of ['revision', 'observedEntry', 'highWaterMark']) {
    assert.throws(() => workerAudit(JSON.stringify({ ...audit, [field]: 4 }), audit.commit, 0, undefined, undefined, demo.sourcePolicy), /invalid-worker-audit/);
  }
});
