import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Stub fetch inside the child: the test must never contact the production site.
function warningFor(baseUrl: string): string {
  const script = `
    process.argv = ['node', 'validate-urls.ts', '--base-url', ${JSON.stringify(baseUrl)}];
    globalThis.fetch = async () => ({ status: 200, headers: new Headers() });
    await import(${JSON.stringify(pathToFileURL(resolve(scriptsDir, 'validate-urls.ts')).href)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: scriptsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  });
  if (child.error) throw child.error;
  expect(child.signal).toBeNull();
  expect(child.stdout).toContain(`Base URL: ${baseUrl.replace(/\/+$/, '')}`);
  return child.stderr;
}

describe('validate-urls production warning', () => {
  it.each(['https://ikpk.su', 'https://www.ikpk.su/'])(
    'warns that %s checks the deployed target, without assuming which site is live',
    (baseUrl) => {
      const warning = warningFor(baseUrl);
      expect(warning).toMatch(/прод-домен/i);
      expect(warning).toMatch(/сборк/i);
      expect(warning).not.toMatch(/до переключения DNS|отвечает старым сайтом|только после переключения/i);
      expect(warning).toMatch(/проверь|убед/i);
    },
  );

  it('does not warn for the staging target', () => {
    expect(warningFor('https://staging.ikpk.su')).not.toMatch(/прод-домен/i);
  });
});
