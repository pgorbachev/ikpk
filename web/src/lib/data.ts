import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localizeAssetUrls } from './media.js';
import { byExplicitOrder } from '../../scripts/lib/content-order';
export { stripLegacySeminarTail, relForExternalUrl, isSafeRichHtml, terminalSanitize, rewriteSafeRichHtml } from './html-cleaner.js';
export type { SafeRichHtml } from './html-cleaner.js';
import { cleanBodyHtml as cleanHtml, type SafeRichHtml } from './html-cleaner.js';

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
 * Чистит легаси-HTML для вывода. Второй аргумент — путь страницы (для
 * restored collapsible panels) либо стабильный source `{ type, id }`.
 */
export function cleanBodyHtml(
  html: string,
  pathOrSource?: string | { type: string; id: string; path?: string },
  legacyCtaHref?: string,
): SafeRichHtml {
  const source = typeof pathOrSource === 'object' && pathOrSource
    ? pathOrSource
    : { type: 'page', id: pathOrSource ?? 'unknown', path: pathOrSource };
  const path = source.path ?? (typeof pathOrSource === 'string' ? pathOrSource : undefined);
  return cleanHtml(html, {
    panels: panelsFor(path),
    legacyCtaHref,
    sourceType: source.type,
    sourceId: source.id,
  });
}

const WEB_ROOT = process.cwd();
const REPO_ROOT = join(WEB_ROOT, '..');

type SnapshotFile = {
  pinned?: boolean;
  referenceDate: string;
  fingerprint?: string;
  snapshotId?: string;
  content: { types: Record<string, unknown> };
};

let _snapshot: SnapshotFile | null = null;
let _snapshotDir: string | null = null;

function snapshotDir(): string {
  if (_snapshotDir) return _snapshotDir;
  const fromEnv = process.env.CONTENT_SNAPSHOT_DIR;
  const candidates = [
    fromEnv,
    join(WEB_ROOT, '.snapshot'),
    join(REPO_ROOT, 'fixtures', 'content-snapshot'),
  ].filter((v): v is string => Boolean(v));
  for (const dir of candidates) {
    if (existsSync(join(dir, 'snapshot.json'))) {
      _snapshotDir = dir;
      return dir;
    }
  }
  throw new Error(
    'снимок контента не найден (CONTENT_SNAPSHOT_DIR / web/.snapshot / fixtures/content-snapshot)',
  );
}

function loadSnapshot(): SnapshotFile {
  if (_snapshot) return _snapshot;
  const raw = readFileSync(join(snapshotDir(), 'snapshot.json'), 'utf-8');
  _snapshot = JSON.parse(localizeAssetUrls(raw)) as SnapshotFile;
  return _snapshot;
}

/** Опорная дата снимка, которым идёт сборка. */
export function getSnapshotReferenceDate(): string {
  return loadSnapshot().referenceDate;
}

export function getSnapshotIdentity(): { fingerprint?: string; snapshotId?: string; referenceDate: string } {
  const snap = loadSnapshot();
  return { fingerprint: snap.fingerprint, snapshotId: snap.snapshotId, referenceDate: snap.referenceDate };
}

const TYPE_BY_FILE: Record<string, string> = {
  'institutes.json': 'institutes',
  'course_groups.json': 'course_groups',
  'seminars.json': 'seminars',
  'teachers.json': 'teachers',
  'articles.json': 'articles',
  'schedule_entries.json': 'schedule_entries',
  'news.json': 'news',
  'promotions.json': 'promotions',
  'video_playlists.json': 'video_playlists',
  'static_pages.json': 'static_pages',
};

function loadJson<T>(filename: string): T {
  if (filename === 'collapsible_panels.json') {
    const panelsPath = join(snapshotDir(), 'collapsible_panels.json');
    const raw = readFileSync(panelsPath, 'utf-8');
    return JSON.parse(localizeAssetUrls(raw)) as T;
  }
  const type = TYPE_BY_FILE[filename];
  if (!type) throw new Error(`неизвестный файл снимка: ${filename}`);
  const records = loadSnapshot().content.types[type];
  if (records === undefined) throw new Error(`в снимке нет типа ${type}`);
  // Локализация уже применена ко всему снимку; повторно сериализуем только запись.
  return records as T;
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
  order?: number;
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

export interface SeminarTeacherRef {
  legacy_id: number;
  name: string;
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
  /** Преподаватели семинара из каталога (не «любой с фото у института»). */
  teachers?: SeminarTeacherRef[];
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
  return byExplicitOrder(_institutes, (item) => item.slug);
}

export function getInstitute(slug: string): Institute | undefined {
  return getInstitutes().find((i) => i.slug === slug);
}

let _courseGroups: CourseGroup[] | null = null;
export function getCourseGroups(instituteSlug?: string): CourseGroup[] {
  if (!_courseGroups) _courseGroups = loadJson<CourseGroup[]>('course_groups.json');
  if (instituteSlug) {
    return byExplicitOrder(
      _courseGroups.filter((cg) => cg.institute_legacy_id === instituteSlug),
      (item) => item.slug,
    );
  }
  return byExplicitOrder(_courseGroups, (item) => item.slug);
}

export function getCourseGroup(slug: string): CourseGroup | undefined {
  return getCourseGroups().find((cg) => cg.slug === slug);
}

let _seminars: Seminar[] | null = null;
export function getSeminars(courseGroupLegacyId?: string): Seminar[] {
  if (!_seminars) _seminars = loadJson<Seminar[]>('seminars.json');
  if (courseGroupLegacyId) {
    return byExplicitOrder(
      _seminars.filter((s) => s.course_group_legacy_id === courseGroupLegacyId),
      (item) => item.slug,
    );
  }
  return byExplicitOrder(_seminars, (item) => item.slug);
}

export function getSeminar(slug: string): Seminar | undefined {
  return getSeminars().find((s) => s.slug === slug);
}

let _teachers: Teacher[] | null = null;
export function getTeachers(instituteSlug?: string): Teacher[] {
  if (!_teachers) _teachers = loadJson<Teacher[]>('teachers.json');
  if (instituteSlug) {
    return byExplicitOrder(
      _teachers.filter((t) => t.institute_legacy_id === instituteSlug),
      (item) => item.slug,
    );
  }
  return byExplicitOrder(_teachers, (item) => item.slug);
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
