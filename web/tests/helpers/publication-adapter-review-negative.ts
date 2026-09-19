/** Explicit mutation acceptance probe, excluded from default test selection.
 * Run from a clean isolated worktree's web/:
 *   npx tsx tests/helpers/publication-adapter-review-negative.ts /absolute/known-green/dist /absolute/evidence.json
 * Requires the adapter smoke's finished artifact, including release.json; never rebuilds.
 * Each mutation must fail its own named real assertion, not collection or another check.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicationCheckPorts } from '../../scripts/lib/publication-check-adapters';
import type { PublicationCheckContext } from '../../scripts/lib/publication-checks';

const webRoot = resolve(import.meta.dirname, '../..');
const treeDir = join(webRoot, 'dist');
const [sourceArg, evidenceArg] = process.argv.slice(2);
assert(sourceArg && evidenceArg, 'provide known-green artifact directory and evidence JSON path');
assert(!existsSync(treeDir), 'run in an isolated worktree without web/dist; existing output is never replaced');
const temporary = mkdtempSync(join(tmpdir(), 'publication-adapter-review-'));
const evidence: unknown[] = [];
const snapshotDir = join(temporary, 'snapshot');
mkdirSync(snapshotDir);
const failures: string[] = [];
try {
  cpSync(resolve(sourceArg), treeDir, { recursive: true });
  const marker = JSON.parse(readFileSync(join(treeDir, 'release.json'), 'utf8')) as { commit: string; snapshotId: string };
  const context: PublicationCheckContext = {
    ...marker, destinationId: 'isolated-review', deployMode: 'stand', paymentRole: 'ci', treeDir,
    snapshotDir, reportPath: join(temporary, 'publication.json'),
    env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary },
  };
  async function check(name: string) {
    const reportsDir = join(temporary, name);
    const ports = createPublicationCheckPorts({ webRoot, snapshotDir, reportsDir, ledgerDir: join(temporary, 'ledger'), captureEnv: {} });
    let accepted = false;
    try { await ports.checkBuild(context); accepted = true; } catch { /* Inspect the real report below. */ }
    const report = JSON.parse(readFileSync(join(reportsDir, 'build.json'), 'utf8')) as {
      numTotalTests: number; numPassedTests: number; numFailedTests: number;
      testResults: { assertionResults: { fullName: string; status: string }[] }[];
    };
    const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
    assert.equal(report.numTotalTests, 4, 'all four build assertions must execute');
    assert.equal(assertions.length, 4);
    assert(assertions.every((item) => ['passed', 'failed'].includes(item.status)), 'no skipped or pending assertions');
    evidence.push({ name, accepted, passed: report.numPassedTests, failed: report.numFailedTests, assertions });
    return { accepted, report, assertions };
  }
  const positive = await check('positive');
  assert(positive.accepted && positive.report.numPassedTests === 4, 'known-green positive control must pass 4/4');
  const home = join(treeDir, 'index.html');
  const original = readFileSync(home, 'utf8');
  assert(original.includes('</body>'), 'fixture needs a body closing tag');
  for (const mutation of [
    { name: 'unregistered-script', html: '<script>window.__publicationUnexpectedScript = true;</script>', assertion: 'all rendered content satisfies the existing rich-content safety matrix' },
    { name: 'http-internal-link', html: '<a href="http://ikpk.su/__missing_publication_internal_link__">HTTP internal probe</a>', assertion: 'internal links and every declared legacy redirect resolve in the checked tree' },
  ]) {
    try {
      writeFileSync(home, original.replace('</body>', `${mutation.html}</body>`));
      const result = await check(mutation.name);
      const target = result.assertions.find((item) => item.fullName === mutation.assertion);
      if (result.accepted || target?.status !== 'failed' || result.report.numFailedTests !== 1) {
        failures.push(`${mutation.name}: expected rejection in its own assertion; accepted=${result.accepted}, passed=${result.report.numPassedTests}, failed=${result.report.numFailedTests}, target=${target?.status}`);
      }
    } finally { writeFileSync(home, original); }
  }
} finally {
  writeFileSync(resolve(evidenceArg), `${JSON.stringify({ evidence, failures }, null, 2)}\n`);
  rmSync(treeDir, { recursive: true, force: true });
  rmSync(temporary, { recursive: true, force: true });
}
assert.deepEqual(failures, [], failures.join('\n'));
