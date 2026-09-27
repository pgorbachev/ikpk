import { describe, expect, it } from 'vitest';
import { allPages, readPage } from './helpers/dist-pages';
import { attr, findAll, textOf, walk } from './helpers/dom';
import { getArticles } from '../src/lib/data.js';

/**
 * Подача даты и набор порядков сортировки в каталоге статей — запросы заказчика D22 и D25
 * с демонстрации 2026-08-19 (`docs/demo-2026-08-19-decisions.md`), дельта требований —
 * change `article-list-pagination`.
 *
 * Предмет — СОБРАННЫЙ вывод: оба требования про то, что видит посетитель.
 *
 * Утверждения написаны по поведению, а не по именам классов: «в контроле нет порядка по
 * заголовку» переживёт переименование `title_asc`, а «в карточке нет подписи даты» —
 * замену `<time>` на что угодно другое. Гейт, знающий имя реализации, зелен ровно до
 * переименования.
 */

const CATALOG = '/statyi';

/**
 * Признак различает ТРИ вещи, и это существенно.
 *
 * 1. Наша подпись даты — `<time>` в карточке либо `published_at` статьи, напечатанный в
 *    том виде, в каком его печатает сайт («26 февраля 2026»). Её не должно быть (D22).
 * 2. Шапка, приехавшая из текста статьи: лид каждой из 68 статей начинается с
 *    «Заголовок ДД мес., ГГГГ | Автор». Дата выкладки видна посетителю и оттуда, поэтому
 *    лид не имеет права начинаться с даты.
 * 3. Дата ВНУТРИ текста статьи («12 декабря 2007 г. в Бирюзовом зале прошла встреча») —
 *    это содержание, а не подпись, и запрещать его нельзя: у трёх статей такая дата есть.
 *
 * Первая редакция признака искала любую дату полными месяцами и потому не видела ни (2),
 * ни (1) в сокращённой форме: она была зелёной при 68 карточках из 68, на каждой из
 * которых посетитель видел дату выкладки.
 */
const MONTH_STEM = '(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-я]*\\.?';

/**
 * Служебная подпись даты выкладки в лиде карточки.
 *
 * Признак — ФОРМА ШАПКИ, а не «лид начинается с даты»: шапка скрейпа выглядит как
 * «ДД мес., ГГГГ | Автор», и разделитель `|` отличает её от содержания. Прежняя редакция
 * требовала лишь, чтобы лид не начинался с даты, и объявляла ошибкой законный анонс
 * «12 декабря 2007 г. в Бирюзовом зале прошла встреча» — текст, который `articleLead`
 * теперь сознательно СОХРАНЯЕТ. Ложный отказ проверки не лучше пропущенного дефекта: он
 * запрещает исправное поведение.
 *
 * Привязка к `published_at` статьи здесь не работает и была измерена как вакуумная: шапка
 * несёт ДРУГУЮ дату («20 янв., 2025»), чем поле данных (`2025-05-25`), — различных
 * `published_at` всего шесть на 68 статей.
 *
 * Зона не участвует вовсе: сравнивается форма, а не вычисленная дата.
 */
const LEAD_PUBLICATION_HEADER = new RegExp(
  `^\\s*\\d{1,2}\\s*${MONTH_STEM},?\\s*\\d{4}\\s*(?:г\\.)?\\s*\\|`,
  'i',
);

/** Наша подпись: `<time>` где угодно в карточке либо дата первой строкой лида. */
const norm = (value: string): string => value.replace(/\s+/g, ' ').trim();

describe('каталог статей: порядки сортировки (D25)', () => {
  const html = readPage(CATALOG);
  const selects = findAll(html, (el) => el.tagName === 'select' && attr(el, 'data-articles-sort') !== null);

  it('контрол сортировки в выводе есть', () => {
    // Без этого всё остальное было бы вакуумно зелёным: нет контрола — нет и лишних
    // порядков, а требование при этом не выполнено.
    expect(selects.length, 'контрола сортировки нет в выводе — проверять нечего').toBe(1);
  });

  it('порядков ровно два, и ни один не сортирует по заголовку', () => {
    const options = [...walk(selects[0])].filter((el) => el.tagName === 'option');
    const labels = options.map((el) => norm(textOf(el)));
    const values = options.map((el) => attr(el, 'value') ?? '');

    expect(options.length, `порядков ${options.length}, а не два: ${labels.join(' | ')}`).toBe(2);

    const alphabetical = labels
      .map((label, index) => ({ label, value: values[index] }))
      .filter(({ label, value }) => /заголов|алфавит|а–я|я–а|а-я|я-а/i.test(label) || /title/i.test(value));
    expect(
      alphabetical.map((x) => `${x.value}: ${x.label}`),
      'в контроле остался порядок по заголовку',
    ).toEqual([]);
  });

  it('клиентская логика не сортирует по заголовку даже в обход контрола', () => {
    // Снятие пункта из `<select>` само по себе ничего не гарантирует: ветви сортировки
    // живут в скрипте страницы, и оставленная ветвь исполнилась бы при любом другом
    // источнике значения. Предмет — текст скриптов страницы.
    const scripts = findAll(html, (el) => el.tagName === 'script').map((el) => textOf(el)).join('\n');
    const leftovers = ['title_asc', 'title_desc'].filter((token) => scripts.includes(token));
    expect(leftovers, `в скрипте страницы остались ветви порядка по заголовку: ${leftovers.join(', ')}`).toEqual([]);
  });
});

describe('каталог статей: подпись даты на карточке (D22)', () => {
  /**
   * Предмет — КАЖДАЯ карточка статьи во всём выводе, а не шесть видимых на первой
   * странице каталога.
   *
   * Первая редакция смотрела только `[data-articles-grid]` на `/statyi`, то есть 6 карточек
   * из 74 на той же странице: остальные 68 лежат в `<template>` и показываются посетителю
   * при поиске и смене порядка. Мимо проверки проходили и блоки связанных статей на 68
   * страницах статей — те же карточки, собранные тем же компонентом.
   *
   * Признак общий: «элемент с классом `article-card`» и «ссылка бокового списка», а не
   * перечень страниц и секций. Перечень отстаёт от предмета молча — стоит появиться новому
   * месту, где показан список статей, и он окажется вне проверки.
   *
   * Собственная дата статьи на её странице (шапка и `sidebar-meta`) предметом НЕ является:
   * D22 просил убрать даты выкладки со СПИСКОВ, а не скрыть дату публикации самой статьи.
   * Поэтому проверяются только карточки и ссылки списков, а не страница целиком.
   */
  const norm2 = (value: string): string => value.replace(/\s+/g, ' ').trim();
  const hasClass = (el: Parameters<typeof textOf>[0], name: string): boolean =>
    (attr(el as never, 'class') ?? '').split(/\s+/).includes(name);

  /** Находки по ОДНОЙ карточке. Вынесено отдельно, чтобы проверять признак фикстурами. */
  const cardOffenders = (card: Parameters<typeof textOf>[0], where: string): string[] => {
    const found: string[] = [];
    const times = [...walk(card as never)].filter((el) => el.tagName === 'time');
    if (times.length > 0) found.push(`${where}: <time>${norm2(textOf(times[0]))}</time> в карточке списка`);
    const lead = [...walk(card as never)]
      .filter((el) => ['p', 'span'].includes(el.tagName))
      .map((el) => norm2(textOf(el)))
      .find((value) => value.length > 0);
    const head = lead?.match(LEAD_PUBLICATION_HEADER);
    if (head) found.push(`${where}: лид карточки несёт служебную шапку — «${head[0]}…»`);
    return found;
  };

  const cardsIn = (html: string) => findAll(html, (el) => hasClass(el, 'article-card'));
  const sidebarLinksIn = (html: string) => findAll(html, (el) => hasClass(el, 'sidebar-article-link'));

  const offenders: string[] = [];
  let catalogCards = 0;
  let relatedCards = 0;
  let sidebarLinks = 0;
  let pagesWithCards = 0;

  for (const page of allPages()) {
    const html = readPage(page);
    const onPage = cardsIn(html);
    const links = sidebarLinksIn(html);
    if (onPage.length > 0) pagesWithCards += 1;
    // Классы считаются РАЗДЕЛЬНО: одним числом потеря целого класса (сотни карточек блоков
    // связанных статей) осталась бы незаметной на фоне общего порога.
    if (page === CATALOG || page === `${CATALOG}/`) catalogCards += onPage.length;
    else relatedCards += onPage.length;
    sidebarLinks += links.length;
    for (const card of [...onPage, ...links]) offenders.push(...cardOffenders(card, page));
  }

  it('охват совпадает с тем, что следует из снимка контента', () => {
    expectCoverage({ catalogCards, relatedCards, sidebarLinks, pagesWithCards }, getArticles().length);
  });

  it('ни одна карточка списка нигде в выводе не несёт подписи даты', () => {
    expect(offenders, offenders.slice(0, 20).join('\n')).toEqual([]);
  });

  it('признак отличает служебную шапку от даты в содержании статьи', () => {
    const card = (lead: string) =>
      cardsIn(`<a class="article-card"><h3>Заголовок</h3><p>${lead}</p></a>`)[0];

    // Законное содержание: дата есть, разделителя шапки нет — и `articleLead` такой текст
    // сохраняет. Ровно этот анонс прежняя редакция признака объявляла ошибкой.
    expect(cardOffenders(card('12 декабря 2007 г. в Бирюзовом зале прошла встреча'), 'фикстура')).toEqual([]);
    expect(cardOffenders(card('5 мая 2024 года институт отметил юбилей.'), 'фикстура')).toEqual([]);

    // Шапка: дата с разделителем в начале лида — значит снятие шапки не сработало.
    expect(cardOffenders(card('20 янв., 2025 | Пилявский Сергей Орестович Период'), 'фикстура')).toHaveLength(1);
    expect(cardOffenders(card('3 сентября 2016 г. | Tim Hutton Тело'), 'фикстура')).toHaveLength(1);

    // Наша подпись в любом виде остаётся запрещённой.
    expect(
      cardOffenders(cardsIn('<a class="article-card"><time>26 февраля 2026 г.</time></a>')[0], 'фикстура'),
    ).toHaveLength(1);
  });
});

/**
 * Ожидаемый охват как функция размера каталога: число статей → сколько карточек и ссылок
 * обязан содержать вывод. Правила вывода названы поимённо, а не подобраны под замер.
 */
const PAGE_SIZE = 6; // размер страницы списка — контракт спеки `article-catalog`
const RELATED_LIMIT = 4; // `web/src/pages/statyi/[slug].astro`, `pool.slice(0, 4)`

function expectedCoverage(articles: number): {
  catalogCards: number; relatedCards: number; sidebarLinks: number; pagesWithCards: number;
} {
  const relatedPerPage = Math.min(RELATED_LIMIT, Math.max(articles - 1, 0));
  return {
    // На `/statyi`: видимая страница плюс корпус поиска из всех статей в `<template>`.
    catalogCards: Math.min(articles, PAGE_SIZE) + articles,
    relatedCards: articles * relatedPerPage,
    sidebarLinks: articles * relatedPerPage,
    // Каталог плюс страницы статей, у которых есть кого показать в связанных.
    pagesWithCards: 1 + (relatedPerPage > 0 ? articles : 0),
  };
}

/**
 * Утверждение об охвате вынесено из тела `it`, чтобы сценарий целиком проверялся и на
 * каталоге, которого в снимке нет, — например из одной статьи.
 *
 * Вакуумность ловится РАЗМЕРОМ СНИМКА, а не ненулевым числом карточек. Прежняя редакция
 * требовала непустых связанных списков — законное требование при 68 статьях и ложный отказ
 * при одной: у единственной статьи связывать не с чем, и пустой список там исправен.
 * Равенство ожиданиям выше уже ловит и потерю класса, и неожиданный рост: сравнивается
 * каждое число, а не сумма.
 */
function expectCoverage(
  counts: { catalogCards: number; relatedCards: number; sidebarLinks: number; pagesWithCards: number },
  articles: number,
): void {
  expect(articles, 'в снимке контента нет статей — предмет проверки пуст').toBeGreaterThan(0);
  expect(counts).toEqual(expectedCoverage(articles));
}

describe('ожидаемый охват вычисляется из снимка, а не зашит под нынешний каталог', () => {
  it('каталог из 68 статей', () => {
    expect(expectedCoverage(68)).toEqual({
      catalogCards: 74, relatedCards: 272, sidebarLinks: 272, pagesWithCards: 69,
    });
  });

  it('каталог из 67 статей — штатное уменьшение, а не дефект', () => {
    expect(expectedCoverage(67)).toEqual({
      catalogCards: 73, relatedCards: 268, sidebarLinks: 268, pagesWithCards: 68,
    });
  });

  it('каталог меньше страницы списка', () => {
    expect(expectedCoverage(3)).toEqual({
      catalogCards: 6, relatedCards: 6, sidebarLinks: 6, pagesWithCards: 4,
    });
  });

  it('единственная статья: связанных нет, и страниц с карточками одна', () => {
    expect(expectedCoverage(1)).toEqual({
      catalogCards: 2, relatedCards: 0, sidebarLinks: 0, pagesWithCards: 1,
    });
  });
});

describe('сценарий охвата целиком на каталоге, которого нет в снимке', () => {
  // Расчёт ожиданий проверен выше; здесь предмет другой — УТВЕРЖДЕНИЕ. Оно исполняется в
  // сборочном тесте на 68 статьях, поэтому отказ на малом каталоге иначе не виден ничем.
  it('единственная статья: исправный вывод принимается, хотя связанные списки пусты', () => {
    expect(() => expectCoverage(expectedCoverage(1), 1)).not.toThrow();
  });

  it('единственная статья: потеря карточки каталога отвергается', () => {
    const broken = { ...expectedCoverage(1), catalogCards: 1 };
    expect(() => expectCoverage(broken, 1)).toThrow();
  });

  it('пустой снимок отвергается как вакуумный прогон', () => {
    expect(() => expectCoverage(expectedCoverage(0), 0)).toThrow();
  });
});
