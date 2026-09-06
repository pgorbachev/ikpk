/**
 * Объявленное соответствие «поле снимка ← источник в системе управления» и проверки по нему
 * (design.md, решение 1, change `cms-live-snapshot-capture`).
 *
 * Имена в CMS и в снимке различаются (`body` против `body_html`, `seo.seo_title` внутри
 * компонента против `seo_title` на верхнем уровне), поэтому соответствие — ДАННЫЕ, а не
 * функции: забытое поле здесь видно как отсутствующая строка, а не как пропавший вызов.
 *
 * Источники объявлены путём к атрибуту в схеме CMS (`cms/src/api/**\/schema.json`,
 * компонент — `cms/src/components/**`). Нетривиальные преобразования (HTML → текст, медиа →
 * ссылка без хоста CMS, `legacy_id` → `legacy_url`) вынесены в `transform` — имя, которое
 * исполняет `capture-content-snapshot.ts`; само соответствие преобразование не исполняет.
 */

export interface FieldMapEntry {
  /** Тип снимка: `articles`, `seminars`, `course_groups`, … — имена те же, что у закреплённой
   *  фикстуры (`fixtures/content-snapshot/snapshot.json`), чтобы существующий контракт
   *  (`content-contract.ts`) и остальной пайплайн не заметили разницы между живым и
   *  закреплённым путём. */
  type: string;
  /** Поле записи снимка. */
  field: string;
  /** Путь к источнику в записи CMS: `body`, `seo.seo_title`, `image`. Без объявленного
   *  источника преобразования не бывает. */
  source: string;
  /** Имя преобразования, исполняемого захватом. Без него поле — прямой passthrough. */
  transform?: string;
}

export interface SourceType {
  /** Имя типа в снимке. */
  type: string;
  /** Множественное имя в REST Strapi: адрес `/api/<endpoint>`. */
  endpoint: string;
  /** Путь к схеме контент-типа от корня репозитория. */
  schema: string;
}

export interface CmsSchema {
  attributes: Record<string, { type: string; component?: string }>;
}

export interface RequiredFieldGroup {
  type: string;
  anyOf: readonly string[];
}

/** Десять типов, которые снимает `scripts/import.ts` и живой захват. */
export const SOURCE_TYPES: readonly SourceType[] = [
  { type: 'institutes', endpoint: 'institutes', schema: 'cms/src/api/institute/content-types/institute/schema.json' },
  { type: 'course_groups', endpoint: 'course-groups', schema: 'cms/src/api/course-group/content-types/course-group/schema.json' },
  { type: 'seminars', endpoint: 'seminars', schema: 'cms/src/api/seminar/content-types/seminar/schema.json' },
  { type: 'teachers', endpoint: 'teachers', schema: 'cms/src/api/teacher/content-types/teacher/schema.json' },
  { type: 'articles', endpoint: 'articles', schema: 'cms/src/api/article/content-types/article/schema.json' },
  { type: 'schedule_entries', endpoint: 'schedule-entries', schema: 'cms/src/api/schedule-entry/content-types/schedule-entry/schema.json' },
  { type: 'news', endpoint: 'news-items', schema: 'cms/src/api/news-item/content-types/news-item/schema.json' },
  { type: 'promotions', endpoint: 'promotions', schema: 'cms/src/api/promotion/content-types/promotion/schema.json' },
  { type: 'static_pages', endpoint: 'pages', schema: 'cms/src/api/page/content-types/page/schema.json' },
  { type: 'video_playlists', endpoint: 'video-playlists', schema: 'cms/src/api/video-playlist/content-types/video-playlist/schema.json' },
] as const;

export const FIELD_MAP: readonly FieldMapEntry[] = [
  // institutes
  { type: 'institutes', field: 'legacy_id', source: 'legacy_id' },
  { type: 'institutes', field: 'legacy_url', source: 'legacy_id', transform: 'legacyUrlFromId' },
  { type: 'institutes', field: 'name', source: 'name' },
  { type: 'institutes', field: 'shortname', source: 'shortName' },
  { type: 'institutes', field: 'slug', source: 'slug' },
  { type: 'institutes', field: 'order', source: 'order' },
  { type: 'institutes', field: 'seo_title', source: 'seo.seo_title' },
  { type: 'institutes', field: 'seo_description', source: 'seo.seo_description' },
  { type: 'institutes', field: 'description_html', source: 'description' },
  { type: 'institutes', field: 'description_text', source: 'description', transform: 'htmlToText' },
  { type: 'institutes', field: 'image', source: 'image', transform: 'mediaRef' },
  { type: 'institutes', field: 'images', source: 'image', transform: 'mediaUrlList' },
  { type: 'institutes', field: 'order', source: 'order' },

  // course_groups
  { type: 'course_groups', field: 'legacy_id', source: 'legacy_id' },
  { type: 'course_groups', field: 'legacy_url', source: 'legacy_id', transform: 'legacyUrlFromId' },
  { type: 'course_groups', field: 'name', source: 'name' },
  { type: 'course_groups', field: 'slug', source: 'slug' },
  { type: 'course_groups', field: 'order', source: 'order' },
  { type: 'course_groups', field: 'images', source: 'image', transform: 'mediaUrlList' },
  { type: 'course_groups', field: 'institute_legacy_id', source: 'institute.legacy_id' },
  { type: 'course_groups', field: 'seo_title', source: 'seo.seo_title' },
  { type: 'course_groups', field: 'seo_description', source: 'seo.seo_description' },
  { type: 'course_groups', field: 'description_html', source: 'description' },
  { type: 'course_groups', field: 'description_text', source: 'description', transform: 'htmlToText' },
  { type: 'course_groups', field: 'image', source: 'image', transform: 'mediaRef' },

  // seminars — БЕЗ institute_legacy_id: у семинара в схеме нет отношения `institute`
  // (только `course_group`). Институт восстанавливается ниже по цепочке group→institute.
  { type: 'seminars', field: 'legacy_id', source: 'legacy_id' },
  { type: 'seminars', field: 'legacy_url', source: 'legacy_id', transform: 'legacyUrlFromId' },
  { type: 'seminars', field: 'name', source: 'name' },
  { type: 'seminars', field: 'slug', source: 'slug' },
  { type: 'seminars', field: 'order', source: 'order' },
  { type: 'seminars', field: 'images', source: 'image', transform: 'mediaUrlList' },
  { type: 'seminars', field: 'course_group_legacy_id', source: 'course_group.legacy_id' },
  { type: 'seminars', field: 'status', source: 'status' },
  { type: 'seminars', field: 'price', source: 'price' },
  { type: 'seminars', field: 'duration', source: 'duration' },
  { type: 'seminars', field: 'seo_title', source: 'seo.seo_title' },
  { type: 'seminars', field: 'seo_description', source: 'seo.seo_description' },
  { type: 'seminars', field: 'description_html', source: 'description' },
  { type: 'seminars', field: 'description_text', source: 'description', transform: 'htmlToText' },
  { type: 'seminars', field: 'full_text_html', source: 'full_text' },
  { type: 'seminars', field: 'image', source: 'image', transform: 'mediaRef' },
  { type: 'seminars', field: 'teachers', source: 'teachers', transform: 'refList' },

  // teachers: связь с институтом добавлена в схему CMS и в импортёр. Прежде её не было ни там,
  // ни там, хотя в данных переноса она есть у всех 29, — и живой захват отказывал на первом же
  // преподавателе, потому что контракт проверяет эту связь кодом.
  { type: 'teachers', field: 'legacy_id', source: 'legacy_id' },
  { type: 'teachers', field: 'legacy_url', source: 'legacy_id', transform: 'legacyUrlFromId' },
  { type: 'teachers', field: 'name', source: 'name' },
  { type: 'teachers', field: 'slug', source: 'slug' },
  { type: 'teachers', field: 'institute_legacy_id', source: 'institute.legacy_id' },
  { type: 'teachers', field: 'bio_html', source: 'bio' },
  { type: 'teachers', field: 'bio_text', source: 'bio', transform: 'htmlToText' },
  { type: 'teachers', field: 'photo', source: 'photo', transform: 'mediaUrl' },
  { type: 'teachers', field: 'order', source: 'order' },

  // articles
  { type: 'articles', field: 'legacy_id', source: 'legacy_id' },
  { type: 'articles', field: 'legacy_url', source: 'legacy_id', transform: 'legacyUrlFromId' },
  { type: 'articles', field: 'title', source: 'title' },
  { type: 'articles', field: 'slug', source: 'slug' },
  { type: 'articles', field: 'body_html', source: 'body' },
  { type: 'articles', field: 'body_text', source: 'body', transform: 'htmlToText' },
  { type: 'articles', field: 'seo_title', source: 'seo.seo_title' },
  { type: 'articles', field: 'seo_description', source: 'seo.seo_description' },
  { type: 'articles', field: 'image', source: 'image', transform: 'mediaUrl' },
  { type: 'articles', field: 'published_at', source: 'published_date' },

  // schedule_entries — уже CMS-нативный тип, без legacy-иерархии: поля называются как в схеме.
  { type: 'schedule_entries', field: 'legacy_id', source: 'legacy_id' },
  { type: 'schedule_entries', field: 'name', source: 'name' },
  { type: 'schedule_entries', field: 'startAt', source: 'startAt' },
  { type: 'schedule_entries', field: 'endAt', source: 'endAt' },
  { type: 'schedule_entries', field: 'city', source: 'city' },
  { type: 'schedule_entries', field: 'price', source: 'price' },
  { type: 'schedule_entries', field: 'oldPrice', source: 'oldPrice' },
  { type: 'schedule_entries', field: 'isFree', source: 'isFree' },
  { type: 'schedule_entries', field: 'status', source: 'status' },
  { type: 'schedule_entries', field: 'registrationFormLink', source: 'registrationFormLink' },
  { type: 'schedule_entries', field: 'description', source: 'description' },
  { type: 'schedule_entries', field: 'additionalText', source: 'additionalText' },
  { type: 'schedule_entries', field: 'duration', source: 'duration' },
  { type: 'schedule_entries', field: 'seminar', source: 'seminar' },
  { type: 'schedule_entries', field: 'teachers', source: 'teachers' },

  // news
  { type: 'news', field: 'legacy_id', source: 'legacy_id' },
  { type: 'news', field: 'name', source: 'name' },
  { type: 'news', field: 'description', source: 'description' },
  { type: 'news', field: 'image', source: 'image', transform: 'mediaRef' },
  { type: 'news', field: 'link', source: 'link' },
  { type: 'news', field: 'priority', source: 'priority' },

  // promotions
  { type: 'promotions', field: 'legacy_id', source: 'legacy_id' },
  { type: 'promotions', field: 'name', source: 'name' },
  { type: 'promotions', field: 'description', source: 'description' },
  { type: 'promotions', field: 'image', source: 'image', transform: 'mediaRef' },
  { type: 'promotions', field: 'link', source: 'link' },
  { type: 'promotions', field: 'priority', source: 'priority' },
  { type: 'promotions', field: 'active', source: 'active' },

  // static_pages
  { type: 'static_pages', field: 'legacy_id', source: 'legacy_id' },
  { type: 'static_pages', field: 'legacy_url', source: 'legacy_id', transform: 'legacyUrlFromId' },
  { type: 'static_pages', field: 'title', source: 'title' },
  { type: 'static_pages', field: 'slug', source: 'slug' },
  { type: 'static_pages', field: 'body_html', source: 'body' },
  { type: 'static_pages', field: 'body_text', source: 'body', transform: 'htmlToText' },
  { type: 'static_pages', field: 'seo_title', source: 'seo.seo_title' },
  { type: 'static_pages', field: 'seo_description', source: 'seo.seo_description' },

  // video_playlists — CMS-поле называется `name`, снимок несёт его как `title`.
  { type: 'video_playlists', field: 'legacy_id', source: 'legacy_id' },
  { type: 'video_playlists', field: 'legacy_url', source: 'legacy_id', transform: 'legacyUrlFromId' },
  { type: 'video_playlists', field: 'title', source: 'name' },
  { type: 'video_playlists', field: 'slug', source: 'slug' },
  { type: 'video_playlists', field: 'videos', source: 'videos' },
  { type: 'video_playlists', field: 'seo_title', source: 'seo.seo_title' },
  { type: 'video_playlists', field: 'seo_description', source: 'seo.seo_description' },
] as const;

/**
 * Полнота относительно КОНТРАКТА снимка (`content-contract.ts`, `REQUIRED_SNAPSHOT_FIELDS`),
 * а не относительно фикстуры: фикстура сама может быть неполной (design.md, Risks).
 */
export function checkFieldMapCompleteness(input: {
  map: readonly FieldMapEntry[];
  required: readonly RequiredFieldGroup[];
}): { ok: boolean; missing: { type: string; field: string }[]; vacuous: boolean } {
  const { map, required } = input;
  const vacuous = map.length === 0 || required.length === 0;
  if (vacuous) return { ok: false, missing: [], vacuous: true };

  const missing: { type: string; field: string }[] = [];
  for (const group of required) {
    const covered = map.some((entry) => entry.type === group.type && group.anyOf.includes(entry.field));
    if (!covered) missing.push({ type: group.type, field: group.anyOf[0]! });
  }
  return { ok: missing.length === 0, missing, vacuous: false };
}

/** Атрибут компонента `shared.seo` и подобных — второй сегмент пути `seo.seo_title`. */
function componentAttributeMissing(
  attr: { type: string; component?: string } | undefined,
  subfield: string,
  components: Record<string, CmsSchema>,
): boolean {
  if (!attr || attr.type !== 'component' || !attr.component) return false;
  const componentSchema = components[attr.component];
  if (!componentSchema) return false;
  return componentSchema.attributes[subfield] === undefined;
}

/**
 * Сверка объявленного соответствия со схемой CMS: исчезнувший источник — отказ с названием
 * ОБОИХ имён; поле схемы, не названное ни в одном соответствии, — не отказ, но и не тишина.
 */
export function checkFieldMapAgainstSchema(input: {
  map: readonly FieldMapEntry[];
  schemas: Record<string, CmsSchema>;
  components: Record<string, CmsSchema>;
}): {
  ok: boolean;
  missingSources: { type: string; field: string; source: string }[];
  unmapped: { type: string; field: string }[];
} {
  const { map, schemas, components } = input;
  const missingSources: { type: string; field: string; source: string }[] = [];
  const coveredRoots = new Map<string, Set<string>>();

  for (const entry of map) {
    const [root, subfield] = entry.source.split('.');
    const schema = schemas[entry.type];
    const attr = schema?.attributes[root!];
    const gone = attr === undefined || (subfield !== undefined && componentAttributeMissing(attr, subfield, components));
    if (gone) {
      missingSources.push({ type: entry.type, field: entry.field, source: entry.source });
    } else {
      const set = coveredRoots.get(entry.type) ?? new Set<string>();
      set.add(root!);
      coveredRoots.set(entry.type, set);
    }
  }

  const unmapped: { type: string; field: string }[] = [];
  for (const [type, schema] of Object.entries(schemas)) {
    const covered = coveredRoots.get(type) ?? new Set<string>();
    for (const field of Object.keys(schema.attributes)) {
      if (!covered.has(field)) unmapped.push({ type, field });
    }
  }

  return { ok: missingSources.length === 0, missingSources, unmapped };
}
