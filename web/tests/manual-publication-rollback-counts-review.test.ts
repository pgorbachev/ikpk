import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRollbackChecks, type RollbackCheckPorts } from '../scripts/lib/publication-rollback-checks.ts';
import { PublicationReportError } from '../scripts/lib/publication-report-error.ts';
import { createWorkerAudit } from '../scripts/publication-worker.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

it.each([
  { failed: 'checkDestination', count: 0, total: 0, group: 'destination-mode' },
  { failed: 'checkBrowser', count: 3, total: 5, group: 'browser-smoke' },
] as const)('retained audit includes $count executed tests from $failed', async ({ failed, count, total, group }) => {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-retained-counts-review-')); dirs.push(temp);
  const treeDir = join(temp, 'retained'); mkdirSync(treeDir);
  const success = async () => ({ conclusion: 'success' as const, executedTests: 2 });
  const ports: RollbackCheckPorts = {
    checkDestination: success, checkBrowser: success, checkPaymentAbsent: success,
    checkPaymentReadiness: success, checkPaymentPreflight: success,
    digest: async () => 'a'.repeat(64),
  };
  ports[failed] = async () => { throw new PublicationReportError('private diagnostic must not leak', 'local', count); };
  const error = await runRollbackChecks({ commit: 'b'.repeat(40), snapshotId: 'retained-snapshot',
    destinationId: 'stand', deployMode: 'stand', paymentRole: 'ci', treeDir, reportPath: join(temp, 'report.json') }, ports)
    .then(() => { throw new Error('expected refusal'); }, (error: unknown) => error);
  const audit = createWorkerAudit({ error });
  expect(audit).toMatchObject({ check: group, localExecutedTests: total });
  expect(JSON.stringify(audit)).not.toContain('private diagnostic');
});
