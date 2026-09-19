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

/** RED scaffold. This coordinator and its production effect ports are not implemented. */
export async function runPublicationChecks(input: PublicationCheckInput, ports: PublicationCheckPorts): Promise<LocalChecks> {
  void input; void ports;
  return undefined as unknown as LocalChecks;
}
