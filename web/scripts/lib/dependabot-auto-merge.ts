export type UpdateType = 'semver-patch' | 'semver-minor' | 'semver-major';

export interface DependencyUpdate {
  ecosystem: string;
  packageName?: string;
  dependencyName: string;
  updateType: string;
  dependencySection?: string;
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

export interface ProvenanceEvidenceCandidate {
  sha: string;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | null;
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
  eventName: 'pull_request_target';
  externalId: string;
  callerWorkflowPath: string;
  reusablePolicyPath: string;
  reusablePolicySha: string;
}

export interface AuthoritativeEvidenceRunInput {
  targetPullRequestNumber: number;
  targetHeadSha: string;
  provenanceJobName: string;
  run: {
    pullRequests: Array<{ number: number; headSha: string }>;
  };
  jobs: Array<{
    name: string;
    conclusion: 'success' | 'failure' | 'cancelled' | null;
  }>;
}

const allow = (reason: string): ClassificationDecision => ({ ok: true, eligible: true, reason });
const deny = (reason: string): ClassificationDecision => ({ ok: true, eligible: false, reason });

export function normalizeDependabotEcosystem(ecosystem: string): string {
  if (ecosystem === 'npm_and_yarn') return 'npm';
  if (ecosystem === 'github_actions') return 'github-actions';
  return ecosystem;
}

export function isTrustedPositiveEvidence(
  candidate: ProvenanceEvidenceCandidate,
  policy: TrustedEvidencePolicy,
): boolean {
  return candidate.sha === policy.sha &&
    candidate.name === policy.checkName &&
    candidate.status === 'completed' &&
    candidate.conclusion === 'success' &&
    candidate.appSlug === policy.appSlug &&
    candidate.appId === policy.appId &&
    candidate.eventName === policy.eventName &&
    candidate.externalId === policy.externalId &&
    candidate.callerWorkflowPath === policy.callerWorkflowPath &&
    candidate.reusablePolicyPath === policy.reusablePolicyPath &&
    candidate.reusablePolicySha === policy.reusablePolicySha;
}

export function isAuthoritativeEvidenceRun(input: AuthoritativeEvidenceRunInput): boolean {
  const matchingPullRequests = input.run.pullRequests.filter(({ number, headSha }) =>
    number === input.targetPullRequestNumber && headSha === input.targetHeadSha);
  if (matchingPullRequests.length !== 1) return false;
  const provenanceJobs = input.jobs.filter(({ name }) => name === input.provenanceJobName);
  return provenanceJobs.length === 1 && provenanceJobs[0].conclusion === 'success';
}

function updateMatchesAllowTable(update: DependencyUpdate): boolean {
  if (!['semver-patch', 'semver-minor'].includes(update.updateType)) return false;
  if (update.ecosystem === 'github-actions') return update.packageName === undefined;
  return update.ecosystem === 'npm' && (update.packageName === 'web' || update.packageName === 'scripts');
}

export function classifyPullRequest(input: ClassificationInput): ClassificationDecision {
  if (!input.metadata || input.metadata.updates.length === 0) {
    return deny('Dependabot metadata is unavailable');
  }

  for (const update of input.metadata.updates) {
    if (!updateMatchesAllowTable(update)) return deny('update is outside the allow table');

    if (update.ecosystem === 'npm' && update.packageName === 'web') {
      const registry = input.securityRegistry;
      if (!registry?.readable || !registry.consistent) {
        return deny('security dependency registry is missing, unreadable, or stale');
      }
      if (registry.directPackages.includes(update.dependencyName)) {
        return deny(`direct security package ${update.dependencyName} requires manual review`);
      }
      const changedRegisteredNode = (input.changedLockfileNodes ?? [])
        .find((node) => registry.lockfileNodes.includes(node));
      if (changedRegisteredNode) {
        return deny(`registered lockfile node ${changedRegisteredNode} changed`);
      }
    }
  }

  return allow('every update matches the allow table');
}

function validOrigin(input: HeadEvaluationInput): boolean {
  if (input.prAuthor !== 'dependabot[bot]') return false;
  if (!input.signature.valid || !input.signature.wasSignedByGitHub) return false;
  if (input.actor?.kind === 'dependabot') return true;
  if (input.actor?.kind !== 'update-mechanism') return false;

  const topology = input.topology;
  if (!topology || topology.parentShas.length !== 2) return false;
  if (!topology.secondParentInBase || !topology.introducesOnlyBaseChanges) return false;

  const firstParent = topology.parentShas[0];
  return input.storedResults?.some((result) =>
    result.sha === firstParent &&
    result.kind === 'provenance' &&
    result.producer === input.expectedEvidenceProducer &&
    result.conclusion === 'positive') ?? false;
}

export function evaluateHead(input: HeadEvaluationInput): HeadEvaluation {
  const originIsValid = validOrigin(input);
  const evidence: StoredResult = {
    sha: input.sha,
    kind: 'provenance',
    producer: input.expectedEvidenceProducer,
    conclusion: originIsValid ? 'positive' : 'negative',
  };

  if (!input.classificationEligible) {
    return { gate: { ok: false, reason: 'update class requires manual review' }, evidence };
  }
  if (!originIsValid) {
    return { gate: { ok: false, reason: 'head provenance is not valid for automatic merge' }, evidence };
  }
  return { gate: { ok: true, reason: 'eligible update with valid provenance' }, evidence };
}

export function evaluateMergeReadiness(input: MergeReadinessInput): Decision {
  if (!input.baseUpToDate) return { ok: false, reason: 'pull request base is stale' };

  for (const check of [...input.requiredChecks, ...input.mergeCombinationChecks]) {
    if (check.state !== 'success') return { ok: false, reason: `${check.name}: ${check.state}` };
  }
  return { ok: true, reason: 'all required checks passed against current main' };
}
