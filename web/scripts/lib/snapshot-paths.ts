import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Каталог снимка контента. Порядок:
 * 1. CONTENT_SNAPSHOT_DIR — явный путь (артефакт прогона / локальный override);
 * 2. web/.snapshot — живой снимок, положенный шагом capture;
 * 3. fixtures/content-snapshot — закреплённая фикстура для проверок предложений.
 */
export function resolveSnapshotDir(webRoot: string, repoRoot: string): string {
  const fromEnv = process.env.CONTENT_SNAPSHOT_DIR;
  if (fromEnv && existsSync(join(fromEnv, 'snapshot.json'))) return fromEnv;

  const live = join(webRoot, '.snapshot');
  if (existsSync(join(live, 'snapshot.json'))) return live;

  const pinned = join(repoRoot, 'fixtures', 'content-snapshot');
  if (existsSync(join(pinned, 'snapshot.json'))) return pinned;

  throw new Error(
    'снимок контента не найден: задайте CONTENT_SNAPSHOT_DIR или положите snapshot.json в web/.snapshot / fixtures/content-snapshot',
  );
}
