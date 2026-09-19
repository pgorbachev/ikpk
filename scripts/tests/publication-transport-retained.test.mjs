import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSshTransport } from '../publication-transport.mjs';

const options = { timeout: 15000 };
const proxy = fileURLToPath(new URL('./fixtures/retained-read-stream-proxy.mjs', import.meta.url));
function files(root) {
  const result = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [name, bytes] of Object.entries(files(path))) result[`${entry.name}/${name}`] = bytes;
    else if (entry.isFile()) result[entry.name] = readFileSync(path);
    else result[entry.name] = entry.isSymbolicLink() ? `symlink:${readlinkSync(path)}` : 'nonregular';
  }
  return result;
}
function digest(tree) {
  const hash = createHash('sha256');
  for (const [name, bytes] of Object.entries(tree).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(`${Buffer.byteLength(name)}:`).update(name).update(`${bytes.length}:`).update(bytes);
  return hash.digest('hex');
}
function fixture(t, fault = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-retained-test-'));
  const root = join(temp, 'remote');
  const retained = join(root, 'releases', 'retained');
  mkdirSync(join(retained, 'assets'), { recursive: true });
  mkdirSync(join(root, 'releases', 'current-release'));
  writeFileSync(join(retained, 'index.html'), '<h1>retained bytes</h1>');
  writeFileSync(join(retained, 'assets', 'κείμενο with space.bin'), Buffer.from([0, 255, 128, 10, 13, 0]));
  writeFileSync(join(retained, 'safe-file.txt'), 'not a command');
  writeFileSync(join(retained, 'empty.txt'), '');
  writeFileSync(join(root, 'releases', 'current-release', 'index.html'), 'currently served');
  symlinkSync('releases/current-release', join(root, 'current'));
  const index = join(root, 'publication-index.json');
  writeFileSync(index, '{"entries":["untouched retained evidence"]}\n');
  const knownHostsFile = join(temp, 'known_hosts');
  const logPath = join(temp, 'ssh.jsonl');
  writeFileSync(knownHostsFile, '# local fake SSH\n'); writeFileSync(logPath, '');
  const proof = { releaseId: 'retained', destinationId: 'stand', commit: 'a'.repeat(40), snapshotId: 'snapshot-retained', treeDigest: digest(files(retained)) };
  const requests = [];
  const config = { host: 'transport.test.invalid', user: 'deploy', root, destinationId: 'stand', knownHostsFile,
    sshCommand: [process.execPath, proxy, logPath, JSON.stringify(fault)],
    authorize: async (request) => { requests.push(structuredClone(request)); return { ...proof }; } };
  const events = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const commands = () => Buffer.concat(events().filter((event) => event.kind === 'client-bytes').map((event) => Buffer.from(event.data, 'base64'))).toString().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  t.after(() => {
    for (const event of events().filter((event) => event.kind === 'connection')) { try { process.kill(event.pid, 'SIGTERM'); } catch { /* complete */ } }
    rmSync(temp, { recursive: true, force: true });
  });
  return { temp, root, retained, index, proof, requests, config, events, commands,
    read: (session, releaseId = 'retained') => session.readRetained({ releaseId }),
    current: () => readlinkSync(join(root, 'current')) };
}
function untouched(f, before) {
  assert.deepEqual(files(join(f.root, 'releases')), before);
  assert.equal(f.current(), 'releases/current-release');
  assert.equal(readFileSync(f.index, 'utf8'), '{"entries":["untouched retained evidence"]}\n');
  assert.equal(existsSync(join(f.root, '.publication-pending.json')), false);
  assert.equal(existsSync(join(f.root, '.publication-preparation.json')), false);
}
function probeLock(root) {
  const result = spawnSync('/usr/bin/python3', ['-c', 'import fcntl,sys\nwith open(sys.argv[1], "rb") as lock:\n try: fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)\n except BlockingIOError: sys.exit(73)\n', join(root, '.publication.lock')], { timeout: 3000 });
  assert.equal(result.error, undefined); return result.status;
}

test('retained read copies actual binary files and metadata without changing the remote release or index', options, async (t) => {
  const f = fixture(t); const before = files(join(f.root, 'releases')); let local;
  await createSshTransport(f.config).withLock(async (session) => {
    const result = await f.read(session); local = result.treeDir;
    assert.equal(result.releaseId, 'retained'); assert.equal(result.destinationId, 'stand'); assert.equal(result.currentReleaseId, 'current-release');
    assert.ok(isAbsolute(local)); assert.ok(lstatSync(local).isDirectory()); assert.ok(!lstatSync(local).isSymbolicLink());
    assert.notEqual(realpathSync(local), realpathSync(f.retained));
    assert.ok(relative(realpathSync(f.root), realpathSync(local)).startsWith('..'), 'download must be local isolated temporary storage');
    assert.deepEqual(files(local), files(f.retained)); untouched(f, before);
    assert.equal(probeLock(f.root), 73, 'host lock remains held while caller checks downloaded files');
    assert.deepEqual(f.requests.map((request) => request.action), ['connect', 'read-retained']);
    assert.equal(f.requests[1].releaseId, 'retained'); assert.equal(f.requests[1].destinationId, 'stand');
  });
  assert.equal(existsSync(local), false, 'downloaded copy is removed when lock callback finishes');
  assert.equal(probeLock(f.root), 0); untouched(f, before);
  assert.equal(f.events().filter((event) => event.kind === 'connection').length, 1);
  assert.equal(f.commands().filter((command) => command.command === 'read-retained').length, 1);
  assert.equal(f.commands().filter((command) => command.command === 'stage').length, 0, 'reading retained bytes never uploads a second tree');
  const reads = f.commands().filter((command) => command.command === 'read-retained-file');
  assert.equal(new Set(reads.map(({ path, offset }) => JSON.stringify([path, offset]))).size, reads.length, 'no retained file chunk is transferred twice');
});

test('retained read and rollback share the same locked SSH session without staging bytes again', options, async (t) => {
  const f = fixture(t); let local; const recorded = [];
  const operation = { ...f.proof, publicationId: 'rollback-operation', rollbackOf: 'prior-publication' };
  await createSshTransport(f.config).withLock(async (session) => {
    const result = await f.read(session); local = result.treeDir;
    assert.equal(digest(files(local)), f.proof.treeDigest);
    await session.rollback({ releaseId: result.releaseId, expectedDigest: f.proof.treeDigest, operation,
      recordIndex: async (record) => { assert.equal(probeLock(f.root), 73); recorded.push(record); } });
    assert.equal(f.current(), 'releases/retained');
    assert.ok(existsSync(local));
  });
  assert.equal(existsSync(local), false); assert.deepEqual(recorded, [operation]);
  assert.equal(f.events().filter((event) => event.kind === 'connection').length, 1);
  assert.equal(f.commands().filter((command) => command.command === 'read-retained').length, 1);
  assert.equal(f.commands().filter((command) => command.command === 'stage').length, 0);
});

test('retained download is cleaned after a failed caller check and session cannot be reused', options, async (t) => {
  const f = fixture(t); let local; let escapedSession;
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    escapedSession = session; local = (await f.read(session)).treeDir;
    assert.ok(existsSync(local)); throw new Error('caller smoke failed');
  }), /caller smoke failed/);
  assert.equal(existsSync(local), false); assert.equal(probeLock(f.root), 0);
  await assert.rejects(async () => f.read(escapedSession), /lock|closed|session/i);
  assert.equal(f.events().filter((event) => event.kind === 'connection').length, 1);
});

test('retained scripts are copied as data and are never executed', options, async (t) => {
  const f = fixture(t); const marker = join(f.temp, 'executed');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;
  const control = spawnSync(process.execPath, ['-e', script]); assert.equal(control.status, 0); assert.ok(existsSync(marker)); rmSync(marker);
  writeFileSync(join(f.retained, 'publication-launcher.cjs'), script);
  writeFileSync(join(f.retained, 'package.json'), JSON.stringify({ scripts: { build: `node publication-launcher.cjs` } }));
  await createSshTransport(f.config).withLock(async (session) => {
    const result = await f.read(session);
    assert.ok(existsSync(join(result.treeDir, 'publication-launcher.cjs')), 'retained scripts must be present as data');
    assert.equal(readFileSync(join(result.treeDir, 'publication-launcher.cjs'), 'utf8'), script);
    assert.equal(existsSync(marker), false);
  });
  assert.equal(existsSync(marker), false);
});

for (const label of ['missing', 'pruned']) test(`retained read reports ${label} target as not retained`, options, async (t) => {
  const f = fixture(t); if (label === 'pruned') rmSync(f.retained, { recursive: true });
  const id = label === 'missing' ? 'missing' : 'retained'; f.config.authorize = async () => ({ ...f.proof, releaseId: id });
  await assert.rejects(createSshTransport(f.config).withLock((session) => f.read(session, id)), /not[- ]retained|retained.*(missing|absent|unavailable)/i);
  assert.equal(f.current(), 'releases/current-release');
});

for (const id of ['../retained', '/retained', '..', 'retained/child', 'retained\\child']) test(`retained read refuses invalid release ID ${JSON.stringify(id)}`, options, async (t) => {
  const f = fixture(t); const before = files(join(f.root, 'releases'));
  await assert.rejects(createSshTransport(f.config).withLock((session) => f.read(session, id)), /release|path|invalid/i);
  assert.equal(f.commands().filter((command) => command.command === 'read-retained').length, 0); untouched(f, before);
});

for (const kind of ['root symlink', 'file symlink', 'directory symlink', 'FIFO', 'backslash traversal']) test(`retained read refuses ${kind}`, options, async (t) => {
  const f = fixture(t);
  if (kind === 'root symlink') { rmSync(f.retained, { recursive: true }); symlinkSync(join(f.root, 'releases', 'current-release'), f.retained); }
  if (kind === 'file symlink') symlinkSync(f.index, join(f.retained, 'linked.json'));
  if (kind === 'directory symlink') symlinkSync(join(f.root, 'releases', 'current-release'), join(f.retained, 'linked-dir'));
  if (kind === 'FIFO') assert.equal(spawnSync('/usr/bin/mkfifo', [join(f.retained, 'fifo')]).status, 0);
  if (kind === 'backslash traversal') writeFileSync(join(f.retained, '..\\escape.txt'), 'escape');
  const before = files(join(f.root, 'releases'));
  await assert.rejects(createSshTransport(f.config).withLock((session) => f.read(session)), /symlink|symbolic|member|regular|path|invalid/i);
  untouched(f, before);
});

for (const binding of ['absent', 'different']) test(`retained read rejects ${binding} target binding in authorization before requesting bytes`, options, async (t) => {
  const f = fixture(t); const before = files(join(f.root, 'releases'));
  f.config.authorize = async (request) => {
    f.requests.push(structuredClone(request)); const proof = { ...f.proof };
    if (request.action === 'read-retained') { if (binding === 'absent') delete proof.releaseId; else proof.releaseId = 'different'; }
    return proof;
  };
  await assert.rejects(createSshTransport(f.config).withLock((session) => f.read(session)), /authoriz|release|binding|mismatch/i);
  assert.equal(f.requests.at(-1).action, 'read-retained'); assert.equal(f.requests.at(-1).releaseId, 'retained');
  assert.equal(f.commands().filter((command) => command.command === 'read-retained').length, 0); untouched(f, before);
});

for (const kind of ['absolute', 'traversal']) test(`malicious ${kind} download path cannot escape the local copy`, options, async (t) => {
  const f = fixture(t);
  const sentinel = join(f.temp, 'outside-download.txt');
  const target = kind === 'absolute' ? sentinel : '../'.repeat(32) + sentinel.slice(1);
  f.config.sshCommand[3] = JSON.stringify({ replace: { from: 'safe-file.txt', to: target } });
  await assert.rejects(createSshTransport(f.config).withLock((session) => f.read(session)), /path|escape|invalid|protocol/i);
  assert.ok(f.events().some((event) => event.kind === 'corrupted-download'), 'the actual download stream must contain the injected unsafe name');
  assert.equal(existsSync(sentinel), false);
  assert.equal(f.current(), 'releases/current-release');
});
