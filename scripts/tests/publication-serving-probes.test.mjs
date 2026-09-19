import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSshTransport } from '../publication-transport.mjs';

const options = { timeout: 10000 };
const fakeSsh = fileURLToPath(new URL('./fixtures/serving-probe-ssh.mjs', import.meta.url));
const redirects = 'location = /old { return 301 /new; }\n';
const ready = { status: 'ready', mode: 'test', shopId: 'shop-42' };

function setup(t, fault = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-serving-probes-'));
  const root = join(temp, 'remote');
  mkdirSync(join(root, 'releases', 'old'), { recursive: true });
  mkdirSync(join(root, 'shared'));
  writeFileSync(join(root, 'releases', 'old', 'index.html'), 'old release');
  symlinkSync('releases/old', join(root, 'current'));
  const fragment = join(root, 'shared', 'nginx-redirects.conf');
  writeFileSync(fragment, redirects);
  const source = join(temp, 'source'); mkdirSync(source);
  const payload = Buffer.from('new release');
  writeFileSync(join(source, 'index.html'), payload);
  const treeDigest = createHash('sha256').update('10:index.html').update(`${payload.length}:`).update(payload).digest('hex');
  const nginxDump = `# configuration file /etc/nginx/sites-enabled/site:\nserver { listen 80; root ${root}/current; include ${fragment}; }\n`;
  const log = join(temp, 'effects.jsonl'); writeFileSync(log, '');
  const fixture = join(temp, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ log, nginxDump, ...fault }));
  const knownHostsFile = join(temp, 'known_hosts'); writeFileSync(knownHostsFile, '# no real SSH\n');
  const proof = { commit: 'a'.repeat(40), destinationId: 'stand', snapshotId: 'snapshot-1', treeDigest };
  const authorizations = [];
  const config = {
    root, destinationId: 'stand', host: 'transport.test.invalid', user: 'deploy', knownHostsFile,
    sshCommand: [process.execPath, fakeSsh, fixture],
    authorize: async (request) => { authorizations.push(request); return { ...proof }; },
  };
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return { root, source, fragment, nginxDump, config, proof, treeDigest, events, authorizations,
    transport: () => createSshTransport(config),
    unchanged() {
      assert.equal(readlinkSync(join(root, 'current')), 'releases/old');
      assert.equal(readFileSync(join(root, 'releases', 'old', 'index.html'), 'utf8'), 'old release');
      assert.equal(readFileSync(fragment, 'utf8'), redirects);
      assert.deepEqual(readdirSync(join(root, 'releases')), ['old']);
      assert.equal(existsSync(join(root, '.publication-pending.json')), false);
    },
  };
}

// RED-only no-op seam for absent APIs: assertions measure missing observations/refusals,
// never a TypeError from calling an undefined method. Once methods exist, the real
// session implementation is always called; this shim cannot manufacture evidence.
async function probe(session, method) {
  return typeof session[method] === 'function' ? session[method]() : undefined;
}

test('harness control executes the real remote upload protocol without real SSH', options, async (t) => {
  const f = setup(t);
  await f.transport().withLock((session) => session.stage({ releaseId: 'new', sourceDir: f.source, expectedDigest: f.treeDigest }));
  assert.equal(readFileSync(join(f.root, 'releases', 'new', 'index.html'), 'utf8'), 'new release');
  assert.equal(readlinkSync(join(f.root, 'current')), 'releases/old');
  assert.equal(readFileSync(f.fragment, 'utf8'), redirects);
  assert.equal(f.events().filter((event) => event.kind === 'connection').length, 1);
  assert.equal(f.events().filter((event) => ['command', 'http'].includes(event.kind)).length, 0);
});

test('serving inspection reads actual nginx dump and the existing root-bound redirect fragment over SSH', options, async (t) => {
  const f = setup(t);
  const result = await f.transport().withLock((session) => probe(session, 'inspectServing'));
  assert.deepEqual(result, { nginxDump: f.nginxDump, redirects });
  assert.deepEqual(f.events().filter((event) => event.kind === 'command'), [
    { kind: 'command', argv: ['/usr/bin/sudo', '-n', '/usr/sbin/nginx', '-T'], shell: false },
  ]);
  assert.equal(f.events().filter((event) => event.kind === 'connection').length, 1);
  assert.ok(f.authorizations.some((request) => request.action === 'inspect-serving'));
  f.unchanged();
});

test('payment readiness uses fixed GET on VPS loopback and returns HTTP metadata with parsed JSON', options, async (t) => {
  const f = setup(t);
  // An operator-supplied URL is never an alternative probe target.
  f.config.readinessUrl = 'https://operator.test.invalid/readyz';
  const result = await f.transport().withLock((session) => probe(session, 'paymentReadiness'));
  assert.deepEqual(result, { status: 200, contentType: 'application/json', body: ready });
  assert.deepEqual(f.events().filter((event) => event.kind === 'http'), [
    { kind: 'http', url: 'http://127.0.0.1:8787/readyz', method: 'GET' },
  ]);
  assert.ok(f.authorizations.some((request) => request.action === 'payment-readiness'));
  f.unchanged();
});

test('source and destination proof permits both probes before snapshot and full report exist', options, async (t) => {
  const f = setup(t);
  delete f.proof.snapshotId; delete f.proof.treeDigest;
  const outcome = await f.transport().withLock(async (session) => ({
    serving: await probe(session, 'inspectServing'), readiness: await probe(session, 'paymentReadiness'),
  })).then((value) => ({ value }), (error) => ({ error: error.message }));
  assert.equal(outcome.error, undefined, 'read-only proof must not depend on the report these probes produce');
  assert.equal(outcome.value.serving.nginxDump, f.nginxDump);
  assert.deepEqual(outcome.value.readiness.body, ready);
  assert.equal(f.events().filter((event) => event.kind === 'connection').length, 1);
  f.unchanged();
});

test('source-only proof opens the read-only session but cannot upload bytes', options, async (t) => {
  const f = setup(t); delete f.proof.snapshotId; delete f.proof.treeDigest;
  let entered = false;
  await assert.rejects(f.transport().withLock(async (session) => {
    entered = true;
    await session.stage({ releaseId: 'new', sourceDir: f.source, expectedDigest: f.treeDigest });
  }), /authorization|proof|snapshot|digest/i);
  assert.equal(entered, true, 'refusal must guard upload, not prevent prerequisite read-only probes');
  f.unchanged();
});

for (const method of ['inspectServing', 'paymentReadiness']) {
  test(`${method} rechecks authorization before making its remote observation`, options, async (t) => {
    const f = setup(t);
    const action = method === 'inspectServing' ? 'inspect-serving' : 'payment-readiness';
    f.config.authorize = async (request) => {
      if (request.action === action) throw new Error('probe permission revoked');
      return { ...f.proof };
    };
    await assert.rejects(f.transport().withLock((session) => probe(session, method)), /revoked/);
    assert.equal(f.events().filter((event) => ['command', 'http'].includes(event.kind)).length, 0);
    f.unchanged();
  });
}

test('unavailable nginx inspection refuses instead of producing empty evidence', options, async (t) => {
  const f = setup(t, { nginxFailure: true });
  await assert.rejects(f.transport().withLock((session) => probe(session, 'inspectServing')));
  assert.equal(f.events().filter((event) => event.kind === 'command').length, 1);
  f.unchanged();
});

test('redirect fragment symlinks are not accepted as destination evidence', options, async (t) => {
  const f = setup(t); const outside = join(f.root, '..', 'outside.conf');
  writeFileSync(outside, redirects); unlinkSync(f.fragment); symlinkSync(outside, f.fragment);
  await assert.rejects(f.transport().withLock((session) => probe(session, 'inspectServing')));
  assert.equal(readlinkSync(f.fragment), outside);
  f.unchanged();
});

for (const [label, fault] of [
  ['unreachable service', { networkFailure: true }],
  ['malformed JSON', { readyBody: '{not json' }],
  ['readiness body over 64 KiB', { readyBody: `"${'x'.repeat(64 * 1024)}"` }],
]) {
  test(`${label} cannot return successful readiness evidence`, options, async (t) => {
    const f = setup(t, fault);
    await assert.rejects(f.transport().withLock((session) => probe(session, 'paymentReadiness')));
    assert.equal(f.events().filter((event) => event.kind === 'http').length, 1);
    f.unchanged();
  });
}

test('non-200 readiness is preserved or refused and never normalized into ready HTTP 200', options, async (t) => {
  const f = setup(t, { readyStatus: 503 });
  const result = await f.transport().withLock((session) => probe(session, 'paymentReadiness'))
    .then((value) => ({ value }), (error) => ({ error }));
  if (!result.error) assert.equal(result.value?.status, 503);
  assert.equal(f.events().filter((event) => event.kind === 'http').length, 1);
  f.unchanged();
});

test('nginx dump over 2 MiB is refused as oversized evidence', options, async (t) => {
  const f = setup(t, { nginxDump: 'x'.repeat(2 * 1024 * 1024 + 1) });
  await assert.rejects(f.transport().withLock((session) => probe(session, 'inspectServing')));
  f.unchanged();
});

test('redirect fragment over 1 MiB is refused as oversized evidence', options, async (t) => {
  const f = setup(t); writeFileSync(f.fragment, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(f.transport().withLock((session) => probe(session, 'inspectServing')));
  assert.equal(readFileSync(f.fragment).length, 1024 * 1024 + 1);
  assert.equal(readlinkSync(join(f.root, 'current')), 'releases/old');
});
