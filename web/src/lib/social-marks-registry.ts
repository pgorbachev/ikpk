/**
 * Реестр применимости официальных марок соцсетей.
 *
 * Место и поля — `design.md`, Решение 18. Исход бинарный: `mark` | `text-link`.
 * Хеш — отпечаток файла на момент проверки условий, независимо от текущего
 * содержимого на диске: иначе сверка «файл совпадает с первоисточником»
 * сравнивала бы файл сам с собой.
 *
 * Сами файлы — `web/src/assets/social-marks/`. Дословный импорт `?raw` живёт в
 * `social-mark-files.ts`, который подключает только продукт: Playwright не умеет
 * `?raw` и иначе разберёт SVG как JavaScript.
 */

export type MarkOutcome = 'mark' | 'text-link';

export interface MarkRegistryEntry {
  network: string;
  outcome: MarkOutcome;
  decidedAt: string;
  conditionsSource: string;
  conditionsOutcome: string;
  markFileHash?: string;
  themeAssets?: Record<string, string>;
}

export const SOCIAL_MARKS_REGISTRY: MarkRegistryEntry[] = [
  {
    network: 'ВКонтакте',
    outcome: 'mark',
    decidedAt: '',
    conditionsSource: 'https://vk.com/brand',
    conditionsOutcome:
      'компактная монограмма снята с vk.com/brand (Wikimedia File:VK Compact Logo ' +
      '(2021-present).svg, source=vk.com/brand). Гайдлайн VK (corp.vkcdn.ru, v2.1) ' +
      'запрещает использование товарного знака без разрешения и запрещает модификацию. ' +
      'Состояние условий — неоднозначное (спека прямо называет этот исход вероятным ' +
      'для ВКонтакте). Исход в поле outcome не действует: записи без даты нет решения, ' +
      'пока владелец не выберет mark или text-link.',
    markFileHash: 'sha256-2c16bcf8dd56d83e5e23fbe0690e3d6a3ef9f84a828b3530495f907187c1f1db',
  },
  {
    network: 'Youtube',
    outcome: 'mark',
    decidedAt: '2026-08-24',
    conditionsSource: 'https://www.youtube.com/about/brand-resources/',
    conditionsOutcome:
      'официальный значок воспроизведения YouTube в фирменном красном, без перекраски. ' +
      'Brand resources разрешают значок для обозначения YouTube и ссылки на канал. ' +
      'Файл — значок, а не словесный логотип.',
    markFileHash: 'sha256-57ba1d2326327172e83aceaf437e837873ff8cdefbb7524dc3341e2fec8ab929',
  },
  {
    network: 'Telegram',
    outcome: 'mark',
    decidedAt: '2026-08-24',
    conditionsSource: 'https://telegram.org/img/t_logo.svg',
    conditionsOutcome:
      'официальный знак с telegram.org/img/t_logo.svg, без перекраски. Файл ' +
      'публикуется правообладателем для обозначения Telegram. Отдельной версии для ' +
      'светлого фона нет: оценка контраста доминирующей заливки к фону подвала в теме ' +
      'dark (#eceeec) даёт около 2,2–2,6 : 1 при пороге 3:1 — исход при недостижимости ' +
      'выбирает владелец (задача 3.9), не перекраска.',
    markFileHash: 'sha256-85059d5e5bf7bda91ebab30664993c49867a26be6b947834aca16c846581766a',
  },
  {
    network: 'Rutube',
    outcome: 'mark',
    decidedAt: '2026-08-24',
    conditionsSource: 'https://rutube.ru/brand/',
    conditionsOutcome:
      'официальная классическая иконка из пакета Logo_RUTUBE с rutube.ru/brand ' +
      '(скачивание rutube_logo.zip). Без перекраски. Фирменная тёмная плашка не даёт ' +
      '3:1 на тёмном подвале темы по умолчанию — в этой теме применяется разрешённая ' +
      'белая версия той же иконки из того же пакета (themeAssets.default).',
    markFileHash: 'sha256-74387533f6ba388f64799d79ac390e6d7d429c12127b9ac35564a2e44c4d394c',
    themeAssets: {
      default: 'rutube-on-dark.svg',
    },
  },
];

export type SocialMarkPresentation = 'text' | 'mark' | 'themed';

/** Как рисовать сеть в подвале. `themed` — разные файлы в теме по умолчанию и `dark`. */
export function socialMarkPresentation(network: string): SocialMarkPresentation {
  const entry = SOCIAL_MARKS_REGISTRY.find((e) => e.network === network);
  if (
    entry === undefined ||
    entry.outcome !== 'mark' ||
    !entry.decidedAt.trim() ||
    !entry.conditionsSource.trim() ||
    !entry.conditionsOutcome.trim() ||
    (entry.outcome === 'mark' && !entry.markFileHash?.trim())
  ) {
    return 'text';
  }
  const assets = entry.themeAssets ?? {};
  if (assets.default !== undefined || assets.dark !== undefined) return 'themed';
  return 'mark';
}
