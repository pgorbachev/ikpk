import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from '../publication-launcher.mjs';
import { createSshTransport } from '../publication-transport.mjs';

test('REVIEW: cancelled candidates cannot evict the immediately preceding published rollback target', { timeout: 20000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-retention-review-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'remote');
  const releases = join(root, 'releases');
  const source = join(temp, 'source');
  mkdirSync(releases, { recursive: true }); mkdirSync(source);
  writeFileSync(join(source, 'index.html'), 'verified static content');
  const treeDigest = await digestTree(source, ['index.html']);
  const published = ['published-1', 'published-2', 'published-3', 'published-4', 'published-5'];
  for (const [i, id] of published.entries()) {
    const dir = join(releases, id); mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), `old content ${i}`);
    const time = new Date(Date.UTC(2020, 0, i + 1)); utimesSync(dir, time, time);
  }
  symlinkSync('releases/published-5', join(root, 'current'));
  const knownHostsFile = join(temp, 'known_hosts'); writeFileSync(knownHostsFile, '# isolated fake SSH\n');
  const log = join(temp, 'events.jsonl'); writeFileSync(log, '');
  const history = [...published];
  const transport = createSshTransport({
    root, destinationId: 'stand', host: 'transport.test.invalid', user: 'deploy', knownHostsFile,
    sshCommand: [process.execPath, fileURLToPath(new URL('./fixtures/fake-ssh.mjs', import.meta.url)), log, '{}'],
    authorize: async ({ operation }) => ({ commit: 'a'.repeat(40), snapshotId: 'verified-snapshot', destinationId: 'stand', treeDigest, ...operation }),
  });
  const publish = (id, beforeActivate) => transport.withLock(async (session) => {
    await session.stage({ releaseId: id, sourceDir: source, expectedDigest: treeDigest });
    await session.activate({ releaseId: id,
      operation: { publicationId: `op-${id}`, releaseId: id, commit: 'a'.repeat(40), snapshotId: 'verified-snapshot', destinationId: 'stand', treeDigest },
      beforeActivate, recordIndex: async () => { history.push(id); },
    });
  });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(publish(`cancelled-${i}`, async () => { throw new Error('main advanced before activation'); }), /main advanced/);
    assert.equal(readlinkSync(join(root, 'current')), 'releases/published-5');
    assert.deepEqual(history, published);
  }
  await publish('accepted-new');
  assert.equal(readlinkSync(join(root, 'current')), 'releases/accepted-new');
  assert.deepEqual(history, [...published, 'accepted-new']);
  const retainedPublished = readdirSync(releases).filter((id) => history.includes(id)).sort();
  assert.ok(retainedPublished.includes('published-5'),
    `the immediately preceding active release must remain a rollback target; retained published releases: ${JSON.stringify(retainedPublished)}`);
  assert.equal(readFileSync(join(releases, 'published-5', 'index.html'), 'utf8'), 'old content 4');
});
