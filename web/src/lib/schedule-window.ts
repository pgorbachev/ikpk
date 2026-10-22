export interface ScheduleWindowEntry {
  startsAtInstant?: string;
  startTimeZone?: string;
  startTimeConfirmed?: boolean;
  startAt?: string;
  endAt?: string;
  /**
   * Город события: в снимке — объект с именем, в схеме CMS может стать строкой, а в
   * данных встречается `null` (поле необязательное). Все три формы принимаются здесь, а
   * не приводятся у вызывающих: иначе тип этого модуля диктовал бы форму чужим снимкам.
   */
  city?: { name?: string } | string | null;
  /** Идентификатор записи: число в нынешнем материале, строка допустима схемой. */
  id?: number | string;
}

/** Exact offer boundary. Invalid or unresolved times never become offers. */
export function isBeforeStart(entry: ScheduleWindowEntry, now: string | Date | number): boolean {
  if (!entry.startsAtInstant || !entry.startTimeZone || entry.startTimeConfirmed === false
    || !/(?:Z|[+-]\d{2}:\d{2})$/.test(entry.startsAtInstant)) return false;
  const start = Date.parse(entry.startsAtInstant);
  const current = typeof now === 'number' ? now : new Date(now).getTime();
  return Number.isFinite(start) && Number.isFinite(current) && current < start;
}

/**
 * Calendar day represented by a CMS date value. SQL DATE values arrive unchanged;
 * CMS datetime values represent Nicosia wall-clock midnight, so their public day is
 * the Europe/Moscow calendar day (the site's established display timezone).
 */
export function calendarDay(value: string | undefined): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Treat a calendar day as UTC midnight for timezone-independent arithmetic/labels. */
export function calendarDayDate(value: string | undefined): Date {
  const day = calendarDay(value);
  return day ? new Date(`${day}T00:00:00.000Z`) : new Date(Number.NaN);
}

/** Последний день события как календарная дата `YYYY-MM-DD`. */
export function lastDay(entry: ScheduleWindowEntry): string {
  const start = calendarDay(entry.startAt);
  const end = calendarDay(entry.endAt);
  return (end > start ? end : start).slice(0, 10);
}

/**
 * Событие ещё не закончилось на дату `today` (календарная, `YYYY-MM-DD`).
 *
 * Сравниваются календарные даты, а не метки времени: CMS хранит SQL DATE как
 * полночь Nicosia, сериализованную в UTC, поэтому преобразование в календарный день
 * должно идти через часовую зону сайта, а не через префикс UTC.
 */
export function isCurrentOrFuture(entry: ScheduleWindowEntry, today: string): boolean {
  return lastDay(entry) >= today;
}

/** Legacy calendar-day query, retained for date-only data inspection. Offers use isBeforeStart. */
export function isUpcomingStart(entry: ScheduleWindowEntry, today: string): boolean {
  return calendarDay(entry.startAt) >= today;
}

/** Календарная дата «сегодня» для вызывающего, которому нужен реальный день. */
export const calendarToday = (): string => new Date().toISOString().slice(0, 10);

/**
 * Legacy date-only query. Public offers use isBeforeStart with compareNearest ordering.
 *
 * **Порядок выбора задан требованием, а не удобством** (change
 * `cms-content-authoring-and-migration`, требование «Даты семинара выводятся из расписания»):
 * первый день → последний день → город лексикографически → идентификатор записи. Первыми
 * идут наблюдаемые поля: из двух событий одного дня раньше освобождается более короткое, а
 * город различает одновременные осмысленно для посетителя. Идентификатор — последний ключ и
 * служит только устойчивости: когда совпали и даты, и город, события для посетителя
 * неразличимы, и от правила требуется лишь чтобы две сборки одного состояния не разошлись.
 *
 * Сравнение идентификатора следует ТИПУ поля: число сравнивается как число, строка —
 * лексикографически. Безусловное лексикографическое сравнение поставило бы `10` раньше `9`.
 *
 * Город сравнивается посимвольно, а не `localeCompare`: результат обязан совпадать у двух
 * сборок одного состояния, а порядок `localeCompare` зависит от ICU машины, на которой шла
 * сборка. Для требования «две сборки не разошлись» это и есть предмет.
 */
export function nearestUpcoming<T extends ScheduleWindowEntry>(
  entries: readonly T[],
  today: string,
): T | undefined {
  // Запись без `startAt` отбрасывается: поле необязательно в схеме CMS, а без него
  // сортировка ставит запись первой, и подпись выходит «NaN undefined – 5 окт».
  // Два других потребителя расписания такую охрану уже имеют.
  const usable = entries.filter((entry) => Boolean(entry.startAt) && isCurrentOrFuture(entry, today));
  let best: T | undefined;
  for (const entry of usable) if (best === undefined || compareNearest(entry, best) < 0) best = entry;
  return best;
}

/** Первый день события как календарная дата: требование говорит о ДНЕ, а не о метке времени. */
const firstDay = (entry: ScheduleWindowEntry): string => calendarDay(entry.startAt);

const cityName = (entry: ScheduleWindowEntry): string => {
  const city = entry.city;
  if (typeof city === 'string') return city;
  return city?.name ?? '';
};

function compareIdentifier(left: ScheduleWindowEntry, right: ScheduleWindowEntry): number {
  const a = left.id;
  const b = right.id;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Строгий порядок «ближайшего»: меньше — ближе. Экспортируется ради проверок. */
export function compareNearest(left: ScheduleWindowEntry, right: ScheduleWindowEntry): number {
  for (const key of [firstDay, lastDay, cityName]) {
    const a = key(left);
    const b = key(right);
    if (a !== b) return a < b ? -1 : 1;
  }
  return compareIdentifier(left, right);
}
