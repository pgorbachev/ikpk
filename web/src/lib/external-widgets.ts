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

/** Ключ конфигурации объявления сообщения офлайн-панели чата (портал Bitrix24). */
export const CHAT_OFFLINE_MESSAGE_KEY = 'CHAT_OFFLINE_MESSAGE';

/**
 * Объявление настройки сообщения панели чата вне часов работы. Значения `configured`/
 * `absent` — портал настроен явно в ту или другую сторону; `null` — ключ не объявлен
 * вовсе (значение отсутствует, пусто или не совпадает ни с одним из двух). Третье
 * состояние читается fail-closed приёмкой: «применимость измерить не удалось», а не
 * «пункт неприменим» (spec.md, требование «У приёмочного утверждения есть запись
 * свидетельства…»).
 */
export function chatOfflineMessage(): 'configured' | 'absent' | null {
  const fromMeta = (import.meta as ImportMeta & { env?: { CHAT_OFFLINE_MESSAGE?: unknown } }).env
    ?.CHAT_OFFLINE_MESSAGE;
  const raw = fromMeta ?? (typeof process !== 'undefined' ? process.env[CHAT_OFFLINE_MESSAGE_KEY] : undefined);
  return raw === 'configured' || raw === 'absent' ? raw : null;
}

/**
 * Синтетический адрес, выдаваемый ТОЛЬКО демо-сборкой (`build:demo`), когда реальный
 * адрес не объявлен. У заказчика два портала Bitrix24 — молчаливый выбор одного из них
 * направил бы обращения демо-посетителей не туда, поэтому адрес заведомо не разрешается
 * ни в один настоящий портал.
 */
const SYNTHETIC_CHAT_LOADER_SRC = 'https://cdn.example.invalid/synthetic-chat-loader.js';

/**
 * Адрес загрузчика, который получила демо-сборка: настоящий, если конфигурация его
 * несёт, иначе синтетический — демо-сборка получает адрес ВСЕГДА (`external-widgets-
 * demo.test.ts`, «у проверки гашения чата предмет есть в любом состоянии
 * конфигурации»). Фасад чата при этом в демо-выводе не рендерится вовсе (см.
 * `ChatFacade.astro`) — рендер зависит только от `chatLoaderConfig()`, поэтому ни
 * настоящий, ни синтетический адрес в разметку demo-сборки не попадают ни при каком
 * состоянии.
 */
export function demoChatLoaderSrc(): string {
  const config = chatLoaderConfig();
  return config.state === 'address' ? config.src : SYNTHETIC_CHAT_LOADER_SRC;
}

/**
 * Признак НЕВЫКЛАДЫВАЕМОГО демо-вывода (`dist-demo`).
 *
 * Отдельная переменная, а не `isDemoForms`, — по решению владельца 2026-09-05 и по
 * требованию спеки «В демо-выводе оба встраивания отсутствуют, а выкладываемый стенд их
 * несёт». У флага демо-форм две цели: не писать в системы заказчика (это относится и к
 * стенду) и не показывать сторонние встраивания в артефакте, который никуда не
 * выкладывается (это относится только к `dist-demo`). Единый признак делал вторую цель
 * невыполнимой без нарушения первой: стенд показывал заказчику ссылку вместо виджета.
 *
 * Переменную выставляет скрипт сборки демо-вывода и только он — тем же приёмом, что
 * `CHAT_LOADER_FALLBACK`, и это проверяется чтением манифеста пакета, а не догадкой о
 * назначении прогона.
 *
 * Читается из обоих источников по той же причине, что `DEMO_FORMS` в `forms.ts`: Astro
 * прокидывает переменную в `import.meta.env`, а vitest без плагина Astro пишет только
 * `process.env`.
 */
const demoOutputEnv =
  (import.meta as ImportMeta & { env?: { DEMO_OUTPUT?: unknown } }).env?.DEMO_OUTPUT ??
  (typeof process !== 'undefined' ? process.env?.DEMO_OUTPUT : undefined);

export const isDemoOutput = String(demoOutputEnv ?? '').trim().length > 0;
