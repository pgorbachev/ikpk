import { attr, parseDocument, textOf, walk, type Element } from './dom';

/**
 * Общие ПРИЗНАКИ для проверок change `external-widgets`.
 *
 * Модуль объявлен один на все предметы (боевой вывод, демо-вывод, фикстуры) намеренно:
 * спека требует, чтобы «на демо встраиваний нет» и «в боевом выводе встраивания есть»
 * проверялись ОДНИМ признаком, иначе два прочтения одного требования дают две проверки
 * разной силы над одним предметом, и расхождение не видно ни одной из них
 * (`openspec/changes/external-widgets/specs/external-widgets/spec.md:889`,
 * `Признак присутствия SHALL быть **тем же**`).
 *
 * Корня вывода модуль НЕ объявляет и не имеет права объявить: он принимает разметку
 * строкой. Иначе один файл проверок получил бы два предмета — ровно то, что запрещает
 * инвариант `web/tests/demo-gate.test.ts:670`,
 * `it('у каждой проверки обязательного прогона ровно один предмет'`. Общий у предметов
 * только разбор (`./dom`), который корня тоже не объявляет.
 *
 * Разбор — ПАРСЕРОМ, а не регуляркой. Это не стиль: в этом репозитории приблизительный
 * разбор дважды дал обход гейта, и правило записано поимённо (AGENTS.md, «Гейтам нужен
 * парсер, а не регулярка»). Здесь оно особенно важно, потому что предмет — адрес в
 * ЛЮБОМ атрибуте, включая атрибуты данных, из которых встраивание создаётся скриптом.
 */

// ─── Имена, которые эти проверки закрепляют (швы, выбранные тестами) ─────────
// Спека имён не задаёт, а проверке нужен способ отличить наш узел от чужого. Каждое
// имя ниже — решение ЭТОЙ сессии, и оно названо здесь одним списком, чтобы реализация
// не искала его по телам тестов. Менять их можно, но тогда меняются и тесты.
//
// Требование спеки, из которого имена и берутся: «Точка монтирования стороннего
// виджета SHALL быть объявлена нашим контейнером с нашим именем» — происхождение узла
// селектором не выражается, а своё имя сторона переименовать не может.

/** Секция отзывов на главной. */
export const SEL_REVIEWS_SECTION = 'data-reviews-section';
/** Контейнер, в который подставляется iframe виджета отзывов (ленивое встраивание). */
export const SEL_REVIEWS_EMBED = 'data-reviews-embed';
/** Знак награды в секции отзывов. */
export const SEL_AWARD_BADGE = 'data-award-badge';
/** Обёртка фасада чата (наш контейнер, наше имя). */
export const SEL_CHAT_FACADE = 'data-chat-facade';
/** Наша кнопка вызова чата — существует до исполнения стороннего загрузчика. */
export const SEL_CHAT_TRIGGER = 'data-chat-trigger';
/** Объявленная нами точка монтирования стороннего интерфейса. */
export const SEL_CHAT_MOUNT = 'data-chat-mount';
/** Блок часов работы менеджера и телефона. */
export const SEL_CHAT_HOURS = 'data-chat-hours';

// ─── Адреса третьей стороны ──────────────────────────────────────────────────
// Значения измерены в `proposal.md` (блок «Что мерено, а не взято на слово») и здесь
// повторены как ВХОД проверок, а не как утверждение о живом сервисе.

/** Идентификатор организации на Яндекс.Картах — из замеров `proposal.md`. */
export const REVIEWS_ORG_ID = '112883331290';
/** Хост документа виджета отзывов. */
export const REVIEWS_WIDGET_HOST = 'yandex.ru';
/** Путь встраивания виджета отзывов. */
export const REVIEWS_WIDGET_PATH = `/maps-reviews-widget/${REVIEWS_ORG_ID}`;
/** Хост аватаров авторов отзывов: их к себе не переносим ни одной ссылкой. */
export const REVIEWS_AVATAR_HOST = 'avatars.mds.yandex.net';
/** Идентификатор ЧУЖОГО счётчика, приходящего внутри виджета. */
export const FOREIGN_METRIKA_ID = '57020224';
/** Идентификатор НАШЕГО счётчика — для различения по идентификатору, а не по адресу. */
export const OWN_METRIKA_ID = '39506315';
/** Адрес тега Метрики: у нас и у виджета он ОДИН И ТОТ ЖЕ, деления не существует. */
export const METRIKA_TAG_URL = 'https://mc.yandex.ru/metrika/tag.js';
/** Трекинг-пиксель несёт идентификатор в пути — этим счётчики и различаются. */
export const metrikaPixelPath = (id: string): string => `/watch/${id}`;

// ─── Значения, к которым проверки привязываться НЕ ИМЕЮТ ПРАВА ───────────────
/**
 * Сегодняшние рейтинг, число отзывов и число оценок. Лежат здесь ровно для того,
 * чтобы проверка сводки могла доказать, что она их НЕ использует: признак, знающий
 * сегодняшние значения, зелен в день, когда кто-то вставит сводку с другими числами
 * (spec, «Признак SHALL NOT опираться на **текущие** значения»).
 *
 * Ни одна проверка не имеет права подставлять их в признак. Использование — только в
 * фикстурах, и только чтобы показать, что признак ловит и ДРУГИЕ числа.
 */
export const MEASURED_TODAY = { rating: '4,9', reviews: 33, ratings: 66 } as const;

// ─── Признаки ────────────────────────────────────────────────────────────────

/** Все значения атрибутов документа — вместе с именем атрибута и тегом носителя. */
export function attributeValues(html: string): { tag: string; name: string; value: string }[] {
  const out: { tag: string; name: string; value: string }[] = [];
  for (const el of walk(parseDocument(html)))
    for (const a of el.attrs) out.push({ tag: el.tagName, name: a.name, value: a.value });
  return out;
}

/**
 * Нормализация адреса до «хост + путь»: адрес встраивания может быть записан со схемой,
 * без схемы (`//host/…`), с другой схемой и с любым query. Признак, различающий эти
 * формы, был бы слепым ровно к той форме, которую спека запрещает отдельным требованием
 * (адрес загрузчика — со схемой).
 */
export function hostAndPath(raw: string): { host: string; path: string } | null {
  const value = raw.trim();
  if (value === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : value.startsWith('//')
      ? `https:${value}`
      : null;
  if (withScheme === null) return null;
  try {
    const url = new URL(withScheme);
    return { host: url.hostname.toLowerCase(), path: url.pathname };
  } catch {
    return null;
  }
}

/**
 * Вхождения адреса встраивания — в ЛЮБОМ атрибуте любого элемента.
 *
 * Именно это и есть признак, названный спекой: «адрес самого встраивания в любом
 * атрибуте вывода, включая атрибуты данных, из которых встраивание создаётся скриптом».
 * Поиск по `src=` пропустил бы весь ленивый путь, то есть весь наш путь.
 */
export function embedAddressHits(
  html: string,
  expect: { host: string; pathPrefix: string },
): { tag: string; name: string; value: string }[] {
  return attributeValues(html).filter(({ value }) => {
    const parsed = hostAndPath(value);
    return (
      parsed !== null &&
      (parsed.host === expect.host || parsed.host.endsWith(`.${expect.host}`)) &&
      parsed.path.startsWith(expect.pathPrefix)
    );
  });
}

/** Вхождения встраивания виджета отзывов. */
export const reviewsEmbedHits = (html: string) =>
  embedAddressHits(html, { host: REVIEWS_WIDGET_HOST, pathPrefix: REVIEWS_WIDGET_PATH });

/** Вхождения адреса загрузчика чата: хост берётся из конфигурации, а не угадывается. */
export function chatLoaderHits(html: string, loaderSrc: string) {
  const parsed = hostAndPath(loaderSrc);
  if (parsed === null)
    throw new Error(
      `адрес загрузчика чата '${loaderSrc}' не разбирается как адрес — проверять нечем`,
    );
  return embedAddressHits(html, { host: parsed.host, pathPrefix: parsed.path });
}

/** Элементы с данным атрибутом-именем (наши объявленные точки). */
export function byDataName(html: string, name: string): Element[] {
  return [...walk(parseDocument(html))].filter((el) => attr(el, name) !== null);
}

/**
 * Числовая сводка отзывов: число, стоящее В СВЯЗКЕ со словом «отзыв», «оцен» или
 * «рейтинг».
 *
 * Признак назван спекой и намеренно НЕ «десятичная дробь»: на странице есть телефоны,
 * цены и даты. И он НЕ содержит сегодняшних значений — иначе был бы зелен при подмене
 * их другими числами.
 *
 * Окно ±40 символов, а не «тот же текстовый узел»: разметка вставляет числа в
 * отдельные элементы (`<b>4,9</b> <span>отзывов</span>`), и признак по узлу
 * пропустил бы ровно эту форму.
 */
const SUMMARY_STEMS = /отзыв|оцен|рейтинг/gi;
const NUMBER = /\d[\d.,\u00a0 ]*/;

export function ratingSummaryHits(html: string): string[] {
  return ratingSummaryHitsInText(textOf(parseDocument(html)));
}

export function ratingSummaryHitsInText(text: string): string[] {
  const out: string[] = [];
  for (const stem of text.matchAll(SUMMARY_STEMS)) {
    const at = stem.index ?? 0;
    const window = text.slice(Math.max(0, at - 40), Math.min(text.length, at + stem[0].length + 40));
    if (NUMBER.test(window)) out.push(window.trim());
  }
  return [...new Set(out)];
}

/** Видимый текст поддерева элемента — для проверок содержимого секции. */
export function elementText(el: Element): string {
  return textOf(el);
}

/** Все элементы документа: нужно проверкам, судящим по составу поддерева. */
export function elements(html: string): Element[] {
  return [...walk(parseDocument(html))];
}

/** Потомки элемента, включая его самого. */
export function subtree(el: Element): Element[] {
  return [el, ...walk(el)];
}
