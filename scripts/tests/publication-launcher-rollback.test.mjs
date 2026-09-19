import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNTIME_SHA = 'c'.repeat(40), ORIGINAL_SHA = 'a'.repeat(40), CANARY = 'rollback-credential-74f836';
const audit = { version: 1, status: 'success', code: 'rolled-back', commit: ORIGINAL_SHA,
  releaseId: 'retained-release', snapshotId: `snap:${'b'.repeat(64)}`, treeDigest: 'd'.repeat(64),
  publicationId: 'rollback-operation', revision: 7, localExecutedTests: 9, ciExecutedTests: 51 };
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value, { mode: 0o600 }); }
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ikpk-installed-rollback-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'protected/publication-launcher.mjs'), config = join(dirname(installed), 'config.json');
  const runtime = join(dirname(installed), 'runtime'), worker = join(runtime, 'web/scripts/publication-operator.ts');
  const broker = join(dirname(installed), 'broker.mjs'), brokerTrace = join(root, 'broker.json'), workerTrace = join(root, 'worker.json');
  const evil = join(root, 'evil.mjs'), evilTrace = join(root, 'evil-called');
  mkdirSync(dirname(installed), { recursive: true }); copyFileSync(join(ROOT, 'scripts/publication-launcher.mjs'), installed); chmodSync(installed, 0o700);
  write(join(runtime, 'runtime.json'), JSON.stringify({ version: 1, commit: RUNTIME_SHA }));
  write(join(runtime, 'web/package.json'), '{"type":"module"}');
  write(join(dirname(installed), 'known_hosts'), '# test fixture\n');
  write(config, JSON.stringify({ canonicalRepository: join(root, 'unavailable-canonical.git'), actor: 'protected-operator',
    destinationId: 'prod', deployMode: 'prod', paymentRole: 'ci', siteUrl: 'https://site.test.invalid',
    sshTarget: 'deploy@host.test.invalid', webRoot: '/var/www/ikpk', keepReleases: 5, chatLoaderSrc: 'none',
    knownHostsFile: join(dirname(installed), 'known_hosts'), credentialBroker: [process.execPath, broker] }));
  write(broker, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(brokerTrace)}, JSON.stringify({called:true, ambient:process.env.IKPK_SECRET})); process.stdout.write(JSON.stringify({env:{SSH_AUTH_SOCK:${JSON.stringify(CANARY)},GH_TOKEN:${JSON.stringify(CANARY)}}}));`);
  write(evil, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(evilTrace)}, 'executed');`);
  function setWorker(value = audit, status = 0) {
    write(worker, `import {writeFileSync,existsSync} from 'node:fs';
writeFileSync(${JSON.stringify(workerTrace)}, JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2),runtime:process.env.PUBLICATION_RUNTIME_SHA,
config:process.env.PUBLICATION_CONFIG,launcher:process.env.PUBLICATION_LAUNCHER,destination:process.env.PUBLICATION_DESTINATION_ID,
credential:process.env.SSH_AUTH_SOCK===${JSON.stringify(CANARY)},broker:existsSync(${JSON.stringify(brokerTrace)}),hook:process.env.NODE_OPTIONS,source:process.env.PUBLICATION_SOURCE_SHA}));
console.log(${JSON.stringify(CANARY)}); console.error(${JSON.stringify(CANARY)});
writeFileSync(3, ${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))}); process.exitCode=${status};`);
  }
  setWorker();
  const args = ['rollback', '--config', config, '--release-id', audit.releaseId, '--confirm', '--reason', 'Broken navigation'];
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, IKPK_SECRET: CANARY };
  const launch = (argv = args, extraEnv = {}) => spawnSync(process.execPath, [installed, ...argv], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
  return { root, installed, config, runtime, worker, broker, brokerTrace, workerTrace, evil, evilTrace, args, env, launch, setWorker };
}
function report(result) { assert.equal(result.error, undefined); assert.ok(!(result.stdout + result.stderr).includes(CANARY)); return JSON.parse((result.stdout + result.stderr).trim()); }
function refused(f, result, reason) {
  assert.notEqual(result.status, 0); assert.equal(report(result).reason, reason);
  assert.equal(existsSync(f.brokerTrace), false, 'broker ran before trust/argument validation');
  assert.equal(existsSync(f.workerTrace), false); assert.equal(existsSync(f.evilTrace), false);
}

test('fixture positive control executes native installed worker and broker with the original release audit', (t) => {
  const f = fixture(t); const broker = spawnSync(process.execPath, [f.broker], { env: f.env, encoding: 'utf8' });
  assert.equal(broker.status, 0);
  const result = spawnSync(process.execPath, [f.worker, ...f.args.filter((arg) => arg !== '--config' && arg !== f.config)], {
    cwd: f.runtime, env: { ...f.env, ...JSON.parse(broker.stdout).env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.output[3]), audit);
  assert.equal(JSON.parse(readFileSync(f.workerTrace, 'utf8')).credential, true);
});

test('rollback runs fixed installed runtime while canonical main is unavailable and binds audit to selected old release', (t) => {
  const f = fixture(t); const result = f.launch(); assert.equal(result.status, 0, result.stderr);
  const value = report(result); assert.deepEqual(value.audit, audit); assert.equal(value.commit, ORIGINAL_SHA);
  const marker = JSON.parse(readFileSync(f.workerTrace, 'utf8'));
  assert.deepEqual(marker.argv, ['rollback', '--release-id', audit.releaseId, '--confirm', '--reason', 'Broken navigation']);
  assert.equal(marker.cwd, f.runtime); assert.equal(marker.runtime, RUNTIME_SHA); assert.equal(marker.config, f.config);
  assert.equal(marker.launcher, f.installed); assert.equal(marker.destination, 'prod'); assert.equal(marker.credential, true); assert.equal(marker.broker, true);
  assert.equal(marker.source, undefined); assert.equal(marker.hook, undefined);
  assert.deepEqual(JSON.parse(readFileSync(f.brokerTrace, 'utf8')), { called: true });
});

for (const fault of ['confirmation', 'reason', 'release-id', 'source', 'worker', 'duplicate']) test(`rollback ${fault} is refused before broker access`, (t) => {
  const f = fixture(t); let args = [...f.args];
  if (fault === 'confirmation') args = args.filter((arg) => arg !== '--confirm');
  if (fault === 'reason') args[args.indexOf('--reason') + 1] = ' ';
  if (fault === 'release-id') args[args.indexOf('--release-id') + 1] = '../outside';
  if (fault === 'source') args.push('--source-url', f.evil);
  if (fault === 'worker') args.push('--worker', f.evil);
  if (fault === 'duplicate') args.push('--release-id', 'another');
  refused(f, f.launch(args), 'invalid-arguments');
});
for (const fault of ['missing-manifest', 'bad-manifest', 'writable-manifest', 'writable-worker', 'symlink-worker', 'symlink-parent']) test(`rollback ${fault} refuses before broker access`, (t) => {
  const f = fixture(t); const manifest = join(f.runtime, 'runtime.json');
  if (fault === 'missing-manifest') rmSync(manifest);
  if (fault === 'bad-manifest') write(manifest, JSON.stringify({ version: 1, commit: 'main' }));
  if (fault === 'writable-manifest') chmodSync(manifest, 0o622);
  if (fault === 'writable-worker') chmodSync(f.worker, 0o622);
  if (fault === 'symlink-worker') { rmSync(f.worker); symlinkSync(f.evil, f.worker); }
  if (fault === 'symlink-parent') { const outside = join(f.root, 'outside'); mkdirSync(outside); copyFileSync(f.evil, join(outside, 'publication-operator.ts')); rmSync(dirname(f.worker), { recursive: true }); symlinkSync(outside, dirname(f.worker)); }
  refused(f, f.launch(), 'untrusted-runtime');
});

test('ambient source and command replacements cannot redirect installed rollback or inherit startup hooks', (t) => {
  const f = fixture(t);
  // Set hooks inside the calling process after Node startup: otherwise Node itself
  // runs NODE_OPTIONS before the launcher has an opportunity to strip them.
  const driver = join(f.root, 'driver.mjs');
  write(driver, `process.env.NODE_OPTIONS=${JSON.stringify(`--import=${f.evil}`)}; process.env.PUBLICATION_WORKER=${JSON.stringify(f.evil)}; process.env.PUBLICATION_SOURCE_SHA='f'.repeat(40); const {launch}=await import(${JSON.stringify(f.installed)}); console.log(JSON.stringify(await launch(${JSON.stringify(f.args)})));`);
  const result = spawnSync(process.execPath, [driver], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(report(result).audit, audit); assert.equal(existsSync(f.evilTrace), false);
  const marker = JSON.parse(readFileSync(f.workerTrace, 'utf8')); assert.equal(marker.hook, undefined); assert.equal(marker.source, undefined);
});

test('rollback audit refuses wrong release, unknown fields, wrong operation kind, zero checks and malformed output', (t) => {
  for (const invalid of [{ ...audit, releaseId: 'foreign-release' }, { ...audit, message: CANARY }, { ...audit, code: 'published' },
    { ...audit, localExecutedTests: 0 }, { ...audit, commit: 'main' }, '{not-json']) {
    const f = fixture(t); f.setWorker(invalid); const result = f.launch();
    assert.equal(existsSync(f.workerTrace), true, 'audit refusal must follow actual worker execution');
    assert.notEqual(result.status, 0); assert.equal(report(result).reason, 'invalid-worker-audit');
  }
});

test('preselection rollback refusal may omit commit and never substitutes runtime SHA', (t) => {
  const f = fixture(t); const failure = { version: 1, status: 'refused', code: 'rollback-failed' }; f.setWorker(failure, 1);
  const result = f.launch(); assert.notEqual(result.status, 0); assert.deepEqual(report(result).audit, failure);
  assert.equal(existsSync(f.workerTrace), true);
});

test('rollback preserves checked refusal and active-unindexed audit without raw worker logs', (t) => {
  for (const code of ['checks-failed', 'active-unindexed']) {
    const f = fixture(t); const failure = { ...audit, status: 'refused', code,
      ...(code === 'checks-failed' ? { check: 'browser-smoke', localExecutedTests: 0 } :
        { activePair: { commit: ORIGINAL_SHA, snapshotId: audit.snapshotId, releaseId: audit.releaseId } }) };
    f.setWorker(failure, 1); const result = f.launch(); assert.notEqual(result.status, 0); assert.deepEqual(report(result).audit, failure);
    assert.equal(existsSync(f.workerTrace), true);
  }
});

test('hosted CI cannot invoke installed rollback or obtain broker credentials', (t) => {
  const f = fixture(t); refused(f, f.launch(f.args, { CI: 'true' }), 'hosted-publication-forbidden');
});
