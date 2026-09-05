/**
 * Test-only port for the implementation introduced by `dependabot-auto-merge`.
 * The default dynamic import deliberately stays RED until production code exists.
 * Tests may point at a fixture with DEPENDABOT_AUTO_MERGE_IMPLEMENTATION for
 * negative verification of the test suite itself.
 */

export type UpdateType = 'semver-patch' | 'semver-minor' | 'semver-major';
export type PackageName = 'web' | 'scripts' | 'cms';

export interface DependencyUpdate {
  ecosystem: 'npm' | 'github-actions' | string;
  packageName?: PackageName | string;
  dependencyName: string;
  updateType: UpdateType | string;
  dependencySection?: 'production' | 'development';
}

export interface ClassificationInput {
  metadata: { updates: DependencyUpdate[] } | null;
  securityRegistry?: {
    readable: boolean;
    consistent: boolean;
    directPackages: string[];
    lockfileNodes: string[];
  };
  changedLockfileNodes?: string[];
}

export interface Decision {
  ok: boolean;
  reason: string;
  conclusion?: 'success' | 'failure' | 'neutral' | 'skipped';
}

export interface ClassificationDecision extends Decision {
  eligible: boolean;
  status?: 'eligible' | 'manual-review' | 'error';
}

export interface StoredResult {
  sha: string;
  kind: 'provenance' | 'eligibility-gate';
  producer: string;
  conclusion: 'positive' | 'negative' | 'success' | 'failure' | 'neutral' | 'skipped';
}

export interface HeadEvaluationInput {
  sha: string;
  autoMergeEnabled: boolean;
  classificationEligible: boolean;
  classificationStatus?: 'eligible' | 'manual-review' | 'error' | 'not-applicable';
  action?: 'opened' | 'synchronize' | 'reopened' | 'auto_merge_enabled' | 'auto_merge_disabled';
  prAuthor: string;
  signature: {
    valid: boolean;
    wasSignedByGitHub: boolean;
    signerLogin: string | null;
  };
  actor: { login: string; kind: 'dependabot' | 'update-mechanism' | 'human' } | null;
  topology?: {
    parentShas: string[];
    secondParentInBase: boolean;
    introducesOnlyBaseChanges: boolean;
  };
  storedResults?: StoredResult[];
  expectedEvidenceProducer: string;
}

export interface HeadEvaluation {
  gate: Decision;
  evidence: StoredResult;
  enableAutoMerge?: boolean;
  disableAutoMerge?: boolean;
  recordEvidence?: boolean;
}

export interface MergeReadinessInput {
  requiredChecks: Array<{ name: string; state: 'pending' | 'success' | 'failure' }>;
  baseUpToDate: boolean;
  mergeCombinationChecks: Array<{ name: string; state: 'pending' | 'success' | 'failure' }>;
}

export interface ProvenanceEvidenceCandidate {
  sha: string;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | null;
  appSlug: string;
  appId: number;
  eventName: string;
  externalId: string;
  callerWorkflowPath: string;
  reusablePolicyPath: string;
  reusablePolicySha: string;
}

export interface TrustedEvidencePolicy {
  sha: string;
  checkName: string;
  appSlug: string;
  appId: number;
  eventName: 'workflow_run';
  externalId: string;
  callerWorkflowPath: string;
  reusablePolicyPath: string;
  reusablePolicySha: string;
}

export interface AuthoritativeEvidenceRunInput {
  targetPullRequestNumber: number;
  targetHeadSha: string;
  provenanceJobName: string;
  expectedDispatcherWorkflowPath: string;
  expectedSignalWorkflowPath: string;
  expectedSignalActor: string;
  dispatcherRun: {
    id: number;
    runAttempt: number;
    event: string;
    path: string;
    sourceRunId: number;
    sourceRunAttempt: number;
  };
  sourceRun: {
    id: number;
    runAttempt: number;
    event: string;
    path: string;
    conclusion: string | null;
    actorLogin: string;
    headSha: string;
    pullRequests: Array<{ number: number; headSha: string }>;
  };
  jobsRunId: number;
  jobsRunAttempt: number;
  jobs: Array<{
    name: string;
    conclusion: 'success' | 'failure' | 'cancelled' | null;
  }>;
}

export interface DependabotAutoMerge {
  classifyPullRequest(input: ClassificationInput): ClassificationDecision;
  evaluateHead(input: HeadEvaluationInput): HeadEvaluation;
  evaluateMergeReadiness(input: MergeReadinessInput): Decision;
  normalizeDependabotEcosystem(ecosystem: string): string;
  isTrustedPositiveEvidence(candidate: ProvenanceEvidenceCandidate, policy: TrustedEvidencePolicy): boolean;
  isAuthoritativeEvidenceRun(input: AuthoritativeEvidenceRunInput): boolean;
}

export async function loadDependabotAutoMerge(): Promise<DependabotAutoMerge> {
  const configured = process.env.DEPENDABOT_AUTO_MERGE_IMPLEMENTATION;
  const implementation = configured
    ? new URL(configured, import.meta.url).href
    : new URL('../../scripts/lib/dependabot-auto-merge.ts', import.meta.url).href;
  return (await import(/* @vite-ignore */ implementation)) as DependabotAutoMerge;
}
