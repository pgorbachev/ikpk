import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('describes legacy output and media processing without claiming to update the current build', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-refresh-catalog-'));
  try {
    const scripts = join(root, 'web', 'scripts');
    const lib = join(scripts, 'lib');
    const dump = join(root, 'legacy');
    mkdirSync(lib, { recursive: true });
    mkdirSync(dump);
    mkdirSync(join(root, 'migration'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'migration', 'legacy-transfer-dir.json'), '{"relativeDir":"legacy"}');
    for (const file of ['seminars.json', 'course_groups.json', 'teachers.json', 'schedule_entries.json']) {
      writeFileSync(join(dump, file), '[]');
    }
    copyFileSync(join(webDir, 'scripts/refresh-catalog.ts'), join(scripts, 'refresh-catalog.ts'));
    for (const file of ['seminar-sections.ts', 'planned-seminars.ts', 'legacy-transfer-dir.ts']) {
      copyFileSync(join(webDir, 'scripts', 'lib', file), join(lib, file));
    }
    const code = `
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ pagesCount: 1, totalCount: 0, items: [] }) });
      await import(${JSON.stringify(pathToFileURL(join(scripts, 'refresh-catalog.ts')).href)});
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: webDir, encoding: 'utf8', timeout: 15000,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    const output = result.stdout;
    expect(output).toMatch(/legacy|историческ/i);
    expect(output).toMatch(/медиа/i);
    expect(output).toMatch(/не\s+(?:обновляет|используется|влияет)[^\n]*(?:сборк|сним)/i);
    expect(output).not.toMatch(/иначе сборка сошлётся/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
