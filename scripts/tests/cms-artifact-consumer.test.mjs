import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync, symlinkSync, copyFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runClient } from '../deploy.mjs';
import { createServer, readServerConfig } from '../server-deploy.mjs';
import { releaseTestManifest } from '../release-test-policy.mjs';
import { REQUIRED_TEST_REPORTS } from '../release-test-reports.mjs';

// Synthetic archives and size limits in this file exist only for isolated tests. The live
// consumer must remain disabled until its measured CMS ZIP cap and disk reserve are pinned.

const sha = 'a'.repeat(40);
const runId = 42;
const runAttempt = 3;
const sourceRef = 'dev';
const TEST_CMS_POLICY = Object.freeze({ maxArchiveBytes: 1024 * 1024, maxExpandedBytes: 8 * 1024 * 1024,
  freeSpaceReserveBytes: 1024 * 1024, nodeMajor: 22, nodeAbi: '127' });
const sourceProof = Buffer.from('fixture source proof zip');
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const controlProof = {
  repository: 'pgorbachev/ikpk', workflow: '.github/workflows/release-tests.yml', sourceRef, commit: sha,
  runId, runAttempt, artifactDigest: digest(sourceProof), artifactZipBase64: sourceProof.toString('base64'),
};
const artifactMetadata = (bytes, overrides = {}) => ({
  id: 501, name: `release-cms-artifact-${runAttempt}`, digest: digest(bytes), size_in_bytes: bytes.length,
  expired: false, workflow_run: { id: runId, head_sha: sha }, runAttempt, ...overrides,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-cms-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root };
}

function cmsArchive(t, { source = { sha, ref: `refs/heads/${sourceRef}`, runId, runAttempt }, files,
  migrationMarkerPath = 'database/.migrations-expected', nestedMigrationFiles = [], manifestMutator } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-cms-zip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = files ?? {
    'dist/build/index.html': '<html>admin</html>',
    'dist/src/index.js': 'export default {};',
    'dist/config/database.js': 'export default {};',
    'package.json': '{"name":"cms"}',
    'package-lock.json': '{"lockfileVersion":3}',
    'tsconfig.json': '{}',
    [migrationMarkerPath]: '1\n',
    'database/migrations/0001-fixture.sql': '-- fixture migration\n',
    'database/migrations/target-schema/seminar.json': '{}',
    'scripts/run-data-migrations.mjs': 'export {};',
    'scripts/audit-data-migration.mjs': 'export {};',
    'scripts/audit-schema-snapshot.mjs': 'export {};',
    'scripts/institute-method-author-classification.mjs': 'export {};',
    'scripts/normalize-null-documents-state.mjs': 'export {};',
    'src/lib/demo193-source-empty-fields.json': '{}',
  };
  for (const [path, contents] of nestedMigrationFiles) payload[path] = contents;
  for (const [path, contents] of Object.entries(payload)) {
    const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, contents);
  }
  const filesManifest = Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, contents]) => ({ path, sha256: createHash('sha256').update(contents).digest('hex') }));
  const lock = Buffer.from(payload['package-lock.json'] ?? '');
  const manifest = {
    schemaVersion: 1, source,
    packageLockSha256: createHash('sha256').update(lock).digest('hex'),
    runtime: { nodeVersion: 'v22.23.3', nodeMajor: 22, nodeAbi: '127', npmVersion: '10.8.2' },
    files: filesManifest,
  };
  manifestMutator?.(manifest);
  writeFileSync(join(root, 'cms-artifact-manifest.json'), JSON.stringify(manifest));
  const zip = join(root, 'cms.zip');
  execFileSync('/usr/bin/zip', ['-q', '-r', zip, '.'], { cwd: root });
  return readFileSync(zip);
}

function framed(control, archiveBytes) {
  const json = Buffer.from(JSON.stringify(control));
  const header = Buffer.alloc(16);
  header.writeBigUInt64BE(BigInt(json.length), 0);
  header.writeBigUInt64BE(BigInt(archiveBytes.length), 8);
  return Buffer.concat([header, json, archiveBytes]);
}

function validServerRequest(id, archiveBytes, metadata = artifactMetadata(archiveBytes)) {
  return { id, destination: 'demo', action: 'publish', sourceSha: sha, sourceCiEvidence: controlProof, cmsArtifact: metadata };
}

function validSourceProof() {
  const reports = REQUIRED_TEST_REPORTS.map(({ suite, runner }) => ({ suite, runner,
    reportSha256: 'a'.repeat(64), total: 1, passed: 1, failed: 0, skipped: 0, todo: 0,
    flaky: 0, retried: 0, omissions: [], roleOmissions: [], acceptedDeviations: [] }));
  const manifest = releaseTestManifest({ RELEASE_SOURCE_PROFILE: 'source-default-ci-pinned', GITHUB_SHA: sha,
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev', GITHUB_RUN_ID: String(runId), GITHUB_RUN_ATTEMPT: String(runAttempt) },
  Object.fromEntries(['identity', 'source-tests', 'supplemental', 'visual', 'provision'].map((name) => [name, { result: 'success' }])), reports);
  const root = mkdtempSync(join(tmpdir(), 'ikpk-ci-proof-'));
  writeFileSync(join(root, 'release-source-tests.json'), JSON.stringify(manifest));
  const zip = join(root, 'proof.zip'); execFileSync('/usr/bin/zip', ['-q', zip, 'release-source-tests.json'], { cwd: root });
  const bytes = readFileSync(zip); rmSync(root, { recursive: true, force: true });
  return { ...controlProof, artifactDigest: digest(bytes), artifactZipBase64: bytes.toString('base64') };
}

function serverFixture(t, { cmsArtifactPolicy = TEST_CMS_POLICY } = {}) {
  const { root } = fixture(t), state = join(root, 'operations'); mkdirSync(state, { mode: 0o700 });
  const events = [];
  const config = { state, destination: 'demo', sourceRef, ...(cmsArtifactPolicy ? { cmsArtifactPolicy } : {}) };
  const ports = { now: () => '2026-10-17T12:00:00.000Z', start: (_, id) => events.push(`start:${id}`),
    service: () => ({ state: 'active' }), cmsRuntime: () => ({ nodeMajor: 22, nodeAbi: '127' }),
    publisher: () => { events.push('publisher'); return { status: 'success' }; } };
  return { root, state, events, config, server: createServer(config, ports) };
}

function installedServerFixture(root, { cmsArtifactPolicy = TEST_CMS_POLICY } = {}) {
  const actualRoot = realpathSync(root), serverDir = join(actualRoot, 'installed-server');
  mkdirSync(serverDir, { mode: 0o700 });
  const scriptsUrl = new URL('../', import.meta.url);
  for (const name of ['server-deploy.mjs', 'release-test-policy.mjs', 'release-test-reports.mjs', 'cms-artifact.mjs']) {
    const source = new URL(name, scriptsUrl);
    if (existsSync(source)) copyFileSync(source, join(serverDir, name));
  }
  const installed = realpathSync(join(serverDir, 'server-deploy.mjs')); chmodSync(installed, 0o700);
  const launcher = join(serverDir, 'publication-launcher.mjs'), launcherConfig = join(serverDir, 'config.json');
  const lock = join(actualRoot, 'build.lock');
  writeFileSync(launcher, '', { mode: 0o700 }); writeFileSync(lock, '', { mode: 0o600 });
  writeFileSync(launcherConfig, JSON.stringify({ sourceRef: 'dev', deployMode: 'stand',
    canonicalRepository: 'https://github.com/pgorbachev/ikpk.git' }), { mode: 0o600 });
  const config = { version: 1, destination: 'demo', sourceRef: 'dev', repository: 'pgorbachev/ikpk',
    timeoutSeconds: 3600, launcher, buildLockFile: lock,
    ...(cmsArtifactPolicy === null ? {} : { cmsArtifactPolicy }) };
  writeFileSync(join(serverDir, 'server.json'), JSON.stringify(config), { mode: 0o600 });
  return { serverDir, installed, config };
}

test('publish binds the full CMS ZIP to the exact admitted CI run and sends one binary frame', async (t) => {
  const f = fixture(t), archiveBytes = cmsArchive(t), received = []; let savedReceipt;
  const run = await runClient(['demo', '--sha', sha, '--request-id', randomUUID()], {
    configHome: clientConfig(f.root), stateHome: join(f.root, 'client'), sleep: async () => {},
    admitSource: async (source) => { assert.deepEqual(source, { destination: 'demo', sourceRef, sha }); return controlProof; },
    prepareCmsArtifact: async (request) => {
      assert.deepEqual(request, { destination: 'demo', sourceRef, sha, sourceCiEvidence: controlProof });
      return { metadata: artifactMetadata(archiveBytes), archiveBytes };
    },
    announce: (receipt) => { savedReceipt = receipt.receipt; },
    call(_, action, control, frame) {
      received.push({ action, control, frame });
      return { id: control.id, destination: 'demo', status: action === 'submit' ? 'success' : 'success' };
    },
  });
  assert.equal(run.status, 'success');
  assert.equal(received.length, 1, 'publish must make one submit, with no second archive upload');
  assert.equal(received[0].action, 'submit');
  assert.ok(Buffer.isBuffer(received[0].frame), 'publish SSH call receives one binary request frame');
  assert.deepEqual(received[0].frame, framed(received[0].control, archiveBytes));
  assert.deepEqual(received[0].control.cmsArtifact, artifactMetadata(archiveBytes));
  assert.equal(JSON.stringify(received[0].control).includes(archiveBytes.toString('base64')), false,
    'CMS ZIP bytes must not be encoded into control JSON');
  const persisted = JSON.parse(readFileSync(savedReceipt, 'utf8'));
  assert.deepEqual(persisted.cmsArtifact, artifactMetadata(archiveBytes), 'recovery retains the admitted artifact identity');
  assert.equal(JSON.stringify(persisted).includes(archiveBytes.toString('base64')), false,
    'raw CMS payload bytes are never persisted in client JSON');
});

function clientConfig(root, suffix = 'default') {
  const home = join(root, `config-${suffix}`); mkdirSync(home, { mode: 0o700 });
  const identityFile = join(home, 'key'), knownHostsFile = join(home, 'known_hosts');
  writeFileSync(identityFile, 'key', { mode: 0o600 }); writeFileSync(knownHostsFile, 'pin', { mode: 0o600 });
  writeFileSync(join(home, 'demo.json'), JSON.stringify({ version: 1, destination: 'demo', sourceRef,
    sshTarget: 'deploy@example.test', identityFile, knownHostsFile,
    serverEntry: '/opt/ikpk/demo/server-deploy.mjs', serverNode: '/usr/bin/node' }), { mode: 0o600 });
  return home;
}

test('publish refuses before any SSH call when there is no matching CMS artifact', async (t) => {
  const f = fixture(t); let submits = 0;
  await assert.rejects(runClient(['demo', '--sha', sha], {
    configHome: clientConfig(f.root), stateHome: join(f.root, 'client'), admitSource: async () => controlProof,
    prepareCmsArtifact: async () => { throw new Error('cms-artifact-not-found'); },
    call() { submits++; return { status: 'success' }; }, announce() {},
  }), /cms-artifact-not-found/);
  assert.equal(submits, 0);
  assert.equal(existsSync(join(f.root, 'client', 'demo')), false, 'no publish receipt is saved before artifact admission');
});

test('CMS selection refuses an expired, stale-attempt, wrong-SHA, or wrong-size native artifact', async (t) => {
  const f = fixture(t), bytes = cmsArchive(t); let submits = 0;
  let index = 0;
  for (const metadata of [
    artifactMetadata(bytes, { expired: true }),
    artifactMetadata(bytes, { name: 'release-cms-artifact-2' }),
    artifactMetadata(bytes, { runAttempt: runAttempt - 1 }),
    artifactMetadata(bytes, { workflow_run: { id: runId, head_sha: 'b'.repeat(40) } }),
    artifactMetadata(bytes, { size_in_bytes: bytes.length + 1 }),
  ]) {
    await assert.rejects(runClient(['demo', '--sha', sha], {
      configHome: clientConfig(f.root, String(index++)), stateHome: join(f.root, `client-${randomUUID()}`),
      admitSource: async () => controlProof,
      prepareCmsArtifact: async () => ({ metadata, archiveBytes: bytes }),
      call() { submits++; return { status: 'success' }; }, announce() {},
    }));
  }
  assert.equal(submits, 0);
});

test('server validates the full admitted archive before durable acceptance or worker start', async (t) => {
  const f = serverFixture(t), bytes = cmsArchive(t), id = randomUUID();
  const request = { ...validServerRequest(id, bytes, { ...artifactMetadata(bytes), digest: digest(Buffer.from('different')) }),
    sourceCiEvidence: validSourceProof() };
  await assert.rejects(f.server.submit(request, bytes), /cms|archive|artifact/i);
  assert.deepEqual(f.events, []);
  assert.equal(existsSync(join(f.state, id)), false, 'invalid archive leaves no accepted receipt or partial request directory');
});

test('server checks CMS source, runtime lock, inventory, and required entries before start', async (t) => {
  const mutations = [
    (manifest) => { manifest.source.sha = 'b'.repeat(40); },
    (manifest) => { manifest.source.runAttempt++; },
    (manifest) => { manifest.packageLockSha256 = '0'.repeat(64); },
    (manifest) => { manifest.runtime.nodeAbi = 'wrong-abi'; },
    (manifest) => { manifest.files.pop(); },
  ];
  for (const mutate of mutations) {
    const f = serverFixture(t), bytes = cmsArchive(t, { manifestMutator: mutate }), id = randomUUID();
    await assert.rejects(f.server.submit({ ...validServerRequest(id, bytes), sourceCiEvidence: validSourceProof() }, bytes), /cms|archive|artifact|manifest|runtime|inventory/i);
    assert.deepEqual(f.events, []);
    assert.equal(existsSync(join(f.state, id)), false);
  }
});

test('CMS manifest accepts only the exact producer refs for the two supported source branches', async (t) => {
  const { validateCmsArtifact } = await import('../cms-artifact.mjs');
  for (const [sourceRef, nativeRef] of [['main', 'refs/heads/main'], ['dev', 'refs/heads/dev']]) {
    const evidence = { ...controlProof, sourceRef };
    const bytes = cmsArchive(t, { source: { sha, ref: nativeRef, runId, runAttempt } });
    const request = { ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: evidence };
    assert.doesNotThrow(() => validateCmsArtifact({ request, archiveBytes: bytes,
      policy: TEST_CMS_POLICY, runtime: { nodeMajor: 22, nodeAbi: '127' } }), `${nativeRef} must bind exactly to ${sourceRef}`);
  }
  for (const [sourceRef, untrustedRef] of [
    ['dev', 'refs/heads/feature/cms'], ['main', 'refs/tags/v1.0.0'], ['dev', 'dev'],
    ['main', 'refs/heads/Main'], ['dev', 'refs/pull/42/merge'],
  ]) {
    const evidence = { ...controlProof, sourceRef };
    const bytes = cmsArchive(t, { source: { sha, ref: untrustedRef, runId, runAttempt } });
    const request = { ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: evidence };
    assert.throws(() => validateCmsArtifact({ request, archiveBytes: bytes,
      policy: TEST_CMS_POLICY, runtime: { nodeMajor: 22, nodeAbi: '127' } }), /cms|source|ref|manifest/i,
    `${untrustedRef} must not normalize into supported source ${sourceRef}`);
  }
});

test('CMS validator accepts the producer canonical database migration marker with exact count', async (t) => {
  const { validateCmsArtifact } = await import('../cms-artifact.mjs');
  const bytes = cmsArchive(t), request = { ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: validSourceProof() };
  assert.doesNotThrow(() => validateCmsArtifact({ request, archiveBytes: bytes,
    policy: TEST_CMS_POLICY, runtime: { nodeMajor: 22, nodeAbi: '127' } }));
});

test('CMS migration marker counts only direct JavaScript and SQL migration children', async (t) => {
  const { validateCmsArtifact } = await import('../cms-artifact.mjs');
  const bytes = cmsArchive(t, { nestedMigrationFiles: [
    ['database/migrations/helpers/nested-helper.js', 'export {};'],
    ['database/migrations/helpers/nested-fixture.sql', '-- nested helper, not a top-level migration\n'],
  ] });
  const request = { ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: validSourceProof() };
  assert.doesNotThrow(() => validateCmsArtifact({ request, archiveBytes: bytes,
    policy: TEST_CMS_POLICY, runtime: { nodeMajor: 22, nodeAbi: '127' } }),
  'the producer writes the expected count from direct readdir children, excluding nested helpers');
});

test('CMS validator rejects the misplaced nested migration marker', async (t) => {
  const { validateCmsArtifact } = await import('../cms-artifact.mjs');
  const bytes = cmsArchive(t, { migrationMarkerPath: 'database/migrations/.migrations-expected' });
  const request = { ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: validSourceProof() };
  assert.throws(() => validateCmsArtifact({ request, archiveBytes: bytes,
    policy: TEST_CMS_POLICY, runtime: { nodeMajor: 22, nodeAbi: '127' } }), /cms|migration|inventory/i);
});

test('unconfigured CMS archive policy keeps recovery/status available and refuses publish', async (t) => {
  const f = fixture(t), { installed } = installedServerFixture(f.root, { cmsArtifactPolicy: null });
  const installedConfig = readServerConfig(installed);
  assert.equal(installedConfig.cmsArtifactPolicy, undefined);
  const direct = serverFixture(t, { cmsArtifactPolicy: null });
  assert.equal(direct.server.status(randomUUID()).status, 'not-found');
  await assert.rejects(direct.server.submit({ ...validServerRequest(randomUUID(), Buffer.from('archive')), sourceCiEvidence: validSourceProof() }, Buffer.from('archive')),
    /cms-artifact-policy-unconfigured/);
  const rollback = { id: randomUUID(), destination: 'demo', action: 'rollback', releaseId: 'retained', reason: 'approved recovery' };
  assert.equal((await direct.server.submit(rollback)).status, 'accepted');
  assert.deepEqual(direct.events, [`start:${rollback.id}`]);
});

test('CMS disk reserve is checked before any private stage or accepted request is written', async (t) => {
  const f = serverFixture(t), bytes = cmsArchive(t), request = {
    ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: validSourceProof(),
  };
  let reserveCheck;
  const server = createServer(f.config, {
    now: () => '2026-10-17T12:00:00.000Z', start: (_, id) => f.events.push(`start:${id}`),
    service: () => ({ state: 'active' }), cmsRuntime: () => ({ nodeMajor: 22, nodeAbi: '127' }), publisher: () => ({ status: 'success' }),
    checkCmsDiskReserve(config, declaredBytes, reserveBytes) {
      reserveCheck = { config, declaredBytes, reserveBytes };
      throw new Error('cms-artifact-disk-reserve-insufficient');
    },
  });
  await assert.rejects(server.submit(request, bytes), /cms-artifact-disk-reserve-insufficient/);
  assert.deepEqual(reserveCheck, { config: f.config, declaredBytes: bytes.length,
    reserveBytes: TEST_CMS_POLICY.freeSpaceReserveBytes });
  assert.deepEqual(readdirSync(f.state), [], 'reserve rejection precedes all operation, receipt, counter, and archive writes');
  assert.deepEqual(f.events, [], 'reserve rejection cannot start a worker');
});

test('failed CMS disk materialization preserves the partial private stage and blocks another UUID', async (t) => {
  const f = serverFixture(t), bytes = cmsArchive(t), request = {
    ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: validSourceProof(),
  };
  const server = createServer(f.config, {
    now: () => '2026-10-17T12:00:00.000Z', start: (_, id) => f.events.push(`start:${id}`),
    service: () => ({ state: 'active' }), cmsRuntime: () => ({ nodeMajor: 22, nodeAbi: '127' }), publisher: () => ({ status: 'success' }),
    stageCmsArchive(path, archiveBytes) {
      writeFileSync(path, archiveBytes.subarray(0, 12), { mode: 0o600, flag: 'wx' });
      throw new Error('synthetic-stage-failure');
    },
  });
  await assert.rejects(server.submit(request, bytes), /synthetic-stage-failure/);
  const incoming = join(f.state, '.incoming');
  assert.deepEqual(readdirSync(incoming).sort(), ['cms-artifact.zip', 'request.json']);
  assert.deepEqual(readFileSync(join(incoming, 'cms-artifact.zip')), bytes.subarray(0, 12));
  assert.equal(statSync(join(incoming, 'cms-artifact.zip')).mode & 0o777, 0o600);
  await assert.rejects(server.submit({ ...request, id: randomUUID() }, bytes), /cms-incomplete-stage-pending/);
  assert.deepEqual(readFileSync(join(incoming, 'cms-artifact.zip')), bytes.subarray(0, 12), 'later UUID cannot overwrite or clean the orphan stage');
  assert.deepEqual(f.events, [], 'a failed or blocked materialization never invokes a worker');
});

test('partial CMS staging fsyncs the state directory after incoming mkdir and before archive writes', async (t) => {
  const f = serverFixture(t), bytes = cmsArchive(t), request = {
    ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: validSourceProof(),
  };
  const events = [], incoming = join(f.state, '.incoming');
  const server = createServer(f.config, {
    now: () => '2026-10-17T12:00:00.000Z', start: (_, id) => f.events.push(`start:${id}`),
    service: () => ({ state: 'active' }), cmsRuntime: () => ({ nodeMajor: 22, nodeAbi: '127' }),
    syncDirectory(path) {
      events.push(`sync:${path}`);
      assert.equal(path, f.state, 'the parent directory entry for .incoming must be made durable');
      assert.equal(existsSync(incoming), true, '.incoming must exist before its parent is synced');
    },
    stageCmsArchive(path, archiveBytes) {
      events.push('stage');
      writeFileSync(path, archiveBytes.subarray(0, 12), { mode: 0o600, flag: 'wx' });
      throw new Error('synthetic-stage-failure');
    },
  });
  await assert.rejects(server.submit(request, bytes), /synthetic-stage-failure/);
  assert.deepEqual(events, [`sync:${f.state}`, 'stage']);
  assert.deepEqual(readdirSync(incoming).sort(), ['cms-artifact.zip', 'request.json']);
});

test('unmarked durable .incoming stage is visible as incomplete and blocks another publish UUID', async (t) => {
  const f = serverFixture(t), incoming = join(f.state, '.incoming'), id = randomUUID();
  mkdirSync(incoming, { mode: 0o700 });
  const status = f.server.status(id);
  assert.deepEqual(status, { id, destination: 'demo', status: 'unknown', code: 'request-acceptance-incomplete', stage: '.incoming' });
  const bytes = cmsArchive(t), next = { ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: validSourceProof() };
  await assert.rejects(f.server.submit(next, bytes), /cms-incomplete-stage-pending/);
  assert.deepEqual(readdirSync(incoming), [], 'status and blocked publish leave an unmarked durable stage untouched');
  assert.deepEqual(f.events, [], 'an incomplete stage never starts a worker');
});

test('corrupt .incoming request marker remains diagnosable and blocks another publish UUID', async (t) => {
  const f = serverFixture(t), incoming = join(f.state, '.incoming'), id = randomUUID();
  mkdirSync(incoming, { mode: 0o700 });
  const marker = join(incoming, 'request.json'), markerBytes = Buffer.from('{corrupt durable marker');
  writeFileSync(marker, markerBytes, { mode: 0o600 });
  const status = f.server.status(id);
  assert.deepEqual(status, { id, destination: 'demo', status: 'unknown', code: 'request-acceptance-incomplete', stage: '.incoming' });
  const bytes = cmsArchive(t), next = { ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: validSourceProof() };
  await assert.rejects(f.server.submit(next, bytes), /cms-incomplete-stage-pending/);
  assert.deepEqual(readFileSync(marker), markerBytes, 'diagnosis never rewrites or removes an unreadable marker');
  assert.deepEqual(f.events, [], 'an invalid marker never starts a worker');
});

test('server rejects traversal, symlink, unexpected dependencies, and missing Strapi admin output', async (t) => {
  const variants = [
    { files: { 'node_modules/x.js': 'x' } },
    { files: { 'package.json': '{}', 'package-lock.json': '{}', 'tsconfig.json': '{}' } },
  ];
  for (const variant of variants) {
    const f = serverFixture(t), bytes = cmsArchive(t, variant), id = randomUUID();
    await assert.rejects(f.server.submit({ ...validServerRequest(id, bytes), sourceCiEvidence: validSourceProof() }, bytes), /cms|archive|artifact|manifest|runtime|inventory/i);
    assert.deepEqual(f.events, []);
  }
  const f = serverFixture(t), root = mkdtempSync(join(tmpdir(), 'ikpk-cms-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'outside'), 'outside');
  symlinkSync('outside', join(root, 'dist-link'));
  const linkZip = join(root, 'link.zip'); execFileSync('/usr/bin/zip', ['-q', '-r', '-y', linkZip, '.'], { cwd: root });
  const linkBytes = readFileSync(linkZip), id = randomUUID();
  await assert.rejects(f.server.submit({ ...validServerRequest(id, linkBytes), sourceCiEvidence: validSourceProof() }, linkBytes), /cms|archive|artifact|manifest|runtime|inventory/i);
  assert.deepEqual(f.events, []);
});

test('accepted archive is staged in a private server-owned file and the worker starts only after admission', async (t) => {
  const f = serverFixture(t), bytes = cmsArchive(t), id = randomUUID();
  const accepted = await f.server.submit({ ...validServerRequest(id, bytes), sourceCiEvidence: validSourceProof() }, bytes);
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(f.events, [`start:${id}`]);
  const requestDir = join(f.state, id), receipt = JSON.parse(readFileSync(join(requestDir, 'request.json'), 'utf8'));
  const stagedName = readdirSync(requestDir).find((name) => name.endsWith('.zip'));
  assert.ok(stagedName, 'validated CMS ZIP is durably staged by the server');
  assert.deepEqual(readFileSync(join(requestDir, stagedName)), bytes);
  assert.equal(statSync(requestDir).mode & 0o077, 0);
  assert.equal(statSync(join(requestDir, stagedName)).mode & 0o077, 0);
  assert.equal(JSON.stringify(receipt).includes(bytes.toString('base64')), false);
  assert.equal(receipt.request.cmsArtifact.archiveBytes, undefined);
  assert.equal(f.events.includes('publisher'), false, 'staging does not execute archive contents during admission');
});

test('execute refuses CMS receipt before marking execution until the activation adapter is integrated', async (t) => {
  const f = serverFixture(t), bytes = cmsArchive(t), id = randomUUID();
  const request = { ...validServerRequest(id, bytes), sourceCiEvidence: validSourceProof() };
  assert.equal((await f.server.submit(request, bytes)).status, 'accepted');
  const operation = join(f.state, id), receiptPath = join(operation, 'request.json');
  const receiptBytes = readFileSync(receiptPath), receipt = JSON.parse(receiptBytes);
  const archivePath = receipt.cmsArchivePath;
  assert.ok(archivePath);
  assert.deepEqual(readFileSync(archivePath), bytes);
  f.events.length = 0;

  const result = await f.server.execute(id);
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'cms-activation-adapter-not-integrated');
  assert.equal(existsSync(join(operation, 'execution.json')), false, 'refusal precedes one-shot execution marker');
  assert.equal(existsSync(join(f.state, 'last-started.json')), false, 'refusal precedes publication sequence mutation');
  assert.equal(existsSync(join(operation, 'tests.json')), false, 'proof is not handed to a publisher before activation exists');
  assert.equal(f.events.includes('publisher'), false, 'publisher is never invoked');
  assert.deepEqual(readFileSync(receiptPath), receiptBytes, 'accepted receipt remains byte-for-byte intact');
  assert.deepEqual(readFileSync(archivePath), bytes, 'staged CMS archive remains byte-for-byte intact');
});

test('activation refusal remains visible in status without service inspection or execution markers', async (t) => {
  const f = serverFixture(t), bytes = cmsArchive(t), id = randomUUID();
  const request = { ...validServerRequest(id, bytes), sourceCiEvidence: validSourceProof() };
  let serviceCalls = 0, publisherCalls = 0;
  const server = createServer(f.config, {
    now: () => '2026-10-17T12:00:00.000Z', cmsRuntime: () => ({ nodeMajor: 22, nodeAbi: '127' }),
    start() { throw new Error('cms-activation-adapter-not-integrated'); },
    service() { serviceCalls++; return { state: 'active' }; },
    publisher() { publisherCalls++; return { status: 'success' }; },
  });
  const submission = await server.submit(request, bytes);
  assert.equal(submission.code, 'cms-activation-adapter-not-integrated');
  const operation = join(f.state, id), receiptPath = join(operation, 'request.json');
  const receiptBytes = readFileSync(receiptPath), receipt = JSON.parse(receiptBytes), archivePath = receipt.cmsArchivePath;
  assert.ok(archivePath); assert.deepEqual(readFileSync(archivePath), bytes);

  const status = server.status(id);
  assert.deepEqual(status, { id, destination: 'demo', status: 'refused', code: 'cms-activation-adapter-not-integrated' });
  assert.equal(serviceCalls, 0, 'status preserves the guard instead of probing a worker that must not exist');
  assert.equal(publisherCalls, 0);
  assert.equal(existsSync(join(operation, 'execution.json')), false);
  assert.equal(existsSync(join(f.state, 'last-started.json')), false);
  assert.equal(existsSync(join(operation, 'tests.json')), false);
  assert.deepEqual(readFileSync(receiptPath), receiptBytes, 'refusal leaves the accepted receipt unchanged');
  assert.deepEqual(readFileSync(archivePath), bytes, 'refusal leaves the staged archive unchanged');
});

test('the production gateway frame reader waits for EOF, then admits those exact bytes under an injected worker', async (t) => {
  const f = serverFixture(t), bytes = cmsArchive(t), request = {
    ...validServerRequest(randomUUID(), bytes), sourceCiEvidence: validSourceProof(),
  };
  const frame = framed(request, bytes), releaseTail = {};
  const gate = new Promise((resolve) => { releaseTail.open = resolve; });
  let reachedTail = false;
  async function* incoming() {
    yield frame.subarray(0, 16 + 32);
    await gate;
    reachedTail = true;
    yield frame.subarray(16 + 32);
  }
  const { readSubmitFrame } = await import('../server-deploy.mjs');
  let submitCalls = 0;
  const pending = readSubmitFrame(Readable.from(incoming()), { maxControlBytes: 8 * 1024 * 1024, maxArchiveBytes: bytes.length })
    .then(({ request: received, archiveBytes }) => {
      assert.equal(reachedTail, true, 'complete frame must be read before admission begins');
      submitCalls++;
      return f.server.submit(received, archiveBytes);
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitCalls, 0);
  assert.deepEqual(f.events, [], 'worker is not invoked while only a partial frame has arrived');
  releaseTail.open();
  assert.equal((await pending).status, 'accepted');
  assert.equal(submitCalls, 1);
  const requestDir = join(f.state, request.id), stagedName = readdirSync(requestDir).find((name) => name.endsWith('.zip'));
  assert.deepEqual(readFileSync(join(requestDir, stagedName)), bytes);
  assert.deepEqual(f.events, [`start:${request.id}`]);
});

test('the installed frame reader reports bounded oversize and truncation errors before admission', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-gateway-cli-'));
  try {
    const { installed, serverDir } = installedServerFixture(temp);
    const overLimitFrame = Buffer.alloc(16);
    overLimitFrame.writeBigUInt64BE(8n * 1024n * 1024n + 1n, 0);
    const cli = spawnSync(process.execPath, [installed, 'accept-frame'], {
      input: overLimitFrame, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(cli.status, 1, `the installed accept-frame command refuses an over-limit declared frame (stdout=${cli.stdout}, stderr=${cli.stderr})`);
    assert.match(cli.stderr, /cms-frame-too-large/, 'CLI exposes the bounded decoder refusal code');
    assert.deepEqual(readdirSync(join(serverDir, 'operations')), [], 'oversized frame never creates an operation or starts a worker');
    const truncated = spawnSync(process.execPath, [installed, 'accept-frame'], {
      input: Buffer.from([0]), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(truncated.status, 1);
    assert.match(truncated.stderr, /cms-frame-truncated/, 'EOF during header has a specific refusal code');
  } finally { rmSync(temp, { recursive: true, force: true }); }

  const { readSubmitFrame } = await import('../server-deploy.mjs');
  const header = Buffer.alloc(16); header.writeBigUInt64BE(2n, 0); header.writeBigUInt64BE(4n, 8);
  await assert.rejects(readSubmitFrame(Readable.from([header, Buffer.from('{}'), Buffer.from('x')]),
    { maxControlBytes: 8, maxArchiveBytes: 3 }), /frame|truncated|size|length/i);
  const tooLarge = Buffer.alloc(16); tooLarge.writeBigUInt64BE(9n, 0); tooLarge.writeBigUInt64BE(0n, 8);
  await assert.rejects(readSubmitFrame(Readable.from([tooLarge]), { maxControlBytes: 8, maxArchiveBytes: 3 }), /frame|size|length/i);
});

test('Linux gateway acquires the shared flock before consuming a frame and serializes receivers', { skip: process.platform !== 'linux' }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-gateway-flock-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const { installed } = installedServerFixture(temp);
  const env = { ...process.env, SSH_ORIGINAL_COMMAND: `${process.execPath} ${installed} submit` };
  const first = spawn(process.execPath, [installed, 'gateway'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let firstOut = '', firstErr = '', secondOut = '', secondErr = '';
  first.stdout.setEncoding('utf8').on('data', (chunk) => { firstOut += chunk; });
  first.stderr.setEncoding('utf8').on('data', (chunk) => { firstErr += chunk; });
  const firstDone = new Promise((resolve) => first.on('close', (code) => resolve(code)));
  t.after(() => { if (!first.killed) first.kill('SIGKILL'); });
  first.stdin.write(Buffer.from([0]));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = spawn(process.execPath, [installed, 'gateway'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  second.stdout.setEncoding('utf8').on('data', (chunk) => { secondOut += chunk; });
  second.stderr.setEncoding('utf8').on('data', (chunk) => { secondErr += chunk; });
  const secondDone = new Promise((resolve) => second.on('close', (code) => resolve(code)));
  t.after(() => { if (!second.killed) second.kill('SIGKILL'); });
  second.stdin.end(Buffer.alloc(16));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(second.exitCode, null, 'second request waits while the first owns the receive lock');
  first.stdin.end();
  const [firstCode, secondCode] = await Promise.all([firstDone, secondDone]);
  assert.equal(firstCode, 1);
  assert.match(firstErr, /cms-frame-truncated/);
  assert.equal(secondCode, 1);
  assert.match(secondErr, /cms-frame-too-large|cms-frame-invalid-control|server-request-failed/);
  assert.equal(firstOut, '');
  assert.equal(secondOut, '');
  assert.deepEqual(readdirSync(join(temp, 'operations')), [], 'incomplete receives create no operation or worker');
});

test('same UUID and same archive bytes replay status without a second start; changed bytes conflict', async (t) => {
  const f = serverFixture(t), bytes = cmsArchive(t), id = randomUUID(), request = {
    ...validServerRequest(id, bytes), sourceCiEvidence: validSourceProof(),
  };
  assert.equal((await f.server.submit(request, bytes)).status, 'accepted');
  assert.deepEqual(await f.server.submit(request, bytes), {
    id, destination: 'demo', status: 'running', code: 'inspect-pending-before-retry',
  });
  assert.equal(f.events.filter((value) => value === `start:${id}`).length, 1);
  const other = Buffer.from(bytes); other[other.length - 1] ^= 1;
  await assert.rejects(f.server.submit(request, other), /request-id-conflict/);
  assert.equal(f.events.filter((value) => value === `start:${id}`).length, 1);
});

test('retry checks status before downloading and revalidates the same run artifact only after not-found', async (t) => {
  const f = fixture(t), home = clientConfig(f.root), archiveBytes = cmsArchive(t), id = randomUUID();
  let prepared = 0; const calls = [];
  const prepareCmsArtifact = async (request) => {
    prepared++;
    assert.deepEqual(request.sourceCiEvidence, controlProof);
    return { metadata: artifactMetadata(archiveBytes), archiveBytes };
  };
  await assert.rejects(runClient(['demo', '--sha', sha, '--request-id', id], {
    configHome: home, stateHome: join(f.root, 'client'), admitSource: async () => controlProof,
    prepareCmsArtifact, announce() {}, call(_, action) { calls.push(action); throw new Error('reply lost'); },
  }), /reply lost/);
  assert.equal(prepared, 1);
  calls.length = 0;
  const status = ['not-found', 'success'];
  const result = await runClient(['demo', '--sha', sha, '--request-id', id], {
    configHome: home, stateHome: join(f.root, 'client'), admitSource: async () => controlProof,
    prepareCmsArtifact, announce() {}, call(_, action, request, frame) {
      calls.push(action);
      if (action === 'status') return { id, destination: 'demo', status: status.shift() };
      assert.deepEqual(request.cmsArtifact, artifactMetadata(archiveBytes));
      assert.deepEqual(frame, framed(request, archiveBytes));
      return { id, destination: 'demo', status: 'success' };
    },
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(calls, ['status', 'submit']);
  assert.equal(prepared, 2, 'the exact canonical run artifact is downloaded and digest checked again only after not-found');
});

test('native CMS artifact lookup pins run attempt, metadata digest, bounded ZIP bytes, and allowed redirect without auth leakage', async () => {
  const { downloadCmsArtifactForEvidence } = await import('../release-ci.mjs');
  assert.equal(typeof downloadCmsArtifactForEvidence, 'function');
  const archiveBytes = Buffer.from('synthetic native artifact zip body');
  const nativeRun = (attempt = runAttempt) => ({ repository: { full_name: 'pgorbachev/ikpk' },
    head_repository: { full_name: 'pgorbachev/ikpk' }, path: '.github/workflows/release-tests.yml',
    head_sha: sha, head_branch: sourceRef, run_attempt: attempt, status: 'completed', conclusion: 'success', event: 'push' });
  const jsonResponse = (value) => ({ ok: true, status: 200, body: Readable.from([Buffer.from(JSON.stringify(value))]), headers: { get: () => null } });
  function fetchFixture({ finalAttempt = runAttempt, artifactDigest = digest(archiveBytes), artifactSize = archiveBytes.length,
    redirect = 'https://native.blob.core.windows.net/cms.zip' } = {}) {
    const calls = []; let runRequests = 0;
    const fetch = async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith(`/actions/runs/${runId}`)) return jsonResponse(nativeRun(runRequests++ === 0 ? runAttempt : finalAttempt));
      if (url.includes(`/actions/runs/${runId}/artifacts?`)) return jsonResponse({ total_count: 1, artifacts: [{
        id: 501, name: `release-cms-artifact-${runAttempt}`, digest: artifactDigest, size_in_bytes: artifactSize,
        expired: false, workflow_run: { id: runId, head_sha: sha },
      }] });
      if (url.endsWith('/actions/artifacts/501/zip')) return { ok: false, status: 302, headers: { get: (name) => name === 'location' ? redirect : null } };
      if (url === redirect) return { ok: true, status: 200, body: Readable.from([archiveBytes]), headers: { get: () => null } };
      throw new Error(`unexpected mocked request ${url}`);
    };
    return { fetch, calls };
  }

  const fixture = fetchFixture();
  const result = await downloadCmsArtifactForEvidence(controlProof, { token: 'fixture-token', fetch: fixture.fetch, maxArchiveBytes: 1024 });
  assert.deepEqual(result.archiveBytes, archiveBytes);
  assert.deepEqual(result.metadata, { id: 501, name: `release-cms-artifact-${runAttempt}`, digest: digest(archiveBytes),
    size_in_bytes: archiveBytes.length, expired: false, workflow_run: { id: runId, head_sha: sha }, runAttempt });
  assert.equal(fixture.calls.length, 5, 'initial run, unique artifact listing, API download, allowlisted redirect, final run recheck');
  assert.ok(fixture.calls.every(({ options }) => options.redirect === 'manual' || options.redirect === 'error'));
  assert.equal(fixture.calls[0].url, `https://api.github.com/repos/pgorbachev/ikpk/actions/runs/${runId}`);
  assert.equal(fixture.calls[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(fixture.calls[3].url, 'https://native.blob.core.windows.net/cms.zip');
  assert.equal(Object.hasOwn(fixture.calls[3].options, 'headers'), false, 'redirected artifact host receives no GitHub authorization header');

  const stale = fetchFixture({ finalAttempt: runAttempt + 1 });
  await assert.rejects(downloadCmsArtifactForEvidence(controlProof, { token: 'fixture-token', fetch: stale.fetch, maxArchiveBytes: 1024 }), /cms-artifact-attempt-changed/);
  const digestMismatch = fetchFixture({ artifactDigest: digest(Buffer.from('different')) });
  await assert.rejects(downloadCmsArtifactForEvidence(controlProof, { token: 'fixture-token', fetch: digestMismatch.fetch, maxArchiveBytes: 1024 }), /cms-artifact-digest-mismatch/);
  const oversized = fetchFixture({ artifactSize: 1025 });
  await assert.rejects(downloadCmsArtifactForEvidence(controlProof, { token: 'fixture-token', fetch: oversized.fetch, maxArchiveBytes: 1024 }), /cms-artifact-native-metadata-mismatch/);
  assert.equal(oversized.calls.some(({ url }) => url.endsWith('/zip')), false, 'over-cap metadata is rejected before downloading bytes');
  const untrustedRedirect = fetchFixture({ redirect: 'https://attacker.example/cms.zip' });
  await assert.rejects(downloadCmsArtifactForEvidence(controlProof, { token: 'fixture-token', fetch: untrustedRedirect.fetch, maxArchiveBytes: 1024 }), /release-ci-untrusted-artifact-redirect/);
});

test('rollback and status requests need no CMS archive frame', async (t) => {
  const f = serverFixture(t), id = randomUUID();
  const status = f.server.status(id);
  assert.equal(status.status, 'not-found');
  const rollback = { id, destination: 'demo', action: 'rollback', releaseId: 'retained', reason: 'approved recovery' };
  assert.equal((await f.server.submit(rollback)).status, 'accepted');
  assert.deepEqual(f.events, [`start:${id}`]);
});
