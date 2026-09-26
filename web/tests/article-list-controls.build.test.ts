import { describe, expect, it } from 'vitest';
import { readPage } from './helpers/dist-pages';
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
 * Дата выкладки в тексте карточки — в ЛЮБОЙ форме, а не только в нашей.
 *
 * Привязка к `published_at` этой статьи не работает и была измерена как вакуумная: шапка,
 * приехавшая из скрейпа, несёт ДРУГУЮ дату («20 янв., 2025»), чем поле данных
 * (`2025-05-25`), — различных `published_at` всего шесть на 68 статей. Проверка,
 * сверявшая формы `published_at`, оставалась зелёной при возвращённом дефекте: мутация
 * «не снимать шапку» не ловилась ни одной из трёх проверок файла.
 *
 * Поэтому предмет — начало лида: подпись даты выкладки стоит именно там, а дата ВНУТРИ
 * текста статьи («12 декабря 2007 г. в Бирюзовом зале прошла встреча») остаётся законной.
 *
 * Зона не участвует вовсе: сравнивается форма, а не вычисленная дата. Прежняя редакция
 * строила формы через `getUTC*`, тогда как страница печатает `toLocaleDateString` без
 * `timeZone`, — вердикт зависел бы от зоны машины (данные лежат как `…T21:00:00.000Z`).
 */
const LEAD_DATE_HEAD = new RegExp(`^\\s*\\d{1,2}\\s*${MONTH_STEM},?\\s*\\d{4}`, 'i');

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
  const html = readPage(CATALOG);
  const grid = findAll(html, (el) => attr(el, 'data-articles-grid') !== null)[0];
  const articles = getArticles();

  it('сетка карточек в выводе есть', () => {
    expect(grid, 'сетки карточек нет в выводе — проверять нечего').toBeTruthy();
  });

  it('ни одна карточка не несёт подписи даты публикации и не начинается с даты', () => {
    const cards = [...walk(grid)].filter((el) => (attr(el, 'class') ?? '').split(/\s+/).includes('article-card'));
    expect(cards.length, 'карточек в сетке ноль — проверять нечего').toBeGreaterThan(0);

    const byslug = new Map(articles.map((a) => [a.slug, a] as const));
    const offenders: string[] = [];
    let leadsChecked = 0;

    for (const card of cards) {
      const href = attr(card, 'href') ?? '';
      const slug = href.replace(/^\/statyi\//, '').replace(/\/$/, '');
      const article = byslug.get(slug);

      const times = [...walk(card)].filter((el) => el.tagName === 'time');
      if (times.length > 0) offenders.push(`${href}: <time>${norm(textOf(times[0]))}</time>`);


      const lead = [...walk(card)]
        .filter((el) => el.tagName === 'p')
        .map((el) => norm(textOf(el)))
        .find((value) => value.length > 0);
      if (lead) {
        leadsChecked += 1;
        const startsWithDate = lead.match(LEAD_DATE_HEAD);
        if (startsWithDate) offenders.push(`${href}: лид начинается с даты выкладки — «${startsWithDate[0]}…»`);
        if (article && lead.toLowerCase().startsWith(norm(article.title).toLowerCase().slice(0, 40)))
          offenders.push(`${href}: лид повторяет заголовок карточки — «${lead.slice(0, 60)}…»`);
      }
    }

    expect(leadsChecked, 'ни у одной карточки не нашлось лида — предмет проверки пуст').toBeGreaterThan(0);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
