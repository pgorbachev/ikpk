import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../..');
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function runRestore(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-restore-entry-bypass-'));
  roots.push(root);
  function put(name: string, bytes: string, executable = false) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    if (executable) chmodSync(file, 0o755);
    return file;
  }
  const current = put('site/releases/current-release/index.html', 'CURRENT VERIFIED RELEASE');
  put('backup/current-20260919/index.html', 'UNVERIFIED BACKUP');
  symlinkSync(dirname(current), join(root, 'site/current'));
  put('deploy/environments/stand.env', `SITE_NAME=ikpk\nWEB_ROOT=${root}/site\nCONTENT_BACKUP_DIR=${root}/backup\n`);
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  copyFileSync(source, join(root, 'scripts/restore-server-state.sh'));
  copyFileSync(join(repository, 'scripts/lib/declared.sh'), join(root, 'scripts/lib/declared.sh'));
  // Only adapt GNU rsync/mv mechanics to this macOS test host. No remote access,
  // publication state, SSH credentials or protected launcher is supplied.
  put('bin/rsync', `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(-2);fs.cpSync(a[0],a[1],{recursive:true});\n`, true);
  put('bin/mv', `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(-2);fs.renameSync(a[0],a[1]);\n`, true);
  const run = spawnSync('/bin/bash', [join(root, 'scripts/restore-server-state.sh'), 'stand'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { PATH: `${root}/bin:/usr/bin:/bin`, HOME: root },
  });
  return { run, previous: dirname(current), active: readlinkSync(join(root, 'site/current')) };
}

describe('backup restoration cannot independently publish the web tree', () => {
  it('positive control proves the historical utility activates a backup without the launcher', () => {
    const { run, previous, active } = runRestore(join(repository, 'web/tests/fixtures/manual-publication/legacy-restore-server-state.sh'));
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('predicate=byte-equal-after-restore');
    expect(active).not.toBe(previous);
  });
  it('the current utility leaves the live release unchanged without an approved publication', () => {
    const { run, previous, active } = runRestore(join(repository, 'scripts/restore-server-state.sh'));
    expect(run.error).toBeUndefined();
    expect(active, `independent activation escaped the publication path; exit=${run.status}; ${run.stdout}`).toBe(previous);
  });
});
