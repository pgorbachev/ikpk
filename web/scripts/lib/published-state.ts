export function comparePublishedState(input: {
  expected: { commit: string; snapshotId: string };
  observed: { commit: string; snapshotId: string } | null;
}): { status: 'match' | 'mismatch' | 'unreadable'; differing?: ('commit' | 'snapshotId')[] } {
  if (input.observed === null) return { status: 'unreadable' };
  const differing: ('commit' | 'snapshotId')[] = [];
  if (input.expected.commit !== input.observed.commit) differing.push('commit');
  if (input.expected.snapshotId !== input.observed.snapshotId) differing.push('snapshotId');
  if (differing.length === 0) return { status: 'match' };
  return { status: 'mismatch', differing };
}
