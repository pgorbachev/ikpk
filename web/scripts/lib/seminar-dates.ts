/**
 * Даты семинара, выводимые из расписания: какие события делают его запланированным
 * относительно опорной даты и какое из них ближайшее.
 *
 * Опорная дата приходит аргументом — см. `planned-seminars.ts`, где та же оговорка
 * уже стоит: гейт, сравнивающий сохранённый статус с `new Date()`, красил из-за хода
 * времени при исправном коде.
 */

export interface ScheduleEvent {
  id: string | number;
  status: string;
  startAt: string;
  endAt: string;
  city?: string;
}

/** Последний день события в виде календарной даты (см. `planned-seminars.ts`). */
function lastDay(event: ScheduleEvent): string {
  const start = event.startAt ?? '';
  const end = event.endAt ?? '';
  return (end > start ? end : start).slice(0, 10);
}

export function plannedEvents(events: ScheduleEvent[], referenceDate: string): ScheduleEvent[] {
  return events.filter((event) => event.status === 'active' && lastDay(event) >= referenceDate);
}

/** Сравнение по типу поля: числовые id — численно, строковые — лексикографически. */
function compareId(a: ScheduleEvent['id'], b: ScheduleEvent['id']): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const [sa, sb] = [String(a), String(b)];
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export function nearestEvent(events: ScheduleEvent[], referenceDate: string): ScheduleEvent | null {
  const planned = plannedEvents(events, referenceDate);
  if (planned.length === 0) return null;

  return [...planned].sort((a, b) => {
    if (a.startAt !== b.startAt) return a.startAt < b.startAt ? -1 : 1;
    if (a.endAt !== b.endAt) return a.endAt < b.endAt ? -1 : 1;
    const cityA = a.city ?? '';
    const cityB = b.city ?? '';
    if (cityA !== cityB) return cityA < cityB ? -1 : 1;
    return compareId(a.id, b.id);
  })[0];
}
