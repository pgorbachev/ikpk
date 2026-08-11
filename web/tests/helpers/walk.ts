import { readdirSync, statSync } from 'fs';
import { join } from 'path';

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
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walkFiles(full, exts);
    } else if (exts.some((e) => name.endsWith(e))) {
      yield full;
    }
  }
}
