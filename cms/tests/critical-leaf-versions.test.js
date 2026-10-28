import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const requiredVersions = {
  handlebars: '4.7.10',
  'fast-uri': '3.1.8',
  zod: '4.6.6',
  undici: '6.28.1',
  axios: '1.20.0',
  nodemailer: '10.0.13',
  qs: '6.16.0',
};

const removedPackages = ['proxy-addr', 'shell-quote'];

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

for (const name of removedPackages) {
  test(`CMS lockfile removes unused ${name} from the dependency graph`, () => {
    const paths = Object.keys(lock.packages).filter((path) => path.split('/').at(-1) === name);
    assert.deepEqual(paths, []);
  });
}
