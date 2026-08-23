/**
 * Сборка секций семинара из полей API.
 *
 * Вынесено отдельным модулем, чтобы соответствие полей проверялось тестом на
 * фикстуре, где ОБА поля заполнены. Гейт по реальным данным ловил только
 * частный случай: он считал секции перепутанными, если «Как проходит обучение»
 * пусто. Если бы оба поля заполнили и подписали наоборот — прежний дефект прошёл
 * бы проверку незамеченным.
 *
 * Имена полей в API обманчивы:
 *   curriculum      — РЕЖИМ обучения: «2 дня (с 10:00 до 18:00)», «объём 36 часов»
 *   learningProcess — УЧЕБНЫЙ ПЛАН: темы теории и практики
 *
 * «Выдаваемые документы» сюда не входят: секция построена из структурных полей
 * CMS (`documents_state`, `documents`), а не из произвольного текста — см.
 * `openspec/changes/cms-content-authoring-and-migration`, D2. Второй источник
 * истины о том же самом не заводится.
 */

export interface ApiSeminarSections {
  curriculum?: string | null;
  learningProcess?: string | null;
  recommendations?: string | null;
}

/** Заголовки секций в том порядке, в каком они выводятся на странице. */
export const SECTION_TITLES = {
  plan: 'Учебный план',
  process: 'Как проходит обучение',
  documents: 'Выдаваемые документы',
  recommendations: 'Рекомендации',
} as const;

export function sectionsHtml(s: ApiSeminarSections): string {
  const parts: Array<[string, string | null | undefined]> = [
    [SECTION_TITLES.plan, s.learningProcess],
    [SECTION_TITLES.process, s.curriculum],
    [SECTION_TITLES.recommendations, s.recommendations],
  ];

  return parts
    .filter(([, html]) => (html ?? '').trim().length > 0)
    .map(([title, html]) => `<h2>${title}</h2>${html}`)
    .join('');
}
