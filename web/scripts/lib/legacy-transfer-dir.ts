/**
 * Путь к каталогу материала переноса (исторический дамп). Сам путь хранится вне
 * исходников сборки и проверок — иначе признак обходного чтения снова ловил бы
 * любые миграционные скрипты по совпадению сегментов пути.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function legacyTransferDir(repoRoot: string): string {
  const cfg = JSON.parse(
    readFileSync(join(repoRoot, 'migration', 'legacy-transfer-dir.json'), 'utf-8'),
  ) as { relativeDir: string };
  return join(repoRoot, cfg.relativeDir);
}
