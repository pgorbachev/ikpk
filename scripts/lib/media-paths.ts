import { join, resolve, sep } from 'node:path';

/**
 * Куда класть скачанный ассет. Вынесено из download-media.ts, чтобы поведение
 * можно было проверить тестом: сам скрипт — top-level поток, его импорт запускает
 * скачивание, поэтому изолированно проверить построение пути было нельзя.
 */
export interface MediaDirs {
  /** Оригиналы (/media/**) — не отдаются посетителю. */
  originalsDir: string;
  /** Всё остальное (/terms/** и прочее) — внутри web/public. */
  publicDir: string;
}

/**
 * Локальный путь для ассета по его пути из данных.
 *
 * `path` приходит уже декодированным (см. safeDecode в download-media.ts):
 * decodeURI не трогает зарезервированные символы, но `%2E` в их число не входит,
 * поэтому `%2e%2e` превращается в `..` ДО попадания сюда.
 */
export class UnsafeAssetPathError extends Error {
  constructor(
    readonly assetPath: string,
    readonly resolvedPath: string,
  ) {
    super(`путь ассета выходит за пределы целевого каталога: ${assetPath} → ${resolvedPath}`);
    this.name = 'UnsafeAssetPathError';
  }
}

export function resolveLocalPath(path: string, dirs: MediaDirs): string {
  const segments = path.split('/').filter(Boolean);
  const toOriginals = segments[0] === 'media';
  const base = toOriginals ? dirs.originalsDir : dirs.publicDir;
  const localPath = join(base, ...(toOriginals ? segments.slice(1) : segments));

  // `filter(Boolean)` убирает только пустые сегменты: `..` проходит насквозь, а
  // `join` их схлопывает — без этой проверки запись уезжает выше целевого каталога.
  // Отказ, а не пропуск: молчаливый `continue` — это ровно тот случай, от которого
  // защищает счётчик malformed (отсутствие сигнала выдаётся за отсутствие проблемы).
  const resolved = resolve(localPath);
  if (!resolved.startsWith(resolve(base) + sep)) {
    throw new UnsafeAssetPathError(path, resolved);
  }
  return localPath;
}
