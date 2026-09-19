import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const webRoot = resolve(import.meta.dirname, '..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const READINESS = 'read-only readiness reports the trusted service mode and shop';
const ENDPOINT = 'active artifact declares exactly the trusted payment endpoint and role';
const good = { status: 200, contentType: 'application/json; charset=utf-8', body: { status: 'ready', mode: 'test', shopId: '1440249' } };
const SECRET = 'never-report-remote-payment-secret-52a9';

// Run the actual assertion suite in an isolated miniature artifact. No Astro build,
// no HTTP server and no replacement assertion functions. The curl trap provides a
// contradictory green operator response: accepting it proves the wrong host was read.
function runSuite(observed: unknown, options: { legacyUrl?: boolean; wrongEndpoint?: boolean; role?: 'stand' | 'prod' } = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ikpk-readiness-suite-'))); roots.push(temp);
  const root = join(temp, 'web'); const bin = join(temp, 'bin');
  for (const directory of ['tests/publication', 'tests/helpers', 'dist']) mkdirSync(join(root, directory), { recursive: true });
  mkdirSync(bin); mkdirSync(join(temp, 'scripts/lib'), { recursive: true });
  for (const path of ['vitest.publication.config.ts', 'tests/publication/payment-readiness.test.ts', 'tests/publication/helpers.ts', 'tests/helpers/dist-pages.ts', 'tests/helpers/walk.ts']) copyFileSync(join(webRoot, path), join(root, path));
  copyFileSync(join(webRoot, '../scripts/lib/deploy-checks.sh'), join(temp, 'scripts/lib/deploy-checks.sh'));
  symlinkSync(join(webRoot, 'node_modules'), join(root, 'node_modules'));
  const role = options.role ?? 'stand';
  const endpoint = 'https://payments.test.invalid/api';
  writeFileSync(join(root, 'dist/index.html'), `<main data-payment-role="${role}"><form data-payment-form data-payment-endpoint="${options.wrongEndpoint ? 'https://foreign.invalid/api' : endpoint}"></form></main>`);
  const responseFile = join(temp, 'readiness-response.json'); writeFileSync(responseFile, JSON.stringify(observed));
  const trace = join(temp, 'operator-curl.log');
  const curl = join(bin, 'curl');
  writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${trace}'\nprintf '%s\\n200\\tapplication/json' '{"status":"ready","mode":"${role === 'prod' ? 'prod' : 'test'}","shopId":"${role === 'prod' ? '409285' : '1440249'}"}'\n`); chmodSync(curl, 0o700);
  const reportFile = join(temp, 'report.json');
  const result = spawnSync(process.execPath, [join(webRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.publication.config.ts', 'tests/publication/payment-readiness.test.ts', '--reporter=json', `--outputFile=${reportFile}`], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: temp, TMPDIR: temp,
      PUBLICATION_TREE_DIR: join(root, 'dist'), PAYMENT_ROLE: role, PUBLICATION_PAYMENT_ENDPOINT: endpoint,
      PUBLICATION_PAYMENT_MODE: role === 'prod' ? 'prod' : 'test', PUBLICATION_PAYMENT_SHOP_ID: role === 'prod' ? '409285' : '1440249', PUBLICATION_PAYMENT_SITE_ORIGIN: 'https://site.test.invalid',
      PUBLICATION_PAYMENT_READY_RESPONSE_FILE: responseFile,
      ...(options.legacyUrl === false ? {} : { PUBLICATION_PAYMENT_READY_URL: 'https://operator.invalid/readyz' }),
    },
  });
  expect(result.error, 'the real Vitest subprocess must complete').toBeUndefined();
  expect(result.signal).toBeNull(); expect(existsSync(reportFile), result.stderr).toBe(true);
  const rawReport = readFileSync(reportFile, 'utf8');
  const report = JSON.parse(rawReport) as { testResults: { assertionResults: { fullName: string; status: string }[] }[] };
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
  expect(assertions.map((item) => item.fullName)).toEqual([ENDPOINT, READINESS]);
  return { status: result.status, output: result.stdout + result.stderr + rawReport,
    endpoint: assertions.find((item) => item.fullName === ENDPOINT)!.status,
    readiness: assertions.find((item) => item.fullName === READINESS)!.status,
    curlCalls: existsSync(trace) ? readFileSync(trace, 'utf8') : '',
  };
}

describe('real fixed readiness assertions consume the destination observation, never curl locally', () => {
  it('positive control executes both existing endpoint and readiness assertions', () => {
    const result = runSuite(good);
    expect(result.endpoint, result.output).toBe('passed'); expect(result.readiness).toBe('passed'); expect(result.status).toBe(0);
  });
  it.each(['stand', 'prod'] as const)('%s succeeds without any operator URL or local API request', (role) => {
    const result = runSuite({ ...good, body: { ...good.body, mode: role === 'prod' ? 'prod' : 'test', shopId: role === 'prod' ? '409285' : '1440249' } }, { legacyUrl: false, role });
    expect(result.endpoint, result.output).toBe('passed'); expect(result.readiness).toBe('passed'); expect(result.status).toBe(0);
    expect(result.curlCalls).toBe('');
  });
  it('obsolete operator URL is ignored even when present', () => {
    const result = runSuite(good);
    expect(result.status).toBe(0); expect(result.curlCalls).toBe('');
  });
  const bad = [
    ['HTTP error', { ...good, status: 503 }],
    ['redirect', { ...good, status: 302 }],
    ['text content type', { ...good, contentType: 'text/plain' }],
    ['missing content type', { ...good, contentType: '' }],
    ['malformed body', { ...good, body: '{not-json' }],
    ['null body', { ...good, body: null }],
    ['array body', { ...good, body: [good.body] }],
    ['missing status', { ...good, body: { mode: 'test', shopId: '1440249' } }],
    ['missing mode', { ...good, body: { status: 'ready', shopId: '1440249' } }],
    ['missing shop', { ...good, body: { status: 'ready', mode: 'test' } }],
    ['not ready', { ...good, body: { ...good.body, status: 'starting' } }],
    ['wrong mode', { ...good, body: { ...good.body, mode: 'prod' } }],
    ['wrong shop', { ...good, body: { ...good.body, shopId: 'foreign-shop' } }],
    ['numeric shop', { ...good, body: { ...good.body, shopId: 42 } }],
    ['extra key and secret', { ...good, body: { ...good.body, diagnostic: SECRET } }],
  ] as const;
  it.each(bad)('%s fails the named readiness assertion despite contradictory green operator response', (_name, observed) => {
    const result = runSuite(observed);
    expect(result.endpoint, result.output).toBe('passed');
    expect(result.readiness).toBe('failed'); expect(result.status).not.toBe(0);
    expect(result.output).not.toContain(SECRET);
    expect(result.curlCalls).toBe('');
  });
  it('correct remote identity cannot replace public artifact endpoint validation', () => {
    const result = runSuite(good, { wrongEndpoint: true });
    expect(result.endpoint).toBe('failed'); expect(result.readiness).toBe('passed'); expect(result.status).not.toBe(0);
  });
});
