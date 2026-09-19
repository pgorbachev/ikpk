import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSshTransport } from '../publication-transport.mjs';
import { createTestAuthorizer } from './fixtures/transport-authorization.mjs';

const options = { timeout: 15000 };
const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.mjs', import.meta.url));
// Intentionally neither lexicographic nor reverse-lexicographic chronological order.
const chronology = ['z-oldest', 'b-second', 'x-third', 'a-fourth', 'm-fifth', 'c-sixth', 'y-seventh', 'd-eighth'];
const body = 'independently verified retained static bytes';
const digest = createHash('sha256').update(`10:index.html${Buffer.byteLength(body)}:`).update(body).digest('hex');
function probeLock(root) {
  const result = spawnSync('/usr/bin/python3', ['-c', 'import fcntl,sys\nwith open(sys.argv[1], "rb") as lock:\n try: fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)\n except BlockingIOError: sys.exit(73)\n', join(root, '.publication.lock')], { timeout: 3000 });
  assert.equal(result.error, undefined); return result.status;
}
function fixture(t, { count = 7, keepReleases = 5, omitLimit = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-retention-'));
  const root = join(temp, 'remote'); const releases = join(root, 'releases'); const source = join(temp, 'source');
  mkdirSync(releases, { recursive: true }); mkdirSync(source); writeFileSync(join(source, 'index.html'), body);
  const ids = chronology.slice(0, count);
  const identity = (releaseId) => ({ publicationId: `publication-${releaseId}`, releaseId, destinationId: 'stand',
    commit: 'a'.repeat(40), snapshotId: `snapshot-${releaseId}`, treeDigest: digest });
  for (const [index, id] of ids.entries()) {
    const dir = join(releases, id); mkdirSync(dir); writeFileSync(join(dir, 'index.html'), body);
    const age = new Date(Date.UTC(2020, 0, index + 1)); utimesSync(dir, age, age);
  }
  symlinkSync(`releases/${ids.at(-1)}`, join(root, 'current'));
  const history = ids.map(identity); const indexPath = join(root, 'publication-index.json');
  writeFileSync(indexPath, JSON.stringify(history));
  const knownHostsFile = join(temp, 'known_hosts'); writeFileSync(knownHostsFile, '# local fake SSH only\n');
  const log = join(temp, 'ssh.jsonl'); writeFileSync(log, '');
  const operation = identity('new-release');
  const config = { host: 'transport.test.invalid', user: 'deploy', root, destinationId: 'stand', knownHostsFile,
    ...(omitLimit ? {} : { keepReleases }), sshCommand: [process.execPath, fakeSsh, log, '{}'],
    authorize: createTestAuthorizer(operation) };
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  t.after(() => {
    for (const event of events().filter(({ kind }) => kind === 'connection')) { try { process.kill(event.pid, 'SIGTERM'); } catch { /* already exited */ } }
    for (const id of readdirSync(releases)) { try { chmodSync(join(releases, id), 0o700); } catch { /* already removed */ } }
    rmSync(temp, { recursive: true, force: true });
  });
  const index = () => JSON.parse(readFileSync(indexPath, 'utf8'));
  const recordIndex = async (record) => {
    assert.equal(probeLock(root), 73, 'host flock must include the durable index acknowledgement');
    writeFileSync(indexPath, JSON.stringify([...index(), record]));
  };
  return { root, releases, source, ids, history, config, operation, identity, index, recordIndex, events,
    list: () => readdirSync(releases).sort(), active: () => readlinkSync(join(root, 'current')),
    stage: (session) => session.stage({ releaseId: operation.releaseId, sourceDir: source, expectedDigest: digest }),
    activate: (session, callback = recordIndex, overrides = {}) => session.activate({ releaseId: operation.releaseId, operation, recordIndex: callback, ...overrides }) };
}

for (const scenario of [{ keep: 5, count: 7 }, { keep: 7, count: 8 }, { keep: 5, count: 7, omitted: true }]) {
  test(`retention keeps ${scenario.keep} total releases after acknowledged activation${scenario.omitted ? ' by default' : ''}`, options, async (t) => {
    const f = fixture(t, { keepReleases: scenario.keep, count: scenario.count, omitLimit: scenario.omitted });
    await createSshTransport(f.config).withLock(async (session) => {
      await f.stage(session);
      const before = [...f.ids, f.operation.releaseId].sort(); assert.deepEqual(f.list(), before, 'upload alone must not prune');
      await f.activate(session, async (record) => {
        assert.deepEqual(f.list(), before, 'activation must preserve all trees until index acknowledgement');
        assert.equal(f.active(), 'releases/new-release'); await f.recordIndex(record);
      });
      assert.deepEqual(f.list(), [...f.ids.slice(-(scenario.keep - 1)), f.operation.releaseId].sort(), 'remove only oldest excess directories, including current in the configured count');
      assert.deepEqual(f.index(), [...f.history, f.operation], 'pruning must preserve historical index records');
      assert.equal(probeLock(f.root), 73, 'the same host lock remains held through completed retention');
    });
    assert.equal(probeLock(f.root), 0); assert.equal(f.events().filter(({ kind }) => kind === 'connection').length, 1);
  });
}

test('retention positive control leaves all releases when below the configured limit', options, async (t) => {
  const f = fixture(t, { count: 3 });
  await createSshTransport(f.config).withLock(async (session) => { await f.stage(session); await f.activate(session); });
  assert.deepEqual(f.list(), [...f.ids, f.operation.releaseId].sort()); assert.deepEqual(f.index(), [...f.history, f.operation]);
  assert.equal(f.active(), 'releases/new-release');
});

test('retention preserves current, pending release and every prior tree when index acknowledgement fails', options, async (t) => {
  const f = fixture(t);
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    await f.stage(session); await f.activate(session, async () => { throw new Error('index write refused'); });
  }), (error) => { assert.match(error.message, /index write refused/); assert.deepEqual(error.activeOperation, f.operation); return true; });
  assert.deepEqual(f.list(), [...f.ids, f.operation.releaseId].sort()); assert.deepEqual(f.index(), f.history);
  assert.equal(f.active(), 'releases/new-release');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.publication-pending.json'), 'utf8')), f.operation);
});

test('retention recovery prunes only after the missing publication index entry is acknowledged', options, async (t) => {
  const f = fixture(t);
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    await f.stage(session); await f.activate(session, async () => { throw new Error('index temporarily offline'); });
  }), /index temporarily offline/);
  const result = await createSshTransport(f.config).recover({ recordIndex: async (record) => {
    assert.deepEqual(f.list(), [...f.ids, f.operation.releaseId].sort()); await f.recordIndex(record);
  } });
  assert.equal(result.recovered, true);
  assert.deepEqual(f.list(), [...f.ids.slice(-4), f.operation.releaseId].sort());
  assert.deepEqual(f.index(), [...f.history, f.operation]); assert.equal(f.active(), 'releases/new-release');
  assert.equal(existsSync(join(f.root, '.publication-pending.json')), false);
});

test('retention after rollback preserves the oldest active target and the newest previous releases', options, async (t) => {
  const f = fixture(t);
  const target = f.ids[0]; const operation = { ...f.identity(target), publicationId: 'rollback-oldest', rollbackOf: f.history[0].publicationId };
  await createSshTransport(f.config).withLock(async (session) => {
    await session.rollback({ releaseId: target, expectedDigest: digest, operation, recordIndex: async (record) => {
      assert.deepEqual(f.list(), [...f.ids].sort()); await f.recordIndex(record);
    } });
    assert.deepEqual(f.list(), [target, ...f.ids.slice(-4)].sort());
    assert.equal(f.active(), `releases/${target}`); assert.equal(readFileSync(join(f.releases, target, 'index.html'), 'utf8'), body);
    assert.ok(existsSync(join(f.releases, f.ids.at(-1))), 'the previous active release remains a valid rollback target');
    assert.deepEqual(f.index(), [...f.history, operation]); assert.equal(probeLock(f.root), 73);
  });
});

test('retention never prunes when the final source check refuses activation', options, async (t) => {
  const f = fixture(t);
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    await f.stage(session); await f.activate(session, f.recordIndex, { beforeActivate: async () => { throw new Error('main moved'); } });
  }), /main moved/);
  assert.deepEqual(f.list(), [...f.ids, f.operation.releaseId].sort()); assert.deepEqual(f.index(), f.history);
  assert.equal(f.active(), `releases/${f.ids.at(-1)}`); assert.equal(existsSync(join(f.root, '.publication-pending.json')), false);
});

for (const keepReleases of [2, 4]) test(`retention rejects configured depth ${keepReleases} below the accepted five-release minimum before SSH`, options, async (t) => {
  const f = fixture(t, { keepReleases });
  await assert.rejects(async () => createSshTransport(f.config).withLock(async () => {}), /retention|keepReleases|release.*(five|5|minimum|depth)/i);
  assert.equal(f.events().length, 0); assert.deepEqual(f.list(), [...f.ids].sort()); assert.deepEqual(f.index(), f.history);
});

for (const keepReleases of [null, '5', true, 5.5, NaN, Infinity]) test(`retention refuses invalid depth ${String(keepReleases)} before SSH`, options, async (t) => {
  const f = fixture(t, { keepReleases });
  await assert.rejects(async () => createSshTransport(f.config).withLock(async () => {}), /keepReleases/);
  assert.equal(f.events().length, 0);
});

for (const kind of ['file symlink', 'directory symlink', 'FIFO']) test(`retention refuses ${kind} inside an excess tree without touching external bytes`, options, async (t) => {
  const f = fixture(t); const member = join(f.releases, f.ids[0], 'unsafe');
  if (kind === 'FIFO') assert.equal(spawnSync('/usr/bin/mkfifo', [member]).status, 0);
  else symlinkSync(kind === 'file symlink' ? join(f.source, 'index.html') : f.source, member);
  const oldestTime = new Date(Date.UTC(2020, 0, 1));
  utimesSync(join(f.releases, f.ids[0]), oldestTime, oldestTime);
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    await f.stage(session); await f.activate(session);
  }), (error) => {
    assert.match(error.message, /symlink|invalid member/);
    assert.deepEqual(error.activeOperation, f.operation); return true;
  });
  assert.equal(readFileSync(join(f.source, 'index.html'), 'utf8'), body);
  assert.equal(f.active(), 'releases/new-release');
  assert.deepEqual(f.index(), [...f.history, f.operation]);
});

test('retention removes nested regular files in excess release directories', options, async (t) => {
  const f = fixture(t); const oldest = join(f.releases, f.ids[0]);
  mkdirSync(join(oldest, 'assets', 'nested'), { recursive: true });
  writeFileSync(join(oldest, 'assets', 'nested', 'old.js'), 'old immutable asset');
  const oldestTime = new Date(Date.UTC(2020, 0, 1)); utimesSync(oldest, oldestTime, oldestTime);
  await createSshTransport(f.config).withLock(async (session) => { await f.stage(session); await f.activate(session); });
  assert.equal(existsSync(oldest), false);
  assert.deepEqual(f.list(), [...f.ids.slice(-4), f.operation.releaseId].sort());
});

test('retention deletion failure refuses success while reporting the actual active and indexed operation', options, async (t) => {
  const f = fixture(t); const oldest = join(f.releases, f.ids[0]);
  chmodSync(oldest, 0o500);
  assert.throws(() => rmSync(join(oldest, 'index.html')), /EACCES|EPERM/, 'positive fault control: this process really cannot delete the protected retained file');
  assert.equal(readFileSync(join(oldest, 'index.html'), 'utf8'), body);
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    await f.stage(session); await f.activate(session);
  }), (error) => {
    assert.deepEqual(error.activeOperation, f.operation, 'cleanup failure cannot claim the already switched publication never activated');
    assert.match(error.message, /retention|prun|remove|filesystem|permission|delet/i); return true;
  });
  assert.equal(f.active(), 'releases/new-release'); assert.deepEqual(f.index(), [...f.history, f.operation]);
  assert.equal(readFileSync(join(f.releases, f.operation.releaseId, 'index.html'), 'utf8'), body);
  assert.ok(existsSync(join(f.releases, f.ids.at(-1))), 'cleanup failure must preserve the preceding active rollback target');
});

test('retention recovery retries a failed prune with an already acknowledged index operation', options, async (t) => {
  const f = fixture(t); const oldest = join(f.releases, f.ids[0]);
  chmodSync(oldest, 0o500);
  assert.throws(() => rmSync(join(oldest, 'index.html')), /EACCES|EPERM/);
  await assert.rejects(createSshTransport(f.config).withLock(async (session) => {
    await f.stage(session); await f.activate(session);
  }));
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.publication-pending.json'), 'utf8')), f.operation);
  chmodSync(oldest, 0o700);
  const result = await createSshTransport(f.config).recover({ recordIndex: async (record) => {
    assert.equal(probeLock(f.root), 73);
    assert.deepEqual(record, f.index().at(-1), 'idempotent index acknowledgement must not append a second occurrence');
  } });
  assert.equal(result.recovered, true);
  assert.deepEqual(f.list(), [...f.ids.slice(-4), f.operation.releaseId].sort());
  assert.deepEqual(f.index(), [...f.history, f.operation]);
  assert.equal(f.active(), 'releases/new-release');
  assert.equal(existsSync(join(f.root, '.publication-pending.json')), false);
});
