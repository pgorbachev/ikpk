import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

const PINNED_ADMIN_VERSION = '5.51.2';
const PINNED_LOGIN_SHA256 = '0410dba55b124ef78a6ff8cd81177ae7eaf7d1251668151ab504c081a977334c';
const ORIGINAL_REDIRECT = "const redirectUrl = redirectTo ? decodeURIComponent(redirectTo) : '/';";
const SAFE_REDIRECT = 'const redirectUrl = safeAdminRedirect(redirectTo, window.location.origin);';
const LOGIN_MODULE_SUFFIX = '/@strapi/admin/dist/admin/admin/src/pages/Auth/components/Login.mjs';
const require = createRequire(import.meta.url);

function getPinnedLoginModule(): string {
  const packageJsonPath = require.resolve('@strapi/admin/package.json');
  const adminPackage = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  if (adminPackage.version !== PINNED_ADMIN_VERSION) {
    throw new Error(
      `Expected @strapi/admin ${PINNED_ADMIN_VERSION}, found ${adminPackage.version ?? 'unknown'}`
    );
  }

  const loginPath = realpathSync(resolve(
    dirname(packageJsonPath),
    'dist/admin/admin/src/pages/Auth/components/Login.mjs'
  ));
  const source = readFileSync(loginPath, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== PINNED_LOGIN_SHA256) {
    throw new Error('Pinned Strapi Login.mjs source changed; review the redirect transform before upgrading');
  }
  if (source.split(ORIGINAL_REDIRECT).length !== 2) {
    throw new Error('Pinned Strapi Login.mjs must contain exactly one known redirect expression');
  }

  return loginPath;
}

export function createAdminLoginRedirectPlugin(): Plugin {
  let loginPath = getPinnedLoginModule();
  let transformCount = 0;

  return {
    name: 'ikpk-safe-strapi-admin-redirect',
    enforce: 'pre',
    buildStart() {
      loginPath = getPinnedLoginModule();
      transformCount = 0;
    },
    transform(code, id) {
      if (id.includes('\0')) return null;
      const sourcePath = id.split('?')[0];
      if (!sourcePath.replaceAll('\\', '/').endsWith(LOGIN_MODULE_SUFFIX)) return null;

      const modulePath = realpathSync(resolve(sourcePath));
      if (modulePath !== loginPath) return null;

      const actualHash = createHash('sha256').update(code).digest('hex');
      if (actualHash !== PINNED_LOGIN_SHA256 || code.split(ORIGINAL_REDIRECT).length !== 2) {
        this.error('Pinned Strapi Login.mjs no longer matches the reviewed redirect transform');
      }
      if (transformCount !== 0) {
        this.error('Pinned Strapi Login.mjs was transformed more than once');
      }

      transformCount += 1;
      const helperPath = resolve(process.cwd(), 'src/admin/admin-redirect.ts');
      return {
        code: `import { safeAdminRedirect } from ${JSON.stringify(helperPath)};\n${code.replace(ORIGINAL_REDIRECT, SAFE_REDIRECT)}`,
        map: null,
      };
    },
    generateBundle() {
      if (transformCount !== 1) {
        this.error('Expected exactly one pinned Strapi Login.mjs transform; refusing to build an unguarded admin login');
      }
    },
  };
}
