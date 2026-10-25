import { afterEach, describe, expect, it, vi } from 'vitest';
import { usesPublicationCandidateCapture } from './helpers/publication-smoke-context.ts';

afterEach(() => vi.unstubAllEnvs());

describe('publication smoke context selection', () => {
  it('uses the owned candidate for production-static captures', () => {
    vi.stubEnv('PUBLICATION_PRODUCTION_STATIC_CAPTURE', '1');
    expect(usesPublicationCandidateCapture()).toBe(true);
  });
});
