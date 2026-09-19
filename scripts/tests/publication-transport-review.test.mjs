import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSshTransport } from '../publication-transport.mjs';

const options = { timeout: 15000 };
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-transport-independent-'));
  const root = join(temp, 'host'); const source = join(temp, 'source');
  mkdirSync(join(root, 'releases', 'old'), { recursive: true }); mkdirSync(source);
  writeFileSync(join(root, 'releases', 'old', 'index.html'), 'old');
  const bytes = Buffer.from('verified new release'); writeFileSync(join(source, 'index.html'), bytes);
  symlinkSync('releases/old', join(root, 'current'));
  const digest = createHash('sha256').update(`10:index.html${bytes.length}:`).update(bytes).digest('hex');
  const operation = { publicationId: 'operation-1', releaseId: 'new', destinationId: 'stand',
    commit: 'a'.repeat(40), snapshotId: 'snapshot-1', treeDigest: digest, actor: 'operator' };
  const proof = { destinationId: 'stand', commit: operation.commit, snapshotId: operation.snapshotId, treeDigest: digest };
  const log = join(temp, 'ssh.jsonl'); const knownHostsFile = join(temp, 'known_hosts');
  writeFileSync(log, ''); writeFileSync(knownHostsFile, '# no real SSH\n');
  const config = { host: 'transport.test.invalid', user: 'deploy', root, destinationId: 'stand', knownHostsFile,
    sshCommand: [process.execPath, fileURLToPath(new URL('./fixtures/fake-ssh.mjs', import.meta.url)), log, '{}'],
    authorize: async () => ({ ...proof }) };
  t.after(() => {
    for (const line of readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.kind === 'connection') { try { process.kill(entry.pid, 'SIGTERM'); } catch { /* completed */ } }
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const pending = join(root, '.publication-pending.json'); const sidecar = join(root, '.publication-preparation.json');
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
  function currentIdentity() {
    const info = lstatSync(join(root, 'current'), { bigint: true });
    // The filesystem fixture uses small inode/device numbers exactly representable in JSON.
    return { target: readlinkSync(join(root, 'current')), device: Number(info.dev), inode: Number(info.ino), ctimeNs: Number(info.ctimeNs) };
  }
  function seed(phase, active = false) {
    cpSync(source, join(root, 'releases', 'new'), { recursive: true });
    const previousCurrent = currentIdentity();
    if (active) { unlinkSync(join(root, 'current')); symlinkSync('releases/new', join(root, 'current')); }
    writeJson(pending, operation); writeJson(sidecar, { operation, previousCurrent, phase });
  }
  return { root, source, operation, proof, config, pending, sidecar, json, writeJson, seed,
    current: () => readlinkSync(join(root, 'current')),
    stage: (session) => session.stage({ releaseId: 'new', sourceDir: source, expectedDigest: digest }),
    activate: (session, extras = {}) => session.activate({ releaseId: 'new', operation, recordIndex: async () => {}, ...extras }) };
}

test('REVIEW: committing intent with old current remains blocked and preserves both recovery records', options, async (t) => {
  const f = fixture(t); f.seed('committing'); const pending = readFileSync(f.pending); const sidecar = readFileSync(f.sidecar);
  let writes = 0;
  await assert.rejects(createSshTransport(f.config).recover({ recordIndex: async () => { writes++; } }), /current.*mismatch/);
  assert.equal(writes, 0); assert.equal(f.current(), 'releases/old');
  assert.deepEqual(readFileSync(f.pending), pending); assert.deepEqual(readFileSync(f.sidecar), sidecar);
});

test('REVIEW: same publication ID cannot hide a different complete sidecar operation', options, async (t) => {
  const f = fixture(t); f.seed('committing', true);
  const other = { ...f.operation, actor: 'different-operator' };
  const metadata = f.json(f.sidecar); metadata.operation = other; f.writeJson(f.sidecar, metadata);
  let writes = 0;
  await assert.rejects(createSshTransport(f.config).recover({ recordIndex: async () => { writes++; } }), /operation.*mismatch/);
  assert.equal(writes, 0); assert.equal(existsSync(f.pending), true); assert.equal(existsSync(f.sidecar), true);
});

test('REVIEW: completed committing phase has a positive recovery path with the original complete operation', options, async (t) => {
  const f = fixture(t); f.seed('committing', true); const recorded = [];
  const result = await createSshTransport(f.config).recover({ recordIndex: async (operation) => { recorded.push(operation); } });
  assert.deepEqual(result, { recovered: true, operation: f.operation }); assert.deepEqual(recorded, [f.operation]);
  assert.equal(f.current(), 'releases/new'); assert.equal(existsSync(f.pending), false); assert.equal(existsSync(f.sidecar), false);
});

test('REVIEW: activation must refuse a pending operation changed after durable preparation', options, async (t) => {
  const f = fixture(t); let writes = 0;
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, { beforeActivate: async () => {
      assert.equal(f.current(), 'releases/old');
      f.writeJson(f.pending, { ...f.operation, commit: 'b'.repeat(40) });
    }, recordIndex: async () => { writes++; } });
  }), /operation|pending|identity|mismatch/);
  assert.equal(writes, 0); assert.equal(f.current(), 'releases/old');
  assert.equal(existsSync(f.pending), true); assert.equal(existsSync(f.sidecar), true);
});

test('REVIEW: finish cannot clear a different pending identity after recording the authorized operation', options, async (t) => {
  const f = fixture(t); const recorded = [];
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, { recordIndex: async (operation) => {
      recorded.push(operation);
      f.writeJson(f.pending, { ...operation, snapshotId: 'unrecorded-snapshot' });
    } });
  }), /operation|pending|identity|mismatch/);
  assert.deepEqual(recorded, [f.operation]); assert.equal(f.current(), 'releases/new');
  assert.equal(existsSync(f.pending), true, 'unrecorded identity must continue to block publication');
});

test('REVIEW: prepared cancellation remains bound to the operation already authorized by recover', options, async (t) => {
  const f = fixture(t);
  // Obtain the actual Python ctime identity through a completed prepare and failed final check.
  // Recreate the preparation before cancellation from the authoritative sidecar bytes.
  let saved;
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, { beforeActivate: async () => { saved = readFileSync(f.sidecar, 'utf8'); throw new Error('stop before switch'); } });
  }), /stop before switch/);
  f.writeJson(f.pending, f.operation); writeFileSync(f.sidecar, saved);
  let recoverAuthorized = false;
  f.config.authorize = async (request) => {
    if (request.action === 'recover') {
      recoverAuthorized = true;
      assert.deepEqual(request.operation, f.operation);
      const replacement = { ...f.operation, snapshotId: 'other-pending-snapshot' };
      f.writeJson(f.pending, replacement);
      writeFileSync(f.sidecar, saved.replace('\"snapshot-1\"', '\"other-pending-snapshot\"'));
    }
    return { ...f.proof };
  };
  await assert.rejects(createSshTransport(f.config).recover({ recordIndex: async () => { assert.fail('prepared operation cannot be indexed'); } }), /operation|pending|identity|mismatch/);
  assert.equal(recoverAuthorized, true); assert.equal(f.current(), 'releases/old');
  assert.equal(existsSync(f.pending), true); assert.equal(existsSync(f.sidecar), true);
});
