import { it as test, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../scripts/publication-context.ts';
const web = fileURLToPath(new URL('../', import.meta.url));

async function scenario(t: TestContext, mismatch: boolean) {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-payment-origin-review-'));
  const allowed = 'https://allowed-site.example.invalid';
  const actual = mismatch ? 'https://actual-site.example.invalid' : allowed;
  const requests: { method: string | undefined; origin: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, origin: req.headers.origin });
    if (req.method === 'OPTIONS' && req.headers.origin === allowed) res.writeHead(204, { 'access-control-allow-origin': allowed }).end();
    else res.writeHead(403).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(temp, { recursive: true, force: true }); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api`;
  const known = join(temp, 'known_hosts'); writeFileSync(known, 'fixture', { mode: 0o600 });
  const path = join(temp, 'config.json');
  writeFileSync(path, JSON.stringify({ canonicalRepository: 'https://github.com/pgorbachev/ikpk.git', sshTarget: 'deploy@stand.example.invalid',
    destinationId: 'stand', deployMode: 'stand', paymentRole: 'stand', actor: 'reviewer', webRoot: '/var/www/ikpk',
    knownHostsFile: known, keepReleases: 5, chatLoaderSrc: 'none', siteUrl: actual,
    payment: { endpoint, mode: 'test', shopId: '1440249', siteOrigin: allowed } }), { mode: 0o600 });
  // Use production config validation and the real fixed preflight assertion suite.
  const live = await fetch(`${endpoint}/payments`, { method: 'OPTIONS', headers: { Origin: actual } });
  let config;
  try { config = readConfig(path); }
  catch { return { rejected: true, status: 1, count: 0, liveStatus: live.status, requests, actual, allowed }; }
  const report = join(temp, 'preflight.json');
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [join(web, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.publication.config.ts',
      'tests/publication/payment-preflight.test.ts', '--reporter=json', `--outputFile=${report}`], {
      cwd: web, stdio: 'ignore', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: temp, TMPDIR: temp,
        PAYMENT_ROLE: 'stand', PUBLICATION_PAYMENT_ENDPOINT: config.payment!.endpoint,
        PUBLICATION_PAYMENT_MODE: config.payment!.mode, PUBLICATION_PAYMENT_SHOP_ID: config.payment!.shopId,
        PUBLICATION_PAYMENT_SITE_ORIGIN: config.payment!.siteOrigin },
    }); child.once('error', reject); child.once('close', resolve);
  });
  const count = JSON.parse(readFileSync(report, 'utf8')).numPassedTests;
  return { rejected: false, status, count, liveStatus: live.status, requests, actual, allowed };
}
test('payment preflight positive control accepts the real site origin', async t => {
  const result = await scenario(t, false);
  assert.equal(result.status, 0); assert.equal(result.count, 1); assert.equal(result.liveStatus, 204);
  assert.deepEqual(result.requests, [{ method: 'OPTIONS', origin: result.allowed }, { method: 'OPTIONS', origin: result.allowed }]);
});
test('publication refuses when preflight checks a different origin from the published site', async t => {
  const result = await scenario(t, true);
  assert.equal(result.liveStatus, 403, 'actual browser origin is rejected');
  if (result.rejected) return; // A mismatched protected config must refuse before the suite.
  assert.equal(result.count, 1, 'the fixed check ran rather than failing to launch');
  assert.deepEqual(result.requests, [{ method: 'OPTIONS', origin: result.actual }, { method: 'OPTIONS', origin: result.allowed }]);
  assert.notEqual(result.status, 0, 'accepted config and fixed preflight falsely approve an unusable payment destination');
});
