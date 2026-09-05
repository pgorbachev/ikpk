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
  conclusion?: 'success' | 'failure' | 'neutral' | 'skipped';
}

export interface ClassificationDecision extends Decision {
  eligible: boolean;
  status: 'eligible' | 'manual-review' | 'error';
}

export interface StoredResult {
  sha: string;
  kind: 'provenance' | 'eligibility-gate';
  producer: string;
  conclusion: 'positive' | 'negative' | 'skipped';
}

export interface HeadEvaluationInput {
  sha: string;
  autoMergeEnabled: boolean;
  classificationEligible: boolean;
  classificationStatus?: ClassificationDecision['status'] | 'not-applicable';
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
  enableAutoMerge: boolean;
  disableAutoMerge: boolean;
  recordEvidence: boolean;
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

const allow = (reason: string): ClassificationDecision => ({
  ok: true, eligible: true, status: 'eligible', conclusion: 'success', reason,
});
const deny = (reason: string): ClassificationDecision => ({
  ok: true, eligible: false, status: 'manual-review', conclusion: 'neutral', reason,
});
const error = (reason: string): ClassificationDecision => ({
  ok: false, eligible: false, status: 'error', conclusion: 'failure', reason,
});

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
  const dispatcherIsBound = input.dispatcherRun.event === 'workflow_run' &&
    input.dispatcherRun.path === input.expectedDispatcherWorkflowPath &&
    input.dispatcherRun.sourceRunId === input.sourceRun.id &&
    input.dispatcherRun.sourceRunAttempt === input.sourceRun.runAttempt &&
    input.jobsRunId === input.dispatcherRun.id &&
    input.jobsRunAttempt === input.dispatcherRun.runAttempt;
  const sourceIsBound = input.sourceRun.event === 'pull_request_target' &&
    input.sourceRun.path === input.expectedSignalWorkflowPath &&
    input.sourceRun.conclusion === 'success' &&
    input.sourceRun.actorLogin === input.expectedSignalActor &&
    input.sourceRun.headSha === input.targetHeadSha &&
    input.sourceRun.pullRequests.filter(({ number, headSha }) =>
      number === input.targetPullRequestNumber && headSha === input.targetHeadSha).length === 1;
  const provenanceJobs = input.jobs.filter(({ name }) => name === input.provenanceJobName);
  return dispatcherIsBound && sourceIsBound && provenanceJobs.length === 1 &&
    provenanceJobs[0].conclusion === 'success';
}

function updateMatchesAllowTable(update: DependencyUpdate): boolean {
  if (!['semver-patch', 'semver-minor'].includes(update.updateType)) return false;
  if (update.ecosystem === 'github-actions') return update.packageName === undefined;
  return update.ecosystem === 'npm' && (update.packageName === 'web' || update.packageName === 'scripts');
}

export function classifyPullRequest(input: ClassificationInput): ClassificationDecision {
  if (!input.metadata || input.metadata.updates.length === 0) {
    return error('Dependabot metadata is unavailable; restore metadata and rerun the assessment');
  }

  if (input.metadata.updates.some((update) =>
    typeof update.dependencyName !== 'string' || !update.dependencyName.trim() ||
    !['semver-patch', 'semver-minor', 'semver-major'].includes(update.updateType))) {
    return error('Dependabot metadata is malformed; restore metadata and rerun the assessment');
  }
  // A manual member must not hide a failed mandatory evaluation in a grouped PR.
  if (input.metadata.updates.some((update) => update.ecosystem === 'npm' && update.packageName === 'web') &&
      (!input.securityRegistry?.readable || !input.securityRegistry.consistent)) {
    return error('security dependency registry is missing, unreadable, or stale; repair the registry');
  }

  for (const update of input.metadata.updates) {
    if (!updateMatchesAllowTable(update)) return deny('update is outside the allow table');

    if (update.ecosystem === 'npm' && update.packageName === 'web') {
      const registry = input.securityRegistry;
      if (!registry?.readable || !registry.consistent) {
        return error('security dependency registry is missing, unreadable, or stale; repair the registry');
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
  const recordEvidence = input.action === undefined || input.action === 'opened' || input.action === 'synchronize';
  if (input.prAuthor && input.prAuthor !== 'dependabot[bot]') {
    return {
      gate: { ok: true, conclusion: 'skipped', reason: 'Not a Dependabot PR; follow the ordinary PR review process' },
      evidence: { sha: input.sha, kind: 'provenance', producer: input.expectedEvidenceProducer, conclusion: 'skipped' },
      enableAutoMerge: false, disableAutoMerge: false, recordEvidence,
    };
  }
  const originIsValid = validOrigin(input);
  const evidence: StoredResult = {
    sha: input.sha,
    kind: 'provenance',
    producer: input.expectedEvidenceProducer,
    conclusion: originIsValid ? 'positive' : 'negative',
  };

  const eligible = input.classificationEligible &&
    (input.classificationStatus === undefined || input.classificationStatus === 'eligible');
  const actions = {
    evidence, recordEvidence,
    enableAutoMerge: eligible && originIsValid && !input.autoMergeEnabled,
    disableAutoMerge: input.autoMergeEnabled && (!eligible || !originIsValid),
  };
  if (!originIsValid) {
    return { ...actions, gate: { ok: false, conclusion: 'failure', reason: 'head provenance is not valid for automatic merge; have Dependabot regenerate the branch' } };
  }
  if (!eligible) {
    return input.classificationStatus === 'manual-review'
      ? { ...actions, gate: { ok: true, conclusion: 'neutral', reason: 'update class requires manual review' } }
      : { ...actions, gate: { ok: false, conclusion: 'failure', reason: 'classification could not be confirmed; repair the assessment inputs' } };
  }
  return { ...actions, gate: { ok: true, conclusion: 'success', reason: 'eligible update with valid provenance; await required CI checks' } };
}

export function evaluateMergeReadiness(input: MergeReadinessInput): Decision {
  if (!input.baseUpToDate) return { ok: false, reason: 'pull request base is stale' };

  for (const check of [...input.requiredChecks, ...input.mergeCombinationChecks]) {
    if (check.state !== 'success') return { ok: false, reason: `${check.name}: ${check.state}` };
  }
  return { ok: true, reason: 'all required checks passed against current main' };
}
