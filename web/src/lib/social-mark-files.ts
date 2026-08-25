/**
 * Дословный импорт файлов марок (`?raw`) и сверка с хешем реестра.
 * Подключать только из продукта: Playwright не обрабатывает `?raw`.
 */
import { createHash } from 'node:crypto';
import vkontakteMark from '../assets/social-marks/vkontakte.svg?raw';
import youtubeMark from '../assets/social-marks/youtube.svg?raw';
import telegramMark from '../assets/social-marks/telegram.svg?raw';
import rutubeMark from '../assets/social-marks/rutube.svg?raw';
import rutubeOnDarkMark from '../assets/social-marks/rutube-on-dark.svg?raw';
import { SOCIAL_MARKS_REGISTRY } from './social-marks-registry';
import { assertMarkAstroBodiesMatchAssets } from './social-mark-sync';

export { assertMarkAstroBodiesMatchAssets } from './social-mark-sync';
export { MARK_ASTRO_BY_ASSET, normalizeMarkSvg } from './social-mark-sync';

export const SOCIAL_MARK_FILES: Record<string, string> = {
  'vkontakte.svg': vkontakteMark,
  'youtube.svg': youtubeMark,
  'telegram.svg': telegramMark,
  'rutube.svg': rutubeMark,
  'rutube-on-dark.svg': rutubeOnDarkMark,
};

const PRIMARY_FILE: Record<string, string> = {
  ВКонтакте: 'vkontakte.svg',
  Youtube: 'youtube.svg',
  Telegram: 'telegram.svg',
  Rutube: 'rutube.svg',
};

function sha256sri(body: string): string {
  return `sha256-${createHash('sha256').update(body).digest('hex')}`;
}

/** Падает на сборке, если файл марки разошёлся с хешем, зафиксированным в реестре. */
export function assertMarkFilesMatchRegistry(): void {
  for (const entry of SOCIAL_MARKS_REGISTRY) {
    if (entry.outcome !== 'mark') continue;
    const primary = PRIMARY_FILE[entry.network];
    if (primary === undefined) {
      throw new Error(`нет основного файла марки для сети ${entry.network}`);
    }
    const body = SOCIAL_MARK_FILES[primary];
    if (body === undefined) {
      throw new Error(`нет содержимого ${primary}`);
    }
    const hash = sha256sri(body);
    if (entry.markFileHash !== hash) {
      throw new Error(
        `хеш ${primary} ${hash} не равен markFileHash реестра ${entry.markFileHash}`,
      );
    }
    for (const [theme, file] of Object.entries(entry.themeAssets ?? {})) {
      const themeBody = SOCIAL_MARK_FILES[file];
      if (themeBody === undefined) {
        throw new Error(`themeAssets ссылается на отсутствующий файл ${file}`);
      }
      const expected = entry.themeAssetHashes?.[theme];
      if (!expected?.trim()) {
        throw new Error(`нет themeAssetHashes.${theme} для ${entry.network}`);
      }
      const themeHash = sha256sri(themeBody);
      if (themeHash !== expected) {
        throw new Error(
          `хеш ${file} ${themeHash} не равен themeAssetHashes.${theme} ${expected}`,
        );
      }
    }
  }
  // TD-45: хеш ассета не ловит дрейф *Mark.astro — сверяем нормализованные тела.
  assertMarkAstroBodiesMatchAssets();
}
