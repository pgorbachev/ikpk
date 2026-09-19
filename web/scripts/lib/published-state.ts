import type { PublicationRecord } from './publish-gate.ts';

type Pair = { commit: string; snapshotId: string };
export function comparePublishedState(input: {
  expected?: Pair;
  observed: Pair | null;
  publications?: PublicationRecord[];
  destinationId?: string;
  pendingDestinations?: string[];
}): { status: 'match' | 'mismatch' | 'unreadable'; differing?: ('commit' | 'snapshotId')[]; reason?: string } {
  if (input.pendingDestinations?.includes(input.destinationId ?? '')) {
    return { status: 'mismatch', reason: 'unfinished-publication-record' };
  }
  if (input.observed === null) return { status: 'unreadable' };
  const expected = input.publications === undefined ? input.expected :
    input.publications.filter((record) => record.destinationId === input.destinationId).at(-1);
  if (!expected) return { status: 'unreadable', reason: 'no-publication-record-for-destination' };
  const differing: ('commit' | 'snapshotId')[] = [];
  if (expected.commit !== input.observed.commit) differing.push('commit');
  if (expected.snapshotId !== input.observed.snapshotId) differing.push('snapshotId');
  if (differing.length === 0) return { status: 'match' };
  return { status: 'mismatch', differing };
}
