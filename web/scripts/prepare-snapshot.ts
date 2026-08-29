/**
 * Готовит каталог снимка для сборки: копирует закреплённую фикстуру (или
 * CONTENT_SNAPSHOT_DIR) в web/.snapshot и web/dist-snapshot.
 *
 * Публикующий прогон подменяет источник живым артефактом до этого шага.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
