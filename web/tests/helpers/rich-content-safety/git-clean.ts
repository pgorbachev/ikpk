import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './paths.js';

export function assertCleanGitWorktree(purpose: string, repoRoot = REPO_ROOT): string {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  if (status.trim()) {
    throw new Error(`${purpose}: dirty worktree, генерация запрещена:\n${status}`);
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
}
