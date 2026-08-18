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
}

export interface ClassificationDecision extends Decision {
  eligible: boolean;
}

export interface StoredResult {
  sha: string;
  kind: 'provenance' | 'eligibility-gate';
  producer: string;
  conclusion: 'positive' | 'negative';
}

export interface HeadEvaluationInput {
  sha: string;
  autoMergeEnabled: boolean;
  classificationEligible: boolean;
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
}

export interface MergeReadinessInput {
  requiredChecks: Array<{ name: string; state: 'pending' | 'success' | 'failure' }>;
  baseUpToDate: boolean;
  mergeCombinationChecks: Array<{ name: string; state: 'pending' | 'success' | 'failure' }>;
}

export interface DependabotAutoMerge {
  classifyPullRequest(input: ClassificationInput): ClassificationDecision;
  evaluateHead(input: HeadEvaluationInput): HeadEvaluation;
  evaluateMergeReadiness(input: MergeReadinessInput): Decision;
}

export async function loadDependabotAutoMerge(): Promise<DependabotAutoMerge> {
  const configured = process.env.DEPENDABOT_AUTO_MERGE_IMPLEMENTATION;
  const implementation = configured
    ? new URL(configured, import.meta.url).href
    : new URL('../../scripts/lib/dependabot-auto-merge.ts', import.meta.url).href;
  return (await import(/* @vite-ignore */ implementation)) as DependabotAutoMerge;
}
