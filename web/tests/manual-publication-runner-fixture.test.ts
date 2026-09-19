import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerFixture } from './helpers/publication-runner-fixture.ts';

it('runner state machine positive control performs counted effects and actual local stage switch pending and index', async () => {
  const f = runnerFixture();
  try {
    await f.ports.readCiEvidence(f.input.commit);
    await f.ports.runChecks(f.input);
    const operation = f.operation();
    const proof = { commit: operation.commit, snapshotId: operation.snapshotId, destinationId: operation.destinationId, treeDigest: operation.treeDigest };
    await f.ports.createTransport({ authorize: async () => proof }).withLock(async (session) => {
      await session.stage({ releaseId: operation.releaseId, sourceDir: f.input.treeDir, expectedDigest: operation.treeDigest });
      await session.activate({ releaseId: operation.releaseId, operation,
        async beforeActivate() {
          expect(f.current()).toBe('old'); expect(existsSync(f.pendingPath)).toBe(true);
          await f.ports.readMain(); await f.ports.state.read(f.snapshot.fingerprint!);
        },
        async recordIndex(record) {
          expect(f.current()).toBe(operation.releaseId);
          expect((await f.ports.fetch(`${f.input.origin}/release.json`)).status).toBe(200);
          expect((await f.ports.fetch(`${f.input.origin}/`)).status).toBe(200);
          await f.ports.state.appendPublication(record);
        },
      });
    });
    expect(f.state.checks).toBe(1); expect(f.state.captures).toBe(1); expect(f.state.connections).toBe(1);
    expect(f.events.length).toBeGreaterThan(12); expect(f.state.requests).toHaveLength(2);
    expect(readFileSync(join(f.remote, 'releases', f.input.releaseId, 'index.html'))).toEqual(readFileSync(join(f.input.treeDir, 'index.html')));
    expect(f.index).toEqual([operation]); expect(existsSync(f.pendingPath)).toBe(false); expect(f.state.locked).toBe(false);
  } finally { f.clean(); }
});
