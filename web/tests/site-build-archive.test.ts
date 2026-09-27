/**
 * Доставка дерева сборки берёт архив коммита, а не рабочий каталог.
 *
 * `git status --porcelain` не показывает игнорируемые файлы. Прежний `tar` рабочего
 * каталога увозил бы web/.env на стенд, хотя объявленный SHA этого файла не содержит.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..');
const LIB = join(REPO, 'scripts', 'lib', 'site-build-archive.sh');
const BOOTSTRAP = join(REPO, 'scripts', 'bootstrap-vps.sh');

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

describe('архив дерева сборки', () => {
  it('игнорируемый .env не входит в доставку, хотя status чист', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ikpk-archive-'));
    const dest = mkdtempSync(join(tmpdir(), 'ikpk-archive-out-'));
    try {
      mkdirSync(join(repo, 'web'), { recursive: true });
      mkdirSync(join(repo, 'media-originals'), { recursive: true });
      writeFileSync(join(repo, 'web', '.gitignore'), '.env\n.env.production\n');
      writeFileSync(join(repo, 'web', 'package-lock.json'), '{"name":"web"}\n');
      writeFileSync(join(repo, 'media-originals', '.gitkeep'), '');
      execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
      git(repo, ['config', 'user.email', 'fixture@example.com']);
      git(repo, ['config', 'user.name', 'fixture']);
      git(repo, ['add', 'web', 'media-originals']);
      git(repo, ['commit', '-m', 'fixture']);
      writeFileSync(join(repo, 'web', '.env'), 'SECRET=operator\n');
      writeFileSync(join(repo, 'web', '.env.production'), 'SECRET=production\n');

      const porcelain = git(repo, ['status', '--porcelain', '--', 'web', 'media-originals']);
      expect(porcelain, 'игнорируемый .env не должен делать статус грязным').toBe('');

      const worktreeList = execFileSync(
        'tar',
        ['-C', repo, '-tf', '-'],
        { encoding: 'utf8', input: execFileSync('tar', ['-C', repo, '-cf', '-', 'web', 'media-originals']) },
      );
      expect(worktreeList, 'фикстура не содержит дыру tar рабочего каталога').toContain('web/.env');

      const script = `set -euo pipefail\nsource ${JSON.stringify(LIB)}\nsite_build_archive ${JSON.stringify(repo)}\n`;
      const archive = execFileSync('bash', ['-c', script], { encoding: 'buffer' });
      execFileSync('tar', ['-C', dest, '-xzf', '-'], { input: archive });

      expect(existsSync(join(dest, 'web', 'package-lock.json'))).toBe(true);
      expect(existsSync(join(dest, 'web', '.env'))).toBe(false);
      expect(existsSync(join(dest, 'web', '.env.production'))).toBe(false);
      expect(readFileSync(join(dest, 'web', 'package-lock.json'), 'utf8')).toContain('"name":"web"');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('провижининг вызывает архив коммита, а не tar рабочего каталога', () => {
    const bootstrap = readFileSync(BOOTSTRAP, 'utf8');
    expect(bootstrap).toContain('source "$ROOT/scripts/lib/site-build-archive.sh"');
    expect(bootstrap).toContain('site_build_archive "$ROOT"');
    expect(bootstrap).not.toContain('tar -C "$ROOT"');
  });
});
