import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const cmsRoot = resolve(import.meta.dirname, '..');
const cmsRequire = createRequire(join(cmsRoot, 'package.json'));

test('real Strapi 5.51.2 disables notifier during isolated migration construction', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-notifier-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist/config'), { recursive: true });
  writeFileSync(join(root, 'package.json'), readFileSync(join(cmsRoot, 'package.json')));
  const typescript = cmsRequire('typescript');
  const source = readFileSync(join(cmsRoot, 'config/server.ts'), 'utf8');
  const compiled = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS } }).outputText;
  writeFileSync(join(root, 'dist/config/server.js'), compiled);
  const child = `
    const {createRequire} = require('node:module');
    const fs = require('node:fs');
    const [root,cmsRoot] = process.argv.slice(1);
    process.chdir(root);
    const req = createRequire(cmsRoot + '/package.json');
    const strapi = req('@strapi/strapi').createStrapi({appDir:root, distDir:root + '/dist'});
    const updatesEnabled = strapi.config.get('server.logger.updates.enabled');
    const bytes = fs.readFileSync(root + '/.strapi-updater.json', 'utf8');
    process.stdout.write(JSON.stringify({version:req('@strapi/strapi/package.json').version,updatesEnabled,bytes}));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['-e', child, root, cmsRoot], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, IKPK_MIGRATION_CLOSED_LOAD: 'true', STRAPI_TELEMETRY_DISABLED: 'true' },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { version: '5.51.2', updatesEnabled: false, bytes: '{}' });
});
