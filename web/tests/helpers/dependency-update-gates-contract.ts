/**
 * Test-only contract for the implementation introduced by
 * `dependency-update-gates`.  The dynamic import deliberately keeps this RED
 * before production code exists while still collecting every scenario test.
 */

export interface GateResult {
  ok: boolean;
  message: string;
  headCount?: number;
  baseCount?: number;
  missingTuples?: string[];
  staleAllowances?: string[];
}

export interface LintCoverageInput {
  packageName: 'web' | 'cms' | 'scripts';
  threshold: number;
  changedFiles: string[];
  head: { exitCode: number; reportJson: string };
  base?: { exitCode: number; reportJson: string };
}

export interface PlatformTuple {
  packageName: string;
  os: string;
  cpu: string;
  libc: string;
}

export interface AcceptedPlatformLoss extends PlatformTuple {
  reason: string;
}

export interface PlatformEntriesInput {
  baseLockfile: unknown;
  headLockfile: unknown;
  baseAcceptedLosses?: AcceptedPlatformLoss[];
  headAcceptedLosses?: AcceptedPlatformLoss[];
}

export interface TestExecutionInput {
  runner: 'vitest' | 'playwright';
  threshold: number;
  changedFiles: string[];
  headReport: unknown;
  baseReport?: unknown;
}

export interface RuntimeAuditScopeInput {
  packageName: 'web' | 'cms' | 'scripts';
  base: { exitCode: number; reportJson: string };
  head: { exitCode: number; reportJson: string };
}

export interface PublishedHeadInput {
  mainHeadSha: string;
  mainHeadCreatedAt: string;
  publishedSha: string | null;
  now: string;
  maxLagMs: number;
  cancelledIntermediateShas?: string[];
}

export interface DependencyUpdateGates {
  checkLintCoverage(input: LintCoverageInput): GateResult;
  checkPlatformEntries(input: PlatformEntriesInput): GateResult;
  checkTestExecution(input: TestExecutionInput): GateResult;
  checkRuntimeAuditScope(input: RuntimeAuditScopeInput): GateResult;
  checkPublishedHead(input: PublishedHeadInput): GateResult;
}

export async function loadDependencyUpdateGates(): Promise<DependencyUpdateGates> {
  const implementation = new URL(
    '../../scripts/lib/dependency-update-gates.ts',
    import.meta.url,
  ).href;
  return (await import(/* @vite-ignore */ implementation)) as DependencyUpdateGates;
}
