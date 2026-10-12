import { mkdirSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Serialize tests that mutate the checkout's shared web/.snapshot directories. */
export async function acquireSharedSnapshotLock(webRoot: string, timeoutMs = 60_000): Promise<() => void> {
  const key = createHash('sha256').update(webRoot).digest('hex').slice(0, 16);
  const lockDir = join(tmpdir(), `ikpk-web-snapshot-${key}.lock`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      return () => rmdirSync(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Timed out waiting for shared snapshot test lock: ${lockDir}`);
}
