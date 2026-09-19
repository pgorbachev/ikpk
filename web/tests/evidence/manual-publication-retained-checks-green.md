# Retained rollback check implementation and GREEN

Implementation: `codex/retained-checks@7a2e6591c974b3c85f9fd0f13267f9fa87bb2d71`.
Independent RED: `52849a1641397d17ea85b8ad504761c28f89610e`, cherry-picked as
`4213fa7b` in this isolated worktree. Original no-op RED: 20 tests, 17 failures,
3 controls passing; prior snapshot-dependent browser diagnostic: 8 failures.

The retained coordinator owns exactly destination-mode, browser-smoke and payment-destination.
The adapter pins an absolute retained tree, uses installed commands and suites from webRoot,
and exposes no capture, build or snapshot checks. The existing browser suite has a trusted
retained mode: it selects a real Article and Event/Course from artifact HTML and requires both
on desktop and mobile. Fresh publication still uses its captured snapshot for route selection.
Reports remain outside the artifact and its digest must remain unchanged.

## Verification

From `web/`:

```sh
node_modules/.bin/vitest run tests/manual-publication-rollback-checks.test.ts tests/manual-publication-rollback-adapters.test.ts tests/manual-publication-retained-tree.test.ts tests/manual-publication-adapters.test.ts tests/manual-publication-local-checks.test.ts tests/manual-publication-remote-readiness-adapter.test.ts tests/manual-publication-remote-readiness-suite.test.ts --reporter=json --outputFile=tests/evidence/manual-publication-retained-checks-green.json
node_modules/.bin/eslint scripts/lib/publication-checks.ts scripts/lib/publication-rollback-checks.ts scripts/lib/publication-check-adapters.ts tests/publication/helpers.ts tests/publication-smoke.spec.ts
npm run typecheck
node_modules/.bin/tsx tests/helpers/publication-retained-real-smoke.ts /Users/pgorbachev/projects/private/ikpk-manual-publication-adapters/web/dist
```

- **86/86 tests pass**, including all 20 independent retained RED cases.
- Targeted ESLint passes; typecheck: 412 files, 0 errors, 0 warnings, 7 existing hints.
- Real retained harness: **destination 4 + browser 8 (4 desktop, 4 mobile) + ci absence 1 = 13**.
- Original commit and snapshotId come from the fixture's existing `release.json`.
- Before/after digest: `b0b50e3f0bdb187cc31e2181d29d83a0fe2f9398917379c15326145be3ad8204`.
- The prebuilt source was copied, never built or modified. No CMS, SSH, live payment,
  or GitHub writes occurred. The harness is fixture acceptance, not a live deployment.

## Negative verification

After committing the implementation, only the copied downloaded tree was mutated.
Article schema recognition was removed **68 → 0**; separately Event/Course recognition
was removed **152 → 0**. Each run executed 8 browser tests: **6 pass, 2 fail, 0 skipped**.
In each case the two failures are exactly `article and seminar routes open on this exact artifact`
for desktop and mobile. The adapter rejected both runs. Original file bytes were restored in
`finally` and each restored digest equals the above positive digest.

Exact reproducer below, run from `web/` after the positive harness has generated
`manual-publication-retained-real-green.json` with its still-existing downloadedTree.
The temporary script was removed after execution; tracked implementation files are unchanged.

```sh
cat > tests/helpers/retained-negative-probe.tmp.ts <<'EOF'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRollbackCheckPorts } from '../../scripts/lib/publication-check-adapters.ts';
import { walkHtml } from './dist-pages.ts';
const green = JSON.parse(readFileSync('tests/evidence/manual-publication-retained-real-green.json', 'utf8'));
const treeDir = green.downloadedTree;
const temp = mkdtempSync(join(tmpdir(), 'ikpk-retained-negative-'));
const results = [];
for (const kind of ['article', 'seminar']) {
  const ports = createRollbackCheckPorts({ webRoot: resolve('.'), treeDir, reportsDir: join(temp, kind) });
  const before = await ports.digest(treeDir);
  const originals = new Map<string, string>();
  const pattern = kind === 'article' ? /"@type":"Article"/g : /"@type":"(?:Course|Event)"/g;
  let removed = 0;
  try {
    for (const file of walkHtml(treeDir)) {
      const html = readFileSync(file, 'utf8');
      const matches = [...html.matchAll(pattern)].length;
      if (!matches) continue;
      originals.set(file, html); removed += matches;
      writeFileSync(file, html.replace(pattern, '"@type":"RetainedMutation"'));
    }
    assert(removed > 0);
    assert.equal([...walkHtml(treeDir)].reduce((n, file) => n + [...readFileSync(file, 'utf8').matchAll(pattern)].length, 0), 0);
    let rejected = false;
    try {
      await ports.checkBrowser({ ...green.checks, treeDir, reportPath: join(temp, 'unused.json'),
        deployMode: 'stand', paymentRole: 'ci', env: { PATH: process.env.PATH, HOME: temp, TMPDIR: temp, DEMO_FORMS: 'stub', CHAT_LOADER_SRC: 'none' } });
    } catch { rejected = true; }
    assert(rejected);
    const report = JSON.parse(readFileSync(join(temp, kind, 'browser.json'), 'utf8'));
    const failed: string[] = [];
    function visit(suites: any[]) {
      for (const suite of suites) {
        for (const spec of suite.specs ?? []) for (const test of spec.tests) if (test.status !== 'expected') failed.push(`${test.projectName}: ${spec.title}`);
        visit(suite.suites ?? []);
      }
    }
    visit(report.suites);
    assert.equal(failed.length, 2); assert(failed.every((title) => title.endsWith('article and seminar routes open on this exact artifact')));
    results.push({ kind, matchingSchemasBefore: removed, matchingSchemasAfter: 0, rejected, stats: report.stats, failed, before });
  } finally {
    for (const [file, html] of originals) writeFileSync(file, html);
    assert.equal(await ports.digest(treeDir), before);
  }
}
writeFileSync('tests/evidence/manual-publication-retained-negative-green.json', JSON.stringify({ results, restoredDigest: green.immutableTreeDigest }, null, 2) + '\n');
rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
EOF
node_modules/.bin/tsx tests/helpers/retained-negative-probe.tmp.ts
rm tests/helpers/retained-negative-probe.tmp.ts
```

## Integration boundary

This bounded delivery does not wire the installed rollback CLI/runtime. That is a separate
integration step owned by the parent task. It preserves the destination-side payment readiness
callback from the supplied base. Actual active payment readiness/preflight remains covered by
existing fixed-suite tests and role dispatch by independent coordinator tests, not live APIs.
The concurrent typed failed-reporter count change must also be applied to the new coordinator's
catch when combining these commits; its implementation was deliberately not duplicated here.
