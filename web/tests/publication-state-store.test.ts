import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLedger } from '../scripts/lib/provenance-ledger.ts';
import { PUBLICATION_CI_POLICY, PUBLICATION_GROUPS, type PublicationRecord } from '../scripts/lib/publish-gate.ts';
import { createPublicationStateStore, type PublicationStateStoreOptions } from '../scripts/lib/publication-state-store.ts';

const BRANCH = 'state/cms-provenance';
const CANARY = 'state-store-auth-canary-4c7d29';
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const env = () => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'State fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'State fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, {
  cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-state-store-')); temporary.push(root);
  const remote = join(root, 'canonical.git'); const author = join(root, 'cms-author');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  mkdirSync(author); git(author, 'init', '--initial-branch=main');
  write(join(author, 'main-only.txt'), 'unrelated source tree\n');
  git(author, 'add', '.'); git(author, 'commit', '-m', 'main source');
  git(author, 'remote', 'add', 'origin', remote); git(author, 'push', 'origin', 'main');
  git(author, 'checkout', '--orphan', BRANCH); git(author, 'rm', '-rf', '.');
  const ledger = createLedger({ dir: join(author, 'ledger') });
  await ledger.recordEvent({ fingerprint: 'A', marker: 'initial-migration' });
  await ledger.recordEvent({ fingerprint: 'B', marker: 'edit' });
  await ledger.recordEvent({ fingerprint: 'A', marker: 'restore' });
  write(join(author, 'verified-pairs.json'), '[]\n');
  write(join(author, 'writer-owned.txt'), 'do not stage or modify\n');
  git(author, 'add', '.'); git(author, 'commit', '-m', 'shared provenance journal');
  git(author, 'push', 'origin', BRANCH);
  return { root, remote, author, workDir: join(root, 'publication-clone') };
}
const head = (f: Fixture) => git(f.root, '--git-dir', f.remote, 'rev-parse', BRANCH);
const remoteFile = (f: Fixture, name: string) => git(f.root, '--git-dir', f.remote, 'show', `${BRANCH}:${name}`);
const remotePairs = (f: Fixture) => JSON.parse(remoteFile(f, 'verified-pairs.json')) as PublicationRecord[];
const remoteEntry = (f: Fixture, number: number) => JSON.parse(remoteFile(f, `ledger/entry-${String(number).padStart(6, '0')}.json`));
const record = (id = 'publication-1'): PublicationRecord => {
  const commit = 'a'.repeat(40); const treeDigest = '1'.repeat(64);
  return { publicationId: id, releaseId: `release-${id}`, destinationId: 'stand', commit,
    snapshotId: 'snapshot-A', revision: 1, referenceDate: '2026-09-19', capturedAt: '2026-09-19T00:00:00Z',
    testRunConclusion: 'success', treeDigest, publishedAt: '2026-09-19T01:00:00Z', actor: 'operator',
    paymentRole: 'ci', deployMode: 'stand', ciEvidence: { ...PUBLICATION_CI_POLICY,
      event: 'push', branch: 'main', commit, runId: 123, conclusion: 'success', executedTests: 42,
      jobs: PUBLICATION_CI_POLICY.requiredJobs.map((name) => ({ name, conclusion: 'success' })) },
    localChecks: { commit, snapshotId: 'snapshot-A', destinationId: 'stand', treeDigest,
      groups: PUBLICATION_GROUPS.map((name) => ({ name, conclusion: 'success', executedTests: 2 })) } };
};
function store(f: Fixture, overrides: Partial<PublicationStateStoreOptions> = {}) {
  return createPublicationStateStore({ remote: f.remote, workDir: f.workDir, gitEnv: env(), maxPushAttempts: 3, ...overrides });
}
async function otherWriter(f: Fixture, kind: 'cms' | 'publication') {
  const other = join(f.root, 'concurrent-writer');
  git(f.root, 'clone', '--branch', BRANCH, f.remote, other);
  if (kind === 'cms') await createLedger({ dir: join(other, 'ledger') }).recordEvent({ fingerprint: 'C', marker: 'edit' });
  else write(join(other, 'verified-pairs.json'), JSON.stringify([record('other-writer')]));
  git(other, 'add', '.'); git(other, 'commit', '-m', `concurrent ${kind} writer`);
  return other;
}
/** A real competing push occurs while the first receive-pack is checking its update. */
function raceNextPush(f: Fixture, other: string) {
  const marker = join(f.root, 'second-writer-pushed');
  const hook = join(f.remote, 'hooks', 'pre-receive');
  write(hook, `#!/bin/sh
set -eu
if [ ! -e ${quote(marker)} ]; then
  touch ${quote(marker)}
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH
  /usr/bin/git -C ${quote(other)} push origin ${quote(BRANCH)}
fi
`);
  chmodSync(hook, 0o700);
  return marker;
}

function sshFixture(f: Fixture) {
  const ssh = join(f.root, 'fixture-ssh'); const trace = join(f.root, 'ssh-trace.jsonl');
  write(ssh, `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args,received:process.env.IKPK_STATE_TOKEN===${JSON.stringify(CANARY)}})+'\\n');
if(args.includes('-G'))process.exit(1);
const r=cp.spawnSync('/bin/sh',['-c',args.at(-1)],{stdio:'inherit',env:process.env});process.exit(r.status??1);\n`);
  chmodSync(ssh, 0o700);
  return { remote: `ssh://git@fixture.invalid${f.remote}`, gitEnv: { ...env(), GIT_SSH: ssh, IKPK_STATE_TOKEN: CANARY }, trace };
}

describe('shared Git state store: real bare-remote contract', () => {
  it.each(['publication', 'legacy'] as const)('REVIEW: duplicate persisted %s records cannot make a new publication falsely idempotent', async (kind) => {
    const f = await fixture();
    const publication = record('existing');
    const existing = kind === 'publication' ? publication : {
      commit: publication.commit, snapshotId: publication.snapshotId, revision: publication.revision,
      referenceDate: publication.referenceDate, capturedAt: publication.capturedAt,
      testRunConclusion: publication.testRunConclusion,
    };
    write(join(f.author, 'verified-pairs.json'), JSON.stringify([existing, existing]));
    git(f.author, 'add', 'verified-pairs.json');
    git(f.author, 'commit', '-m', 'duplicate historical index record');
    git(f.author, 'push', 'origin', BRANCH);
    const before = head(f);
    expect(remotePairs(f)).toEqual([existing, existing]);
    await expect(store(f).appendPublication(record('new'))).rejects.toThrow(/duplicate|immutable|corrupt|history|index/i);
    expect(head(f)).toBe(before);
    expect(remotePairs(f)).toEqual([existing, existing]);
  });

  it.each([`https://${CANARY}@github.com/pgorbachev/ikpk.git`, `HTTPS://operator:${CANARY}@github.com/pgorbachev/ikpk.git`])('REVIEW: credential URL %s is refused before Git argv or clone config', async (remote) => {
    const f = await fixture();
    expect(() => store(f, { remote })).toThrow(/unsafe|credential|remote/i);
    expect(existsSync(f.workDir)).toBe(false);
  });

  it.each(['unrecorded-live-state', 'A'])('REVIEW: read cannot assign the latest revision to mismatched fingerprint %s', async (fingerprint) => {
    const f = await fixture();
    const other = await otherWriter(f, 'cms');
    git(other, 'push', 'origin', BRANCH);
    const api = store(f);
    const known = await api.read('C');
    expect(known.observation).toMatchObject({ observedEntry: 4, revision: 4, highWaterMark: 4, requiresConfirmation: false });
    let unknown;
    try { unknown = await api.read(fingerprint); }
    catch (error) {
      expect(String(error)).toMatch(/fingerprint|provenance|revision|отпечат|ревизи/i);
      return;
    }
    expect(unknown.entries.at(-1)?.fingerprint).toBe('C');
    expect(unknown.observation.revision, 'different bytes have no revision backed by the current entry').toBeNull();
    expect(unknown.observation.requiresConfirmation).toBe(true);
  });

  it('positive control: a competing writer really pushes and rejects the stale Git update', async () => {
    const f = await fixture(); const other = await otherWriter(f, 'cms'); const marker = raceNextPush(f, other);
    write(join(f.author, 'verified-pairs.json'), JSON.stringify([record()]));
    git(f.author, 'add', 'verified-pairs.json'); git(f.author, 'commit', '-m', 'stale publication');
    const transport = sshFixture(f); git(f.author, 'remote', 'set-url', 'origin', transport.remote);
    const result = spawnSync('/usr/bin/git', ['push', 'origin', BRANCH], { cwd: f.author, env: transport.gitEnv, encoding: 'utf8' });
    const trace = readFileSync(transport.trace, 'utf8');
    expect(trace).not.toContain(CANARY); expect(trace).toContain('"received":true');
    expect(result.status).not.toBe(0); expect(existsSync(marker)).toBe(true);
    expect(head(f)).toBe(git(other, 'rev-parse', 'HEAD'));
    expect(remoteEntry(f, 4).fingerprint).toBe('C'); expect(remotePairs(f)).toEqual([]);
  });
  it('read observes the existing journal without writing any remote commit or tracked bytes, and refreshes later reads', async () => {
    const f = await fixture(); const initial = head(f); const api = store(f);
    const state = await api.read('A');
    expect(state).toMatchObject({ head: initial, publications: [], observation: { observedEntry: 3, revision: 1, highWaterMark: 3 } });
    expect(state.entries).toHaveLength(3); expect(head(f)).toBe(initial);
    expect(git(f.workDir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    const other = await otherWriter(f, 'cms'); git(other, 'push', 'origin', BRANCH);
    expect((await api.read('C')).observation).toMatchObject({ observedEntry: 4, revision: 4, highWaterMark: 4 });
    expect(head(f)).toBe(git(other, 'rev-parse', 'HEAD'));
  });
  it('a missing provenance branch is refused instead of bootstrapping a substitute journal', async () => {
    const f = await fixture(); git(f.author, 'push', 'origin', `:${BRANCH}`);
    await expect(store(f).read('A')).rejects.toThrow(/state-branch|provenance.*(missing|unavailable)/);
    expect(git(f.root, '--git-dir', f.remote, 'branch', '--list', BRANCH)).toBe('');
  });
  it('checksum corruption is rejected without repairing or overwriting the remote journal', async () => {
    const f = await fixture(); const path = join(f.author, 'ledger/entry-000003.json');
    const damaged = JSON.parse(readFileSync(path, 'utf8')); damaged.fingerprint = 'tampered'; write(path, JSON.stringify(damaged));
    git(f.author, 'add', '.'); git(f.author, 'commit', '-m', 'corrupted journal'); git(f.author, 'push', 'origin', BRANCH);
    const before = head(f); await expect(store(f).read('A')).rejects.toThrow(/corrupt|checksum|поврежд|контрольн/);
    expect(head(f)).toBe(before);
  });
  it('append commits only the publication index and leaves a clean isolated checkout', async () => {
    const f = await fixture(); const before = head(f); const main = git(f.root, '--git-dir', f.remote, 'rev-parse', 'main');
    const result = await store(f).appendPublication(record());
    expect(result).toEqual({ head: head(f), changed: true }); expect(result.head).not.toBe(before);
    expect(remotePairs(f)).toEqual([record()]);
    expect(git(f.root, '--git-dir', f.remote, 'diff', '--name-only', before, head(f))).toBe('verified-pairs.json');
    expect(git(f.workDir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(f.root, '--git-dir', f.remote, 'rev-parse', 'main')).toBe(main);
  });
  it('same-operation retry is idempotent but conflicting reuse cannot replace earlier evidence', async () => {
    const f = await fixture(); const api = store(f); await api.appendPublication(record()); const before = head(f);
    expect(await api.appendPublication(structuredClone(record()))).toEqual({ head: before, changed: false });
    await expect(api.appendPublication({ ...record(), actor: 'replacement' })).rejects.toThrow(/immutable|conflict/);
    expect(head(f)).toBe(before); expect(remotePairs(f)).toEqual([record()]);
  });
  it('a non-fast-forward append retries against the shared branch and preserves a concurrent CMS event', async () => {
    const f = await fixture(); const other = await otherWriter(f, 'cms'); const marker = raceNextPush(f, other);
    await store(f).appendPublication(record());
    expect(existsSync(marker)).toBe(true); expect(remotePairs(f)).toEqual([record()]);
    expect(remoteEntry(f, 4).fingerprint).toBe('C'); expect(remoteFile(f, 'ledger/high-water-mark')).toBe('4');
    expect(git(f.root, '--git-dir', f.remote, 'merge-base', '--is-ancestor', git(other, 'rev-parse', 'HEAD'), head(f))).toBe('');
  });
  it('a non-fast-forward append preserves another publication record in append order', async () => {
    const f = await fixture(); const other = await otherWriter(f, 'publication'); const marker = raceNextPush(f, other);
    await store(f).appendPublication(record());
    expect(existsSync(marker)).toBe(true); expect(remotePairs(f)).toEqual([record('other-writer'), record()]);
    expect(remoteEntry(f, 3).marker).toBe('restore');
  });
  it('exhausting the push budget refuses without force-pushing over the competing writer', async () => {
    const f = await fixture(); const other = await otherWriter(f, 'cms'); const marker = raceNextPush(f, other);
    await expect(store(f, { maxPushAttempts: 1 }).appendPublication(record())).rejects.toThrow(/retry|attempt|conflict/);
    expect(existsSync(marker)).toBe(true); expect(head(f)).toBe(git(other, 'rev-parse', 'HEAD')); expect(remotePairs(f)).toEqual([]);
  });
  it('invalid retry budgets fail explicitly instead of enabling unbounded retry or silent success', async () => {
    const f = await fixture();
    for (const maxPushAttempts of [0, -1, 1.5, Infinity, 1_000_000]) {
      await expect(Promise.resolve().then(() => store(f, { maxPushAttempts }).read('A'))).rejects.toThrow(/invalid.*(attempt|retry)|retry.*(invalid|limit)/);
    }
  });
  it('explicit acceptance persists the actor and a checksum-compatible accept-state entry with the next revision', async () => {
    const f = await fixture(); const result = await store(f).acceptState({ expectedObservedEntry: 3, fingerprint: 'A', actor: 'operator' });
    expect(result).toMatchObject({ head: head(f), entry: { number: 4, previous: 3, fingerprint: 'A', marker: 'accept-state', confirmedBy: 'operator' } });
    expect(remoteEntry(f, 4)).toMatchObject({ confirmedBy: 'operator', marker: 'accept-state' });
    expect(remotePairs(f)).toEqual([]); expect(remoteFile(f, 'ledger/high-water-mark')).toBe('4');
    const audit = join(f.root, 'audit'); git(f.root, 'clone', '--branch', BRANCH, f.remote, audit);
    expect((await createLedger({ dir: join(audit, 'ledger') }).observe({ fingerprint: 'A' })).revision).toBe(4);
    const entryPath = join(audit, 'ledger/entry-000004.json');
    const tampered = JSON.parse(readFileSync(entryPath, 'utf8')); tampered.confirmedBy = 'forged-actor';
    write(entryPath, JSON.stringify(tampered));
    await expect(createLedger({ dir: join(audit, 'ledger') }).entries()).rejects.toThrow(/checksum|поврежд|контрольн/);
  });
  it('a previously observed entry cannot confirm a newer current CMS event', async () => {
    const f = await fixture(); const before = head(f);
    await expect(store(f).acceptState({ expectedObservedEntry: 2, fingerprint: 'A', actor: 'operator' })).rejects.toThrow(/stale|observed-entry/);
    expect(head(f)).toBe(before);
  });
  it('an unknown fingerprint or absent actor cannot manufacture an acceptance event', async () => {
    const f = await fixture(); const before = head(f);
    await expect(store(f).acceptState({ expectedObservedEntry: 3, fingerprint: 'unknown', actor: 'operator' })).rejects.toThrow(/fingerprint/);
    await expect(store(f).acceptState({ expectedObservedEntry: 3, fingerprint: 'A', actor: ' ' })).rejects.toThrow(/actor/);
    expect(head(f)).toBe(before);
  });
  it('loss of the journal refuses acceptance even if the branch and publication index still exist', async () => {
    const f = await fixture(); git(f.author, 'rm', '-r', 'ledger'); git(f.author, 'commit', '-m', 'lost journal'); git(f.author, 'push', 'origin', BRANCH);
    const before = head(f);
    await expect(store(f).acceptState({ expectedObservedEntry: 3, fingerprint: 'A', actor: 'operator' })).rejects.toThrow(/ledger|journal|журнал/);
    expect(head(f)).toBe(before); expect(remotePairs(f)).toEqual([]);
  });
  it('a CMS event racing the acceptance push invalidates confirmation rather than replaying it on the new event', async () => {
    const f = await fixture(); const other = await otherWriter(f, 'cms'); const marker = raceNextPush(f, other);
    await expect(store(f).acceptState({ expectedObservedEntry: 3, fingerprint: 'A', actor: 'operator' })).rejects.toThrow(/stale|observed-entry/);
    expect(existsSync(marker)).toBe(true); expect(head(f)).toBe(git(other, 'rev-parse', 'HEAD'));
    expect(remoteEntry(f, 4)).toMatchObject({ fingerprint: 'C', marker: 'edit' });
    expect(git(f.root, '--git-dir', f.remote, 'ls-tree', '-r', '--name-only', BRANCH)).not.toContain('entry-000005');
  });
  it('a concurrent publication alone does not stale CMS confirmation and survives the acceptance retry', async () => {
    const f = await fixture(); const other = await otherWriter(f, 'publication'); const marker = raceNextPush(f, other);
    await store(f).acceptState({ expectedObservedEntry: 3, fingerprint: 'A', actor: 'operator' });
    expect(existsSync(marker)).toBe(true); expect(remotePairs(f)).toEqual([record('other-writer')]);
    expect(remoteEntry(f, 4)).toMatchObject({ fingerprint: 'A', marker: 'accept-state', confirmedBy: 'operator' });
  });
  it('an existing operator checkout with executable local hooks is refused as the isolated work directory', async () => {
    const f = await fixture(); const marker = join(f.root, 'untrusted-hook');
    const hook = join(f.author, '.git/hooks/post-checkout'); write(hook, `#!/bin/sh\ntouch ${quote(marker)}\n`); chmodSync(hook, 0o700);
    await expect(store(f, { workDir: f.author }).read('A')).rejects.toThrow(/work.*(exist|clean|fresh|empty|unsafe)|isolat/);
    expect(existsSync(marker)).toBe(false);
  });
  it('real Git SSH transport receives authentication through environment without credentials in argv, config or result', async () => {
    const f = await fixture(); const transport = sshFixture(f); const { trace } = transport;
    const result = await store(f, transport).appendPublication(record());
    const traces = readFileSync(trace, 'utf8'); const calls = traces.trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.some((call) => call.received && call.args.some((arg: string) => arg.includes('git-receive-pack')))).toBe(true);
    expect(remotePairs(f)).toEqual([record()]); expect(traces).not.toContain(CANARY);
    expect(readFileSync(join(f.workDir, '.git/config'), 'utf8')).not.toContain(CANARY); expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe('review: real store preserves stale-snapshot diagnostic evidence', () => {
  it('a mismatched current fingerprint exposes the actual latest entry and high-water mark', async () => {
    const f = await fixture();
    const api = store(f);
    expect((await api.read('A')).observation.observedEntry).toBe(3);
    const other = await otherWriter(f, 'cms');
    git(other, 'push', 'origin', BRANCH);
    const failure = await api.read('A').catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    const diagnostic = `${failure.message} ${JSON.stringify(failure)}`;
    expect(diagnostic).toMatch(/latestEntry[=:"\s]+4/);
    expect(diagnostic).toMatch(/highWaterMark[=:"\s]+4/);
  });
});

describe('rollback history does not depend on the CMS journal', () => {
  function historyStore(f: Fixture) {
    return store(f) as ReturnType<typeof store> & {
      readHistory(): Promise<{ head: string; publications: PublicationRecord[] }>;
    };
  }
  function indexWithoutLedger(f: Fixture, records: PublicationRecord[]) {
    rmSync(join(f.author, 'ledger'), { recursive: true });
    write(join(f.author, 'verified-pairs.json'), JSON.stringify(records));
    git(f.author, 'add', '.'); git(f.author, 'commit', '-m', 'retained publication index without CMS journal');
    git(f.author, 'push', 'origin', BRANCH);
  }

  it('readHistory refreshes only the immutable index when the CMS journal is unavailable', async () => {
    const f = await fixture(); const original = record('retained'); indexWithoutLedger(f, [original]);
    const before = head(f); const api = historyStore(f);
    expect(api.readHistory).toBeTypeOf('function');
    await expect(api.readHistory()).resolves.toEqual({ head: before, publications: [original] });
    expect(head(f)).toBe(before); expect(existsSync(join(f.workDir, 'ledger'))).toBe(false);
  });

  it('readHistory refuses duplicate publication keys instead of silently repairing the index', async () => {
    const f = await fixture(); const original = record('retained'); indexWithoutLedger(f, [original, original]);
    const before = head(f); const api = historyStore(f);
    expect(api.readHistory).toBeTypeOf('function');
    await expect(api.readHistory()).rejects.toThrow(/duplicate|immutable|corrupt|history|index/i);
    expect(head(f)).toBe(before); expect(remotePairs(f)).toEqual([original, original]);
  });

  it('appends rollback audit without a CMS ledger and preserves original publication evidence', async () => {
    const f = await fixture(); const original = record('retained'); indexWithoutLedger(f, [original]);
    const rollback = { ...structuredClone(original), publicationId: 'rollback-without-ledger', actor: 'rollback-operator',
      publishedAt: '2026-09-19T02:00:00Z', rollbackOfPublicationId: original.publicationId, reason: 'Repair current serving',
      rollbackChecks: { ...structuredClone(original.localChecks),
        groups: original.localChecks.groups.filter(({ name }) => ['destination-mode', 'browser-smoke', 'payment-destination'].includes(name)) } };
    await expect(store(f).appendPublication(rollback)).resolves.toMatchObject({ changed: true });
    expect(remotePairs(f)).toEqual([original, rollback]);
    expect(git(f.root, '--git-dir', f.remote, 'ls-tree', '-r', '--name-only', BRANCH)).not.toContain('ledger/');
    expect(remoteFile(f, 'writer-owned.txt')).toBe('do not stage or modify');
  });

  it.each(['missing', 'wrong-pair', 'failed-group'] as const)('refuses %s fresh rollback evidence before index effects', async (fault) => {
    const f = await fixture(); const original = record('retained'); indexWithoutLedger(f, [original]);
    const before = head(f);
    const checks = { ...structuredClone(original.localChecks),
      groups: structuredClone(original.localChecks.groups.filter(({ name }) => ['destination-mode', 'browser-smoke', 'payment-destination'].includes(name))) };
    if (fault === 'wrong-pair') checks.treeDigest = 'f'.repeat(64);
    if (fault === 'failed-group') checks.groups[0].conclusion = 'failure';
    const rollback = { ...structuredClone(original), publicationId: 'bad-rollback', rollbackOfPublicationId: original.publicationId,
      reason: 'Repair current serving', ...(fault === 'missing' ? {} : { rollbackChecks: checks }) };
    await expect(store(f).appendPublication(rollback)).rejects.toThrow('invalid publication evidence');
    expect(head(f)).toBe(before); expect(remotePairs(f)).toEqual([original]);
  });
});
