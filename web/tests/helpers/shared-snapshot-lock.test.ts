import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireSharedSnapshotLock } from './shared-snapshot-lock.ts';

describe('shared snapshot test lock', () => {
  it('times out without taking a lock already held by another suite', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'ikpk-snapshot-lock-test-'));
    const release = await acquireSharedSnapshotLock(webRoot);

    try {
      await expect(acquireSharedSnapshotLock(webRoot, 10)).rejects.toThrow('Timed out waiting for shared snapshot test lock');
    } finally {
      release();
    }
  });
});
