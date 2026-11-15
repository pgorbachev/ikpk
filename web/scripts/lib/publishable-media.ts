import { extname } from 'node:path';

/**
 * Extensions the site copy step may write. The check uses the path only:
 * a query string is ignored, and the extension comparison is case-insensitive.
 */
const PUBLISHABLE_MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

export function mediaExtension(ref: string): string {
  const pathOnly = ref.split(/[?#]/, 1)[0] ?? '';
  return extname(pathOnly).toLowerCase();
}

export function isPublishableMedia(ref: string): boolean {
  return PUBLISHABLE_MEDIA_EXTENSIONS.has(mediaExtension(ref));
}
