import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import astroConfig from '../astro.config.mjs';

const webRoot = dirname(fileURLToPath(new URL('../astro.config.mjs', import.meta.url)));

describe('Vite cache placement', () => {
  it('keeps the cache outside the symlinked dependency tree', () => {
    expect(astroConfig.vite?.cacheDir).toBe(join(webRoot, '.astro', 'vite-cache'));
    expect(astroConfig.vite?.cacheDir).not.toBe(join(webRoot, 'node_modules', '.vite'));
  });
});
