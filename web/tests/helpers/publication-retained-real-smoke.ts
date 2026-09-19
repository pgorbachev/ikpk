/** Manual retained-artifact acceptance, without capture or build.
 * From web: node_modules/.bin/tsx tests/helpers/publication-retained-real-smoke.ts /absolute/prebuilt/stand-ci-artifact
 * Input must be a valid existing stand/ci artifact with DEMO_FORMS=stub and CHAT_LOADER_SRC=none.
 * Copies input into an isolated downloaded-tree stand-in; invokes real fixed Vitest and
 * Playwright desktop/mobile suites via the installed adapter. No CMS/SSH/live payment.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createRollbackCheckPorts } from '../../scripts/lib/publication-check-adapters.ts';
import { runRollbackChecks } from '../../scripts/lib/publication-rollback-checks.ts';

const source = process.argv[2];
assert(source && isAbsolute(source), 'absolute existing artifact directory required');
const webRoot = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'ikpk-retained-real-smoke-'));
const treeDir = join(temp, 'downloaded-retained-tree');
cpSync(source, treeDir, { recursive: true, dereference: false, errorOnExist: true });
const release = JSON.parse(readFileSync(join(treeDir, 'release.json'), 'utf8')) as { commit: string; snapshotId: string };
const ports = createRollbackCheckPorts({ webRoot, treeDir, reportsDir: join(temp, 'reports') });
const before = await ports.digest(treeDir);
const report = await runRollbackChecks({ ...release, treeDir, reportPath: join(temp, 'rollback.json'),
  destinationId: 'fixture-stand', deployMode: 'stand', paymentRole: 'ci',
  env: { PATH: process.env.PATH, DEMO_FORMS: 'stub', CHAT_LOADER_SRC: 'none' },
}, ports);
assert.deepEqual(report.groups.map((group) => group.name), ['destination-mode', 'browser-smoke', 'payment-destination']);
assert(report.groups.every((group) => group.conclusion === 'success' && group.executedTests > 0));
assert.equal(report.treeDigest, before); assert.equal(await ports.digest(treeDir), before);
assert.equal(JSON.parse(readFileSync(join(temp, 'rollback.json'), 'utf8')).treeDigest, before);
const evidence = { fixtureOnly: true, source, downloadedTree: treeDir, immutableTreeDigest: before,
  checks: report };
writeFileSync(join(temp, 'acceptance-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ evidenceDirectory: temp, ...evidence }, null, 2));
