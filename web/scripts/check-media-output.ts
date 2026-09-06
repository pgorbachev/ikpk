/**
 * Fail the build when snapshot media is not a complete static-site input.
 * This runs after derivatives are generated and before Astro renders pages,
 * so a missing file or geometry cannot be postponed until deployment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const webRoot = resolve(import.meta.dirname, '..');
const snapshotPath = join(webRoot, '.snapshot', 'snapshot.json');
const mediaRoot = join(webRoot, 'public', 'media');
const manifestPath = join(webRoot, 'src', 'lib', 'media-manifest.json');

interface SnapshotMedia {
  ref: string;
  contentId: string;
}

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as {
  content?: { media?: SnapshotMedia[] };
};
const media = snapshot.content?.media ?? [];
if (media.length === 0) {
  throw new Error('медиа-гейт: в снимке нет медиа — проверять нечего');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<
  string,
  { width?: number; height?: number; widths?: number[] }
>;
const failures: string[] = [];

for (const item of media) {
  const ref = item.ref.startsWith('/uploads/') ? `/media${item.ref}` : item.ref;
  if (!ref.startsWith('/media/')) {
    failures.push(`${item.ref}: адрес не является статическим /media/**`);
    continue;
  }

  const rel = decodeURI(ref.slice('/media/'.length));
  const file = resolve(mediaRoot, rel);
  const outside = relative(resolve(mediaRoot), file);
  if (outside.startsWith('..') || outside === '' || !existsSync(file)) {
    failures.push(`${ref}: файла нет в public/media`);
    continue;
  }

  const entry = manifest[ref];
  if (!entry?.width || !entry.height) {
    failures.push(`${ref}: в манифесте нет width/height`);
  }
  for (const width of entry?.widths ?? []) {
    const variant = join(mediaRoot, '_w', String(width), rel);
    if (!existsSync(variant)) failures.push(`${ref}: нет производной @${width}w`);
  }
}

if (failures.length > 0) {
  throw new Error(`медиа-гейт: сборка остановлена:\n${failures.join('\n')}`);
}

console.log(`медиа-гейт: проверено ${media.length} записей снимка`);
