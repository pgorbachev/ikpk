import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHA = 'c'.repeat(40), CANARY = 'recovery-credential-canary-617a';
const recovered = { version: 1, status: 'success', code: 'recovered', commit: 'a'.repeat(40),
  snapshotId: `snap:${'b'.repeat(64)}`, releaseId: 'recovered-release', treeDigest: 'd'.repeat(64), publicationId: 'pending-op',
  revision: 7, localExecutedTests: 10, ciExecutedTests: 51 };
const accepted = { version: 1, status: 'success', code: 'state-accepted', observedEntry: 3, revision: 4 };
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value, { mode: 0o600 }); }
function fixture(t, command = 'recover') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ikpk-operator-recovery-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launcher = join(root, 'protected/publication-launcher.mjs'), config = join(dirname(launcher), 'config.json');
  const runtime = join(dirname(launcher), 'runtime'), worker = join(runtime, 'web/scripts/publication-operator.ts');
  const broker = join(dirname(launcher), 'broker.mjs'), brokerTrace = join(root, 'broker.json'), trace = join(root, 'worker.json');
  write(launcher, ''); copyFileSync(join(ROOT, 'scripts/publication-launcher.mjs'), launcher); chmodSync(launcher, 0o700);
  write(join(runtime, 'runtime.json'), JSON.stringify({ version: 1, commit: SHA }));
  write(join(runtime, 'web/package.json'), '{"type":"module"}');
  write(config, JSON.stringify({ canonicalRepository: join(root, 'unavailable-main.git'), actor: 'protected-operator',
    destinationId: 'prod', deployMode: 'prod', paymentRole: 'ci', siteUrl: 'https://site.test.invalid',
    sshTarget: 'deploy@host.test.invalid', webRoot: '/var/www/ikpk', keepReleases: 5, chatLoaderSrc: 'none',
    knownHostsFile: join(dirname(launcher), 'known_hosts'), credentialBroker: [process.execPath, broker] }));
  write(join(dirname(launcher), 'known_hosts'), '# fixture');
  write(broker, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(brokerTrace)},'called');process.stdout.write(JSON.stringify({env:{SSH_AUTH_SOCK:${JSON.stringify(CANARY)},GH_TOKEN:${JSON.stringify(CANARY)}}}));`);
  function setAudit(audit = command === 'recover' ? recovered : accepted, status = 0) {
    write(worker, `import{writeFileSync,existsSync}from'node:fs';writeFileSync(${JSON.stringify(trace)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),sha:process.env.PUBLICATION_RUNTIME_SHA,credential:process.env.SSH_AUTH_SOCK===${JSON.stringify(CANARY)},broker:existsSync(${JSON.stringify(brokerTrace)})}));console.log(${JSON.stringify(CANARY)});console.error(${JSON.stringify(CANARY)});writeFileSync(3,${JSON.stringify(JSON.stringify(audit))});process.exitCode=${status};`);
  }
  setAudit();
  const argv = command === 'recover' ? ['recover'] : ['accept-state', '--observed-entry', '3', '--fingerprint', 'A', '--confirm'];
  const args = [...argv, '--config', config];
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root };
  const launch = (input = args) => spawnSync(process.execPath, [launcher, ...input], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  return { root, config, runtime, worker, broker, brokerTrace, trace, args, argv, env, launch, setAudit };
}
function report(result) { assert.equal(result.error, undefined); assert.ok(!(result.stdout + result.stderr).includes(CANARY)); return JSON.parse((result.stdout + result.stderr).trim()); }

test('positive control: broker and native installed worker execute and emit the recovery audit', (t) => {
  const f = fixture(t); const broker = spawnSync(process.execPath, [f.broker], { env: f.env, encoding: 'utf8' });
  assert.equal(broker.status, 0);
  const result = spawnSync(process.execPath, [f.worker, ...f.argv], { cwd: f.runtime, env: { ...f.env, ...JSON.parse(broker.stdout).env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.output[3]), recovered);
  assert.equal(JSON.parse(readFileSync(f.trace, 'utf8')).credential, true);
});
for (const command of ['recover', 'accept-state']) test(`${command} executes fixed installed runtime without main and suppresses raw worker secrets`, (t) => {
  const f = fixture(t, command); const result = f.launch(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(report(result).audit, command === 'recover' ? recovered : accepted);
  assert.deepEqual(JSON.parse(readFileSync(f.trace, 'utf8')), { argv: f.argv, cwd: f.runtime, sha: SHA, credential: true, broker: true });
});
for (const fault of ['confirmation', 'observed-entry', 'fingerprint', 'actor', 'source', 'duplicate']) test(`accept-state invalid ${fault} refuses before credential broker`, (t) => {
  const f = fixture(t, 'accept-state'); let args = [...f.args];
  if (fault === 'confirmation') args = args.filter((arg) => arg !== '--confirm');
  if (fault === 'observed-entry') args[args.indexOf('--observed-entry') + 1] = '0';
  if (fault === 'fingerprint') args[args.indexOf('--fingerprint') + 1] = ' ';
  if (fault === 'actor') args.push('--actor', 'spoofed');
  if (fault === 'source') args.push('--source-url', '/untrusted');
  if (fault === 'duplicate') args.push('--observed-entry', '4');
  const result = f.launch(args); assert.notEqual(result.status, 0); assert.equal(report(result).reason, 'invalid-arguments');
  assert.equal(existsSync(f.brokerTrace), false); assert.equal(existsSync(f.trace), false);
});
test('recover rejects caller-provided operation/evidence before broker', (t) => {
  const f = fixture(t); const result = f.launch([...f.args, '--operation', JSON.stringify(recovered)]);
  assert.notEqual(result.status, 0); assert.equal(report(result).reason, 'invalid-arguments'); assert.equal(existsSync(f.brokerTrace), false);
});
for (const code of ['recovery-noop', 'recovery-cancelled']) test(`${code} is a valid typed success without inventing a published pair`, (t) => {
  const f = fixture(t); const audit = { version: 1, status: 'success', code }; f.setAudit(audit);
  const result = f.launch(); assert.equal(result.status, 0, result.stderr); assert.deepEqual(report(result).audit, audit);
});
test('acceptance audit binds observed entry to explicit confirmation and requires exactly the next revision', (t) => {
  for (const audit of [{ ...accepted, observedEntry: 4 }, { ...accepted, revision: 3 }, { ...accepted, revision: 5 }, { ...accepted, message: CANARY }]) {
    const f = fixture(t, 'accept-state'); f.setAudit(audit); const result = f.launch();
    assert.equal(existsSync(f.trace), true, 'audit refusal must reach worker');
    assert.notEqual(result.status, 0); assert.equal(report(result).reason, 'invalid-worker-audit');
  }
});
for (const command of ['recover', 'accept-state']) test(`${command} surfaces only its curated refusal`, (t) => {
  const f = fixture(t, command); const audit = { version: 1, status: 'refused', code: command === 'recover' ? 'recovery-failed' : 'accept-state-failed' }; f.setAudit(audit, 1);
  const result = f.launch(); assert.equal(existsSync(f.trace), true); assert.notEqual(result.status, 0); assert.deepEqual(report(result).audit, audit);
});
