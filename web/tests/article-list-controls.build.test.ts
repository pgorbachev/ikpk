import { describe, expect, it } from 'vitest';
import { readPage } from './helpers/dist-pages';
import { attr, findAll, textOf, walk } from './helpers/dom';

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

/** Месяцы в том виде, в каком их печатает `toLocaleDateString('ru-RU')`. */
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const DATE_IN_TEXT = new RegExp(`\\b\\d{1,2}\\s+(${MONTHS.join('|')})\\s+\\d{4}`);

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

  it('сетка карточек в выводе есть', () => {
    expect(grid, 'сетки карточек нет в выводе — проверять нечего').toBeTruthy();
  });

  it('ни одна карточка не несёт подписи даты публикации', () => {
    const cards = [...walk(grid)].filter((el) => (attr(el, 'class') ?? '').split(/\s+/).includes('article-card'));
    expect(cards.length, 'карточек в сетке ноль — проверять нечего').toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const card of cards) {
      const href = attr(card, 'href') ?? '(без href)';
      const times = [...walk(card)].filter((el) => el.tagName === 'time');
      if (times.length > 0) offenders.push(`${href}: <time>${norm(textOf(times[0]))}</time>`);
      const text = norm(textOf(card));
      const match = text.match(DATE_IN_TEXT);
      if (match) offenders.push(`${href}: дата в тексте карточки — «${match[0]}»`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
