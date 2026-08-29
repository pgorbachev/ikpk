import { describe, expect, it } from 'vitest';
import {
  mergeVerifiedPairs,
  newerVerifiedPair,
  upsertVerifiedPair,
} from '../scripts/lib/verified-pairs.ts';
import type { VerifiedPair } from '../scripts/lib/publish-gate.ts';

function pair(partial: Partial<VerifiedPair> & Pick<VerifiedPair, 'commit' | 'snapshotId' | 'revision'>): VerifiedPair {
  return {
    referenceDate: '2026-08-01',
    capturedAt: '2026-08-01T00:00:00.000Z',
    testRunConclusion: 'success',
    ...partial,
  };
}

describe('verified-pairs index merge', () => {
  it('запоздавший индекс не выкидывает более новую пару', () => {
    const newer = pair({
      commit: 'a'.repeat(40),
      snapshotId: 'snap-new',
      revision: 5,
      capturedAt: '2026-08-27T12:00:00.000Z',
    });
    const olderView = [
      pair({ commit: 'a'.repeat(40), snapshotId: 'snap-old', revision: 2 }),
    ];
    const remoteWithNewer = [
      pair({ commit: 'a'.repeat(40), snapshotId: 'snap-old', revision: 2 }),
      newer,
    ];
    const merged = mergeVerifiedPairs(olderView, remoteWithNewer);
    expect(merged).toHaveLength(2);
    expect(merged.find((p) => p.snapshotId === 'snap-new')?.revision).toBe(5);
  });

  it('upsert не затирает другие ключи', () => {
    const base = [
      pair({ commit: 'a'.repeat(40), snapshotId: 'snap-1', revision: 1 }),
      pair({ commit: 'b'.repeat(40), snapshotId: 'snap-2', revision: 3 }),
    ];
    const next = upsertVerifiedPair(
      base,
      pair({ commit: 'a'.repeat(40), snapshotId: 'snap-1', revision: 4 }),
    );
    expect(next).toHaveLength(2);
    expect(next.find((p) => p.snapshotId === 'snap-1')?.revision).toBe(4);
    expect(next.find((p) => p.snapshotId === 'snap-2')?.revision).toBe(3);
  });

  it('newerVerifiedPair предпочитает большую revision', () => {
    const low = pair({ commit: 'a'.repeat(40), snapshotId: 's', revision: 1 });
    const high = pair({ commit: 'a'.repeat(40), snapshotId: 's', revision: 9 });
    expect(newerVerifiedPair(low, high).revision).toBe(9);
  });
});
