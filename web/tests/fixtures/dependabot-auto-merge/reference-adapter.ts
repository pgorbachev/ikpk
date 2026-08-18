import type {
  ClassificationInput,
  ClassificationDecision,
  Decision,
  HeadEvaluation,
  HeadEvaluationInput,
  MergeReadinessInput,
  StoredResult,
} from '../../helpers/dependabot-auto-merge-contract';

const allow = (reason: string): ClassificationDecision => ({ ok: true, eligible: true, reason });
const deny = (reason: string): ClassificationDecision => ({ ok: true, eligible: false, reason });

export function classifyPullRequest(input: ClassificationInput): ClassificationDecision {
  if (!input.metadata || input.metadata.updates.length === 0) return deny('Dependabot metadata unavailable');
  for (const update of input.metadata.updates) {
    const allowed = update.updateType !== 'semver-major' && (
      (update.ecosystem === 'github-actions' && update.packageName === undefined) ||
      (update.ecosystem === 'npm' && ['web', 'scripts'].includes(update.packageName ?? ''))
    );
    if (!allowed || update.packageName === 'cms') return deny('update is outside the allow table');
    if (update.ecosystem === 'npm' && update.packageName === 'web') {
      const registry = input.securityRegistry;
      if (!registry?.readable || !registry.consistent) return deny('security registry unavailable or stale');
      if (registry.directPackages.includes(update.dependencyName)) return deny('direct security package');
      if ((input.changedLockfileNodes ?? []).some((node) => registry.lockfileNodes.includes(node))) {
        return deny('registered lockfile node changed');
      }
    }
  }
  return allow('every update matches the allow table');
}

function originIsValid(input: HeadEvaluationInput): boolean {
  if (!input.signature.valid || !input.signature.wasSignedByGitHub || input.prAuthor !== 'dependabot[bot]') {
    return false;
  }
  if (input.actor?.kind === 'dependabot') return true;
  if (input.actor?.kind !== 'update-mechanism') return false;
  const topology = input.topology;
  if (!topology || topology.parentShas.length !== 2 || !topology.secondParentInBase ||
      !topology.introducesOnlyBaseChanges) return false;
  return (input.storedResults ?? []).some((result) =>
    result.sha === topology.parentShas[0] &&
    result.kind === 'provenance' &&
    result.producer === input.expectedEvidenceProducer &&
    result.conclusion === 'positive');
}

export function evaluateHead(input: HeadEvaluationInput): HeadEvaluation {
  const origin = originIsValid(input);
  const evidence: StoredResult = {
    sha: input.sha,
    kind: 'provenance',
    producer: input.expectedEvidenceProducer,
    conclusion: origin ? 'positive' : 'negative',
  };
  const gate = !input.autoMergeEnabled
    ? { ok: true, reason: 'manual path' }
    : input.classificationEligible && origin
      ? { ok: true, reason: 'eligible class and valid origin' }
      : { ok: false, reason: 'auto-merge requires eligible class and valid origin' };
  return { gate, evidence };
}

export function evaluateMergeReadiness(input: MergeReadinessInput): Decision {
  if (!input.baseUpToDate) return { ok: false, reason: 'base is stale' };
  const checks = [...input.requiredChecks, ...input.mergeCombinationChecks];
  const nonSuccess = checks.find((check) => check.state !== 'success');
  return nonSuccess
    ? { ok: false, reason: `${nonSuccess.name}: ${nonSuccess.state}` }
    : { ok: true, reason: 'all required checks passed on current base' };
}
