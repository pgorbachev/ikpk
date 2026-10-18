import { expect, it } from 'vitest';
import { createWorkerAudit } from '../scripts/publication-audit.ts';

const pair = { commit: 'a'.repeat(40), snapshotId: `snap:${'b'.repeat(64)}`, releaseId: 'retained',
  publicationId: 'pending', treeDigest: 'c'.repeat(64), revision: 7 };
const localChecks = { groups: [{ executedTests: 4 }, { executedTests: 5 }] };
const ciEvidence = { executedTests: 51 };

it('recovered audit of a real publication shape excludes unrelated provenance and raw fields', () => {
  expect(createWorkerAudit({ operation: { ...pair, code: 'recovered', localChecks, ciEvidence,
    observedEntry: 7, highWaterMark: 7, latestEntry: 7, check: 'capture', message: 'credential-canary' } }))
    .toEqual({ version: 1, status: 'success', code: 'recovered', ...pair, localExecutedTests: 9, ciExecutedTests: 51 });
});
it('recovered rollback reports the checks of the pending rollback operation', () => {
  expect(createWorkerAudit({ operation: { ...pair, code: 'recovered', localChecks, ciEvidence,
    rollbackOfPublicationId: 'original', rollbackChecks: { groups: [{ executedTests: 3 }] } } }))
    .toEqual({ version: 1, status: 'success', code: 'recovered', ...pair, localExecutedTests: 3, ciExecutedTests: 51 });
});
it.each(['recovery-noop', 'recovery-cancelled'])('%s strips every publication claim', (code) => {
  expect(createWorkerAudit({ operation: { ...pair, code, localChecks, ciEvidence } }))
    .toEqual({ version: 1, status: 'success', code });
});
it('state acceptance emits only the explicitly observed entry and resulting revision', () => {
  expect(createWorkerAudit({ operation: { ...pair, code: 'state-accepted', observedEntry: 6, localChecks, ciEvidence } }))
    .toEqual({ version: 1, status: 'success', code: 'state-accepted', observedEntry: 6, revision: 7 });
});
