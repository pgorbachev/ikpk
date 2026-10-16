import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicationSourceRef } from '../publication-launcher.mjs';
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
  const ambient = new Map(['CI', 'GITHUB_ACTIONS'].map(key => [key, process.env[key]]));
  for (const key of ambient.keys()) delete process.env[key];
  t.after(() => { for (const [key, value] of ambient) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  for (const fault of faults) {
    writeFileSync(config, JSON.stringify({ ...demo, ...fault, destinationId: 'stand', canonicalRepository: 'https://github.com/pgorbachev/ikpk.git', credentialBroker: [process.execPath, broker] }), { mode: 0o600 });
    const args = [command, '--config', config, ...(command === 'rollback' ? ['--release-id', 'previous', '--confirm', '--reason', 'fixture'] : [])];
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
