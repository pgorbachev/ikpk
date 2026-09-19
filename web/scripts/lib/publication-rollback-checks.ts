import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalPath, inside, publicEnvironment } from './publication-checks.ts';
import { localChecksProblem, ROLLBACK_GROUPS } from './publish-gate.ts';
import type { WorkerAudit } from '../publication-worker.ts';
import type { LocalChecks } from './publish-gate.ts';

import type { PublicationCheckInput, CheckResult } from './publication-checks.ts';

export interface RollbackCheckInput extends PublicationCheckInput { snapshotId: string }
export interface RollbackCheckContext extends RollbackCheckInput { env: Record<string, string | undefined> }
export interface RollbackCheckPorts {
  checkDestination(context: RollbackCheckContext): Promise<CheckResult>;
  checkBrowser(context: RollbackCheckContext): Promise<CheckResult>;
  checkPaymentAbsent(context: RollbackCheckContext): Promise<CheckResult>;
  checkPaymentReadiness(context: RollbackCheckContext): Promise<CheckResult>;
  checkPaymentPreflight(context: RollbackCheckContext): Promise<CheckResult>;
  digest(treeDir: string): Promise<string>;
}

/** Effect adapters are fixed by the installed worker; operator input cannot choose checks. */
export async function runRollbackChecks(input: RollbackCheckInput, ports: RollbackCheckPorts): Promise<LocalChecks> {
  if ('groups' in input || 'command' in input) throw new Error('unsupported-publication-groups-or-command');
  if (!/^[a-f0-9]{40}$/.test(input.commit) || !input.destinationId?.trim() || !input.snapshotId?.trim() ||
      !['stand', 'prod'].includes(input.deployMode) || !['ci', 'stand', 'prod'].includes(input.paymentRole)) throw new Error('invalid-publication-identity');
  const treeDir = canonicalPath(input.treeDir); const reportPath = canonicalPath(input.reportPath);
  if (inside(treeDir, reportPath)) throw new Error('report-inside-artifact-tree');
  if (existsSync(reportPath)) throw new Error('publication-report-already-exists');
  const home = mkdtempSync(join(tmpdir(), 'ikpk-publication-checks-'));
  const audit: WorkerAudit = { version: 1, status: 'refused', code: 'checks-failed', check: 'artifact-digest' };
  let executedTests = 0;
  try {
    const environment = Object.fromEntries(publicEnvironment.filter((name) => input.env?.[name] !== undefined).map((name) => [name, input.env![name]]));
    const env = Object.freeze({ ...environment, HOME: home, TMPDIR: home,
      DEPLOY_MODE: input.deployMode, PAYMENT_ROLE: input.paymentRole });
    const context: RollbackCheckContext = Object.freeze({ commit: input.commit, snapshotId: input.snapshotId,
      destinationId: input.destinationId, deployMode: input.deployMode, paymentRole: input.paymentRole, treeDir, reportPath, env });
    const groups: LocalChecks['groups'] = [];
    function requireResult(name: string, result: CheckResult): CheckResult {
      audit.check = name;
      if (result && Number.isSafeInteger(result.executedTests) && result.executedTests >= 0) {
        executedTests += result.executedTests;
        audit.localExecutedTests = executedTests;
      }
      if (!result || result.conclusion !== 'success' || !Number.isSafeInteger(result.executedTests) || result.executedTests <= 0) {
        throw new Error(`publication-group:${name}:executed=${result?.executedTests ?? 0}:conclusion=${result?.conclusion ?? 'missing'}`);
      }
      return { conclusion: 'success', executedTests: result.executedTests };
    }
    async function check(name: string, effect: (context: RollbackCheckContext) => Promise<CheckResult>): Promise<void> {
      audit.check = name;
      const result = requireResult(name, await effect(context));
      groups.push({ name, ...result });
    }
    const treeDigest = await ports.digest(treeDir);
    if (!/^[a-f0-9]{64}$/.test(treeDigest)) throw new Error('invalid-tree-digest');
    await check('destination-mode', ports.checkDestination);
    await check('browser-smoke', ports.checkBrowser);
    if (input.paymentRole === 'ci') await check('payment-destination', ports.checkPaymentAbsent);
    else {
      audit.check = 'payment-readiness';
      const readiness = requireResult('payment-readiness', await ports.checkPaymentReadiness(context));
      audit.check = 'payment-preflight';
      const preflight = requireResult('payment-preflight', await ports.checkPaymentPreflight(context));
      groups.push({ name: 'payment-destination', conclusion: 'success', executedTests: readiness.executedTests + preflight.executedTests });
    }
    if (await ports.digest(treeDir) !== treeDigest) throw new Error('artifact-changed-during-checks');
    const report: LocalChecks = { commit: input.commit, snapshotId: input.snapshotId, destinationId: input.destinationId, treeDigest, groups };
    const problem = localChecksProblem(report, report, ROLLBACK_GROUPS);
    if (problem) throw new Error(problem);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return report;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('publication checks failed');
    Object.assign(failure, { audit });
    throw failure;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
