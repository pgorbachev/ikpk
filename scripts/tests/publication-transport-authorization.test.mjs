import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSshTransport } from '../publication-transport.mjs';

const options = { timeout: 15000 };
const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.mjs', import.meta.url));
function setup(t) {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-transport-auth-'));
  const root = join(temp, 'remote');
  const source = join(temp, 'source');
  mkdirSync(join(root, 'releases', 'old'), { recursive: true });
  mkdirSync(source);
  const body = Buffer.from('authorized bytes only');
  writeFileSync(join(source, 'index.html'), body);
  writeFileSync(join(root, 'releases', 'old', 'index.html'), 'old bytes');
  symlinkSync('releases/old', join(root, 'current'));
  const treeDigest = createHash('sha256').update('10:index.html').update(`${body.length}:`).update(body).digest('hex');
  const operation = {
    publicationId: 'authorized-operation', releaseId: 'new', destinationId: 'stand',
    commit: 'a'.repeat(40), snapshotId: 'authorized-snapshot', treeDigest,
  };
  const proof = { destinationId: operation.destinationId, treeDigest, commit: operation.commit, snapshotId: operation.snapshotId };
  const log = join(temp, 'ssh.jsonl');
  const knownHostsFile = join(temp, 'known_hosts');
  writeFileSync(log, '');
  writeFileSync(knownHostsFile, '# local fake SSH only\n');
  const requests = [];
  const config = {
    host: 'transport.test.invalid', user: 'deploy', root, destinationId: 'stand', knownHostsFile,
    sshCommand: [process.execPath, fakeSsh, log, '{}'],
    authorize: async (request) => { requests.push(structuredClone(request)); return { ...proof }; },
  };
  const connections = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  t.after(() => {
    for (const entry of connections().filter((entry) => entry.kind === 'connection')) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch { /* already exited */ }
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const pending = join(root, '.publication-pending.json');
  return {
    root, source, operation, proof, config, requests, pending, connections,
    current: () => readlinkSync(join(root, 'current')),
    stage: (session) => session.stage({ releaseId: 'new', sourceDir: source, expectedDigest: treeDigest }),
    seedPending() {
      cpSync(source, join(root, 'releases', 'new'), { recursive: true });
      unlinkSync(join(root, 'current'));
      symlinkSync('releases/new', join(root, 'current'));
      writeFileSync(pending, JSON.stringify(operation));
    },
  };
}
function untouched(f) {
  assert.equal(f.current(), 'releases/old');
  assert.deepEqual(readdirSync(join(f.root, 'releases')), ['old']);
  assert.equal(existsSync(f.pending), false);
}
async function denyConnect(f) {
  await assert.rejects(async () => createSshTransport(f.config).withLock((session) => f.stage(session)));
  assert.equal(f.connections().length, 0, 'authorization must precede the first SSH process');
  untouched(f);
}

test('missing or serialized authorization refuses withLock and recover before SSH', options, async (t) => {
  for (const value of [undefined, true, { approved: true }, 'approved']) {
    const f = setup(t);
    f.config.authorize = value;
    await denyConnect(f);
    f.seedPending();
    let records = 0;
    await assert.rejects(async () => createSshTransport(f.config).recover({ recordIndex: async () => { records++; } }));
    assert.equal(f.connections().length, 0);
    assert.equal(records, 0);
    assert.equal(existsSync(f.pending), true);
  }
});

test('false undefined empty and incomplete connect proofs fail closed', options, async (t) => {
  for (const proof of [false, undefined, {}, { destinationId: 'stand' }]) {
    const f = setup(t);
    f.config.authorize = async () => proof;
    await denyConnect(f);
  }
});

test('a throwing authorizer cannot open an SSH connection', options, async (t) => {
  const f = setup(t);
  f.config.authorize = async () => { throw new Error('CI or local report refused'); };
  await denyConnect(f);
});

test('a connect proof for another destination cannot open SSH', options, async (t) => {
  const f = setup(t);
  f.config.authorize = async () => ({ ...f.proof, destinationId: 'foreign' });
  await denyConnect(f);
});

test('fixed trusted proof authorizes connect and stage and reaches actual upload', options, async (t) => {
  const f = setup(t);
  await createSshTransport(f.config).withLock((session) => f.stage(session));
  assert.ok(f.connections().some((entry) => entry.kind === 'connection'));
  assert.deepEqual(readFileSync(join(f.root, 'releases', 'new', 'index.html')), readFileSync(join(f.source, 'index.html')));
  assert.deepEqual(f.requests.map((request) => request.action), ['connect', 'stage']);
  assert.equal(f.requests[0].destinationId, 'stand');
  assert.equal(f.requests[1].expectedDigest, f.proof.treeDigest);
  assert.equal(f.current(), 'releases/old');
});

test('stage rejects a mismatched digest proof before uploading release bytes', options, async (t) => {
  const f = setup(t);
  f.config.authorize = async (request) => {
    f.requests.push(request);
    return { ...f.proof, ...(request.action === 'stage' ? { treeDigest: '0'.repeat(64) } : {}) };
  };
  await assert.rejects(async () => createSshTransport(f.config).withLock((session) => f.stage(session)));
  assert.equal(f.requests.at(-1)?.action, 'stage');
  untouched(f);
});

test('activate checks every proof identity field against the complete operation', options, async (t) => {
  for (const [field, value] of [['destinationId', 'foreign'], ['treeDigest', '0'.repeat(64)], ['commit', 'b'.repeat(40)], ['snapshotId', 'foreign-snapshot']]) {
    const f = setup(t);
    let records = 0;
    f.config.authorize = async (request) => {
      f.requests.push(structuredClone(request));
      return { ...f.proof, ...(request.action === 'activate' ? { [field]: value } : {}) };
    };
    await assert.rejects(async () => createSshTransport(f.config).withLock(async (session) => {
      await f.stage(session);
      await session.activate({ releaseId: 'new', operation: f.operation, recordIndex: async () => { records++; } });
    }));
    assert.deepEqual(f.requests.at(-1)?.operation, f.operation);
    assert.equal(f.requests.at(-1)?.action, 'activate');
    assert.equal(f.current(), 'releases/old');
    assert.equal(existsSync(f.pending), false);
    assert.equal(records, 0);
  }
});

test('rollback requires authorization for its retained operation identity', options, async (t) => {
  const f = setup(t);
  cpSync(f.source, join(f.root, 'releases', 'new'), { recursive: true });
  let records = 0;
  f.config.authorize = async (request) => {
    f.requests.push(structuredClone(request));
    return { ...f.proof, ...(request.action === 'rollback' ? { commit: 'b'.repeat(40) } : {}) };
  };
  await assert.rejects(async () => createSshTransport(f.config).withLock((session) => session.rollback({
    releaseId: 'new', expectedDigest: f.proof.treeDigest, operation: f.operation,
    recordIndex: async () => { records++; },
  })));
  assert.equal(f.requests.at(-1)?.action, 'rollback');
  assert.deepEqual(f.requests.at(-1)?.operation, f.operation);
  assert.equal(f.current(), 'releases/old');
  assert.equal(existsSync(f.pending), false);
  assert.equal(records, 0);
});

test('recover verifies complete pending identity before indexing or clearing pending', options, async (t) => {
  const f = setup(t);
  f.seedPending();
  let records = 0;
  f.config.authorize = async (request) => {
    f.requests.push(structuredClone(request));
    return { ...f.proof, ...(request.action === 'recover' ? { snapshotId: 'wrong-snapshot' } : {}) };
  };
  await assert.rejects(async () => createSshTransport(f.config).recover({ recordIndex: async () => { records++; } }));
  assert.deepEqual(f.requests.map((request) => request.action), ['connect', 'recover']);
  assert.deepEqual(f.requests[1].operation, f.operation);
  assert.deepEqual(JSON.parse(readFileSync(f.pending, 'utf8')), f.operation);
  assert.equal(f.current(), 'releases/new');
  assert.equal(records, 0);
});

test('recover accepts a fixed original proof without consulting new main CMS or Actions', options, async (t) => {
  const f = setup(t);
  f.seedPending();
  const recorded = [];
  const result = await createSshTransport(f.config).recover({ recordIndex: async (operation) => { recorded.push(operation); } });
  assert.deepEqual(result, { recovered: true, operation: f.operation });
  assert.deepEqual(recorded, [f.operation]);
  assert.deepEqual(f.requests.map((request) => request.action), ['connect', 'recover']);
  assert.deepEqual(f.requests[1].operation, f.operation);
  assert.equal(existsSync(f.pending), false);
  assert.equal(f.current(), 'releases/new');
});
