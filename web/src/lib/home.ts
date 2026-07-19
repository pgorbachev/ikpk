// Хелперы для секций главной (варианты редизайна).
import { getScheduleEntries, getInstitutes, formatPrice, type ScheduleEntry } from './data.js';

export interface UpcomingSeminar {
  id: number;
  title: string;
  href: string;
  instituteName: string;
  cityName: string;
  dateLabel: string;
  priceLabel: string;
  isFree: boolean;
}

const MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

function dateRange(startAt: string, endAt: string): string {
  const s = new Date(startAt);
  const e = new Date(endAt);
  const sd = s.getUTCDate();
  const ed = e.getUTCDate();
  const sm = MONTHS[s.getUTCMonth()];
  const em = MONTHS[e.getUTCMonth()];
  if (!endAt || (sd === ed && sm === em)) return `${sd} ${sm}`;
  if (sm === em) return `${sd}–${ed} ${em}`;
  return `${sd} ${sm} – ${ed} ${em}`;
}

/**
 * Ближайшие активные семинары с назначенной датой, отсортированные по дате.
 * Прошедшие отфильтровываются по дате сборки (как в расписании).
 */
export function getUpcomingSeminars(limit = 3, now: Date = new Date()): UpcomingSeminar[] {
  const instituteByName = new Map(getInstitutes().map((i) => [i.name, i.slug]));
  const today = now.toISOString().slice(0, 10);

  return getScheduleEntries()
    .filter((e) => e.status === 'active' && e.startAt && e.startAt.slice(0, 10) >= today)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, limit)
    .map((e: ScheduleEntry): UpcomingSeminar => {
      const instituteSlug = instituteByName.get(e.institute.name);
      const href = instituteSlug
        ? `/${instituteSlug}/${e.program.slug}/${e.seminar.slug}`
        : '/raspisanie-i-tseny';
      return {
        id: e.id,
        title: e.name,
        href,
        instituteName: e.institute.name,
        cityName: e.city?.name || 'Уточняется',
        dateLabel: dateRange(e.startAt, e.endAt),
        priceLabel: e.isFree ? 'Бесплатно' : formatPrice(e.newPrice),
        isFree: e.isFree,
      };
    });
}
