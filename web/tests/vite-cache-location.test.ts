import { describe, expect, it } from 'vitest';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import astroConfig from '../astro.config.mjs';

const webRoot = dirname(fileURLToPath(new URL('../astro.config.mjs', import.meta.url)));
const dependencies = join(webRoot, 'node_modules');

// On production the CMS refresh build runs with `web/node_modules` symlinked into
// a read-only release. Any cache that defaults under `node_modules` fails there
// with EROFS (Astro 7.4 sync writes `<cacheDir>/vite-sync/`), so every cache
// directory must resolve inside the writable workspace.
const writableCache = (label: string, value: string | URL | undefined) => {
  expect(value, `${label} must be set explicitly`).toBeDefined();
  const path = resolve(webRoot, value instanceof URL ? fileURLToPath(value) : value!);
  expect(path.startsWith(webRoot + sep), `${label} = ${path}`).toBe(true);
  expect(path === dependencies || path.startsWith(dependencies + sep), `${label} = ${path}`).toBe(false);
};

describe('Cache placement', () => {
  it('keeps the Vite cache outside the symlinked dependency tree', () => {
    writableCache('vite.cacheDir', astroConfig.vite?.cacheDir);
  });

  it('keeps the Astro cache outside the symlinked dependency tree', () => {
    writableCache('cacheDir', astroConfig.cacheDir);
  });
});
