import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

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

/**
 * Materializes CMS media under the same root used by the regular derivative
 * generator. The ref is a shipped-site URL, so `/media/foo.webp` maps to
 * `<destDir>/foo.webp`.
 *
 * Read and verify every item before writing anything. A later corrupt or
 * missing item must not leave a partially materialized input tree for the
 * derivative step.
 */
export function materializeInto(input: {
  storeDir: string;
  destDir: string;
  media: { ref: string; contentId: string }[];
}):
  | { ok: true; written: string[] }
  | { ok: false; reason: 'content-id-mismatch' | 'missing'; ref: string; contentId: string } {
  const pending: { ref: string; target: string; bytes: Uint8Array }[] = [];
  const root = resolve(input.destDir);

  for (const item of input.media) {
    if (!item.ref.startsWith('/media/')) {
      throw new Error(`некорректный статический адрес медиа: ${item.ref}`);
    }

    let rel: string;
    try {
      rel = decodeURI(item.ref.slice('/media/'.length));
    } catch {
      throw new Error(`некорректное кодирование адреса медиа: ${item.ref}`);
    }
    const target = resolve(root, rel);
    const outside = relative(root, target);
    if (outside.startsWith('..') || outside === '') {
      throw new Error(`адрес медиа выходит из каталога сборки: ${item.ref}`);
    }

    const read = readFromStore({ storeDir: input.storeDir, contentId: item.contentId });
    if (!read.ok) return { ok: false, reason: read.reason, ref: item.ref, contentId: item.contentId };
    pending.push({ ref: item.ref, target, bytes: read.bytes });
  }

  for (const item of pending) {
    mkdirSync(dirname(item.target), { recursive: true });
    writeFileSync(item.target, item.bytes);
  }
  return { ok: true, written: pending.map((item) => item.ref) };
}
