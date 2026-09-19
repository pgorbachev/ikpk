import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digestTree } from '../../../scripts/publication-launcher.mjs';
import { localChecksProblem } from './publish-gate.ts';
import type { CheckConclusion, LocalChecks } from './publish-gate.ts';

export interface PublicationCheckInput {
  commit: string; destinationId: string; deployMode: 'stand' | 'prod';
  paymentRole: 'ci' | 'stand' | 'prod'; treeDir: string; reportPath: string;
  env?: Record<string, string | undefined>;
}
export interface PublicationSnapshot { snapshotId: string; snapshotDir: string }
export interface PublicationCheckContext extends PublicationCheckInput, PublicationSnapshot {
  env: Record<string, string | undefined>;
}
export interface CheckResult { conclusion: CheckConclusion; executedTests: number }
export interface PublicationCheckPorts {
  capture(): Promise<PublicationSnapshot>;
  build(context: PublicationCheckContext): Promise<void>;
  checkSnapshot(context: PublicationCheckContext): Promise<CheckResult>;
  checkBuild(context: PublicationCheckContext): Promise<CheckResult>;
  checkDestination(context: PublicationCheckContext): Promise<CheckResult>;
  checkBrowser(context: PublicationCheckContext): Promise<CheckResult>;
  checkPaymentAbsent(context: PublicationCheckContext): Promise<CheckResult>;
  checkPaymentReadiness(context: PublicationCheckContext): Promise<CheckResult>;
  checkPaymentPreflight(context: PublicationCheckContext): Promise<CheckResult>;
  digest(treeDir: string): Promise<string>;
}

function canonicalPath(path: string): string {
  let existing = resolve(path); const missing: string[] = [];
  while (!existsSync(existing)) { missing.unshift(existing.slice(dirname(existing).length + 1)); existing = dirname(existing); }
  return join(realpathSync(existing), ...missing);
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
function files(root: string): string[] {
  const result: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('snapshot-symlink');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) result.push(relative(root, path));
      else throw new Error('snapshot-not-regular-file');
    }
  }
  walk(root); return result;
}
const publicEnvironment = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'DEMO_FORMS', 'CHAT_LOADER_SRC',
  'PAYMENT_ENDPOINT_STAND', 'PAYMENT_ENDPOINT_PROD'] as const;

/** Effect adapters are fixed by the installed worker; operator input cannot choose checks. */
export async function runPublicationChecks(input: PublicationCheckInput, ports: PublicationCheckPorts): Promise<LocalChecks> {
  if ('groups' in input || 'command' in input) throw new Error('unsupported-publication-groups-or-command');
  if (!/^[a-f0-9]{40}$/.test(input.commit) || !input.destinationId?.trim() ||
      !['stand', 'prod'].includes(input.deployMode) || !['ci', 'stand', 'prod'].includes(input.paymentRole)) throw new Error('invalid-publication-identity');
  const treeDir = canonicalPath(input.treeDir); const reportPath = canonicalPath(input.reportPath);
  if (inside(treeDir, reportPath)) throw new Error('report-inside-artifact-tree');
  if (existsSync(reportPath)) throw new Error('publication-report-already-exists');
  const home = mkdtempSync(join(tmpdir(), 'ikpk-publication-checks-'));
  try {
    const snapshot = await ports.capture();
    if (!snapshot?.snapshotId?.trim() || !snapshot.snapshotDir?.trim()) throw new Error('missing-snapshot-identity');
    const snapshotDir = snapshot.snapshotDir;
    const snapshotRoot = realpathSync(snapshotDir);
    if (inside(treeDir, snapshotRoot) || inside(snapshotRoot, treeDir)) throw new Error('snapshot-and-output-overlap');
    const snapshotDigest = await digestTree(snapshotDir, files(snapshotDir));
    const environment = Object.fromEntries(publicEnvironment.filter((name) => input.env?.[name] !== undefined).map((name) => [name, input.env![name]]));
    const env = Object.freeze({ ...environment, HOME: home, TMPDIR: home, CONTENT_SNAPSHOT_DIR: snapshotDir,
      DEPLOY_MODE: input.deployMode, PAYMENT_ROLE: input.paymentRole });
    const context: PublicationCheckContext = Object.freeze({ ...input, ...snapshot, snapshotDir, treeDir, reportPath, env });
    const groups: LocalChecks['groups'] = [];
    function requireResult(name: string, result: CheckResult): CheckResult {
      if (!result || result.conclusion !== 'success' || !Number.isSafeInteger(result.executedTests) || result.executedTests <= 0) {
        throw new Error(`publication-group:${name}:executed=${result?.executedTests ?? 0}:conclusion=${result?.conclusion ?? 'missing'}`);
      }
      return { conclusion: 'success', executedTests: result.executedTests };
    }
    async function check(name: string, effect: (context: PublicationCheckContext) => Promise<CheckResult>): Promise<void> {
      const result = requireResult(name, await effect(context));
      groups.push({ name, ...result });
    }
    await check('snapshot-provenance', ports.checkSnapshot);
    await ports.build(context);
    writeFileSync(join(treeDir, 'release.json'), `${JSON.stringify({ commit: input.commit, snapshotId: snapshot.snapshotId }, null, 2)}\n`, { flag: 'wx' });
    const treeDigest = await ports.digest(treeDir);
    if (!/^[a-f0-9]{64}$/.test(treeDigest)) throw new Error('invalid-tree-digest');
    await check('build-content', ports.checkBuild);
    await check('destination-mode', ports.checkDestination);
    await check('browser-smoke', ports.checkBrowser);
    if (input.paymentRole === 'ci') await check('payment-destination', ports.checkPaymentAbsent);
    else {
      const readiness = requireResult('payment-readiness', await ports.checkPaymentReadiness(context));
      const preflight = requireResult('payment-preflight', await ports.checkPaymentPreflight(context));
      groups.push({ name: 'payment-destination', conclusion: 'success', executedTests: readiness.executedTests + preflight.executedTests });
    }
    if (await ports.digest(treeDir) !== treeDigest) throw new Error('artifact-changed-during-checks');
    if (await digestTree(snapshotDir, files(snapshotDir)) !== snapshotDigest) throw new Error('snapshot-changed-during-checks');
    const report: LocalChecks = { commit: input.commit, snapshotId: snapshot.snapshotId, destinationId: input.destinationId, treeDigest, groups };
    const problem = localChecksProblem(report, report);
    if (problem) throw new Error(problem);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return report;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
