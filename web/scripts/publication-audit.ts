// Builtin-only audit curator shared by native entrypoints.
export interface WorkerAudit {
  version: 1; status: 'success' | 'refused';
  code: 'recovered' | 'recovery-noop' | 'recovery-cancelled' | 'state-accepted' | 'recovery-failed' | 'accept-state-failed' | 'published' | 'rolled-back' | 'rollback-failed' | 'publication-failed' | 'checks-failed' | 'ci-failed' | 'provenance-changed' | 'active-unindexed' | 'main-changed';
  commit?: string; releaseId?: string; snapshotId?: string; treeDigest?: string; publicationId?: string;
  observedEntry?: number; revision?: number; latestEntry?: number; highWaterMark?: number;
  localExecutedTests?: number; ciExecutedTests?: number; check?: string;
  activePair?: { commit: string; snapshotId: string; releaseId: string };
}
const auditCodes = ['recovery-failed', 'accept-state-failed', 'rollback-failed', 'publication-failed', 'checks-failed', 'ci-failed', 'provenance-changed', 'active-unindexed', 'main-changed'];
const auditChecks = ['snapshot-provenance', 'build-content', 'destination-mode', 'browser-smoke', 'payment-destination', 'payment-readiness', 'payment-preflight', 'capture', 'build'];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Builtin-only, pure curator. No exception messages, causes, log strings or sinks. */
export function createWorkerAudit({ operation, error }: { operation?: unknown; error?: unknown }): WorkerAudit {
  const source = operation === undefined ? object(object(error).audit) : object(operation);
  if (operation !== undefined && typeof source.code === 'string' && ['recovery-noop', 'recovery-cancelled', 'state-accepted'].includes(source.code)) {
    const audit: WorkerAudit = { version: 1, status: 'success', code: source.code as WorkerAudit['code'] };
    if (source.code === 'state-accepted') {
      if (count(source.observedEntry)) audit.observedEntry = source.observedEntry;
      if (count(source.revision)) audit.revision = source.revision;
    }
    return audit;
  }
  const audit: WorkerAudit = { version: 1, status: operation === undefined ? 'refused' : 'success',
    code: operation === undefined ? (typeof source.code === 'string' && auditCodes.includes(source.code) ? source.code as WorkerAudit['code'] : 'publication-failed') : (source.code === 'recovered' ? 'recovered' : typeof source.rollbackOfPublicationId === 'string' ? 'rolled-back' : 'published') };
  for (const [field, pattern] of Object.entries({ commit: /^[a-f0-9]{40}$/, snapshotId: /^snap:[a-f0-9]{64}$/,
    treeDigest: /^[a-f0-9]{64}$/, publicationId: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    ...(audit.code === 'rolled-back' || audit.code === 'recovered' || operation === undefined ? { releaseId: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ } : {}) })) {
    if (typeof source[field] === 'string' && pattern.test(source[field])) Object.assign(audit, { [field]: source[field] });
  }
  for (const field of audit.code === 'recovered' ? ['revision'] : ['observedEntry', 'revision', 'latestEntry', 'highWaterMark', 'localExecutedTests', 'ciExecutedTests']) {
    if (count(source[field])) Object.assign(audit, { [field]: source[field] });
  }
  if (operation !== undefined) {
    const groups = object(typeof source.rollbackOfPublicationId === 'string' ? source.rollbackChecks : source.localChecks).groups;
    if (Array.isArray(groups) && groups.length && groups.every((group) => count(object(group).executedTests))) {
      const total = groups.reduce((sum, group) => sum + Number(object(group).executedTests), 0);
      if (count(total)) audit.localExecutedTests = total;
    }
    if (count(object(source.ciEvidence).executedTests)) audit.ciExecutedTests = object(source.ciEvidence).executedTests as number;
  }
  if (audit.code !== 'recovered' && typeof source.check === 'string' && auditChecks.includes(source.check)) audit.check = source.check as string;
  const pair = object(source.activePair);
  if (audit.code === 'active-unindexed' && typeof pair.commit === 'string' && /^[a-f0-9]{40}$/.test(pair.commit) &&
      typeof pair.snapshotId === 'string' && /^snap:[a-f0-9]{64}$/.test(pair.snapshotId) &&
      typeof pair.releaseId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pair.releaseId)) {
    audit.activePair = { commit: pair.commit, snapshotId: pair.snapshotId, releaseId: pair.releaseId };
  }
  return audit;
}

