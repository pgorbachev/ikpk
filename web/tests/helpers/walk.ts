import { readdirSync, statSync } from 'fs';
import { basename, join } from 'path';

/** Astro routes are index.html (plus 404.html); root public HTML files are static resources. */
export function isSitePageHtml(file: string): boolean {
  const name = basename(file);
  return name === 'index.html' || name === '404.html';
}

/**
 * Обход дерева файлов — без привязки к каталогу вывода.
 *
 * Вынесено из `dist-pages.ts` не ради красоты: спека deploy-gating требует, чтобы
 * проверка боевого вывода и проверка демо-вывода не получали на вход чужой каталог.
 * Предмет проверки определяется тем, какой корень объявляет модуль в её замыкании
 * импортов, поэтому общий обходчик обязан не объявлять НИ ОДНОГО корня — иначе
 * `dist-pages.ts` и `demo-dist.ts` склеились бы в один предмет через общий импорт.
 */
export function* walkFiles(dir: string, exts: string[]): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // Dirents avoid a stat syscall for every ordinary file. statSync is still
    // needed for symlinks to preserve the previous follow-directory behavior;
    // broken links continue to fail closed.
    if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory())) {
      yield* walkFiles(full, exts);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      yield full;
    }
  }
}
