import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const requiredVersions = {
  handlebars: '4.7.10',
  'proxy-addr': '2.0.8',
  'shell-quote': '1.11.0',
};

const compareVersions = (left, right) => {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < b.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

for (const [name, minimum] of Object.entries(requiredVersions)) {
  test(`CMS lockfile pins patched ${name}`, () => {
    const actual = lock.packages[`node_modules/${name}`]?.version;
    assert.ok(actual, `CMS lockfile does not resolve ${name}`);
    assert.ok(
      compareVersions(actual, minimum) >= 0,
      `CMS lockfile resolves vulnerable ${name}@${actual}; require >= ${minimum}`
    );
  });
}
