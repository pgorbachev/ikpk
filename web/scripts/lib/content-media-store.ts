import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function contentIdOf(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

export function readFromStore(input: {
  storeDir: string;
  contentId: string;
}): { ok: true; bytes: Uint8Array } | { ok: false; reason: 'content-id-mismatch' | 'missing'; contentId: string } {
  const path = join(input.storeDir, input.contentId);
  if (!existsSync(path)) return { ok: false, reason: 'missing', contentId: input.contentId };
  const bytes = new Uint8Array(readFileSync(path));
  if (contentIdOf(bytes) !== input.contentId) {
    return { ok: false, reason: 'content-id-mismatch', contentId: input.contentId };
  }
  return { ok: true, bytes };
}
