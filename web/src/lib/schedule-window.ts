/**
 * Актуальность записи расписания для показа посетителю.
 *
 * Событие остаётся актуальным до своего ПОСЛЕДНЕГО дня, а не до первого: из 63
 * записей 60 многодневные, и фильтр по `startAt` убирал бы идущий семинар со
 * страницы уже на второй день обучения — человек, приехавший на трёхдневный курс,
 * не нашёл бы его в расписании.
 *
 * Тот же вывод для статуса семинара живёт в `web/scripts/lib/planned-seminars.ts`,
 * но там он нужен на этапе импорта данных, а здесь — на этапе сборки страниц.
 * Дублирование сознательное: `src/` не должен зависеть от `scripts/`, иначе
 * скрипты импорта попадают в клиентский граф сборки.
 *
 * Дата передаётся аргументом, а не берётся из `new Date()` внутри: иначе проверку
 * нельзя написать фикстурами, и она краснела бы от хода времени — так уже
 * случилось с гейтом `catalog-data`.
 */

export interface ScheduleWindowEntry {
  startAt?: string;
  endAt?: string;
}

/** Последний день события как календарная дата `YYYY-MM-DD`. */
export function lastDay(entry: ScheduleWindowEntry): string {
  const start = entry.startAt ?? '';
  const end = entry.endAt ?? '';
  return (end > start ? end : start).slice(0, 10);
}

/**
 * Событие ещё не закончилось на дату `today` (календарная, `YYYY-MM-DD`).
 *
 * Сравниваются календарные даты, а не метки времени: `startAt` хранится с временем
 * 00:00, и сравнение полных метк выбрасывало событие из актуальных уже в первую
 * минуту дня проведения.
 */
export function isCurrentOrFuture(entry: ScheduleWindowEntry, today: string): boolean {
  return lastDay(entry) >= today;
}

/**
 * Событие ещё не началось на дату `today` (календарная, `YYYY-MM-DD`).
 *
 * Это другой вопрос, чем `isCurrentOrFuture`. Страница расписания держит идущий
 * семинар до последнего дня. Строка «Ближайший семинар» и список ближайших на
 * главной — про набор, на который ещё можно приехать к началу: живой ikpk.su
 * (`/api/public/events`) уже начавшиеся из этой выборки убирает.
 *
 * Сравнение живёт здесь, а не у вызывающего: гейт `schedule-window.test.ts`
 * запрещает фильтровать `src/` по `startAt` вне этого модуля.
 */
export function isUpcomingStart(entry: ScheduleWindowEntry, today: string): boolean {
  return (entry.startAt ?? '').slice(0, 10) >= today;
}

/** Календарная дата «сегодня» для вызывающего, которому нужен реальный день. */
export const calendarToday = (): string => new Date().toISOString().slice(0, 10);

/**
 * Ближайшее ещё не закончившееся событие из набора, или `undefined`.
 *
 * Дата аргументом по той же причине, что и в `isCurrentOrFuture`: вывод должен
 * проверяться фикстурами, а не зависеть от хода времени.
 */
export function nearestUpcoming<T extends ScheduleWindowEntry>(
  entries: readonly T[],
  today: string,
): T | undefined {
  return entries
    .filter((entry) => isCurrentOrFuture(entry, today))
    .sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''))[0];
}
