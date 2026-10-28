import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const archiveScript = join(repo, 'scripts/lib/site-build-archive.sh');
const put = (root, path, contents) => { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, contents); };
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout;
};

test('site-build archive ships the sealed staging capture chain without untracked secrets or build output', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-site-archive-'));
  try {
    const source = join(root, 'source'); mkdirSync(source);
    const required = [
      'cms/scripts/capture-staging194.py',
      'scripts/lib/seal-staging193-capture.mjs',
      'scripts/lib/staging193-capture-bundle.mjs',
      'scripts/lib/server-capture-sqlite.mjs',
    ];
    put(source, '.gitignore', 'web/.env\ncms/.env\nweb/node_modules/\nweb/dist/\n');
    put(source, 'web/scripts/capture-content-snapshot.ts', "import('../../scripts/lib/staging193-capture-bundle.mjs');\n");
    put(source, 'cms/src/api/seminar/content-types/seminar/schema.json', '{}');
    put(source, 'cms/scripts/capture-staging194.py', '# fake capture helper\n');
    for (const path of required.slice(1)) put(source, path, readFileSync(join(repo, path)));
    put(source, 'media-originals/example.txt', 'media');
    put(source, 'fixtures/content-snapshot/collapsible_panels.json', '{}');
    put(source, 'fixtures/content-snapshot/url_map.csv', 'url\n');
    run('git', ['-C', source, 'init', '-q']);
    run('git', ['-C', source, 'add', '.']);
    run('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'archive fixture']);
    put(source, 'web/.env', 'SECRET=must-not-be-packed');
    put(source, 'cms/.env', 'SECRET=must-not-be-packed');
    put(source, 'web/node_modules/cache.txt', 'generated');
    put(source, 'web/dist/index.html', 'generated');
    put(source, 'web/untracked-secret.txt', 'untracked');

    const packed = spawnSync('/bin/bash', ['-c', 'source "$1"; site_build_archive "$2"', 'archive-test', archiveScript, source], { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024 });
    assert.equal(packed.status, 0, packed.stderr.toString());
    const archive = join(root, 'site.tar.gz'); writeFileSync(archive, packed.stdout);
    const names = new Set(run('tar', ['-tzf', archive]).split('\n').filter(Boolean));
    assert.ok(names.has('web/scripts/capture-content-snapshot.ts'));
    assert.ok(names.has('cms/src/api/seminar/content-types/seminar/schema.json'));
    assert.ok(names.has('fixtures/content-snapshot/collapsible_panels.json'));
    assert.ok(names.has('fixtures/content-snapshot/url_map.csv'));
    for (const path of ['web/.env', 'cms/.env', 'web/node_modules/cache.txt', 'web/dist/index.html', 'web/untracked-secret.txt']) {
      assert.equal(names.has(path), false, `секреты и выходы сборки не доставляются: ${path}`);
    }
    assert.deepEqual(required.filter(path => !names.has(path)), [], 'готовый архив должен содержать всю цепочку серверного снимка');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
