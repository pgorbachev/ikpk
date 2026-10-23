// Хелперы для секций главной (варианты редизайна).
import {
  getScheduleEntries,
  getInstitutes,
  getTeachers,
  getSeminars,
  getCourseGroups,
  getArticles,
  getSnapshotReferenceDate,
  formatPrice,
  teacherPageHref,
  type ScheduleEntry,
  type SeminarTeacherRef,
  type Teacher,
} from './data.js';
import { calendarDayDate, isBeforeStart } from './schedule-window';
import { publicScheduleTitle } from './schedule-public-title';

export interface UpcomingSeminar {
  id: number;
  startAt: string;
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
  /** Ссылка на форму записи из расписания (пустая, если в событии её нет). */
  registrationFormLink: string;
}

/** Select each homepage role independently, preserving CMS order and identity. */
export function selectHomepagePeopleByRole(
  people: readonly Teacher[],
  limit = 8,
): { teachers: Teacher[]; methodAuthors: Teacher[] } {
  if (limit <= 0) return { teachers: [], methodAuthors: [] };

  const selectedIds = new Set<string>();
  const select = (trait: 'teacher' | 'method-author') => {
    const selected: Teacher[] = [];
    for (const person of people) {
      if (person.trait !== trait || !person.photo) continue;
      const id = String(person.legacy_id ?? person.slug);
      if (selectedIds.has(id)) continue;
      selectedIds.add(id);
      selected.push(person);
      if (selected.length === limit) break;
    }
    return selected;
  };

  const teachers = select('teacher');
  const methodAuthors = select('method-author');
  return { teachers, methodAuthors };
}

const MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

/** Короткие имена институтов живут в ScheduleEntry.institute.shortname, не в Institute. */
// Фолбэк, когда под рукой нет ScheduleEntry.institute.shortname (страница
// семинара без даты). Живые короткие имена — в расписании. Четвёртый институт
// здесь не заведён: функция вернёт сам slug — не выдумывать короткое имя.
const SHORT_BY_SLUG: Record<string, string> = {
  'institut-klinicheskoy-prikladnoy-kineziologii': 'ИКПК',
  'institut-apledzhera': 'Апледжера',
  'institut-barralya': 'Барраля',
};

export function instituteShortBySlug(slug: string): string {
  return SHORT_BY_SLUG[slug] || slug;
}

export function formatScheduleDateRange(startAt: string, endAt: string): string {
  const s = calendarDayDate(startAt);
  const e = calendarDayDate(endAt);
  const sd = s.getUTCDate();
  const ed = e.getUTCDate();
  const sm = MONTHS[s.getUTCMonth()];
  const em = MONTHS[e.getUTCMonth()];
  if (!endAt || (sd === ed && sm === em)) return `${sd} ${sm}`;
  if (sm === em) return `${sd}–${ed} ${em}`;
  return `${sd} ${sm} – ${ed} ${em}`;
}

export function findTeacherForScheduleLead(
  lead: { id: number | string; fullName: string } | undefined,
  teachers: Teacher[] = getTeachers()
): Teacher | undefined {
  if (!lead) return undefined;
  // Только стабильные ключи: матчинг по префиксу имени давал ложную атрибуцию.
  return teachers.find(
    (t) => t.legacy_id === String(lead.id) || t.slug === String(lead.id)
  );
}

/** Первый преподаватель семинара из каталога (по order), сопоставленный с Teacher. */
export function findTeacherForSeminar(
  refs: SeminarTeacherRef[] | undefined,
  teachers: Teacher[] = getTeachers()
): Teacher | undefined {
  if (!refs?.length) return undefined;
  const ordered = [...refs].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  for (const ref of ordered) {
    const hit = teachers.find(
      (t) => t.legacy_id === String(ref.legacy_id) || t.name === ref.name
    );
    if (hit) return hit;
  }
  return undefined;
}

/** Имя ведущего из seminar.teachers, даже если карточки Teacher нет. */
export function seminarTeacherLabel(refs: SeminarTeacherRef[] | undefined): string {
  if (!refs?.length) return '';
  const ordered = [...refs].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  return ordered[0]?.name.split(',')[0].trim() || '';
}

/**
 * Живые счётчики каталога — для modular-hero и маршрутов.
 * dates — предложения, дата начала которых по МСК ещё не наступила.
 * cities — населённые пункты без «Онлайн».
 */
export function getCatalogStats(now: Date = new Date(getSnapshotReferenceDate())) {
  const schedule = getScheduleEntries().filter(
    (e) => e.status === 'active' && e.startAt && isBeforeStart(e, now)
  );
  const cityNames = [
    ...new Set(
      schedule
        .map((e) => e.city?.name)
        .filter((name): name is string => Boolean(name) && name !== 'Онлайн')
    ),
  ].sort((a, b) => a.localeCompare(b, 'ru'));
  const onlineDates = schedule.filter((e) => e.city?.name === 'Онлайн').length;

  return {
    seminars: getSeminars().length,
    programs: getCourseGroups().length,
    dates: schedule.length,
    cities: cityNames.length,
    cityNames,
    onlineDates,
    teachers: getTeachers().filter((t) => t.photo).length,
    articles: getArticles().length,
  };
}

/**
 * Ближайшие активные семинары с назначенной датой, отсортированные по дате.
 * Уже начавшиеся отфильтровываются: строка «Ближайший семинар» — про набор,
 * к началу которого ещё можно приехать.
 */
export function getUpcomingSeminars(limit = 3, now: Date = new Date(getSnapshotReferenceDate())): UpcomingSeminar[] {
  const instituteByName = new Map(getInstitutes().map((i) => [i.name, i.slug]));
  const teachers = getTeachers();

  return getScheduleEntries()
    // Start-day boundary shared by the server render and browser.
    .filter((e) => e.status === 'active' && e.startAt && isBeforeStart(e, now))
    .sort((a, b) => calendarDayDate(a.startAt).getTime() - calendarDayDate(b.startAt).getTime() || a.id - b.id)
    .slice(0, limit)
    .map((e: ScheduleEntry): UpcomingSeminar => {
      const instituteSlug = instituteByName.get(e.institute.name);
      const href = instituteSlug
        ? `/${instituteSlug}/${e.program.slug}/${e.seminar.slug}`
        : '/raspisanie-i-tseny';
      const lead = e.teachers?.[0];
      const full = findTeacherForScheduleLead(lead, teachers);
      const start = calendarDayDate(e.startAt);
      return {
        id: e.id,
        startAt: e.startAt,
        title: publicScheduleTitle(e),
        href,
        instituteName: e.institute.name,
        instituteShort: e.institute.shortname || instituteShortBySlug(instituteSlug || ''),
        cityName: e.city?.name || 'Уточняется',
        dateLabel: formatScheduleDateRange(e.startAt, e.endAt),
        dayLabel: String(start.getUTCDate()),
        monthLabel: MONTHS[start.getUTCMonth()],
        priceLabel: e.isFree === true ? 'Бесплатно' : formatPrice(e.newPrice),
        isFree: e.isFree,
        durationLabel: e.duration ? `${e.duration} ч` : '',
        teacherName: lead?.fullName?.split(',')[0].trim() || '',
        teacherPhoto: full?.photo || null,
        teacherHref: teacherPageHref(full),
        registrationFormLink: e.registrationFormLink || '',
      };
    });
}
