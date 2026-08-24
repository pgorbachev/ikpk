import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkFiles } from './walk';

/**
 * ПРОБНАЯ СБОРКА: тот же боевой конвейер, но с подставленной конфигурацией и в каталог
 * вне репозитория.
 *
 * ── ЗАЧЕМ ОНА ЕСТЬ, А НЕ ХВАТАЕТ ОДНОЙ СБОРКИ ───────────────────────────────
 * У боевой сборки ОДНО состояние конфигурации и ОДИН год сборки. Спека же требует
 * поведения в трёх состояниях адреса загрузчика и в двух годах, причём объявляет
 * публикуемыми оба состояния, где страница выглядит по-разному. Значит на единственной
 * сборке ровно одна ветвь имеет предмет, а остальные остались бы без построимого красного
 * состояния — и «законное состояние» с «зелёным гейтом» опять стали бы недостижимы
 * одновременно.
 *
 * Приём не выдуман здесь: спека применяет его сама к году сборки — «проверка идёт на ДВУХ
 * СБОРКАХ, различающихся `BUILD_YEAR`, потому что механизма подмены системных часов сборки
 * в репозитории нет». К трём состояниям конфигурации спека того же вывода не сделала, и это
 * названо находкой в передаче; здесь приём просто распространён.
 *
 * ── ЦЕНА ИЗМЕРЕНА, А НЕ ОЦЕНЕНА ─────────────────────────────────────────────
 * `npx astro build --outDir <вне репозитория>` на этом дереве — **6,3 с** и 91 МБ (замер
 * 24.08.2026, node 24.13.0, тёплый кэш vite). Это НЕ `npm run build`: тот идёт 1 мин 14 с,
 * потому что делает ещё `prebuild` (производные картинок) и `pagefind`. Производные пробной
 * сборке нужны уже готовыми — она их не пересобирает, поэтому вызывать её можно только
 * ПОСЛЕ обычной сборки. Отсюда место файлов-потребителей: `vitest.build.config.ts`, который
 * запускается скриптом `test:build` сразу за `npm run build`.
 *
 * ── ПОЧЕМУ КАТАЛОГ ВНЕ РЕПОЗИТОРИЯ ──────────────────────────────────────────
 * Корень сборочного вывода внутри репозитория пришлось бы вписать и в `.gitignore`, и в
 * закрытый перечень корней у `./bin/check-spec-refs` (он сверяет их с `.gitignore` и
 * отказывается при расхождении), и в реестр вхождений исполняемого вывода, который требует
 * ДВА собранных дерева. Пробная сборка ничего из этого не касается, потому что живёт в
 * каталоге операционной системы и не является артефактом проекта.
 */

const WEB = join(import.meta.dirname, '..', '..');

export interface ProbeBuild {
  /** Корень пробной сборки. */
  readonly root: string;
  /** Страницы: путь относительно корня → разметка. */
  readonly pages: Map<string, string>;
  /** Чем сборка отличалась от боевой — для сообщений об отказе. */
  readonly label: string;
}

/**
 * Собрать сайт с подставленным окружением.
 *
 * Ключ со значением `undefined` из окружения УДАЛЯЕТСЯ, а не выставляется пустым: спека
 * называет пустое значение и отсутствие ключа одним состоянием, но проверять их надо
 * обоими способами, иначе реализация, различающая их, пройдёт незамеченной.
 */
export function buildProbe(label: string, env: Record<string, string | undefined>): ProbeBuild {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-widget-probe-'));
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) childEnv[key] = value;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }

  try {
    execFileSync('npx', ['astro', 'build', '--outDir', root], {
      cwd: WEB,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 10 * 60 * 1000,
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `пробная сборка «${label}» не собралась — это «измерить не удалось», а не ` +
        `«нарушений нет».\n${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? ''}`,
      { cause: error },
    );
  }

  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`пробная сборка «${label}» не создала каталога вывода '${root}'`);

  const pages = new Map<string, string>();
  for (const file of walkFiles(root, ['.html']))
    pages.set(file.slice(root.length).replaceAll('\\', '/'), readFileSync(file, 'utf-8'));

  // Пустой набор — «не выполнено», а не «нарушений нет»: все утверждения об отсутствии
  // ниже тривиально верны на пустом выводе.
  if (pages.size === 0)
    throw new Error(`пробная сборка «${label}» не дала ни одной html-страницы: предмета нет`);

  return { root, pages, label };
}

/**
 * Пробный адрес загрузчика.
 *
 * Домен верхнего уровня `.invalid` зарезервирован и не разрешается НИКОГДА — то есть
 * пробная сборка, случайно попавшая в браузер, наружу не уйдёт. Портальный адрес заказчика
 * здесь ставить нельзя: пробный вывод живёт в каталоге операционной системы, и его файлы
 * переживают прогон.
 */
export const PROBE_CHAT_LOADER_SRC = 'https://chat-loader.invalid/probe/loader_probe.js';
