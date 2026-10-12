import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

// The current Strapi 5 admin graph is React Router 6. These floors cover
// GHSA-jjmj-jmhj-qwj2 only. GHSA-wrjc-x8rr-h8h6 still affects React Router 6;
// this test does not claim that 6.30.6 fully mitigates React Router advisories.
const routerFloor = '6.30.6';
const markdownItFloor = '14.3.1';
const cmsRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const lock = JSON.parse(readFileSync(resolve(cmsRoot, 'package-lock.json'), 'utf8'));
const modulesRoot = resolve(
  process.env.IKPK_CMS_NODE_MODULES ?? resolve(cmsRoot, 'node_modules')
);
const hasInstalledGraph = existsSync(modulesRoot);

const consumers = {
  adminRouter: resolve(
    modulesRoot,
    '@strapi/admin/dist/admin/admin/src/core/apis/router.js'
  ),
  adminLogin: resolve(
    modulesRoot,
    '@strapi/admin/dist/admin/admin/src/pages/Auth/components/Login.js'
  ),
  markdownRenderer: resolve(
    modulesRoot,
    '@strapi/content-manager/dist/admin/pages/EditView/components/FormInputs/Wysiwyg/utils/mdRenderer.js'
  ),
};

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function readPackageMetadata(entry, expectedName) {
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

const lockedFloors = [
  ['node_modules/react-router-dom', 'react-router-dom', routerFloor],
  ['node_modules/react-router', 'react-router', routerFloor],
  ['node_modules/markdown-it', 'markdown-it', markdownItFloor],
];

for (const [packagePath, name, minimum] of lockedFloors) {
  test(`CMS lock resolves ${name} at compatible floor ${minimum}+`, () => {
    const actual = lock.packages[packagePath]?.version;
    assert.ok(actual, `CMS lockfile does not resolve ${packagePath}`);
    assert.ok(
      compareVersions(actual, minimum) >= 0,
      `CMS lockfile resolves ${packagePath} to ${name}@${actual}; require >= ${minimum}`
    );
    if (name.startsWith('react-router')) {
      assert.equal(actual.split('.')[0], '6', `${name} must remain on Strapi's React Router 6 family`);
    }
  });
}

test(
  'Strapi admin login and router consumers resolve React Router 6.30.6 or later in the 6.x family',
  { skip: !hasInstalledGraph && 'CMS node_modules is not installed; run with IKPK_CMS_NODE_MODULES for a matching physical graph' },
  () => {
    for (const consumerPath of [consumers.adminLogin, consumers.adminRouter]) {
      assert.ok(existsSync(consumerPath), `Missing Strapi admin consumer ${consumerPath}`);
    }

    const loginSource = readFileSync(consumers.adminLogin, 'utf8');
    const routerSource = readFileSync(consumers.adminRouter, 'utf8');
    assert.match(loginSource, /decodeURIComponent\(redirectTo\)/);
    assert.match(loginSource, /navigate\(redirectUrl\)/);
    assert.match(routerSource, /createBrowserRouter/);

    const routerDomEntry = createRequire(consumers.adminRouter).resolve('react-router-dom');
    const routerEntry = createRequire(routerDomEntry).resolve('react-router');
    const routerDom = readPackageMetadata(routerDomEntry, 'react-router-dom');
    const router = readPackageMetadata(routerEntry, 'react-router');

    assert.equal(routerDom.metadata.version.split('.')[0], '6');
    assert.equal(router.metadata.version.split('.')[0], '6');
    assert.equal(routerDom.metadata.version, router.metadata.version);
    for (const resolved of [routerDom, router]) {
      assert.ok(
        compareVersions(resolved.metadata.version, routerFloor) >= 0,
        `${resolved.metadata.name} resolves ${resolved.metadata.version}; require >= ${routerFloor} in 6.x`
      );
    }
    assert.ok(realpathSync(routerDom.directory).startsWith(realpathSync(modulesRoot)));
    assert.ok(realpathSync(router.directory).startsWith(realpathSync(modulesRoot)));
  }
);

test(
  'Strapi admin navigation APIs remain available from the 6.x router family',
  { skip: !hasInstalledGraph && 'CMS node_modules is not installed; run with IKPK_CMS_NODE_MODULES for a matching physical graph' },
  async () => {
    const routerDomEntry = createRequire(consumers.adminRouter).resolve('react-router-dom');
    const routerDom = await import(pathToFileURL(routerDomEntry).href);

    assert.equal(typeof routerDom.createBrowserRouter, 'function');
    assert.equal(typeof routerDom.createMemoryRouter, 'function');
    assert.equal(typeof routerDom.useNavigate, 'function');
    const memoryRouter = routerDom.createMemoryRouter([{ path: '/', element: null }]);
    assert.equal(memoryRouter.state.location.pathname, '/');
    memoryRouter.dispose();
  }
);

test(
  'Strapi WYSIWYG consumer resolves markdown-it at the compatible 14.3.1 floor',
  { skip: !hasInstalledGraph && 'CMS node_modules is not installed; run with IKPK_CMS_NODE_MODULES for a matching physical graph' },
  () => {
    assert.ok(existsSync(consumers.markdownRenderer), `Missing Strapi WYSIWYG consumer ${consumers.markdownRenderer}`);
    const source = readFileSync(consumers.markdownRenderer, 'utf8');
    assert.match(source, /require\(['"]markdown-it['"]\)/);
    assert.match(source, /linkify:\s*true/);

    const markdownItEntry = createRequire(consumers.markdownRenderer).resolve('markdown-it');
    const markdownItPackage = readPackageMetadata(markdownItEntry, 'markdown-it');
    assert.ok(
      compareVersions(markdownItPackage.metadata.version, markdownItFloor) >= 0,
      `Strapi WYSIWYG resolves markdown-it@${markdownItPackage.metadata.version}; require >= ${markdownItFloor}`
    );
    assert.ok(realpathSync(markdownItPackage.directory).startsWith(realpathSync(modulesRoot)));
  }
);

test(
  'markdown-it linkify rendering remains compatible for WYSIWYG previews',
  { skip: !hasInstalledGraph && 'CMS node_modules is not installed; run with IKPK_CMS_NODE_MODULES for a matching physical graph' },
  () => {
    const markdownItEntry = createRequire(consumers.markdownRenderer).resolve('markdown-it');
    const markdownItRequire = createRequire(markdownItEntry);
    const MarkdownIt = markdownItRequire('markdown-it');
    const md = new MarkdownIt({ linkify: true });

    assert.match(md.render('Visit https://example.test'), /<a href="https:\/\/example\.test">https:\/\/example\.test<\/a>/);
  }
);
