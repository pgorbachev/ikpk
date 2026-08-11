import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { walkFiles } from './walk';

/**
 * Предмет проверок демо-сборки — её собственный каталог вывода.
 *
 * Отдельный каталог нормативен: change `deploy-gated-on-tests` (решение 6 в `design.md`,
 * задача 6.1) требует развести выводы. Пока демо-сборка писала в `dist/`, предметом
 * проверок оказывалась та сборка, которая закончилась последней, — то есть свойство
 * порядка шагов, а не предмета.
 *
 * Модуль намеренно НЕ импортирует `./dist-pages`: тот объявляет боевой корень, и общий
 * импорт дал бы одной проверке два предмета — ровно то, что спека запрещает
 * («проверка, написанная про один из них, SHALL NOT получать на вход другой»). Общий у
 * них только обходчик `./walk`, который не объявляет никакого корня.
 */
export const demoDist = join(import.meta.dirname, '..', '..', 'dist-demo');

function noSubject(root: string, what: string): Error {
  return new Error(
    `предмета проверки нет: ${what} — '${root}'. Пустой вывод считается «не выполнено», ` +
      'а не «нарушений нет» (spec deploy-gating, сценарий «демо-вывода нет вовсе»). ' +
      'Собрать демо-вывод: npm run build:demo',
  );
}

/**
 * Все html-страницы демо-вывода.
 *
 * **Падает** на отсутствующем, не-каталоге и пустом корне — это и есть исполнение
 * сценария «демо-вывода нет вовсе»: проверка, лишившаяся предмета, обязана считаться
 * непройденной. Поэтому перечисление живёт здесь, а не внутри тестового файла: его
 * должно быть можно вызвать отдельно и убедиться, что на пустом каталоге оно падает.
 */
export function demoPages(root: string = demoDist): string[] {
  if (!existsSync(root)) throw noSubject(root, 'каталога вывода нет');
  if (!statSync(root).isDirectory()) throw noSubject(root, 'путь вывода — не каталог');
  const pages = [...walkFiles(root, ['.html'])];
  if (pages.length === 0) throw noSubject(root, 'html-страниц в выводе нет');
  return pages;
}

/** Содержимое файла демо-вывода по пути относительно корня. Нет файла — предмета нет. */
export function readDemoFile(relPath: string, root: string = demoDist): string {
  const file = join(root, relPath);
  if (!existsSync(file)) throw noSubject(file, `файла '${relPath}' в выводе нет`);
  return readFileSync(file, 'utf-8');
}

/** Путь страницы относительно корня демо-вывода, в POSIX-форме и с ведущим слэшем. */
export function demoPagePath(absFile: string, root: string = demoDist): string {
  return absFile.slice(root.length).replaceAll('\\', '/');
}

/**
 * Все страницы демо-вывода каноническими путями ('/', '/statyi/', …) — зеркало
 * `allPages()` из `dist-pages.ts`, чтобы проверки переносились между предметами без
 * переписывания тела.
 */
export function allDemoPages(root: string = demoDist): string[] {
  return demoPages(root)
    .filter((f) => f.endsWith('index.html'))
    .map((f) => demoPagePath(f, root).replace(/index\.html$/, ''));
}

/** Зеркало `readPage()` из `dist-pages.ts` для демо-вывода. */
export function readDemoPage(path: string, root: string = demoDist): string {
  return readDemoFile(join(path, 'index.html'), root);
}
