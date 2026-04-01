import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export { cleanBodyHtml } from './html-cleaner.js';

const ENTITIES_DIR = join(process.cwd(), '..', 'discovery', 'entities');

function loadJson<T>(filename: string): T {
  const raw = readFileSync(join(ENTITIES_DIR, filename), 'utf-8');
  return JSON.parse(raw) as T;
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
  status: string;
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
export function getCourseGroups(instituteSlug?: string): CourseGroup[] {
  if (!_courseGroups) _courseGroups = loadJson<CourseGroup[]>('course_groups.json');
  if (instituteSlug) {
    return _courseGroups.filter((cg) => cg.institute_legacy_id === instituteSlug);
  }
  return _courseGroups;
}

export function getCourseGroup(slug: string): CourseGroup | undefined {
  return getCourseGroups().find((cg) => cg.slug === slug);
}

let _seminars: Seminar[] | null = null;
export function getSeminars(courseGroupLegacyId?: string): Seminar[] {
  if (!_seminars) _seminars = loadJson<Seminar[]>('seminars.json');
  if (courseGroupLegacyId) {
    return _seminars.filter((s) => s.course_group_legacy_id === courseGroupLegacyId);
  }
  return _seminars;
}

export function getSeminar(slug: string): Seminar | undefined {
  return getSeminars().find((s) => s.slug === slug);
}

let _teachers: Teacher[] | null = null;
export function getTeachers(instituteSlug?: string): Teacher[] {
  if (!_teachers) _teachers = loadJson<Teacher[]>('teachers.json');
  if (instituteSlug) {
    return _teachers.filter((t) => t.institute_legacy_id === instituteSlug);
  }
  return _teachers;
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
