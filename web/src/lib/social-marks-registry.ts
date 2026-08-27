/**
 * Реестр применимости официальных марок соцсетей.
 *
 * Место и поля — `design.md`, Решение 18. Исход бинарный: `mark` | `text-link`.
 * Хеш — отпечаток файла на момент проверки условий, независимо от текущего
 * содержимого на диске: иначе сверка «файл совпадает с первоисточником»
 * сравнивала бы файл сам с собой.
 *
 * Сами файлы — `web/src/assets/social-marks/`. Дословный импорт `?raw` живёт в
 * `social-mark-files.ts` и вызывается при сборке подвала. Разметка `<svg>` в
 * `.astro` — копия того же файла: `set:html` запрещён принятой спекой
 * `rich-content-safety`, а без элемента `<svg>` в AST нет source slot.
 * Равенство копий охраняет `assertMarkAstroBodiesMatchAssets` (TD-45).
 *
 * Контраст доминирующей заливки к фону подвала, измерено 2026-08-24 при
 * отрисовке 24px и deviceScaleFactor=1 (задача 3.9):
 * | сеть      | тема default (#1a1a1a) | тема dark (#eceeec) |
 * | ВКонтакте #0077FF | ~5,4:1 | ~3,4:1 |
 * | Youtube   #FF0000 | ~4,0:1 | ~4,0:1 |
 * | Telegram  #2AABEE | ~5,5:1 | ~2,4:1 — порог 3:1 недостижим |
 * | Rutube тёмная #100943 | <3:1 | >3:1 |
 * | Rutube белая        | >3:1 | <3:1 |
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
  themeAssetHashes?: Record<string, string>;
  /**
   * Темы, где владелец принял марку ниже 3:1 (нет разрешённой альтернативы).
   * Ключ `default` — тема по умолчанию (нет `data-theme`); иначе значение атрибута.
   */
  contrastWaiverThemes?: string[];
}

export const SOCIAL_MARKS_REGISTRY: MarkRegistryEntry[] = [
  {
    network: 'ВКонтакте',
    outcome: 'mark',
    decidedAt: '2026-08-24',
    conditionsSource: 'https://vk.com/brand',
    conditionsOutcome:
      'компактная монограмма с vk.com/brand (Wikimedia File:VK Compact Logo ' +
      '(2021-present).svg, source=vk.com/brand). Гайдлайн VK запрещает знак без ' +
      'разрешения и модификацию — условия неоднозначны. Владелец 2026-08-24 на ' +
      'кадре официальных марок выбрал исход mark (один ряд, без общей оправы).',
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
      'Файл — значок, а не словесный логотип. Контраст к обоим фонам подвала ≥ 3:1.',
    markFileHash: 'sha256-57ba1d2326327172e83aceaf437e837873ff8cdefbb7524dc3341e2fec8ab929',
  },
  {
    network: 'Telegram',
    outcome: 'mark',
    decidedAt: '2026-08-25',
    conditionsSource: 'https://telegram.org/tos',
    conditionsOutcome:
      'официальный знак telegram.org/img/t_logo.svg. Отдельной версии для светлого фона ' +
      'нет: доминирующая заливка к фону подвала в теме dark (#eceeec) около 2,4:1 при ' +
      'пороге 3:1. Перекраска запрещена. Владелец 2026-08-25 выбрал исход mark с ' +
      'contrastWaiverThemes=["dark"] (сценарий «порог недостижим»), а не text-link.',
    markFileHash: 'sha256-85059d5e5bf7bda91ebab30664993c49867a26be6b947834aca16c846581766a',
    contrastWaiverThemes: ['dark'],
  },
  {
    network: 'Rutube',
    outcome: 'mark',
    decidedAt: '2026-08-24',
    conditionsSource: 'https://rutube.ru/brand/',
    conditionsOutcome:
      'официальная классическая иконка из пакета Logo_RUTUBE с rutube.ru/brand ' +
      '(rutube_logo.zip). Без перекраски. Тёмная плашка не даёт 3:1 на подвале темы ' +
      'по умолчанию — там белая версия из того же пакета (themeAssets.default). ' +
      'В теме dark — тёмная версия (основной файл).',
    markFileHash: 'sha256-74387533f6ba388f64799d79ac390e6d7d429c12127b9ac35564a2e44c4d394c',
    themeAssets: {
      default: 'rutube-on-dark.svg',
    },
    themeAssetHashes: {
      default: 'sha256-0243fd539c3e866277b7983b1b925e4aa5abc933a517224fa2380c3783d0d6a7',
    },
  },
];

export type SocialMarkPresentation = 'text' | 'mark' | 'themed';

/** Ключ темы для `contrastWaiverThemes` / `themeAssets`. */
export function themeRegistryKey(theme: string | null): string {
  return theme === null ? 'default' : theme;
}

/** Владелец принял марку ниже 3:1 в этой теме. */
export function hasContrastWaiver(network: string, theme: string | null): boolean {
  const entry = SOCIAL_MARKS_REGISTRY.find((e) => e.network === network);
  if (entry === undefined || entry.outcome !== 'mark') return false;
  return (entry.contrastWaiverThemes ?? []).includes(themeRegistryKey(theme));
}

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
