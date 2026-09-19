import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSshTransport } from '../publication-transport.mjs';
import { createTestAuthorizer } from './fixtures/transport-authorization.mjs';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const newBody = 'VERIFIED-STATIC-PAYLOAD-0123456789-ABCDEFGHIJKLMNO';
const oldBody = 'previous verified release';
const options = { timeout: 15000 };

// Independent oracle for the public digest format agreed with the coordinator.
function digest(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(root, path));
    }
  }
  walk(root);
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    const bytes = readFileSync(join(root, path));
    hash.update(`${Buffer.byteLength(path)}:`).update(path).update(`${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

function setup(t, fault = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-transport-'));
  const root = join(temp, 'remote releases with spaces');
  const source = join(temp, 'source');
  const old = join(root, 'releases', 'old');
  mkdirSync(old, { recursive: true });
  mkdirSync(join(source, 'assets'), { recursive: true });
  writeFileSync(join(old, 'index.html'), oldBody);
  writeFileSync(join(source, 'index.html'), newBody);
  writeFileSync(join(source, 'assets', 'κείμενο with space.txt'), Buffer.from([0, 1, 128, 255, 10]));
  writeFileSync(join(source, 'release.json'), JSON.stringify({ commit: 'a'.repeat(40), snapshotId: 'snapshot-new' }));
  symlinkSync('releases/old', join(root, 'current'));
  const knownHostsFile = join(temp, 'known_hosts');
  writeFileSync(knownHostsFile, '# isolated fixture; never used by a real SSH process\n');
  const logPath = join(temp, 'ssh.jsonl');
  writeFileSync(logPath, '');
  const config = {
    host: 'transport.test.invalid', user: 'deploy', root, destinationId: 'stand', knownHostsFile,
    sshCommand: [process.execPath, join(fixtureDir, 'fake-ssh.mjs'), logPath, JSON.stringify(fault)],
  };
  const operation = {
    publicationId: 'operation-new', releaseId: 'new', destinationId: 'stand',
    commit: 'a'.repeat(40), snapshotId: 'snapshot-new', treeDigest: digest(source),
  };
  config.authorize = createTestAuthorizer(operation);
  const transport = createSshTransport(config);
  const pendingPath = join(root, '.publication-pending.json');
  const connections = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  t.after(() => {
    for (const entry of connections().filter((entry) => entry.kind === 'connection')) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch { /* The fake SSH already finished. */ }
    }
    rmSync(temp, { recursive: true, force: true });
  });
  return {
    root, source, old, config, operation, transport, pendingPath, connections,
    active: () => basename(realpathSync(join(root, 'current'))),
    stage: (session, overrides = {}) => session.stage({ releaseId: 'new', sourceDir: source, expectedDigest: operation.treeDigest, ...overrides }),
    activate: (session, recordIndex = async () => {}, overrides = {}) => session.activate({ releaseId: 'new', operation, recordIndex, ...overrides }),
  };
}

function seedPending(f, overrides = {}) {
  cpSync(f.source, join(f.root, 'releases', 'new'), { recursive: true });
  unlinkSync(join(f.root, 'current'));
  symlinkSync('releases/new', join(f.root, 'current'));
  const operation = { ...f.operation, ...overrides };
  writeFileSync(f.pendingPath, JSON.stringify(operation));
  return operation;
}

function client(t, config) {
  const child = fork(join(fixtureDir, 'transport-lock-client.mjs'), [JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('message', (message) => messages.push(message));
  t.after(() => {
    // The worker may disconnect after its released message but before cleanup.
    // Supplying a callback handles that asynchronous closed-channel/EPIPE result.
    if (child.connected) child.send({ release: true }, () => {});
    child.kill();
  });
  return {
    child, messages,
    async until(state) {
      for (let i = 0; i < 1000; i++) {
        const error = messages.find((message) => message.state === 'error');
        assert.equal(error, undefined, error?.message);
        if (messages.some((message) => message.state === state)) return;
        assert.equal(child.exitCode, null, `worker exited before ${state}: ${stderr}`);
        await delay(5);
      }
      assert.fail(`worker did not reach ${state}: ${stderr}`);
    },
  };
}

test('stage transfers exact bytes to a separate release without changing current', options, async (t) => {
  const f = setup(t);
  await f.transport.withLock(async (session) => {
    await f.stage(session);
    assert.equal(f.active(), 'old');
    assert.ok(existsSync(join(f.root, 'releases', 'new')), 'stage must create the uploaded release');
    assert.equal(digest(join(f.root, 'releases', 'new')), f.operation.treeDigest);
    assert.ok(f.connections().length > 0, 'the transfer must use the SSH boundary');
  });
});

test('a wrong declared digest refuses the release before activation', options, async (t) => {
  const f = setup(t);
  await assert.rejects(f.transport.withLock((session) => f.stage(session, { expectedDigest: '0'.repeat(64) })), /digest|checksum|mismatch/i);
  assert.equal(f.active(), 'old');
});

test('corruption on the upload channel is detected by the remote digest', options, async (t) => {
  const f = setup(t, { tamper: { from: newBody, to: newBody.replace('VERIFIED', 'CORRUPTD') } });
  await assert.rejects(f.transport.withLock((session) => f.stage(session)), /digest|checksum|mismatch/i);
  assert.ok(f.connections().some((entry) => entry.kind === 'corrupted-upload'), 'fault must actually alter uploaded bytes');
  assert.equal(f.active(), 'old');
  assert.equal(existsSync(f.pendingPath), false);
});

test('symbolic links cannot escape the checked upload tree', options, async (t) => {
  const f = setup(t);
  symlinkSync(join(f.old, 'index.html'), join(f.source, 'borrowed.html'));
  await assert.rejects(f.transport.withLock((session) => f.stage(session)), /symlink|symbolic/i);
  assert.equal(f.active(), 'old');
});

test('an empty upload cannot satisfy a digest comparison vacuously', options, async (t) => {
  const f = setup(t);
  rmSync(f.source, { recursive: true });
  mkdirSync(f.source);
  await assert.rejects(f.transport.withLock((session) => f.stage(session, { expectedDigest: digest(f.source) })), /empty/i);
  assert.equal(f.active(), 'old');
});

test('release IDs cannot overwrite a retained release', options, async (t) => {
  const f = setup(t);
  await assert.rejects(f.transport.withLock((session) => f.stage(session, { releaseId: 'old' })), /exist|collision|retained/i);
  assert.equal(readFileSync(join(f.old, 'index.html'), 'utf8'), oldBody);
});

test('release IDs cannot traverse outside the releases directory', options, async (t) => {
  const f = setup(t);
  await assert.rejects(f.transport.withLock((session) => f.stage(session, { releaseId: '../../escaped' })), /release|path|invalid/i);
  assert.equal(f.active(), 'old');
});

test('activation atomically points current at the staged tree and retains the old tree', options, async (t) => {
  const f = setup(t);
  const recorded = [];
  await f.transport.withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, async (operation) => { recorded.push(operation); });
  });
  assert.equal(f.active(), 'new');
  assert.equal(readFileSync(join(f.root, 'current', 'index.html'), 'utf8'), newBody);
  assert.equal(readFileSync(join(f.old, 'index.html'), 'utf8'), oldBody);
  assert.deepEqual(recorded, [f.operation]);
  assert.equal(existsSync(f.pendingPath), false);
});

test('concurrent readers never see a missing current or partial document during activation', options, async (t) => {
  const f = setup(t);
  const observations = [];
  const timer = setInterval(() => {
    try { observations.push(readFileSync(join(f.root, 'current', 'index.html'), 'utf8')); }
    catch (error) { observations.push(error.code); }
  }, 1);
  try {
    await delay(10);
    await f.transport.withLock(async (session) => { await f.stage(session); await f.activate(session); });
    await delay(10);
  } finally { clearInterval(timer); }
  assert.ok(observations.includes(oldBody), 'reader must observe the old release');
  assert.ok(observations.includes(newBody), 'reader must observe the new release');
  assert.ok(observations.every((value) => value === oldBody || value === newBody), JSON.stringify(observations));
});

test('pending is persisted before current changes and remains visible to the index writer', options, async (t) => {
  const f = setup(t);
  const events = [];
  await f.transport.withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, async (operation) => {
      events.push('index');
      assert.deepEqual(JSON.parse(readFileSync(f.pendingPath, 'utf8')), operation);
      assert.equal(f.active(), 'new');
    }, {
      beforeActivate: async () => {
        events.push('before-activation');
        assert.deepEqual(JSON.parse(readFileSync(f.pendingPath, 'utf8')), f.operation);
        assert.equal(f.active(), 'old');
      },
    });
  });
  assert.deepEqual(events, ['before-activation', 'index']);
});

test('an index write failure rejects activation while leaving active release and pending identifiable', options, async (t) => {
  const f = setup(t);
  await assert.rejects(f.transport.withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, async () => { throw new Error('index unavailable'); });
  }), /index unavailable/);
  assert.equal(f.active(), 'new');
  assert.deepEqual(JSON.parse(readFileSync(f.pendingPath, 'utf8')), f.operation);
});

for (const action of ['stage', 'activate', 'rollback']) {
  test(`an unfinished operation blocks ${action} without changing current`, options, async (t) => {
    const f = setup(t);
    seedPending(f);
    await assert.rejects(f.transport.withLock(async (session) => {
      if (action === 'stage') return f.stage(session, { releaseId: 'next' });
      if (action === 'activate') return f.activate(session);
      return session.rollback({ releaseId: 'old', expectedDigest: digest(f.old), operation: { ...f.operation, releaseId: 'old' }, recordIndex: async () => {} });
    }), /pending|unfinished|unresolved/i);
    assert.equal(f.active(), 'new');
    assert.deepEqual(JSON.parse(readFileSync(f.pendingPath, 'utf8')), f.operation);
  });
}

test('recovery records the same operation once, clears pending and is idempotent', options, async (t) => {
  const f = setup(t);
  seedPending(f);
  const recorded = [];
  const recordIndex = async (operation) => { recorded.push(operation); };
  assert.deepEqual(await f.transport.recover({ recordIndex }), { recovered: true, operation: f.operation });
  assert.deepEqual(await f.transport.recover({ recordIndex }), { recovered: false });
  assert.deepEqual(recorded, [f.operation]);
  assert.equal(existsSync(f.pendingPath), false);
  assert.equal(f.active(), 'new');
});

test('failed recovery keeps pending and can be retried with the identical publication ID', options, async (t) => {
  const f = setup(t);
  seedPending(f);
  await assert.rejects(f.transport.recover({ recordIndex: async () => { throw new Error('index still unavailable'); } }), /index still unavailable/);
  assert.deepEqual(JSON.parse(readFileSync(f.pendingPath, 'utf8')), f.operation);
  let recorded;
  await f.transport.recover({ recordIndex: async (operation) => { recorded = operation; } });
  assert.deepEqual(recorded, f.operation);
});

test('recovery refuses when actual current is not the pending release', options, async (t) => {
  const f = setup(t);
  seedPending(f);
  unlinkSync(join(f.root, 'current'));
  symlinkSync('releases/old', join(f.root, 'current'));
  let writes = 0;
  await assert.rejects(f.transport.recover({ recordIndex: async () => { writes++; } }), /current|release|mismatch/i);
  assert.equal(writes, 0);
  assert.equal(f.active(), 'old');
  assert.equal(existsSync(f.pendingPath), true);
});

test('recovery refuses a changed active tree before writing the index', options, async (t) => {
  const f = setup(t);
  seedPending(f);
  writeFileSync(join(f.root, 'current', 'index.html'), 'tampered after switch');
  let writes = 0;
  await assert.rejects(f.transport.recover({ recordIndex: async () => { writes++; } }), /digest|checksum|mismatch/i);
  assert.equal(writes, 0);
  assert.equal(existsSync(f.pendingPath), true);
});

test('activation refuses an operation bound to another destination', options, async (t) => {
  const f = setup(t);
  await assert.rejects(f.transport.withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, async () => {}, { operation: { ...f.operation, destinationId: 'production' } });
  }), /destination|назначен/i);
  assert.equal(f.active(), 'old');
});

// Probe the documented host-lock path independently of the transport protocol.
// Nonblocking acquisition gives a deterministic witness after the owner entered.
function hostLockState(root) {
  const program = `import fcntl,sys
with open(sys.argv[1], 'a+') as lock:
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        print('available')
    except BlockingIOError:
        print('held')
`;
  const result = spawnSync('/usr/bin/python3', ['-c', program, join(root, '.publication.lock')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('two separate operator processes cannot hold the host publication lock together', options, async (t) => {
  const f = setup(t);
  const first = client(t, f.config);
  await first.until('entered');
  assert.equal(hostLockState(f.root), 'held', 'callback must hold the actual host OS lock');
  const second = client(t, f.config);
  await second.until('requesting');
  for (let i = 0; i < 1000; i++) {
    if (f.connections().filter((entry) => entry.kind === 'connection').length >= 2 || second.messages.some((message) => message.state === 'entered')) break;
    await delay(5);
  }
  assert.equal(second.messages.some((message) => message.state === 'entered'), false, 'second operator entered while first still holds the host lock');
  assert.ok(f.connections().filter((entry) => entry.kind === 'connection').length >= 2, 'both operators must actually connect');
  first.child.send({ release: true });
  await first.until('released');
  await second.until('entered');
  assert.equal(hostLockState(f.root), 'held', 'the next owner must hold the same OS lock');
  second.child.send({ release: true });
  await second.until('released');
  assert.equal(hostLockState(f.root), 'available', 'positive control: released host lock can be acquired');
});

test('a throwing lock owner releases the host lock for a different process', options, async (t) => {
  const f = setup(t);
  await assert.rejects(f.transport.withLock(async () => { throw new Error('operator aborted'); }), /operator aborted/);
  const next = client(t, f.config);
  await next.until('entered');
  assert.ok(f.connections().filter((entry) => entry.kind === 'connection').length >= 2);
  next.child.send({ release: true });
  await next.until('released');
});

test('retained rollback switches checked bytes without executing scripts in the old release', options, async (t) => {
  const f = setup(t);
  const marker = join(f.root, 'executed-release-code');
  writeFileSync(join(f.old, 'deploy.sh'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  writeFileSync(join(f.old, 'package.json'), JSON.stringify({ scripts: { build: `touch '${marker}'`, deploy: `touch '${marker}'` } }));
  cpSync(f.source, join(f.root, 'releases', 'new'), { recursive: true });
  unlinkSync(join(f.root, 'current'));
  symlinkSync('releases/new', join(f.root, 'current'));
  const operation = { ...f.operation, publicationId: 'rollback-1', releaseId: 'old', treeDigest: digest(f.old) };
  const recorded = [];
  await f.transport.withLock((session) => session.rollback({ releaseId: 'old', expectedDigest: operation.treeDigest, operation, recordIndex: async (op) => { recorded.push(op); } }));
  assert.equal(f.active(), 'old');
  assert.deepEqual(recorded, [operation]);
  assert.equal(existsSync(marker), false);
});

test('rollback refuses retained bytes whose digest differs from their verification record', options, async (t) => {
  const f = setup(t);
  const expectedDigest = digest(f.old);
  writeFileSync(join(f.old, 'index.html'), 'modified retained release');
  await assert.rejects(f.transport.withLock((session) => session.rollback({ releaseId: 'old', expectedDigest, operation: { ...f.operation, releaseId: 'old', treeDigest: expectedDigest }, recordIndex: async () => {} })), /digest|checksum|mismatch/i);
});

test('rollback refuses a release outside the retained history', options, async (t) => {
  const f = setup(t);
  await assert.rejects(f.transport.withLock((session) => session.rollback({ releaseId: 'pruned', expectedDigest: 'f'.repeat(64), operation: { ...f.operation, releaseId: 'pruned' }, recordIndex: async () => {} })), /missing|absent|exist|retained|release/i);
  assert.equal(f.active(), 'old');
});

test('recovery cannot commit a pending operation belonging to another destination', options, async (t) => {
  const f = setup(t);
  seedPending(f, { destinationId: 'production' });
  let writes = 0;
  await assert.rejects(f.transport.recover({ recordIndex: async () => { writes++; } }), /destination|назначен/i);
  assert.equal(writes, 0);
  assert.equal(existsSync(f.pendingPath), true);
});

test('beforeActivate observes prepared pending and the previous current immediately before the switch', options, async (t) => {
  const f = setup(t);
  let calls = 0;
  await f.transport.withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, async () => {}, {
      beforeActivate: async () => {
        calls++;
        assert.equal(f.active(), 'old');
        assert.deepEqual(JSON.parse(readFileSync(f.pendingPath, 'utf8')), f.operation);
        assert.equal(digest(join(f.root, 'releases', 'new')), f.operation.treeDigest);
      },
    });
  });
  assert.equal(calls, 1, 'final CMS/main check must actually execute');
  assert.equal(f.active(), 'new');
});

test('a refusing beforeActivate leaves current unchanged and removes its uncommitted pending marker', options, async (t) => {
  const f = setup(t);
  let calls = 0;
  await assert.rejects(f.transport.withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, async () => { assert.fail('index cannot be written before activation'); }, {
      beforeActivate: async () => {
        calls++;
        assert.equal(f.active(), 'old');
        assert.equal(existsSync(f.pendingPath), true);
        throw new Error('CMS journal advanced before activation');
      },
    });
  }), /CMS journal advanced/);
  assert.equal(calls, 1);
  assert.equal(f.active(), 'old');
  assert.equal(existsSync(f.pendingPath), false);
});

test('a wrong activation digest refuses before invoking beforeActivate', options, async (t) => {
  const f = setup(t);
  let calls = 0;
  await assert.rejects(f.transport.withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, async () => {}, {
      operation: { ...f.operation, treeDigest: '0'.repeat(64) },
      beforeActivate: async () => { calls++; },
    });
  }), /digest|checksum|mismatch/i);
  assert.equal(calls, 0);
  assert.equal(f.active(), 'old');
});

test('REVIEW: recovery cancels a durably prepared operation after SSH loss before switching current', options, async (t) => {
  const f = setup(t);
  let prepared = false;
  let writes = 0;
  await assert.rejects(f.transport.withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, async () => { writes++; }, {
      beforeActivate: async () => {
        assert.equal(f.active(), 'old');
        assert.equal(existsSync(f.pendingPath), true);
        prepared = true;
        // Kill the SSH process after prepare's durable reply, before activate is sent.
        const pid = f.connections().filter((entry) => entry.kind === 'connection').at(-1).pid;
        process.kill(pid, 'SIGTERM');
        for (let attempt = 0; attempt < 1000; attempt++) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') return; throw error; }
          await delay(5);
        }
        assert.fail('the injected SSH loss did not terminate its process');
      },
    });
  }), /SSH|session|stream|closed/i);
  assert.equal(prepared, true, 'the crash must occur after durable preparation');
  assert.equal(f.active(), 'old');
  assert.equal(existsSync(f.pendingPath), true);
  assert.equal(writes, 0);

  await f.transport.recover({ recordIndex: async () => { writes++; } });
  assert.equal(f.active(), 'old', 'recovery must not switch an uncommitted publication');
  assert.equal(writes, 0, 'an unactivated pair must not enter publication history');
  assert.equal(existsSync(f.pendingPath), false, 'recoverable preparation must not block future publications');
  await f.transport.withLock((session) => f.stage(session, { releaseId: 'after-recovery' }));
});

test('REVIEW: prepared crash recovery refuses when current changed to another retained release', options, async (t) => {
  const f = setup(t);
  let prepared = false;
  let writes = 0;
  await assert.rejects(f.transport.withLock(async (session) => {
    await f.stage(session);
    await f.activate(session, async () => { writes++; }, {
      beforeActivate: async () => {
        assert.equal(f.active(), 'old');
        assert.equal(existsSync(f.pendingPath), true);
        prepared = true;
        const pid = f.connections().filter((entry) => entry.kind === 'connection').at(-1).pid;
        process.kill(pid, 'SIGTERM');
        for (let attempt = 0; attempt < 1000; attempt++) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') return; throw error; }
          await delay(5);
        }
        assert.fail('the injected SSH loss did not terminate its process');
      },
    });
  }), /SSH|session|stream|closed/i);
  assert.equal(prepared, true, 'the crash must occur after durable preparation');
  assert.equal(f.active(), 'old');
  const pendingBefore = readFileSync(f.pendingPath, 'utf8');
  cpSync(f.old, join(f.root, 'releases', 'third'), { recursive: true });
  unlinkSync(join(f.root, 'current'));
  symlinkSync('releases/third', join(f.root, 'current'));
  assert.equal(f.active(), 'third', 'the mutation must actually change current');

  await assert.rejects(f.transport.recover({ recordIndex: async () => { writes++; } }), /current|release|mismatch|changed/i);
  assert.equal(f.active(), 'third', 'refused recovery must not switch current');
  assert.equal(writes, 0, 'refused recovery must not write publication history');
  assert.equal(readFileSync(f.pendingPath, 'utf8'), pendingBefore, 'refused recovery must retain the exact pending operation');
  await assert.rejects(f.transport.withLock((session) => f.stage(session, { releaseId: 'after-refusal' })), /pending|unfinished|unresolved/i);
  assert.equal(f.active(), 'third');
});
