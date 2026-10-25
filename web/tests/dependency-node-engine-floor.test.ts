import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Version = [number, number, number];
type JsonObject = Record<string, unknown>;

function object(value: unknown, description: string): JsonObject {
  expect(value, `${description} must be an object`).toBeTypeOf('object');
  expect(value, `${description} must not be null`).not.toBeNull();
  expect(Array.isArray(value), `${description} must not be an array`).toBe(false);
  return value as JsonObject;
}

function nodeFloor(enginesValue: unknown, description: string): { range: string; version: Version } {
  const engines = object(enginesValue, `${description}.engines`);
  const range = engines.node;
  expect(range, `${description}.engines.node must be a string`).toBeTypeOf('string');
  expect(range, `${description}.engines.node must use the supported >=X.Y.Z format`).toMatch(/^>=\d+\.\d+\.\d+$/);

  const match = /^(?:>=)(\d+)\.(\d+)\.(\d+)$/.exec(range as string);
  expect(match, `${description}.engines.node must contain a complete numeric version`).not.toBeNull();
  return {
    range: range as string,
    version: [Number(match![1]), Number(match![2]), Number(match![3])],
  };
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

describe('web Node engine floor', () => {
  it('is at least the installed Astro package Node engine floor', () => {
    const packageJson = object(JSON.parse(readFileSync(join(WEB_ROOT, 'package.json'), 'utf8')), 'web/package.json');
    const packageLock = object(JSON.parse(readFileSync(join(WEB_ROOT, 'package-lock.json'), 'utf8')), 'web/package-lock.json');
    const packages = object(packageLock.packages, 'web/package-lock.json.packages');
    const lockRoot = object(packages[''], 'web/package-lock.json.packages[""]');
    const astro = object(packages['node_modules/astro'], 'web/package-lock.json.packages["node_modules/astro"]');

    const packageFloor = nodeFloor(packageJson.engines, 'web/package.json');
    const lockRootFloor = nodeFloor(lockRoot.engines, 'web/package-lock.json root package');
    const astroFloor = nodeFloor(astro.engines, 'web/package-lock.json Astro package');

    expect(
      compareVersions(packageFloor.version, lockRootFloor.version),
      `web/package.json declares ${packageFloor.range}, but the package-lock root declares ${lockRootFloor.range}`,
    ).toBe(0);
    expect(
      compareVersions(packageFloor.version, astroFloor.version),
      `web Node floor ${packageFloor.range} must be at least installed Astro's ${astroFloor.range}`,
    ).toBeGreaterThanOrEqual(0);
  });
});
