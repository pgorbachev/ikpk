import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { digestTree } from '../publication-launcher.mjs';
import { createSshTransport } from '../publication-transport.mjs';

const options = { timeout: 15000 };
const artifact = 'deploy/nginx-redirects.conf';
const oldRedirects = 'location = /legacy { return 301 /old-page; }\n';
const newRedirects = 'location = /legacy { return 301 /new-page; }\n';
const inspect = ['/usr/bin/sudo', '-n', '/usr/sbin/nginx', '-T'];
const check = ['/usr/bin/sudo', '-n', '/usr/sbin/nginx', '-t'];
const reload = ['/usr/bin/sudo', '-n', '/bin/systemctl', 'reload', 'nginx'];
const fakeSsh = fileURLToPath(new URL('./fixtures/serving-probe-ssh.mjs', import.meta.url));

async function setup(t, fault = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ikpk-redirect-transaction-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'remote');
  const old = join(root, 'releases', 'old');
  mkdirSync(join(old, 'deploy'), { recursive: true });
  writeFileSync(join(old, 'index.html'), 'old body');
  writeFileSync(join(old, artifact), oldRedirects);
  mkdirSync(join(root, 'shared'));
  const fragment = join(root, 'shared', 'nginx-redirects.conf');
  writeFileSync(fragment, oldRedirects);
  symlinkSync('releases/old', join(root, 'current'));
  const source = join(temp, 'source');
  mkdirSync(join(source, 'deploy'), { recursive: true });
  writeFileSync(join(source, 'index.html'), 'new body');
  writeFileSync(join(source, artifact), newRedirects);
  const treeDigest = await digestTree(source, ['index.html', artifact]);
  const operation = { publicationId: 'publish-new', destinationId: 'stand', commit: 'a'.repeat(40), snapshotId: `snap:${'b'.repeat(64)}`, releaseId: 'new', treeDigest };
  const log = join(temp, 'events.jsonl'); writeFileSync(log, '');
  const fixture = join(temp, 'fixture.json');
  let boundary = { transactionRoot: root, oldRedirects, log, nginxDump: `# configuration file /etc/nginx/sites-enabled/stand:\nserver { listen 80; root ${root}/current; include ${fragment}; }\n`, ...fault };
  const update = (patch) => { boundary = { ...boundary, ...patch }; writeFileSync(fixture, JSON.stringify(boundary)); };
  update({});
  const knownHostsFile = join(temp, 'known_hosts'); writeFileSync(knownHostsFile, '# isolated fixture\n');
  const config = { root, destinationId: 'stand', host: 'transport.test.invalid', user: 'deploy', knownHostsFile,
    sshCommand: [process.execPath, fakeSsh, fixture],
    authorize: async ({ operation: selected, expectedDigest }) => ({ ...operation, ...selected, treeDigest: selected?.treeDigest ?? expectedDigest ?? treeDigest }),
  };
  const transport = () => createSshTransport(config);
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const commands = () => events().filter((event) => event.kind === 'command');
  const current = () => readlinkSync(join(root, 'current'));
  const redirects = () => readFileSync(fragment, 'utf8');
  const pending = join(root, '.publication-pending.json');
  const stage = (session) => session.stage({ releaseId: 'new', sourceDir: source, expectedDigest: operation.treeDigest });
  const activate = (session, extra = {}) => session.activate({ releaseId: 'new', operation, redirectsPath: artifact, recordIndex: async () => {}, ...extra });
  const publish = (extra = {}) => transport().withLock(async (session) => { await stage(session); return activate(session, extra); });
  const oldPair = () => { assert.equal(current(), 'releases/old'); assert.equal(redirects(), oldRedirects); };
  return { root, old, source, fragment, operation, log, update, transport, events, commands, current, redirects, pending, stage, activate, publish, oldPair };
}

const isCommand = (event, argv) => event.kind === 'command' && JSON.stringify(event.argv) === JSON.stringify(argv);
const capturedError = async (promise) => promise.then(() => undefined, (error) => error);
async function killPrepared(f) {
  const pid = f.events().findLast((event) => event.kind === 'connection').pid;
  process.kill(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(5);
  }
  assert.fail('crash injection must terminate actual remote Python');
}

// No missing-API shims: every case calls the already shipped stage/activate/rollback/recover.
test('redirect bytes from the digested release are validated before final check and reloaded after current switches', options, async (t) => {
  const f = await setup(t);
  await f.publish({
    beforeActivate: async () => {
      appendFileSync(f.log, JSON.stringify({ kind: 'final-check' }) + '\n');
      assert.equal(f.current(), 'releases/old');
      assert.equal(f.redirects(), newRedirects, 'the checked incoming fragment must already be installed on disk');
      assert.ok(existsSync(f.pending));
    },
    recordIndex: async () => {
      appendFileSync(f.log, JSON.stringify({ kind: 'index' }) + '\n');
      assert.equal(f.current(), 'releases/new');
      assert.equal(f.redirects(), newRedirects);
    },
  });
  assert.equal(readFileSync(join(f.root, 'releases', 'new', artifact), 'utf8'), newRedirects);
  assert.equal(readFileSync(join(f.old, artifact), 'utf8'), oldRedirects);
  const events = f.events();
  const checkAt = events.findIndex((event) => isCommand(event, check));
  const finalAt = events.findIndex((event) => event.kind === 'final-check');
  const switchAt = events.findIndex((event) => event.kind === 'switch');
  const reloadAt = events.findIndex((event) => isCommand(event, reload));
  assert.ok(checkAt >= 0 && checkAt < finalAt && finalAt < switchAt && switchAt < reloadAt);
  assert.ok(reloadAt < events.findIndex((event) => event.kind === 'index'));
  assert.equal(events[checkAt].current, 'releases/old');
  assert.equal(events[checkAt].redirects, newRedirects);
  assert.equal(events[reloadAt].current, 'releases/new');
  assert.deepEqual(f.commands().map(({ argv }) => argv), [inspect, check, reload]);
  assert.equal(events.filter((event) => event.kind === 'connection').length, 1);
  assert.equal(existsSync(f.pending), false);
});

for (const [label, dump] of [
  ['same basename at another path', (f) => `server { root ${f.root}/current; include /other/shared/nginx-redirects.conf; }`],
  ['include only in a comment', (f) => `server { root ${f.root}/current;\n# include ${f.fragment};\n}`],
  ['include in another server block', (f) => `server { root /unrelated/current; include ${f.fragment}; }\nserver { root ${f.root}/current; }`],
]) {
  test(`preflight refuses ${label} before altering the live pair`, options, async (t) => {
    const f = await setup(t); f.update({ nginxDump: dump(f) });
    await assert.rejects(f.publish(), /include|redirect|destination|serving|root/i);
    f.oldPair();
    assert.equal(f.commands().some((event) => isCommand(event, reload)), false);
    assert.equal(existsSync(f.pending), false);
  });
}

test('nginx inspection failure refuses the new release before final check', options, async (t) => {
  const f = await setup(t, { nginxFailure: true }); let finalChecks = 0;
  await assert.rejects(f.publish({ beforeActivate: async () => { finalChecks++; } }), /nginx|inspection/i);
  f.oldPair(); assert.equal(finalChecks, 0);
});

test('incoming nginx validation failure restores old bytes and never switches, reloads, or records', options, async (t) => {
  const f = await setup(t, { nginxTestFailure: true }); let finalChecks = 0; let records = 0;
  await assert.rejects(f.publish({ beforeActivate: async () => { finalChecks++; }, recordIndex: async () => { records++; } }), /nginx|config|validation/i);
  f.oldPair(); assert.equal(finalChecks, 0); assert.equal(records, 0);
  const tested = f.commands().find((event) => isCommand(event, check));
  assert.equal(tested?.redirects, newRedirects, 'failure must actually test incoming config, not old bytes');
  assert.equal(tested?.current, 'releases/old');
  assert.equal(f.events().some((event) => event.kind === 'switch' || isCommand(event, reload)), false);
  assert.equal(existsSync(f.pending), false);
});

test('a refusing final provenance check restores redirects as well as preserving current', options, async (t) => {
  const f = await setup(t); let validatedBeforeFinal = false;
  await assert.rejects(f.publish({ beforeActivate: async () => {
    validatedBeforeFinal = f.commands().some((event) => isCommand(event, check));
    throw new Error('main advanced');
  } }), /main advanced/);
  f.oldPair();
  assert.equal(validatedBeforeFinal, true, 'final provenance check follows nginx validation');
  assert.equal(f.commands().some((event) => isCommand(event, reload)), false);
  assert.equal(existsSync(f.pending), false);
});

test('retained rollback restores its own checked redirect fragment without executing retained scripts', options, async (t) => {
  const f = await setup(t);
  cpSync(f.source, join(f.root, 'releases', 'new'), { recursive: true });
  unlinkSync(join(f.root, 'current')); symlinkSync('releases/new', join(f.root, 'current'));
  writeFileSync(f.fragment, newRedirects);
  const marker = join(f.root, 'executed');
  writeFileSync(join(f.old, 'deploy.sh'), `touch '${marker}'\n`);
  const treeDigest = await digestTree(f.old, ['index.html', artifact, 'deploy.sh']);
  const operation = { ...f.operation, publicationId: 'rollback-old', releaseId: 'old', treeDigest };
  await f.transport().withLock((session) => session.rollback({ releaseId: 'old', expectedDigest: treeDigest, operation, redirectsPath: artifact, recordIndex: async () => {} }));
  f.oldPair();
  assert.equal(existsSync(marker), false);
  assert.equal(f.commands().find((event) => isCommand(event, check))?.redirects, oldRedirects);
  assert.equal(f.commands().find((event) => isCommand(event, reload))?.current, 'releases/old');
});

test('requesting redirect activation without the fixed artifact refuses before switching', options, async (t) => {
  const f = await setup(t); unlinkSync(join(f.source, artifact));
  f.operation.treeDigest = await digestTree(f.source, ['index.html']);
  await assert.rejects(f.publish(), /redirect|missing|artifact|file/i);
  f.oldPair();
});

test('activation cannot select an arbitrary relative configuration artifact', options, async (t) => {
  const f = await setup(t);
  await assert.rejects(f.publish({ redirectsPath: 'index.html' }), /redirect|path|artifact|invalid/i);
  f.oldPair();
});

test('digest protection covers redirect bytes changed after upload', options, async (t) => {
  const f = await setup(t);
  await assert.rejects(f.transport().withLock(async (session) => {
    await f.stage(session);
    writeFileSync(join(f.root, 'releases', 'new', artifact), 'location / { root /etc; }\n');
    await f.activate(session);
  }), /digest|checksum|mismatch/i);
  f.oldPair();
});

for (const component of ['fragment', 'shared']) {
  test(`symlink ${component} cannot redirect configuration writes outside destination`, options, async (t) => {
    const f = await setup(t); const outside = join(f.root, '..', 'outside'); mkdirSync(outside);
    const outsideFile = join(outside, 'nginx-redirects.conf'); writeFileSync(outsideFile, 'outside bytes');
    if (component === 'fragment') { unlinkSync(f.fragment); symlinkSync(outsideFile, f.fragment); }
    else { rmSync(join(f.root, 'shared'), { recursive: true }); symlinkSync(outside, join(f.root, 'shared')); }
    await assert.rejects(f.publish(), /symlink|filesystem|redirect|directory|file/i);
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside bytes');
    assert.equal(f.current(), 'releases/old');
  });
}

test('prepared crash recovery restores old redirect bytes without activating or indexing', options, async (t) => {
  const f = await setup(t); let preparedRedirects; let records = 0;
  await assert.rejects(f.publish({ beforeActivate: async () => { preparedRedirects = f.redirects(); await killPrepared(f); } }), /SSH|session|stream|closed/i);
  assert.equal(existsSync(f.pending), true);
  const result = await f.transport().recover({ recordIndex: async () => { records++; } });
  f.oldPair(); assert.equal(records, 0); assert.equal(result.cancelled, true);
  assert.equal(existsSync(f.pending), false);
  assert.equal(preparedRedirects, newRedirects, 'crash must happen after candidate configuration was installed');
  assert.equal(f.commands().some((event) => isCommand(event, reload)), false);
});

test('prepared recovery refuses unexpected manual config drift without overwriting it or clearing evidence', options, async (t) => {
  const f = await setup(t);
  await assert.rejects(f.publish({ beforeActivate: async () => { await killPrepared(f); } }), /SSH|session|stream|closed/i);
  writeFileSync(f.fragment, 'manual emergency configuration\n');
  await assert.rejects(f.transport().recover({ recordIndex: async () => assert.fail('must not record') }), /redirect|config|changed|drift|mismatch/i);
  assert.equal(f.redirects(), 'manual emergency configuration\n');
  assert.equal(f.current(), 'releases/old'); assert.equal(existsSync(f.pending), true);
});

test('committed crash recovery reloads matching new redirects before recording the active pair', options, async (t) => {
  const f = await setup(t, { crashAt: 'after-current' });
  await assert.rejects(f.publish(), /SSH|session|stream|closed/i);
  assert.equal(f.current(), 'releases/new'); assert.equal(existsSync(f.pending), true);
  assert.ok(f.events().some((event) => event.kind === 'crash' && event.at === 'after-current'));
  f.update({ crashAt: null });
  const result = await f.transport().recover({ recordIndex: async (operation) => {
    assert.deepEqual(operation, f.operation);
    assert.equal(f.redirects(), newRedirects, 'recovered index cannot attest new content with old redirect configuration');
    assert.ok(f.commands().some((event) => isCommand(event, reload)), 'recovery must finish reload before index');
  } });
  assert.equal(result.recovered, true); assert.equal(existsSync(f.pending), false);
  assert.equal(f.current(), 'releases/new'); assert.equal(f.redirects(), newRedirects);
});

test('committing with old current remains blocked for audited repair instead of silently cancelling', options, async (t) => {
  const f = await setup(t, { crashAt: 'before-current' });
  await assert.rejects(f.publish(), /SSH|session|stream|closed/i);
  assert.ok(f.events().some((event) => event.kind === 'crash' && event.at === 'before-current'));
  assert.equal(f.current(), 'releases/old');
  f.update({ crashAt: null });
  await assert.rejects(f.transport().recover({ recordIndex: async () => assert.fail('ambiguous operation cannot enter history') }), /current|mismatch|committ|repair/i);
  assert.equal(existsSync(f.pending), true);
  assert.equal(f.current(), 'releases/old');
});

for (const failure of ['reload', 'index']) {
  test(`${failure} failure after switch names active pair and retains pending without automatic rollback`, options, async (t) => {
    const f = await setup(t, failure === 'reload' ? { reloadFailure: true } : {}); let records = 0;
    const error = await capturedError(f.publish({ recordIndex: async () => { records++; if (failure === 'index') throw new Error('index unavailable'); } }));
    assert.ok(error instanceof Error, `${failure} failure must fail the publication`);
    assert.deepEqual(error.activeOperation, f.operation, 'worker needs exact active operation to emit activePair audit');
    assert.match(error.message, new RegExp(f.operation.commit));
    assert.match(error.message, new RegExp(f.operation.snapshotId));
    assert.equal(f.current(), 'releases/new'); assert.equal(f.redirects(), newRedirects);
    assert.deepEqual(JSON.parse(readFileSync(f.pending, 'utf8')), f.operation);
    if (failure === 'reload') assert.equal(records, 0);
    assert.equal(f.events().filter((event) => event.kind === 'switch').length, 1);
    f.update({ reloadFailure: false });
    await f.transport().recover({ recordIndex: async () => {} });
    assert.equal(f.current(), 'releases/new'); assert.equal(f.redirects(), newRedirects);
    assert.equal(existsSync(f.pending), false);
  });
}

test('failure restoring redirects after rejected nginx validation retains recoverable evidence', options, async (t) => {
  const f = await setup(t, { nginxTestFailure: true, restoreFailure: true });
  await assert.rejects(f.publish());
  assert.ok(f.events().some((event) => event.kind === 'restore-failure'), 'filesystem restore fault must actually run');
  assert.equal(f.current(), 'releases/old');
  assert.equal(f.redirects(), newRedirects);
  assert.equal(existsSync(f.pending), true, 'failed restore must not erase old configuration evidence');
  f.update({ nginxTestFailure: false, restoreFailure: false });
  await f.transport().recover({ recordIndex: async () => assert.fail('rejected candidate cannot enter history') });
  f.oldPair(); assert.equal(existsSync(f.pending), false);
});

test('crash while testing incoming nginx config leaves enough evidence to restore the old pair', options, async (t) => {
  const f = await setup(t, { crashOnTest: true });
  await assert.rejects(f.publish(), /SSH|session|stream|closed/i);
  assert.ok(f.events().some((event) => event.kind === 'crash' && event.at === 'nginx-test'));
  assert.equal(f.current(), 'releases/old'); assert.equal(f.redirects(), newRedirects);
  assert.equal(existsSync(f.pending), true);
  f.update({ crashOnTest: false });
  await f.transport().recover({ recordIndex: async () => assert.fail('unvalidated candidate cannot enter history') });
  f.oldPair(); assert.equal(existsSync(f.pending), false);
});

test('cancel refuses unexpected manual config drift without clearing pending or overwriting manual bytes', options, async (t) => {
  const f = await setup(t);
  await assert.rejects(f.publish({ beforeActivate: async () => {
    writeFileSync(f.fragment, 'manual emergency configuration\n');
    throw new Error('main advanced');
  } }));
  assert.equal(f.redirects(), 'manual emergency configuration\n');
  assert.equal(f.current(), 'releases/old');
  assert.equal(existsSync(f.pending), true, 'refused config restore must preserve pending evidence');
});

// Supplemental boundary checks on the implementation; the independent RED cases above
// remain unchanged and provide the implementation's pre-existing acceptance contract.
test('configuration drift after final validation blocks current without overwriting manual bytes', options, async (t) => {
  const f = await setup(t);
  await assert.rejects(f.publish({ beforeActivate: async () => {
    writeFileSync(f.fragment, 'manual emergency configuration\n');
  } }), /redirect|configuration|changed/i);
  assert.equal(f.current(), 'releases/old');
  assert.equal(f.redirects(), 'manual emergency configuration\n');
  assert.equal(existsSync(f.pending), true);
  assert.equal(f.events().some((event) => event.kind === 'switch' || isCommand(event, reload)), false);
});

test('committed recovery reinstalls recognized old redirect bytes and validates before reload', options, async (t) => {
  const f = await setup(t, { crashAt: 'after-current' });
  await assert.rejects(f.publish(), /SSH|session|stream|closed/i);
  writeFileSync(f.fragment, oldRedirects);
  f.update({ crashAt: null });
  const result = await f.transport().recover({ recordIndex: async () => {
    assert.equal(f.redirects(), newRedirects);
    const commands = f.commands();
    assert.deepEqual(commands.slice(-2).map(({ argv }) => argv), [check, reload]);
    assert.ok(commands.slice(-2).every((event) => event.redirects === newRedirects && event.current === 'releases/new'));
  } });
  assert.equal(result.recovered, true);
  assert.equal(existsSync(f.pending), false);
});

test('committed recovery preserves unexpected redirect drift and pending without recording', options, async (t) => {
  const f = await setup(t, { crashAt: 'after-current' });
  await assert.rejects(f.publish(), /SSH|session|stream|closed/i);
  writeFileSync(f.fragment, 'manual emergency configuration\n');
  f.update({ crashAt: null });
  let records = 0;
  const error = await capturedError(f.transport().recover({ recordIndex: async () => { records++; } }));
  assert.equal(records, 0, 'drift cannot enter history');
  assert.match(error.message, /redirect|configuration|drift/i);
  assert.deepEqual(error.activeOperation, f.operation);
  assert.equal(f.current(), 'releases/new');
  assert.equal(f.redirects(), 'manual emergency configuration\n');
  assert.equal(existsSync(f.pending), true);
  assert.equal(f.commands().some((event) => isCommand(event, reload)), false);
});

// Independent correctness review: a second destination can consume the same file
// through nginx's normal wildcard or nested include expansion.
for (const indirect of ['wildcard', 'wrapper']) {
  test(`REVIEW: refuses shared redirects consumed by another destination through ${indirect} include`, options, async (t) => {
    const f = await setup(t);
    const otherInclude = indirect === 'wildcard' ? join(f.root, 'shared', '*.conf') : '/etc/nginx/snippets/other-redirects.conf';
    const extraDump = indirect === 'wrapper' ? `\n# configuration file ${otherInclude}:\ninclude ${f.fragment};\n` : '';
    f.update({ nginxDump: `# configuration file /etc/nginx/nginx.conf:\nevents {}\nhttp {\nserver { listen 8080; root ${f.root}/current; include ${f.fragment}; }\nserver { listen 8081; root /other/current; include ${otherInclude}; }\n}\n# configuration file ${f.fragment}:\n${oldRedirects}${extraDump}` });
    let records = 0;
    const error = await capturedError(f.publish({ recordIndex: async () => { records++; } }));
    assert.equal(records, 0, 'a configuration fragment used by another destination must never be replaced or indexed');
    assert.ok(error instanceof Error, 'shared include must be refused before publication');
    f.oldPair();
    assert.equal(f.commands().some((event) => isCommand(event, reload)), false);
  });
}
