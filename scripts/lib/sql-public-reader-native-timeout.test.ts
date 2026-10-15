import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NATIVE_STDERR_SENTINEL = 'NATIVE_STDERR_SECRET_SENTINEL';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const nativeExecFile = vi.fn((
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
  callback: ExecFileCallback,
) => {
  const timeoutError = Object.assign(
    new Error(`native psql failed: ${NATIVE_STDERR_SENTINEL}`),
    {
      code: 'ETIMEDOUT',
      killed: true,
      stderr: NATIVE_STDERR_SENTINEL,
    },
  );

  callback(timeoutError, '', NATIVE_STDERR_SENTINEL);
  return {};
});

const CONNECTION = {
  unixSocketPath: '/tmp/synthetic-postgres-socket',
  port: 5432,
  database: 'synthetic_public_source',
  user: 'synthetic_readonly_user',
} as const;

let ownedTempDir: string | undefined;

function errorFootprint(error: Error): string {
  const ownProperties = Object.getOwnPropertyNames(error)
    .map((key) => `${key}:${String((error as unknown as Record<string, unknown>)[key])}`)
    .join('\n');
  const cause = (error as Error & { cause?: unknown }).cause;
  return [error.message, error.stack, ownProperties, String(cause ?? '')].join('\n');
}

afterEach(async () => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
  nativeExecFile.mockClear();
  if (ownedTempDir) {
    await rm(ownedTempDir, { recursive: true, force: true });
    ownedTempDir = undefined;
  }
});

describe('native SQL public source reader process deadline', () => {
  it('bounds the native process and masks timeout diagnostics from the reader error', async () => {
    ownedTempDir = await mkdtemp(join(tmpdir(), 'ikpk-sql-reader-timeout-'));
    const dumpPath = join(ownedTempDir, 'synthetic-dump-marker.bin');
    const dumpBytes = Buffer.from('SYNTHETIC DUMP ARTIFACT MARKER; this is not SQL');
    await writeFile(dumpPath, dumpBytes, { mode: 0o600 });

    vi.resetModules();
    vi.doMock('node:child_process', () => ({ execFile: nativeExecFile }));
    const { readSqlPublicSource } = await import('./sql-public-reader');

    const result = await readSqlPublicSource({
      dumpPath,
      expectedDumpHash: createHash('sha256').update(dumpBytes).digest('hex'),
      connection: { ...CONNECTION },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(nativeExecFile).toHaveBeenCalledOnce();
    const [, , nativeOptions] = nativeExecFile.mock.calls[0];
    expect(typeof nativeOptions.maxBuffer).toBe('number');
    expect(nativeOptions.maxBuffer).toBeGreaterThan(0);
    expect(nativeOptions.maxBuffer).toBeLessThanOrEqual(64 * 1024 * 1024);

    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toBe('Unable to read SQL public source');
      expect(errorFootprint(result)).not.toContain(NATIVE_STDERR_SENTINEL);
    }

    const timeout = nativeOptions.timeout;
    expect(typeof timeout).toBe('number');
    expect(Number.isFinite(timeout)).toBe(true);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});
