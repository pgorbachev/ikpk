import { describe, expect, it } from 'vitest';
import { loadDependencyUpdateGates, type PublishedHeadInput } from './helpers/dependency-update-gates-contract';

const OLD = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';

function input(overrides: Partial<PublishedHeadInput> = {}): PublishedHeadInput {
  return {
    mainHeadSha: HEAD,
    mainHeadCreatedAt: '2026-08-17T09:00:00.000Z',
    publishedSha: HEAD,
    now: '2026-08-17T09:05:00.000Z',
    maxLagMs: 10 * 60 * 1000,
    cancelledIntermediateShas: [OLD],
    ...overrides,
  };
}

describe('dependency update gate: published main head', () => {
  it('does not require a cancelled intermediate commit once the current head is published', async () => {
    const { checkPublishedHead } = await loadDependencyUpdateGates();
    expect(checkPublishedHead(input())).toMatchObject({ ok: true });
  });

  it('signals and names an unpublished main head after the allowed lag', async () => {
    const { checkPublishedHead } = await loadDependencyUpdateGates();
    const result = checkPublishedHead(
      input({ publishedSha: OLD, now: '2026-08-17T09:10:00.001Z' }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain(HEAD);
  });
});
