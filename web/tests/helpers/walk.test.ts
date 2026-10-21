import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walkFiles } from './walk';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-walk-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('walkFiles', () => {
  it('lists nested matching files and follows directory and file symlinks', () => {
    const root = fixture();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    writeFileSync(join(root, 'page.html'), 'page');
    writeFileSync(join(root, 'notes.txt'), 'ignored');
    writeFileSync(join(nested, 'index.html'), 'nested');
    symlinkSync(nested, join(root, 'linked-dir'), 'dir');
    symlinkSync(join(root, 'page.html'), join(root, 'alias.html'));

    expect([...walkFiles(root, ['.html'])].map((file) => file.slice(root.length + 1)).sort()).toEqual([
      'alias.html',
      'linked-dir/index.html',
      'nested/index.html',
      'page.html',
    ]);
  });

  it('fails closed on a broken symlink', () => {
    const root = fixture();
    symlinkSync(join(root, 'missing-target'), join(root, 'broken.html'));

    expect(() => [...walkFiles(root, ['.html'])]).toThrow();
  });
});
