/**
 * Сверка ассета марки с телом *Mark.astro (TD-45 / Decision 17).
 * Без `?raw`: читает файлы с диска — годится и для сборки, и для vitest.
 *
 * Путь к `src/` нельзя брать только от `import.meta.url`: при prerender Astro
 * бандлит модуль в `dist/.prerender/chunks/`, и соседний `assets/` там отсутствует.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ассет → компонент, который реально рисует марку в подвале. */
export const MARK_ASTRO_BY_ASSET: Record<string, string> = {
  'vkontakte.svg': 'VkontakteMark.astro',
  'youtube.svg': 'YoutubeMark.astro',
  'telegram.svg': 'TelegramMark.astro',
  'rutube.svg': 'RutubeMark.astro',
  'rutube-on-dark.svg': 'RutubeOnDarkMark.astro',
};

function webSrcRoot(): string {
  const fromCwd = join(process.cwd(), 'src');
  if (existsSync(join(fromCwd, 'assets', 'social-marks', 'vkontakte.svg'))) {
    return fromCwd;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'assets', 'social-marks', 'vkontakte.svg'))) return dir;
    const nested = join(dir, 'src');
    if (existsSync(join(nested, 'assets', 'social-marks', 'vkontakte.svg'))) return nested;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'не найден web/src с assets/social-marks (cwd=' + process.cwd() + ')',
  );
}

/**
 * Нормализация для сравнения ассета и копии в `.astro`.
 * Допустимые отличия копии: нет XML-prolog; на корневом `<svg>` есть `aria-hidden="true"`.
 */
export function normalizeMarkSvg(source: string): string {
  let text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  text = text.replace(/^<\?xml\b[^>]*\?>\s*/i, '');
  const match = text.match(/<svg\b[\s\S]*<\/svg>/i);
  if (match === null) {
    throw new Error('в источнике марки нет элемента <svg>');
  }
  return match[0].replace(/(<svg\b[^>]*?)\s+aria-hidden=(["'])true\2/i, '$1').trim();
}

export function assertMarkAstroBodiesMatchAssets(
  assets: Iterable<string> = Object.keys(MARK_ASTRO_BY_ASSET),
): void {
  const root = webSrcRoot();
  for (const asset of assets) {
    const astroName = MARK_ASTRO_BY_ASSET[asset];
    if (astroName === undefined) {
      throw new Error(`нет *Mark.astro для ассета ${asset}`);
    }
    const assetPath = join(root, 'assets', 'social-marks', asset);
    const astroPath = join(root, 'components', 'social-marks', astroName);
    const assetSvg = normalizeMarkSvg(readFileSync(assetPath, 'utf8'));
    const astroSvg = normalizeMarkSvg(readFileSync(astroPath, 'utf8'));
    if (assetSvg !== astroSvg) {
      throw new Error(
        `марка ${astroName} разошлась с ассетом ${asset}: ` +
          'нормализованные тела <svg> не равны (TD-45 / Decision 17)',
      );
    }
  }
}
