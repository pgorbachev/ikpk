/**
 * Готовит каталог снимка для сборки: копирует закреплённую фикстуру (или
 * CONTENT_SNAPSHOT_DIR) в web/.snapshot и web/dist-snapshot.
 *
 * Публикующий прогон подменяет источник живым артефактом до этого шага.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeInto } from './lib/content-media-store.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');

const fromEnv = process.env.CONTENT_SNAPSHOT_DIR;
const pinned = join(repoRoot, 'fixtures', 'content-snapshot');
const source = fromEnv && existsSync(join(fromEnv, 'snapshot.json')) ? fromEnv : pinned;

if (!existsSync(join(source, 'snapshot.json'))) {
  throw new Error(`prepare-snapshot: нет snapshot.json в ${source}`);
}

for (const dest of [join(webRoot, '.snapshot'), join(webRoot, 'dist-snapshot')]) {
  mkdirSync(dest, { recursive: true });
  cpSync(join(source, 'snapshot.json'), join(dest, 'snapshot.json'));
  const panels = join(source, 'collapsible_panels.json');
  if (existsSync(panels)) cpSync(panels, join(dest, 'collapsible_panels.json'));
  // Карта адресов — часть артефакта снимка (задача 6.3): генератор редиректов читает её отсюда.
  const urlMap = join(source, 'url_map.csv');
  if (existsSync(urlMap)) cpSync(urlMap, join(dest, 'url_map.csv'));
}

// CMS originals are an input to the same derivative generator as repository originals, but
// remain inside the generated snapshot area. This keeps a live capture reproducible without
// adding mutable CMS files to the tracked `media-originals/` tree.
const materializedDir = join(webRoot, '.snapshot', 'media-originals');
rmSync(materializedDir, { recursive: true, force: true });
const prepared = JSON.parse(readFileSync(join(webRoot, '.snapshot', 'snapshot.json'), 'utf-8')) as {
  content?: { media?: { ref: string; contentId: string }[] };
};
const cmsMedia = (prepared.content?.media ?? []).filter((item) => item.ref.startsWith('/media/uploads/'));
if (cmsMedia.length > 0) {
  const result = materializeInto({
    storeDir: join(source, 'media'),
    destDir: materializedDir,
    media: cmsMedia,
  });
  if (!result.ok) {
    throw new Error(
      `prepare-snapshot: медиа ${result.ref} не подготовлено (${result.reason}, ${result.contentId})`,
    );
  }
}

// Убеждаемся, что идентификаторы на месте (для build-гейтов).
const snap = JSON.parse(readFileSync(join(webRoot, 'dist-snapshot', 'snapshot.json'), 'utf-8')) as {
  fingerprint?: string;
  snapshotId?: string;
  referenceDate: string;
};
if (!snap.fingerprint || !snap.snapshotId) {
  const { contentFingerprint, snapshotId } = await import('./lib/content-snapshot.ts');
  const full = JSON.parse(readFileSync(join(webRoot, 'dist-snapshot', 'snapshot.json'), 'utf-8'));
  full.fingerprint = contentFingerprint(full.content);
  full.snapshotId = snapshotId({ fingerprint: full.fingerprint, referenceDate: full.referenceDate });
  writeFileSync(join(webRoot, 'dist-snapshot', 'snapshot.json'), JSON.stringify(full));
  writeFileSync(join(webRoot, '.snapshot', 'snapshot.json'), JSON.stringify(full));
}

console.log(`prepare-snapshot: ${source} → web/.snapshot, web/dist-snapshot`);
