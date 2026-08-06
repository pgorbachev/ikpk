import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localizeAssetUrls } from './media.js';
export { stripLegacySeminarTail, relForExternalUrl } from './html-cleaner.js';
import { cleanBodyHtml as cleanHtml } from './html-cleaner.js';

let _panels: Record<string, Record<string, string>> | null = null;

/**
 * Контент свёрнутых секций, восстановленный с живого сайта отдельным проходом
 * браузера (web/scripts/recover-collapsibles.mjs). Понадобился потому, что на
 * ikpk.su аккордеоны сделаны на Radix Collapsible: закрытая панель не
 * смонтирована в DOM, и обычный HTTP-скрейп забрал только заголовки — 401
 * секция на 96 страницах, включая учебные планы программ и всю «Оплату».
 */
function panelsFor(path?: string): Record<string, string> | undefined {
  if (!path) return undefined;
  if (!_panels) _panels = loadJson<Record<string, Record<string, string>>>('collapsible_panels.json');
  const key = path.replace(/\/+$/, '') || '/';
  return _panels[key];
}

/**
 * Чистит легаси-HTML для вывода. `path` — путь страницы: по нему
 * подставляется восстановленный контент свёрнутых секций.
 */
export function cleanBodyHtml(html: string, path?: string): string {
  return cleanHtml(html, { panels: panelsFor(path) });
}

const ENTITIES_DIR = join(process.cwd(), '..', 'discovery', 'entities');

function loadJson<T>(filename: string): T {
  const raw = readFileSync(join(ENTITIES_DIR, filename), 'utf-8');
  // Единая точка локализации медиа: все URL бакета (в любых полях, включая
  // HTML-строки) заменяются на локальные /media/** до парсинга (Этап 2).
  return JSON.parse(localizeAssetUrls(raw)) as T;
}

// ---------- Types ----------

export interface Institute {
  legacy_id: string;
  legacy_url: string;
  name: string;
  slug: string;
  seo_title: string;
  seo_description: string;
  description_html: string;
  description_text: string;
  images: string[];
  order: number;
}

export interface CourseGroup {
  legacy_id: string;
  legacy_url: string;
  name: string;
  slug: string;
  institute_legacy_id: string;
  seo_title: string;
  seo_description: string;
  description_html: string;
  description_text: string;
  images: string[];
  /** Порядок с живого сайта (priority); отсутствует у записей, снятых с сайта. */
  order?: number;
}

export interface Seminar {
  legacy_id: string;
  legacy_url: string;
  name: string;
  slug: string;
  course_group_legacy_id: string;
  seo_title: string;
  seo_description: string;
  description_html: string;
  description_text: string;
  images: string[];
  // Поля `status` здесь нет намеренно, хотя в данных оно есть. Это СНИМОК на
  // момент импорта: `refresh-catalog.ts` считает его от календаря того дня, и со
  // временем «planned» превращается в ложное «Набор открыт» у семинара, чьи
  // даты прошли. Страница обязана считать актуальность от даты сборки — так уже
  // делают расписание и страница семинара, отбирая записи расписания с будущей
  // датой. Отсутствие поля в типе делает возврат дефекта ошибкой typecheck, а не
  // тихой регрессией: ранее компонент `SeminarCard.astro` выводил по нему
  // «Набор открыт», причём отрендерен он не был ни на одной странице — ревью
  // правило подписи в мёртвом коде.
  hours?: number | string | null;
  certificate_type?: string | null;
  /** Порядок с живого сайта (priority); отсутствует у записей, снятых с сайта. */
  order?: number;
}

export interface Teacher {
  legacy_id: string;
  legacy_url: string;
  name: string;
  slug: string;
  institute_legacy_id: string;
  bio_html: string;
  bio_text: string;
  photo: string;
  /** Порядок с живого сайта (priority); отсутствует у записей, снятых с сайта. */
  order?: number;
}

export interface Article {
  legacy_id: string;
  legacy_url: string;
  title: string;
  slug: string;
  seo_title: string;
  seo_description: string;
  body_html: string;
  body_text: string;
  published_at: string | null;
  image: string | null;
}

export interface ScheduleEntry {
  id: number;
  status: string;
  name: string;
  seminar: { id: number; name: string; slug: string };
  institute: { id: number; name: string; shortname: string };
  startAt: string;
  endAt: string;
  teachers: { id: number; fullName: string }[];
  image: { url: string; id: string } | null;
  isFree: boolean;
  isEventCollection: boolean;
  description: string | null;
  oldPrice: number;
  newPrice: number;
  city: { id: number; name: string };
  program: { id: number; slug: string; name: string };
  additionalText: string;
  duration: string;
  registrationFormLink: string;
}

export interface NewsItem {
  id: number;
  priority: number;
  name: string;
  image: { url: string; id: string };
  description: string;
  createdAt: string;
  link: string;
}

export interface Promotion {
  id: number;
  name: string;
  priority: number;
  image: { url: string; id: string };
  description: string;
  link: string;
  createdAt: string;
  type: string;
}

export interface VideoPlaylist {
  legacy_id: string;
  legacy_url: string;
  title: string;
  slug: string;
  seo_title: string;
  seo_description: string | null;
  description_html: string;
  description_text: string;
  images: string[];
}

export interface StaticPage {
  legacy_id: string;
  legacy_url: string;
  title: string;
  slug: string;
  seo_title: string;
  seo_description: string;
  body_html: string;
  body_text: string;
}

// ---------- Data accessors ----------

let _institutes: Institute[] | null = null;
export function getInstitutes(): Institute[] {
  if (!_institutes) _institutes = loadJson<Institute[]>('institutes.json');
  return _institutes.sort((a, b) => a.order - b.order);
}

export function getInstitute(slug: string): Institute | undefined {
  return getInstitutes().find((i) => i.slug === slug);
}

let _courseGroups: CourseGroup[] | null = null;
/**
 * Порядок следования, снятый с живого сайта (поле priority в его API).
 *
 * Без него сортировка выходила алфавитной, и это ломало не оформление, а
 * педагогическую последовательность: на группе КСТ продвинутые ADV шли раньше
 * обязательных SER, а флагманская «Прикладная кинезиология» на странице ИКПК
 * оказывалась седьмой вместо первой.
 *
 * Записи без order (исчезли с живого, оставлены осознанно) уходят в конец.
 */
function byOrder<T extends { order?: number; name?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const d = (a.order ?? 9000) - (b.order ?? 9000);
    return d !== 0 ? d : (a.name ?? '').localeCompare(b.name ?? '', 'ru');
  });
}

export function getCourseGroups(instituteSlug?: string): CourseGroup[] {
  if (!_courseGroups) _courseGroups = loadJson<CourseGroup[]>('course_groups.json');
  if (instituteSlug) {
    return byOrder(_courseGroups.filter((cg) => cg.institute_legacy_id === instituteSlug));
  }
  return byOrder(_courseGroups);
}

export function getCourseGroup(slug: string): CourseGroup | undefined {
  return getCourseGroups().find((cg) => cg.slug === slug);
}

let _seminars: Seminar[] | null = null;
export function getSeminars(courseGroupLegacyId?: string): Seminar[] {
  if (!_seminars) _seminars = loadJson<Seminar[]>('seminars.json');
  if (courseGroupLegacyId) {
    return byOrder(_seminars.filter((s) => s.course_group_legacy_id === courseGroupLegacyId));
  }
  return byOrder(_seminars);
}

export function getSeminar(slug: string): Seminar | undefined {
  return getSeminars().find((s) => s.slug === slug);
}

let _teachers: Teacher[] | null = null;
export function getTeachers(instituteSlug?: string): Teacher[] {
  if (!_teachers) _teachers = loadJson<Teacher[]>('teachers.json');
  if (instituteSlug) {
    return byOrder(_teachers.filter((t) => t.institute_legacy_id === instituteSlug));
  }
  return byOrder(_teachers);
}

export function getTeacher(slug: string): Teacher | undefined {
  return getTeachers().find((t) => t.slug === slug);
}

let _articles: Article[] | null = null;
export function getArticles(): Article[] {
  if (!_articles) _articles = loadJson<Article[]>('articles.json');
  return _articles;
}

export function getArticle(slug: string): Article | undefined {
  return getArticles().find((a) => a.slug === slug);
}

let _schedule: ScheduleEntry[] | null = null;
export function getScheduleEntries(): ScheduleEntry[] {
  if (!_schedule) _schedule = loadJson<ScheduleEntry[]>('schedule_entries.json');
  return _schedule;
}

let _news: NewsItem[] | null = null;
export function getNews(): NewsItem[] {
  if (!_news) _news = loadJson<NewsItem[]>('news.json');
  return _news.sort((a, b) => a.priority - b.priority);
}

let _promotions: Promotion[] | null = null;
export function getPromotions(): Promotion[] {
  if (!_promotions) _promotions = loadJson<Promotion[]>('promotions.json');
  return _promotions.sort((a, b) => a.priority - b.priority);
}

let _videos: VideoPlaylist[] | null = null;
export function getVideoPlaylists(): VideoPlaylist[] {
  if (!_videos) _videos = loadJson<VideoPlaylist[]>('video_playlists.json');
  return _videos;
}

export function getVideoPlaylist(slug: string): VideoPlaylist | undefined {
  return getVideoPlaylists().find((v) => v.slug === slug);
}

let _pages: StaticPage[] | null = null;
export function getPages(): StaticPage[] {
  if (!_pages) _pages = loadJson<StaticPage[]>('static_pages.json');
  return _pages;
}

export function getPage(slug: string): StaticPage | undefined {
  return getPages().find((p) => p.slug === slug);
}

// Helper: find institute slug for a course group
export function getInstituteForCourseGroup(cgLegacyId: string): string {
  const parts = cgLegacyId.split('/');
  return parts[0];
}

// Helper: find course group legacy ID for a seminar
export function getCourseGroupForSeminar(seminar: Seminar): CourseGroup | undefined {
  return getCourseGroups().find(
    (cg) => cg.legacy_id === seminar.course_group_legacy_id
  );
}

// Helper: format price
export function formatPrice(price: number): string {
  if (price === 0) return 'Бесплатно';
  return new Intl.NumberFormat('ru-RU').format(price) + ' ₽';
}

// Helper: format date
export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// Helper: strip h1 tags from body_html to avoid duplicate h1 with page template
export function stripH1(html: string): string {
  return html.replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, '');
}
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Helper: excerpt
export function excerpt(text: string, maxLen = 200): string {
  const clean = stripHtml(text);
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}
