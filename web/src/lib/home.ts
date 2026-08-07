// Хелперы для секций главной (варианты редизайна).
import {
  getScheduleEntries,
  getInstitutes,
  getTeachers,
  getSeminars,
  getCourseGroups,
  formatPrice,
  type ScheduleEntry,
} from './data.js';
import { isCurrentOrFuture } from './schedule-window';

export interface UpcomingSeminar {
  id: number;
  title: string;
  href: string;
  instituteName: string;
  instituteShort: string;
  cityName: string;
  dateLabel: string;
  /** День месяца для графического блока даты (modular). */
  dayLabel: string;
  monthLabel: string;
  priceLabel: string;
  isFree: boolean;
  durationLabel: string;
  teacherName: string;
  teacherPhoto: string | null;
  teacherHref: string | null;
}

/** Живые счётчики каталога — для modular-hero и маршрутов, без маркетинговых выдумок. */
export function getCatalogStats() {
  const schedule = getScheduleEntries().filter((e) => e.status === 'active');
  const cities = new Set(
    schedule.map((e) => e.city?.name).filter((name): name is string => Boolean(name))
  );
  return {
    seminars: getSeminars().length,
    programs: getCourseGroups().length,
    dates: schedule.length,
    cities: cities.size,
    teachers: getTeachers().filter((t) => t.photo).length,
  };
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
  const teachers = getTeachers();
  const today = now.toISOString().slice(0, 10);

  return getScheduleEntries()
    // По последнему дню события, а не по первому: многодневных записей 60 из 63,
    // и фильтр по startAt убирал бы идущий семинар с главной на второй день —
    // при том, что расписание его показывает. Общий вывод в schedule-window.ts.
    .filter((e) => e.status === 'active' && e.startAt && isCurrentOrFuture(e, today))
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, limit)
    .map((e: ScheduleEntry): UpcomingSeminar => {
      const instituteSlug = instituteByName.get(e.institute.name);
      const href = instituteSlug
        ? `/${instituteSlug}/${e.program.slug}/${e.seminar.slug}`
        : '/raspisanie-i-tseny';
      const lead = e.teachers?.[0];
      const full = lead
        ? teachers.find(
            (t) =>
              t.legacy_id === String(lead.id) ||
              t.slug === String(lead.id) ||
              t.name.startsWith(lead.fullName.split(',')[0].trim())
          )
        : undefined;
      const start = new Date(e.startAt);
      return {
        id: e.id,
        title: e.name,
        href,
        instituteName: e.institute.name,
        instituteShort: e.institute.shortname || e.institute.name,
        cityName: e.city?.name || 'Уточняется',
        dateLabel: dateRange(e.startAt, e.endAt),
        dayLabel: String(start.getUTCDate()),
        monthLabel: MONTHS[start.getUTCMonth()],
        priceLabel: e.isFree ? 'Бесплатно' : formatPrice(e.newPrice),
        isFree: e.isFree,
        durationLabel: e.duration ? `${e.duration} ч` : '',
        teacherName: lead?.fullName?.split(',')[0].trim() || '',
        teacherPhoto: full?.photo || null,
        teacherHref: full
          ? `/${full.institute_legacy_id}/prepodavatel/${full.slug}`
          : null,
      };
    });
}
