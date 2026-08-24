// Сторонние встраивания: перечень хостов и конфигурация адреса загрузчика чата.
//
// Спека change `external-widgets`: у конфигурации адреса загрузчика ТРИ различимых
// состояния — адрес объявлен, отсутствие объявлено явно, не объявлено ничего. Тип
// `string | null` их бы склеил (`null` годится и для «явно нет», и для «не сказано»),
// поэтому состояние — размеченное объединение, а не строка с умолчанием.

/** Ключ конфигурации адреса загрузчика чата. Без префикса `PUBLIC_` — значение не
 *  должно уехать в клиентский бандл статической подстановкой Astro. */
export const CHAT_LOADER_KEY = 'CHAT_LOADER_SRC';

/** Выделенное значение «адреса загрузчика нет» — не совпадает ни с пустым, ни с адресом. */
const CHAT_LOADER_NONE = 'none';

/**
 * Хосты, с которых страница встраивает сторонний код или ресурс: аналитика внутри
 * виджета отзывов, сам виджет, аватары его авторов, статика Яндекса. Перечень плоский
 * и без повторов — деления на «наши» и «чужие» нет: адрес тега Метрики один и тот же у
 * нас и у виджета, различие несёт только идентификатор счётчика в пути.
 */
export const THIRD_PARTY_EMBED_HOSTS: readonly string[] = [
  'mc.yandex.ru',
  'yandex.ru',
  'avatars.mds.yandex.net',
  'yastatic.net',
];

/** Три состояния конфигурации адреса загрузчика чата, различимые по построению. */
export type ChatLoaderConfig =
  | { readonly state: 'address'; readonly src: string }
  | { readonly state: 'declared-absent' }
  | { readonly state: 'unspecified' };

const ADDRESS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Разбор объявления адреса загрузчика чата. Чистая функция, не читает окружение —
 * так проверка симметрична и над юнит-тестом, и над собранным выводом (боевым и
 * стенда), а не только над окружением сборки.
 */
export function readChatLoaderConfig(raw: unknown): ChatLoaderConfig {
  if (typeof raw !== 'string') return { state: 'unspecified' };
  if (raw === CHAT_LOADER_NONE) return { state: 'declared-absent' };
  if (ADDRESS_SCHEME.test(raw)) return { state: 'address', src: raw };
  return { state: 'unspecified' };
}

/**
 * Конфигурация адреса загрузчика чата из окружения сборки. Читается из обоих
 * источников тем же приёмом, что `paymentRole()` (`web/src/lib/forms.ts`): реальная
 * сборка Astro прокидывает переменные в `import.meta.env`, а vitest без плагина Astro
 * пишет только в `process.env`.
 */
export function chatLoaderConfig(): ChatLoaderConfig {
  const fromMeta = (import.meta as ImportMeta & { env?: { CHAT_LOADER_SRC?: unknown } }).env
    ?.CHAT_LOADER_SRC;
  const raw = fromMeta ?? (typeof process !== 'undefined' ? process.env[CHAT_LOADER_KEY] : undefined);
  return readChatLoaderConfig(raw);
}
