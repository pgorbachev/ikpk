import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, validateRequest, unitName, readServerConfig, publisherResult } from '../server-deploy.mjs';
import { runClient, parseArguments, readClientConfig, sshArguments } from '../deploy.mjs';
import { releaseTestManifest } from '../release-test-policy.mjs';
import { REQUIRED_TEST_REPORTS } from '../release-test-reports.mjs';

const reportFixtures = REQUIRED_TEST_REPORTS.map(({ suite, runner }) => ({ suite, runner,
  reportSha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, skipped: 0, todo: 0,
  flaky: 0, retried: 0, omissions: [], roleOmissions: [], acceptedDeviations: [] }));
function sourceEvidence(sourceRef, commit) {
  const directory = mkdtempSync(join(tmpdir(), 'ikpk-publish-proof-'));
  try {
    const manifest = releaseTestManifest({ RELEASE_SOURCE_PROFILE: 'source-default-ci-pinned', GITHUB_SHA: commit,
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/heads/${sourceRef}`, GITHUB_RUN_ID: '38940517004', GITHUB_RUN_ATTEMPT: '1' },
    Object.fromEntries(['identity', 'source-tests', 'supplemental', 'visual', 'provision'].map((name) => [name, { result: 'success' }])), reportFixtures);
    writeFileSync(join(directory, 'release-source-tests.json'), JSON.stringify(manifest));
    const archive = join(directory, 'proof.zip');
    spawnSync('/usr/bin/zip', ['-q', archive, 'release-source-tests.json'], { cwd: directory });
    const bytes = readFileSync(archive);
    return { repository: 'pgorbachev/ikpk', workflow: '.github/workflows/release-tests.yml', sourceRef, commit,
      runId: 38940517004, runAttempt: 1, artifactDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      artifactZipBase64: bytes.toString('base64') };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-remote-deploy-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'operations'); mkdirSync(state, { mode: 0o700 });
  const config = { state, destination: 'demo', sourceRef: 'dev' }; const events = [];
  const commit = 'a'.repeat(40);
  const ports = {
    now: () => '2026-10-15T20:00:00.000Z',
    resolveSource() { throw new Error('server-must-not-query-source-control'); }, start: (_, id) => events.push(`start:${id}`),
    service: () => ({ state: 'active' }), fullTests() { throw new Error('server-must-not-run-or-rerun-source-ci'); },
    publisher: () => { events.push('publisher'); return { status: 'success', audit: { code: 'published' } }; },
  };
  return { root, state, config, ports, events, request: { id: randomUUID(), destination: 'demo', action: 'publish',
    sourceSha: commit, sourceCiEvidence: sourceEvidence('dev', commit) } };
}
test('retry returns same operation; admitted source proof is pinned before service; parameters cannot change', async (t) => {
  const f = fixture(t); let lookups = 0; const server = createServer(f.config, { ...f.ports, resolveSource() { lookups++; throw new Error('unexpected-source-lookup'); } });
  assert.equal((await server.submit(f.request)).status, 'accepted');
  assert.equal((await server.submit(f.request)).status, 'running');
  assert.equal(lookups, 0); assert.equal(f.events.length, 1);
  await assert.rejects(server.submit({ ...f.request, action: 'recover' }), /request-id-conflict/);
  const receipt = JSON.parse(readFileSync(join(f.state, f.request.id, 'request.json')));
  assert.equal(receipt.request.sourceSha, f.request.sourceSha);
  assert.deepEqual(receipt.request.sourceCiEvidence, f.request.sourceCiEvidence);
});
test('admitted source evidence is published without server-side CI and execution is one-shot', async (t) => {
  const f = fixture(t), server = createServer(f.config, f.ports);
  await server.submit(f.request); await server.execute(f.request.id);
  assert.deepEqual(f.events.slice(1), ['publisher']);
  assert.equal(server.status(f.request.id).status, 'success');
  await assert.rejects(server.execute(f.request.id), /invalid-execution/);
  assert.equal(f.events.filter((s) => s === 'publisher').length, 1);
});
test('source identity mismatch is refused before service start', async (t) => {
  const f = fixture(t), server = createServer(f.config, f.ports);
  await assert.rejects(server.submit({ ...f.request, sourceSha: 'b'.repeat(40) }), /source.*(sha|commit)|evidence/i);
  assert.equal(f.events.length, 0);
});
test('lost start reply never resubmits; vanished service is interrupted, never published', async (t) => {
  const f = fixture(t); let starts = 0;
  const server = createServer(f.config, { ...f.ports, start() { starts++; throw new Error('SSH acknowledgement lost'); }, service: () => ({ state: 'absent' }) });
  assert.equal((await server.submit(f.request)).status, 'interrupted');
  assert.equal((await server.submit(f.request)).status, 'interrupted'); assert.equal(starts, 1);
});
test('host-wide flock refusal is busy, without invoking publisher', async (t) => {
  const f = fixture(t), server = createServer(f.config, { ...f.ports, service: () => ({ state: 'failed', exitCode: 75 }) });
  await server.submit(f.request); assert.equal(server.status(f.request.id).status, 'busy'); assert.ok(!f.events.includes('publisher'));
  assert.match(unitName(f.config, f.request.id), /^ikpk-release-demo-[a-f0-9-]+\.service$/);
});
test('request schema rejects destination changes, traversal, extra source/config options and unsafe rollback', () => {
  const r = { id: randomUUID(), destination: 'demo', action: 'publish' };
  for (const bad of [{ ...r, destination: 'prod' }, { ...r, id: '../escape' }, { ...r, config: '/tmp/x' },
    { ...r, sourceRef: 'main' }, { ...r, action: 'rollback', releaseId: 'x;sh', reason: 'why' }]) {
    assert.throws(() => validateRequest(bad, 'demo'));
  }
});
test('rollback and recover use explicit requests and do not depend on a new source test run', async (t) => {
  const f = fixture(t), server = createServer(f.config, f.ports);
  const r = { id: randomUUID(), destination: 'demo', action: 'rollback', releaseId: 'retained', reason: 'accepted rollback' };
  await server.submit(r); await server.execute(r.id);
  assert.deepEqual(f.events.slice(1), ['publisher']);
});
function clientFixture(t, destination = 'demo') {
  const f = fixture(t); const home = join(f.root, 'config'); mkdirSync(home, { mode: 0o700 });
  const identityFile = join(home, 'key'), knownHostsFile = join(home, 'known_hosts');
  writeFileSync(identityFile, 'key', { mode: 0o600 }); writeFileSync(knownHostsFile, 'pin', { mode: 0o600 });
  const config = { version: 1, destination, sourceRef: destination === 'prod' ? 'main' : 'dev',
    sshTarget: 'deploy@193.124.115.99', identityFile, knownHostsFile,
    serverEntry: '/opt/ikpk/demo/server-deploy.mjs', serverNode: '/usr/bin/node' };
  writeFileSync(join(home, `${destination}.json`), JSON.stringify(config), { mode: 0o600 });
  return { ...f, home, clientConfig: config, stateHome: join(f.root, 'client') };
}
test('client saves and announces ID before SSH; status polling does not create a second request', async (t) => {
  const f = clientFixture(t); const id = randomUUID(); const calls = [];
  const result = await runClient(['demo', '--request-id', id], { configHome: f.home, stateHome: f.stateHome, sleep: async () => {},
    announce(r) { assert.equal(r.id, id); assert.ok(existsSync(r.receipt)); calls.push('saved'); },
    call(_, action, request) { assert.equal(request.id, id); calls.push(action); return { id, destination: 'demo', status: action === 'submit' ? 'accepted' : 'success' }; } });
  assert.equal(result.status, 'success'); assert.deepEqual(calls, ['saved', 'submit', 'status']);
});
test('lost client connection leaves recoverable ID and performs no blind submit retry', async (t) => {
  const f = clientFixture(t); let calls = 0;
  await assert.rejects(runClient(['demo'], { configHome: f.home, stateHome: f.stateHome, announce() {}, call() { calls++; throw new Error('connection lost'); } }), /connection lost/);
  assert.equal(calls, 1); assert.equal(readdirSync(join(f.stateHome, 'demo')).length, 1);
});
test('SSH fixes host pin/key, disables ambient configuration and forwarding; paths cannot inject remote shell', (t) => {
  const f = clientFixture(t); const c = readClientConfig(f.home, 'demo'), args = sshArguments(c, 'submit');
  assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(args.includes('GlobalKnownHostsFile=/dev/null')); assert.ok(args.includes('ForwardAgent=no')); assert.ok(args.includes('/dev/null'));
  assert.equal(args.at(-1), 'submit');
  const p = join(f.home, 'demo.json'); writeFileSync(p, JSON.stringify({ ...f.clientConfig, serverEntry: '/tmp/x;touch_hacked.mjs' }));
  assert.throws(() => readClientConfig(f.home, 'demo'), /untrusted-client-config/);
  writeFileSync(p, JSON.stringify(f.clientConfig)); chmodSync(f.clientConfig.identityFile, 0o644);
  assert.throws(() => readClientConfig(f.home, 'demo'), /untrusted-client-config/);
});
test('command parser requires explicit destination and a reason for rollback', () => {
  assert.equal(parseArguments(['prod']).action, 'publish');
  for (const bad of [[], ['prod', '--source-ref', 'dev'], ['demo', 'status', '../bad'], ['demo', 'rollback', 'old']]) assert.throws(() => parseArguments(bad));
  const sha = 'f'.repeat(40);
  assert.equal(parseArguments(['prod', '--sha', sha]).sha, sha);
  assert.throws(() => parseArguments(['prod', '--sha', 'f'.repeat(39)]), /invalid|sha|arguments/i);
});

test('server request retries compare source evidence semantically and reject changed evidence', async (t) => {
  const f = fixture(t), commit = 'a'.repeat(40);
  const evidence = sourceEvidence('dev', commit);
  const request = { id: randomUUID(), destination: 'demo', action: 'publish', sourceSha: commit, sourceCiEvidence: evidence };
  const server = createServer(f.config, f.ports);
  assert.equal((await server.submit(request)).status, 'accepted');
  const reordered = { sourceCiEvidence: Object.fromEntries(Object.entries(evidence).reverse()),
    action: 'publish', sourceSha: commit, destination: 'demo', id: request.id };
  assert.equal((await server.submit(reordered)).status, 'running');
  await assert.rejects(server.submit({ ...reordered, sourceCiEvidence: { ...reordered.sourceCiEvidence, runAttempt: 2 } }), /request-id-conflict/);
  assert.equal(f.events.filter((event) => event.startsWith('start:')).length, 1);
});

test('server rejects a CI evidence ZIP above 4 MiB before forwarding the request', () => {
  const commit = 'b'.repeat(40);
  const oversized = { id: randomUUID(), destination: 'demo', action: 'publish', sourceSha: commit,
    sourceCiEvidence: { repository: 'pgorbachev/ikpk', workflow: '.github/workflows/release-tests.yml',
      sourceRef: 'dev', commit, runId: 38940517004, runAttempt: 1, artifactDigest: `sha256:${'c'.repeat(64)}`,
      artifactZipBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64') } };
  assert.throws(() => validateRequest(oversized, 'demo'), /too.large|size|limit/i);
});

test('a publish request without explicit source admission cannot reach SSH', async (t) => {
  const f = clientFixture(t); let submits = 0;
  let failure;
  try {
    await runClient(['demo'], { configHome: f.home, stateHome: f.stateHome, announce() {},
      call(_config, action) { if (action === 'submit') submits++; return { id: randomUUID(), destination: 'demo', status: 'success' }; } });
  } catch (error) { failure = error; }
  assert.equal(submits, 0, 'the current no-SHA path must not submit an unadmitted request');
  assert.ok(failure, 'publish without a target SHA must be refused');
});

test('explicit full source SHA is admitted before SSH and its bounded proof is bound to the request', async (t) => {
  const f = clientFixture(t, 'demo'), sha = 'a'.repeat(40), id = randomUUID();
  const evidence = { repository: 'pgorbachev/ikpk', workflow: '.github/workflows/release-tests.yml',
    sourceRef: 'dev', commit: sha, runId: 38940517004, runAttempt: 1,
    artifactDigest: 'sha256:b083f6a3ffd573c667dd1bb5103a17575de9f5043850b2d7d55bddc37eeb4ccb',
    artifactZipBase64: 'UEsDBBQAAAAAADtIUV3j+nkRHwAAAB8AAAANAAAAbWFuaWZlc3QuanNvbnsic2NoZW1hVmVyc2lvbiI6MSwiZmlsZXMiOltdfQpQSwECFAMUAAAAAAA7SFFd4/p5ER8AAAAfAAAADQAAAAAAAAAAAAAAgAEAAAAAbWFuaWZlc3QuanNvblBLBQYAAAAAAQABADsAAABKAAAAAAA=' };
  const events = [];
  const result = await runClient(['demo', '--sha', sha, '--request-id', id], {
    configHome: f.home, stateHome: f.stateHome, announce() {}, sleep: async () => {},
    admitSource: async (source) => { events.push('admit'); assert.deepEqual(source, { destination: 'demo', sourceRef: 'dev', sha }); return evidence; },
    call(_config, action, request) {
      events.push(action);
      assert.equal(action, 'submit'); assert.equal(request.sourceSha, sha);
      assert.deepEqual(request.sourceCiEvidence, evidence); assert.equal(Object.hasOwn(request, 'sourceTag'), false);
      return { id, destination: 'demo', status: 'success' };
    },
  });
  assert.equal(result.status, 'success'); assert.deepEqual(events, ['admit', 'submit']);
});

test('production reserves an exact source tag before SSH and reuses it on a later operation', async (t) => {
  const f = clientFixture(t, 'prod'), sha = 'c'.repeat(40), tag = `prod-src-${sha}`;
  const evidence = sourceEvidence('main', sha);
  const events = [], tags = new Map();
  const reserveOps = {
    resolve(name) { events.push(`resolve:${name}`); return tags.get(name) ?? null; },
    create(name, target) { events.push(`create:${name}:${target}`); tags.set(name, target); },
  };
  for (const id of [randomUUID(), randomUUID()]) {
    const result = await runClient(['prod', '--sha', sha, '--request-id', id], {
      configHome: f.home, stateHome: f.stateHome, announce() {}, sleep: async () => {}, tagOps: reserveOps,
      admitSource: async (source) => { events.push('admit'); assert.deepEqual(source, { destination: 'prod', sourceRef: 'main', sha }); return evidence; },
      call(_config, action, request) {
        events.push(action); assert.equal(action, 'submit');
        assert.equal(request.sourceTag, tag); assert.equal(request.sourceSha, sha);
        assert.equal(request.sourceCiEvidence, evidence);
        return { id, destination: 'prod', status: 'success' };
      },
    });
    assert.equal(result.status, 'success');
  }
  assert.deepEqual(events, [
    'admit', `resolve:${tag}`, `create:${tag}:${sha}`, `submit`,
    'admit', `resolve:${tag}`, 'submit',
  ]);
});

test('source or tag refusal never submits a production request; ambiguous tag creation is resolved by readback', async (t) => {
  const sha = 'd'.repeat(40), tag = `prod-src-${sha}`;
  for (const mode of ['source-refused', 'tag-conflict']) {
    const f = clientFixture(t, 'prod'); let submits = 0, creates = 0;
    await assert.rejects(runClient(['prod', '--sha', sha], {
      configHome: f.home, stateHome: f.stateHome, announce() {},
      admitSource: async () => { if (mode === 'source-refused') throw new Error('source-ci-refused'); return sourceEvidence('main', sha); },
      tagOps: {
        resolve: () => mode === 'tag-conflict' ? 'e'.repeat(40) : null,
        create: () => { creates++; return sha; },
      },
      call(_config, action) { if (action === 'submit') submits++; return { status: 'success' }; },
    }));
    assert.equal(submits, 0, mode); assert.equal(creates, 0, mode);
  }

  const f = clientFixture(t, 'prod'), events = []; let lookups = 0, submits = 0;
  const result = await runClient(['prod', '--sha', sha], {
    configHome: f.home, stateHome: f.stateHome, announce() {},
    admitSource: async () => sourceEvidence('main', sha),
    tagOps: {
      resolve(name) { assert.equal(name, tag); events.push('read'); return ++lookups === 1 ? null : sha; },
      create(name, target) { assert.equal(name, tag); assert.equal(target, sha); events.push('create'); throw new Error('tag creation reply lost'); },
    },
    call(_config, action, request) { assert.equal(request.sourceTag, tag); submits++; return { id: request.id, destination: 'prod', status: 'refused' }; },
  });
  assert.equal(result.status, 'refused'); assert.equal(submits, 1);
  assert.deepEqual(events, ['read', 'create', 'read']);
});

test('manager unavailability is unknown rather than proof that an operation stopped', async (t) => {
  const f = fixture(t), server = createServer(f.config, { ...f.ports, service: () => ({ state: 'unknown' }) });
  assert.equal(server.status(f.request.id).status, 'not-found');
  await server.submit(f.request); assert.equal(server.status(f.request.id).status, 'unknown');
});

test('installed server config has no GitHub CI token dependency', (t) => {
  const f = fixture(t), installed = join(f.root, 'server-deploy.mjs'), launcher = join(f.root, 'publication-launcher.mjs');
  writeFileSync(installed, '', { mode: 0o700 }); writeFileSync(launcher, '', { mode: 0o700 });
  const lock = join(f.root, 'build.lock'); writeFileSync(lock, '', { mode: 0o600 });
  const publisher = { sourceRef: 'dev', deployMode: 'stand', canonicalRepository: 'https://github.com/pgorbachev/ikpk.git' };
  const publisherFile = join(f.root, 'config.json'); writeFileSync(publisherFile, JSON.stringify(publisher), { mode: 0o600 });
  const c = { version: 1, destination: 'demo', sourceRef: 'dev', repository: 'pgorbachev/ikpk', timeoutSeconds: 3600,
    launcher, buildLockFile: lock };
  const configFile = join(f.root, 'server.json'); writeFileSync(configFile, JSON.stringify(c), { mode: 0o600 });
  const loaded = readServerConfig(installed);
  assert.equal(loaded.sourceRef, 'dev'); assert.equal(Object.hasOwn(loaded, 'releaseCiTokenFile'), false);
  writeFileSync(configFile, JSON.stringify({ ...c, destination: 'prod' })); assert.throws(() => readServerConfig(installed));
  writeFileSync(configFile, JSON.stringify(c)); writeFileSync(publisherFile, JSON.stringify({ ...publisher, deployMode: 'prod' }));
  assert.throws(() => readServerConfig(installed), /source-policy-mismatch/);
});

test('a delayed old service cannot publish after a newer admitted operation has executed', async (t) => {
  const f = fixture(t), server = createServer(f.config, f.ports);
  const newer = { ...f.request, id: randomUUID() };
  await server.submit(f.request); await server.submit(newer);
  assert.equal((await server.execute(newer.id)).status, 'success');
  const publishers = f.events.filter((x) => x === 'publisher').length;
  assert.equal((await server.execute(f.request.id)).status, 'refused');
  assert.equal(f.events.filter((x) => x === 'publisher').length, publishers);
});


test('the real installed launcher refusal on stderr retains its reason, and post-switch audit survives', async (t) => {
  const native = spawnSync(process.execPath, [new URL('../publication-launcher.mjs', import.meta.url).pathname],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(native.status, 1);
  assert.equal(native.stdout, '');
  assert.equal(publisherResult(native).status, 'refused');
  assert.equal(typeof publisherResult(native).reason, 'string');
  const audit = { code: 'active-unindexed', activePair: { releaseId: 'retained' } };
  const f = fixture(t), server = createServer(f.config, { ...f.ports,
    publisher: () => publisherResult({ status: 1, stdout: '', stderr: JSON.stringify({ status: 'refused', reason: 'publication-worker-failed', audit }) }) });
  await server.submit(f.request); await server.execute(f.request.id);
  assert.deepEqual(server.status(f.request.id).audit, audit);
  assert.equal(server.status(f.request.id).status, 'refused');
});

test('orphaned temporary files from a crash do not block new requests or recovery', async (t) => {
  const f = fixture(t), server = createServer(f.config, f.ports);
  writeFileSync(join(f.state, 'sequence.json.new'), 'partial');
  writeFileSync(join(f.state, 'last-started.json.new'), 'partial');
  await server.submit(f.request);
  assert.equal((await server.execute(f.request.id)).status, 'success');
  const recover = { id: randomUUID(), destination: 'demo', action: 'recover' };
  await server.submit(recover);
  assert.equal((await server.execute(recover.id)).status, 'success');
});


test('the admitted proof is durable before SSH starts and is not resolved by the server', async (t) => {
  const f = fixture(t);
  const server = createServer(f.config, { ...f.ports, start(_, id) {
    const receipt = JSON.parse(readFileSync(join(f.state, id, 'request.json'), 'utf8'));
    assert.equal(receipt.request.sourceSha, f.request.sourceSha);
    assert.deepEqual(receipt.request.sourceCiEvidence, f.request.sourceCiEvidence);
    f.events.push(`start:${id}`);
  } });
  assert.equal((await server.submit(f.request)).status, 'accepted');
  assert.equal(f.events.length, 1);
});
