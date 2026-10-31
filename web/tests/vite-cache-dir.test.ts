import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

const webRoot = resolve(import.meta.dirname, '..');

describe('Astro build cache', () => {
  it('keeps the Vite dependency cache in the writable build workspace', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const config = (await import('./astro.config.mjs')).default;
      process.stdout.write(JSON.stringify(config.vite?.cacheDir ?? null));
    `], {
      cwd: webRoot,
      env: {
        ...process.env,
        CONTENT_SNAPSHOT_DIR: resolve(webRoot, '../fixtures/content-snapshot'),
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const cacheDir = JSON.parse(result.stdout) as string | null;
    expect(cacheDir).toBe(join(webRoot, '.vite-cache'));
    expect(isAbsolute(cacheDir ?? '')).toBe(true);
    expect(cacheDir).not.toContain('/node_modules/');
  });
});
