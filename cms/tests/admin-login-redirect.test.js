import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const cmsRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const modulesRoot = resolve(
  process.env.IKPK_CMS_NODE_MODULES ?? resolve(cmsRoot, 'node_modules')
);
const loginConsumer = resolve(
  modulesRoot,
  '@strapi/admin/dist/admin/admin/src/pages/Auth/components/Login.mjs'
);
const loginId = loginConsumer;
const redirectGuardModule = resolve(cmsRoot, 'src/admin/admin-redirect.ts');
const viteConfigModule = resolve(cmsRoot, 'src/admin/vite.config.example.ts');
const redirectPluginModule = resolve(cmsRoot, 'src/admin/admin-login-redirect-plugin.ts');

const adminOrigin = 'https://admin.ikpk.su';

test('safe admin redirect accepts only same-origin internal paths', async () => {
  const { safeAdminRedirect } = await import(pathToFileURL(redirectGuardModule).href);

  assert.equal(typeof safeAdminRedirect, 'function');
  assert.equal(safeAdminRedirect(null, adminOrigin), '/');
  assert.equal(safeAdminRedirect(undefined, adminOrigin), '/');
  assert.equal(safeAdminRedirect('', adminOrigin), '/');
  assert.equal(
    safeAdminRedirect('/content-manager/collection-types/api::article.article?page=2', adminOrigin),
    '/content-manager/collection-types/api::article.article?page=2'
  );
  assert.equal(safeAdminRedirect('/', adminOrigin), '/');

  const rejectedRedirects = [
    ['external HTTPS URL', 'https://attacker.example/'],
    ['protocol-relative URL', '//attacker.example/path'],
    ['backslash URL normalization', '/\\attacker.example/path'],
    ['control character', '/content-manager/\n//attacker.example'],
    ['malformed percent encoding', '/content-manager/%E0%A4%A'],
    // URLSearchParams has already decoded the outer query layer. A second decode
    // would turn this internal-looking value into a protocol-relative URL.
    ['double-encoded protocol-relative URL', '/%2F%2Fattacker.example/path'],
    ['origin text before userinfo separator', 'https://admin.ikpk.su@attacker.example/'],
    ['lookalike origin', 'https://admin.ikpk.su.attacker.example/'],
  ];

  for (const [label, redirectTo] of rejectedRedirects) {
    assert.equal(safeAdminRedirect(redirectTo, adminOrigin), '/', label);
  }
});

test(
  'the pinned Strapi login consumer is transformed to call the guard after login',
  {
    skip: !existsSync(loginConsumer) &&
      'CMS node_modules is not installed; set IKPK_CMS_NODE_MODULES to a matching physical graph',
  },
  async () => {
    assert.ok(existsSync(loginConsumer), `Missing pinned Strapi login consumer ${loginConsumer}`);
    assert.ok(existsSync(viteConfigModule), `Missing admin Vite config ${viteConfigModule}`);

    const loginSource = readFileSync(loginConsumer, 'utf8');
    const viteConfigSource = readFileSync(viteConfigModule, 'utf8');
    assert.match(loginSource, /const redirectTo = query\.get\('redirectTo'\);/);
    assert.match(loginSource, /const redirectUrl = redirectTo \? decodeURIComponent\(redirectTo\) : '\/';/);
    assert.match(loginSource, /navigate\(redirectUrl\);/);

    assert.match(viteConfigSource, /createAdminLoginRedirectPlugin/);
    assert.match(viteConfigSource, /plugins\s*:\s*\[[^\]]*createAdminLoginRedirectPlugin/s);

    const { createAdminLoginRedirectPlugin } = await import(pathToFileURL(redirectPluginModule).href);
    const redirectPlugin = createAdminLoginRedirectPlugin();
    assert.equal(redirectPlugin.name, 'ikpk-safe-strapi-admin-redirect');
    assert.equal(typeof redirectPlugin.transform, 'function');

    const transformed = await redirectPlugin.transform(loginSource, loginId);
    assert.ok(transformed, 'The transform must handle the exact pinned Strapi Login module');
    const transformedCode = typeof transformed === 'string' ? transformed : transformed.code;
    assert.match(transformedCode, /safeAdminRedirect\(redirectTo, window\.location\.origin\)/);
    assert.match(transformedCode, /navigate\(redirectUrl\);/);
    assert.doesNotMatch(transformedCode, /decodeURIComponent\(redirectTo\)/);
  }
);
