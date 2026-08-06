/**
 * Заголовок и описание страницы, когда в данных их нет.
 *
 * У 11 семинаров, появившихся при обновлении каталога, seo-полей нет в природе:
 * живой сайт собирает их шаблоном на месте. Подстановка пустого значения
 * оставляла страницу без <title> — это и потеря сниппета в поиске, и нарушение
 * доступности (axe: document-title).
 *
 * Почему отдельный модуль, а не строка в шаблоне: длину надо держать в бюджете
 * поиска, а это проверяется тестом. Первая версия собирала заголовок из полного
 * названия института и давала 73–143 символа — сниппет обрезался бы уже в
 * выдаче. Поэтому в шаблоне участвует КОРОТКОЕ имя института.
 *
 * Унаследованные seo-заголовки заказчика (до 223 символов) здесь не
 * затрагиваются: переписывать их — content-решение, а не техническое, и оно
 * вынесено в вопросы к заказчику.
 */

/** Бюджет поиска: примерно столько показывает выдача, дальше обрезает. */
export const TITLE_BUDGET = 70;
export const DESCRIPTION_BUDGET = 160;

const SHORT_INSTITUTE: Record<string, string> = {
  'institut-klinicheskoy-prikladnoy-kineziologii': 'ИКПК',
  'institut-apledzhera': 'Институт Апледжера',
  'institut-barralya': 'Институт Барраля',
};

/** Короткое имя института для служебных строк; для незнакомого — как есть. */
export function shortInstitute(slug: string, fullName: string): string {
  return SHORT_INSTITUTE[slug] ?? fullName;
}

/** Обрезка по границе слова: обрыв посреди слова читается как ошибка. */
function fit(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const window = text.slice(0, budget - 1);
  const cut = window.lastIndexOf(' ');
  return `${window.slice(0, cut > budget / 2 ? cut : budget - 1).trim()}…`;
}

export function seminarTitleFallback(
  seminarName: string,
  instituteSlug: string,
  instituteName: string,
): string {
  const short = shortInstitute(instituteSlug, instituteName);
  // название семинара — главное, институт — уточнение; если не влезает, режем
  // название, а не выбрасываем институт: без него заголовок теряет контекст
  const suffix = ` — ${short}`;
  return `${fit(seminarName, TITLE_BUDGET - suffix.length)}${suffix}`;
}

export function seminarDescriptionFallback(
  seminarName: string,
  courseGroupName: string,
  instituteSlug: string,
  instituteName: string,
): string {
  const short = shortInstitute(instituteSlug, instituteName);
  const tail = `. Расписание, стоимость и запись.`;
  const head = `${seminarName}: программа обучения «${courseGroupName}», ${short}`;
  return `${fit(head, DESCRIPTION_BUDGET - tail.length)}${tail}`;
}
