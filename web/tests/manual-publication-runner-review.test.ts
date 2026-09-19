import { describe, expect, it } from 'vitest';
import { runNewPublication, type PublicationAuthorizationRequest } from '../scripts/lib/publication-runner.ts';
import { runnerFixture } from './helpers/publication-runner-fixture.ts';

describe('review: provenance refusals remain locally auditable', () => {
  it('stale snapshot refusal exposes the observed and latest entries, revision and current high-water mark', async () => {
    const f = runnerFixture();
    try {
      f.hooks.afterStage = f.changedEvent;
      const failure = await runNewPublication(f.input, f.ports).catch((error) => error);
      expect(f.current()).toBe('old');
      expect(f.index).toEqual([]);
      // Fields or the message may carry the evidence; no remote re-read should be needed.
      const diagnostic = `${failure.message} ${JSON.stringify(failure)}`;
      expect(diagnostic).toMatch(/observedEntry[=:"\s]+4/);
      expect(diagnostic).toMatch(/latestEntry[=:"\s]+5/);
      expect(diagnostic).toMatch(/revision[=:"\s]+4/);
      expect(diagnostic).toMatch(/highWaterMark[=:"\s]+5/);
    } finally { f.clean(); }
  });

  it('regression refusal exposes the captured observation, revision and high-water mark', async () => {
    const f = runnerFixture();
    try {
      f.snapshot.provenance!.revision = 1;
      const failure = await runNewPublication(f.input, f.ports).catch((error) => error);
      expect(f.state.connections).toBe(0);
      const diagnostic = `${failure.message} ${JSON.stringify(failure)}`;
      expect(diagnostic).toMatch(/observedEntry[=:"\s]+4/);
      expect(diagnostic).toMatch(/revision[=:"\s]+1/);
      expect(diagnostic).toMatch(/highWaterMark[=:"\s]+4/);
    } finally { f.clean(); }
  });
});

describe('review: authorization checks are exercised before expiry', () => {
  it('rejects forged requests while a positive connect and original activation remain authorized', async () => {
    const f = runnerFixture();
    try {
      const originalCreate = f.ports.createTransport;
      let assertions = 0;
      f.ports.createTransport = (input) => {
        const transport = originalCreate(input);
        return {
          async withLock(callback) {
            await expect(input.authorize({ action: 'connect', destinationId: 'stand' })).resolves.toMatchObject({ destinationId: 'stand' });
            await expect(input.authorize({ action: 'activate', destinationId: 'stand', operation: f.operation() })).resolves.toMatchObject({ destinationId: 'stand' });
            const requests: PublicationAuthorizationRequest[] = [
              ...['publicationId', 'releaseId', 'destinationId', 'treeDigest', 'commit', 'snapshotId', 'actor'].map((field) => ({
                action: 'activate' as const, destinationId: 'stand', operation: { ...f.operation(), [field]: 'foreign' },
              })),
              { action: 'connect', destinationId: 'foreign' },
              { action: 'stage', destinationId: 'stand', expectedDigest: '0'.repeat(64) },
              { action: 'rollback', destinationId: 'stand', operation: f.operation() },
              { action: 'recover', destinationId: 'stand', operation: f.operation() },
            ];
            for (const request of requests) {
              await expect(input.authorize(request)).rejects.toThrow(); assertions++;
            }
            return transport.withLock(callback);
          },
        };
      };
      await runNewPublication(f.input, f.ports);
      expect(assertions).toBe(11);
      expect(f.index).toHaveLength(1);
    } finally { f.clean(); }
  });
});
