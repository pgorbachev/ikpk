/** Independent review regression; argv[2] is retained harness evidence JSON. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { chromium } from 'playwright';
import { serveStatic } from './static-serve.ts';
import { installThirdPartyGuard } from './third-party-guard.ts';
import { createRollbackCheckPorts } from '../../scripts/lib/publication-check-adapters.ts';
import { runRollbackChecks } from '../../scripts/lib/publication-rollback-checks.ts';
const baseline = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const treeDir = baseline.downloadedTree;
const temp = mkdtempSync(join(tmpdir(), 'ikpk-retained-review-red-'));
const ports = createRollbackCheckPorts({ webRoot: resolve('.'), treeDir, reportsDir: join(temp, 'reports') });
const beforeDigest = await ports.digest(treeDir);
const page = join(treeDir, 'raspisanie-i-tseny/index.html');
const original = readFileSync(page, 'utf8');
const kind = process.argv[3] === 'empty' ? 'empty' : 'hidden';
const doc = parse(original);
let removed = 0;
function removeCards(node: DefaultTreeAdapterMap['node']) {
  if ('childNodes' in node) {
    node.childNodes = node.childNodes.filter((child) => {
      const card = 'attrs' in child && child.attrs.some((attr) => attr.name === 'data-schedule-item');
      if (card) removed++;
      return !card;
    });
    node.childNodes.forEach(removeCards);
  }
  if ('content' in node) removeCards(node.content);
}
removeCards(doc);
assert(removed > 0);
const mutated = kind === 'empty' ? serialize(doc) : original.replace('</head>', '<style>[data-schedule-item]{display:none!important}</style></head>');
if (kind === 'empty') assert.equal([...mutated.matchAll(/\bdata-schedule-item(?:[\s=>])/g)].length, 0);
async function visibility() {
  const site = await serveStatic(treeDir);
  const browser = await chromium.launch();
  try {
    const result = [];
    for (const width of [1280, 375]) {
      const tab = await browser.newPage({ viewport: { width, height: 812 } });
      await installThirdPartyGuard(tab);
      assert.equal((await tab.goto(`${site.origin}/raspisanie-i-tseny`))?.status(), 200);
      result.push({ width, cards: await tab.locator('[data-schedule-item]').count(), visible: await tab.locator('[data-schedule-item]:visible').count() });
      await tab.close();
    }
    return result;
  } finally { await browser.close(); await site.close(); }
}
const beforeVisibility = await visibility();
let afterVisibility;
let accepted = false;
let report;
let failure;
let restoredDigest;
try {
  writeFileSync(page, mutated);
  afterVisibility = await visibility();
  assert(afterVisibility.every((result) => result.visible === 0));
  try {
    report = await runRollbackChecks({ commit: baseline.checks.commit, snapshotId: baseline.checks.snapshotId,
      destinationId: baseline.checks.destinationId, treeDir, reportPath: join(temp, 'rollback.json'),
      deployMode: 'stand', paymentRole: 'ci', env: { PATH: process.env.PATH, DEMO_FORMS: 'stub', CHAT_LOADER_SRC: 'none' } }, ports);
    accepted = true;
  } catch (error) { failure = String(error); }
} finally {
  writeFileSync(page, original);
  restoredDigest = await ports.digest(treeDir);
  assert.equal(restoredDigest, beforeDigest);
}
const browser = JSON.parse(readFileSync(join(temp, 'reports/browser.json'), 'utf8'));
const evidence = { reviewedRevision: '6318961597bfd440437d229d3d855b14082c985e', kind, beforeVisibility, afterVisibility,
  accepted, failure, checks: report, browserStats: browser.stats, beforeDigest, restoredDigest,
  reportsDirectory: temp };
writeFileSync(`tests/evidence/retained-review-schedule-${kind}.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
assert.equal(accepted, false, 'rollback smoke must reject a schedule with zero visible cards');
