/**
 * Test-only контракт для change `cms-content-authoring-and-migration` (сторона
 * сборки: порядок следования, даты семинара, обратная связь границы санитизации).
 *
 * Приём тот же, что в `dependency-update-gates-contract.ts`: интерфейсы объявлены
 * здесь, реализация подгружается ДИНАМИЧЕСКИ. Тесты остаются КРАСНЫМИ до появления
 * реализации, а `astro check` — чистым, потому что ни одна строка не ссылается типом
 * на отсутствующий файл.
 *
 * Правила системы управления (грамматика идентификатора, адреса, обязательные поля,
 * перенос) живут не здесь, а в `scripts/lib/cms-authoring-contract.ts`: у пакета
 * `scripts` свой прогон в том же обязательном workflow `Tests`, и модули системы
 * управления там не тянут за собой конвейер сборки сайта.
 */

export interface OrderedItem {
  identifier: string;
  order?: number | null;
}

export interface ContentOrder {
  /**
   * Явный порядок. Пустое значение — в конец; при равных значениях вторичный ключ —
   * идентификатор, сравнение лексикографическое.
   */
  byExplicitOrder<T extends OrderedItem>(items: T[]): T[];
}

export interface ScheduleEvent {
  id: string | number;
  status: string;
  startAt: string;
  endAt: string;
  city?: string;
}

export interface SeminarDates {
  /** События, делающие семинар запланированным относительно опорной даты. */
  plannedEvents(events: ScheduleEvent[], referenceDate: string): ScheduleEvent[];
  /**
   * Ближайшее из них. Ключи по очереди: первый день, затем последний день, затем
   * город лексикографически, затем идентификатор события — сравнением по типу поля.
   */
  nearestEvent(events: ScheduleEvent[], referenceDate: string): ScheduleEvent | null;
}

/** Разметка, не прошедшая границу, названная по элементу и атрибуту. */
export interface RejectedMarkup {
  elements: string[];
  attributes: string[];
}

export interface RichContentFeedback {
  /**
   * Что граница НЕ пропускает во входе. Отдельная от санитизации функция нужна
   * потому, что `terminalSanitize` возвращает строку и о вырезанном молчит —
   * предупредить редактора нечем.
   */
  describeRejectedMarkup(html: string): RejectedMarkup;
}

const load = async <T>(relative: string): Promise<T> => {
  const href = new URL(relative, import.meta.url).href;
  return (await import(/* @vite-ignore */ href)) as T;
};

export const CONTENT_ORDER_MODULE = '../../scripts/lib/content-order.ts';
export const SEMINAR_DATES_MODULE = '../../scripts/lib/seminar-dates.ts';
export const RICH_CONTENT_FEEDBACK_MODULE = '../../src/lib/rich-html-sanitize.ts';

export const loadContentOrder = (): Promise<ContentOrder> =>
  load<ContentOrder>(CONTENT_ORDER_MODULE);
export const loadSeminarDates = (): Promise<SeminarDates> =>
  load<SeminarDates>(SEMINAR_DATES_MODULE);
export const loadRichContentFeedback = (): Promise<RichContentFeedback> =>
  load<RichContentFeedback>(RICH_CONTENT_FEEDBACK_MODULE);
