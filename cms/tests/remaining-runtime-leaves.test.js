const assert = require('node:assert/strict');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, relative, resolve } = require('node:path');
const { test } = require('node:test');

const cmsPackagePath = require.resolve('../package.json');
const cmsRoot = dirname(cmsPackagePath);
const cmsRequire = createRequire(cmsPackagePath);
const lock = JSON.parse(readFileSync(resolve(cmsRoot, 'package-lock.json'), 'utf8'));
const hasInstalledGraph = existsSync(resolve(cmsRoot, 'node_modules'));
const installedCmsRoot = hasInstalledGraph
  ? dirname(realpathSync(resolve(cmsRoot, 'node_modules')))
  : cmsRoot;

const lockedFloors = [
  ['node_modules/brace-expansion', 'brace-expansion', '5.0.12'],
  ['node_modules/broadcast-channel/node_modules/brace-expansion', 'brace-expansion', '1.1.21'],
  ['node_modules/fork-ts-checker-webpack-plugin/node_modules/brace-expansion', 'brace-expansion', '1.1.21'],
  ['node_modules/nodemon/node_modules/brace-expansion', 'brace-expansion', '1.1.21'],
  ['node_modules/browserslist', 'browserslist', '4.28.7'],
  ['node_modules/js-yaml', 'js-yaml', '4.3.2'],
  ['node_modules/lodash-es', 'lodash-es', '4.18.0'],
  ['node_modules/nanoid', 'nanoid', '3.3.18'],
  ['node_modules/postcss', 'postcss', '8.5.23'],
  ['node_modules/source-map-js', 'source-map-js', '1.2.2'],
];

const consumers = [
  ['minimatch', null, 'brace-expansion', 'node_modules/brace-expansion', '5.0.12'],
  ['broadcast-channel', 'minimatch', 'brace-expansion', 'node_modules/broadcast-channel/node_modules/brace-expansion', '1.1.21'],
  ['fork-ts-checker-webpack-plugin', 'minimatch', 'brace-expansion', 'node_modules/fork-ts-checker-webpack-plugin/node_modules/brace-expansion', '1.1.21'],
  ['nodemon', 'minimatch', 'brace-expansion', 'node_modules/nodemon/node_modules/brace-expansion', '1.1.21'],
  ['@babel/helper-compilation-targets', null, 'browserslist', 'node_modules/browserslist', '4.28.7'],
  ['@strapi/strapi', null, 'browserslist', 'node_modules/browserslist', '4.28.7'],
  ['webpack', null, 'browserslist', 'node_modules/browserslist', '4.28.7'],
  ['load-yaml-file', null, 'js-yaml', 'node_modules/js-yaml', '4.3.2'],
  ['formik', null, 'lodash-es', 'node_modules/lodash-es', '4.18.0'],
  ['yup', null, 'lodash-es', 'node_modules/lodash-es', '4.18.0'],
  ['postcss', null, 'nanoid', 'node_modules/nanoid', '3.3.18'],
  ['vite', null, 'postcss', 'node_modules/postcss', '8.5.23'],
  ['css-loader', null, 'postcss', 'node_modules/postcss', '8.5.23'],
  ['postcss', null, 'source-map-js', 'node_modules/source-map-js', '1.2.2'],
];

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function packageRoot(entry, expectedName) {
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    const packageJson = resolve(directory, 'package.json');
    if (existsSync(packageJson)) {
      const metadata = JSON.parse(readFileSync(packageJson, 'utf8'));
      if (metadata.name === expectedName) return { directory, metadata };
    }
    directory = dirname(directory);
  }
  assert.fail(`Could not find package metadata for ${expectedName} from ${entry}`);
}

for (const [packagePath, name, minimum] of lockedFloors) {
  test(`CMS lock raises ${packagePath} (${name}) to ${minimum}+`, () => {
    const actual = lock.packages[packagePath]?.version;
    assert.ok(actual, `CMS lockfile does not resolve ${packagePath}`);
    assert.ok(
      compareVersions(actual, minimum) >= 0,
      `CMS lockfile resolves ${packagePath} to vulnerable ${name}@${actual}; require >= ${minimum}`
    );
  });
}

for (const [consumer, via, name, expectedPath, minimum] of consumers) {
  test(
    `installed ${consumer}${via ? ` -> ${via}` : ''} resolves patched ${name} from ${expectedPath}`,
    { skip: !hasInstalledGraph && 'CMS node_modules is not installed in this RED worktree' },
    () => {
      const consumerEntry = cmsRequire.resolve(consumer);
      const consumerRequire = createRequire(consumerEntry);
      const dependencyEntry = via
        ? createRequire(consumerRequire.resolve(via)).resolve(name)
        : consumerRequire.resolve(name);
      const resolved = packageRoot(dependencyEntry, name);

      assert.equal(relative(installedCmsRoot, realpathSync(resolved.directory)), expectedPath);
      assert.ok(
        compareVersions(resolved.metadata.version, minimum) >= 0,
        `${consumer} resolves ${name}@${resolved.metadata.version}; require >= ${minimum}`
      );
    }
  );
}

test(
  'lodash-es 4.18 preserves the CMS admin consumer APIs used for omit and unset',
  { skip: !hasInstalledGraph && 'CMS node_modules is not installed in this RED worktree' },
  async () => {
    const { omit, unset } = await import('lodash-es');
    assert.deepEqual(omit({ keep: 1, remove: 2 }, ['remove']), { keep: 1 });

    const value = { nested: { keep: true, remove: true } };
    assert.equal(unset(value, ['nested', 'remove']), true);
    assert.deepEqual(value, { nested: { keep: true } });
  }
);

test(
  'js-yaml 4.3.2 retains deterministic load and dump behavior for CMS metadata',
  { skip: !hasInstalledGraph && 'CMS node_modules is not installed in this RED worktree' },
  () => {
    const yaml = cmsRequire('js-yaml');
    const source = 'title: IKPK\ncount: 2\n';
    assert.deepEqual(yaml.load(source), { title: 'IKPK', count: 2 });
    assert.equal(yaml.dump({ title: 'IKPK', count: 2 }), source);
  }
);
