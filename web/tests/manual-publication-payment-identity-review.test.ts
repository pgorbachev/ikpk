import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const webRoot = resolve(import.meta.dirname, '..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Role = 'stand' | 'prod';
const identity = { stand: { mode: 'test', shopId: '1440249' }, prod: { mode: 'prod', shopId: '409285' } };

// Exercise the real fixed assertion suite. Config and destination response agree;
// only the accepted role's normative identity can detect these substitutions.
function run(role: Role, configured: { mode: string; shopId: string }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ikpk-role-identity-review-'))); roots.push(root);
  const web = join(root, 'web');
  for (const path of ['tests/publication', 'tests/helpers', 'dist']) mkdirSync(join(web, path), { recursive: true });
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  for (const path of ['vitest.publication.config.ts', 'tests/publication/payment-readiness.test.ts', 'tests/publication/helpers.ts', 'tests/helpers/dist-pages.ts', 'tests/helpers/walk.ts']) copyFileSync(join(webRoot, path), join(web, path));
  copyFileSync(join(webRoot, '../scripts/lib/deploy-checks.sh'), join(root, 'scripts/lib/deploy-checks.sh'));
  symlinkSync(join(webRoot, 'node_modules'), join(web, 'node_modules'));
  const endpoint = 'https://payments.example.invalid/api';
  writeFileSync(join(web, 'dist/index.html'), `<main data-payment-role="${role}"><form data-payment-form data-payment-endpoint="${endpoint}"></form></main>`);
  const response = join(root, 'readiness.json');
  writeFileSync(response, JSON.stringify({ status: 200, contentType: 'application/json', body: { status: 'ready', ...configured } }));
  const report = join(root, 'report.json');
  const result = spawnSync(process.execPath, [join(webRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.publication.config.ts', 'tests/publication/payment-readiness.test.ts', '--reporter=json', `--outputFile=${report}`], {
    cwd: web, encoding: 'utf8', timeout: 20_000,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: root,
      PUBLICATION_TREE_DIR: join(web, 'dist'), PAYMENT_ROLE: role,
      // CRM mode is intentionally opposite. Payment identity must follow PAYMENT_ROLE.
      DEPLOY_MODE: role === 'stand' ? 'prod' : 'stand', PUBLICATION_PAYMENT_ENDPOINT: endpoint,
      PUBLICATION_PAYMENT_MODE: configured.mode, PUBLICATION_PAYMENT_SHOP_ID: configured.shopId,
      PUBLICATION_PAYMENT_SITE_ORIGIN: 'https://site.example.invalid', PUBLICATION_PAYMENT_READY_RESPONSE_FILE: response },
  });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  const assertions = parsed.testResults.flatMap((suite: { assertionResults: { fullName: string; status: string }[] }) => suite.assertionResults);
  expect(assertions).toHaveLength(2);
  return { exitCode: result.status, assertions };
}

describe('payment identity is bound to accepted role independently of CRM deployment mode', () => {
  it.each(['stand', 'prod'] as const)('%s canonical identity succeeds with the opposite CRM mode', (role) => {
    const result = run(role, identity[role]);
    expect(result.exitCode).toBe(0);
    expect(result.assertions.every((assertion: { status: string }) => assertion.status === 'passed')).toBe(true);
  });
  it.each(['stand', 'prod'] as const)('%s refuses the other role mode even when config and VPS agree', (role) => {
    const configured = { ...identity[role], mode: role === 'stand' ? 'prod' : 'test' };
    const result = run(role, configured);
    expect(result.exitCode, JSON.stringify(result.assertions)).not.toBe(0);
  });
  it.each(['stand', 'prod'] as const)('%s refuses a foreign shop even when config and VPS agree', (role) => {
    const result = run(role, { ...identity[role], shopId: '9999999' });
    expect(result.exitCode, JSON.stringify(result.assertions)).not.toBe(0);
  });
});
