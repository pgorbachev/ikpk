import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TAG = 'v1.2.3';
function fixture(t, { annotated = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ikpk-release-admission-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Release fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Release fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = join(root, 'author'), remote = join(root, 'canonical.git');
  const installed = join(root, 'protected/publication-launcher.mjs'), config = join(dirname(installed), 'config.json');
  const broker = join(dirname(installed), 'broker.mjs'), brokerTrace = join(root, 'broker-called'), workerTrace = join(root, 'worker.json');
  mkdirSync(repo); mkdirSync(dirname(installed), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/publication-launcher.mjs'), installed); chmodSync(installed, 0o700);
  mkdirSync(join(repo, 'scripts'));
  writeFileSync(join(repo, 'scripts/deploy-web.sh'), '#!/bin/sh\nexec node scripts/worker.mjs\n');
  writeFileSync(join(repo, 'scripts/worker.mjs'), `import{writeFileSync}from'node:fs';
writeFileSync(${JSON.stringify(workerTrace)},JSON.stringify({commit:process.env.PUBLICATION_SOURCE_SHA,tag:process.env.PUBLICATION_RELEASE_TAG}));
writeFileSync(3,JSON.stringify({version:1,status:'success',code:'published',commit:process.env.PUBLICATION_SOURCE_SHA,
snapshotId:'snap:'+'a'.repeat(64),treeDigest:'b'.repeat(64),publicationId:'release-fixture',observedEntry:1,revision:1,highWaterMark:1,localExecutedTests:1,ciExecutedTests:1}));`);
  writeFileSync(broker, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(brokerTrace)},'called');process.stdout.write(JSON.stringify({env:{}}));`, { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ canonicalRepository: remote, destinationId: 'prod', deployMode: 'prod',
    sshTarget: 'deploy@host.test.invalid', credentialBroker: [process.execPath, broker] }), { mode: 0o600 });
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(repo, 'init', '--initial-branch=main');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'first release source');
  const older = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'next'), 'second release source'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'current release source');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', 'origin', 'main');
  git(repo, 'tag', ...(annotated ? ['-a', TAG, '-m', 'Versioned release'] : [TAG])); git(repo, 'push', 'origin', `refs/tags/${TAG}`);
  const args = ['publish', '--config', config, '--source-url', remote, '--source-ref', 'main', '--release-tag', TAG];
  const launch = (argv = args) => spawnSync(process.execPath, [installed, ...argv], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  return { root, repo, remote, head, older, git, args, launch, brokerTrace, workerTrace };
}
function refuseBeforeCredentials(f, args = f.args) {
  const result = f.launch(args);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, `unauthorized release was admitted: ${result.stdout}`);
  assert.equal(existsSync(f.brokerTrace), false, 'release refusal must precede credential delivery');
  assert.equal(existsSync(f.workerTrace), false, 'release refusal must precede worker execution');
}

for (const annotated of [false, true]) test(`publish admits canonical ${annotated ? 'annotated' : 'lightweight'} version tag bound to exact main`, (t) => {
  const f = fixture(t, { annotated }); const result = f.launch();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.brokerTrace), true);
  assert.deepEqual(JSON.parse(readFileSync(f.workerTrace, 'utf8')), { commit: f.head, tag: TAG });
});

test('publish without an explicit release tag refuses before credentials', (t) => {
  const f = fixture(t); refuseBeforeCredentials(f, f.args.slice(0, -2));
});

for (const tag of ['main', 'prod-2026-10-19', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2', 'v1.2.3-rc.1', 'v1.2.3+build', '../v1.2.3']) {
  test(`publish refuses non-release tag ${tag} before credentials`, (t) => {
    const f = fixture(t); const args = [...f.args]; args[args.length - 1] = tag; refuseBeforeCredentials(f, args);
  });
}

test('a valid-looking version absent from the canonical repository refuses before credentials', (t) => {
  const f = fixture(t); const args = [...f.args]; args[args.length - 1] = 'v9.9.9'; refuseBeforeCredentials(f, args);
});

test('a locally existing release tag does not authorize an absent canonical tag', (t) => {
  const f = fixture(t); f.git(f.repo, 'push', 'origin', `:refs/tags/${TAG}`); refuseBeforeCredentials(f);
});

test('a release tag on an earlier green source cannot authorize current main bytes', (t) => {
  const f = fixture(t); f.git(f.repo, 'tag', '-f', TAG, f.older); f.git(f.repo, 'push', '--force', 'origin', `refs/tags/${TAG}`); refuseBeforeCredentials(f);
});

test('a version-named branch cannot impersonate a canonical release tag', (t) => {
  const f = fixture(t); f.git(f.repo, 'push', 'origin', `:refs/tags/${TAG}`);
  f.git(f.repo, 'push', 'origin', `main:refs/heads/${TAG}`); refuseBeforeCredentials(f);
});
