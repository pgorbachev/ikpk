import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Extensions the site copy step may write. The check uses the path only:
 * a query string is ignored, and the extension comparison is case-insensitive.
 * GIF stays here because the derivative step already copies it unchanged.
 */
const PUBLISHABLE_MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.gif']);

export function mediaExtension(ref: string): string {
  const path = ref.split(/[?#]/, 1)[0] ?? '';
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

export function isPublishableMedia(ref: string): boolean {
  return PUBLISHABLE_MEDIA_EXTENSIONS.has(mediaExtension(ref));
}

/** Writes a site file only when the source path is on the publishable allowlist. */
export function copyIfPublishable(src: string, dest: string): 'copied' | 'skipped' {
  if (!isPublishableMedia(src)) return 'skipped';
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return 'copied';
}
