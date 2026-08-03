/**
 * Обновление каталога с живого сайта: семинары, программы (у нас — группы
 * курсов), преподаватели, институты.
 *
 * Почему это возможно и зачем отдельно от других скриптов.
 *
 * Снимок в discovery/entities сделан 2026-03-31 и разошёлся с живым сайтом:
 * 14 живых страниц отдают у нас 404, у преподавателей разъехались направления,
 * а порядка следования в снимке нет вообще — из-за этого сортировка
 * алфавитная, и продвинутые ступени идут раньше обязательных (на группе КСТ
 * ADV раньше SER, хотя SER обязателен).
 *
 * У живого сайта есть публичный API, и он отдаёт ровно то, чего не хватало:
 *   /api/public/seminars      список + priority (это и есть порядок)
 *   /api/public/seminars/<id> ПОЛНЫЙ контент: curriculum, learningProcess,
 *                             certificates, recommendations
 *   /api/public/programs      26 программ = наши группы курсов, с priority
 *   /api/public/teachers      преподаватели с priority и описанием
 *   /api/institutes           институты
 *
 * Отдельно стоит отметить: секции семинара (учебный план, как проходит
 * обучение, выдаваемые документы, рекомендации) доступны прямо из API. Ранее их
 * приходилось восстанавливать браузером через recover-collapsibles.mjs, потому
 * что на живых страницах они смонтированы только по клику. Тот скрипт остаётся
 * как способ снять то, чего в API нет (например разделы «Сведений об
 * образовательной организации»), но для каталога источник теперь API — он
 * авторитетнее и полнее.
 *
 * Схему discovery/entities НЕ меняем: поля остаются в snake_case, потому что на
 * них смотрят lib/data.ts и все страницы. Добавляется только `order`.
 *
 * Запуск: из web/ — `npm run data:refresh` (или tsx scripts/refresh-catalog.ts)
 *   --dry   ничего не писать, показать расхождения
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sectionsHtml, SECTION_TITLES } from './lib/seminar-sections.js';
import { calendarToday, plannedSlugs as derivePlannedSlugs } from './lib/planned-seminars.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTITIES = join(ROOT, 'discovery', 'entities');
const ORIGIN = 'https://ikpk.su';
const CONCURRENCY = 6;

const dryRun = process.argv.includes('--dry');

async function api<T>(path: string): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(ORIGIN + path, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw new Error('unreachable');
}

interface Paged<T> {
  pagesCount: number;
  totalCount: number;
  items: T[];
}

/** Все страницы списочного эндпоинта. */
async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    // pageSize=20, а не 30: у /api/public/programs предел ниже, и 30 даёт
    // validation error. Единое безопасное значение проще, чем предел на каждый
    // эндпоинт.
    const d = await api<Paged<T>>(`${path}${sep}page=${page}&pageSize=20`);
    out.push(...d.items);
    if (page >= d.pagesCount) break;
    page += 1;
  }
  return out;
}

/** Пул с ограничением параллельности: 125 запросов подряд сайт не любит. */
async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const text = (html: string | null | undefined): string =>
  (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();


interface SeminarListItem {
  id: number;
  name: string;
  slug: string;
  priority: number;
  program?: { id: number; name: string; priority: number } | null;
  institute?: { id: number; name: string } | null;
  /** События расписания у семинара: по их наличию определяется статус. */
  events?: Array<{ id: number }> | null;
  /** Преподаватели с собственным порядком следования. */
  teachers?: Array<{ id: number; fullName: string; priority: number }> | null;
}

interface SeminarDetail extends SeminarListItem {
  seoTitle?: string | null;
  seoDescription?: string | null;
  curriculum?: string | null;
  learningProcess?: string | null;
  certificates?: string | null;
  recommendations?: string | null;
}

interface ProgramItem {
  id: number;
  name: string;
  slug: string;
  priority: number;
  seoTitle?: string | null;
  seoDescription?: string | null;
  content?: string | null;
  image?: { url?: string } | string | null;
  institute?: { id: number } | null;
}

interface TeacherItem {
  id: number;
  fullName: string;
  priority: number;
  description?: string | null;
  image?: { url?: string } | string | null;
  institutes?: Array<{ id: number }> | null;
}

const imageUrl = (v: ProgramItem['image']): string =>
  typeof v === 'string' ? v : (v?.url ?? '');

// ── Сбор
console.log('запрашиваю живой API…');
const [seminarList, programs, teachers] = await Promise.all([
  all<SeminarListItem>('/api/public/seminars'),
  all<ProgramItem>('/api/public/programs'),
  all<TeacherItem>('/api/public/teachers'),
]);
console.log(
  `семинаров ${seminarList.length}, программ ${programs.length}, преподавателей ${teachers.length}`,
);

console.log('качаю детали семинаров (в них секции: учебный план и остальные)…');
const seminars = await mapPool(seminarList, (s) => api<SeminarDetail>(`/api/public/seminars/${s.id}`));

/**
 * КЛЮЧЕВОЕ отличие пространств идентификаторов.
 *
 * У API числовые id (семинар 201, программа 150, институт 1). У нас
 * идентификаторы ПУТЕВЫЕ: `институт/программа/семинар` — они кодируют
 * иерархию URL, по которой строятся вложенные маршруты. Подстановка числовых id
 * рвёт все связи: первая версия скрипта так и сделала, и сборка дала 93 страницы
 * вместо 260.
 *
 * Поэтому строим соответствие: институт по порядку в API → наш slug института,
 * программа по slug (он совпадает), и собираем путевые идентификаторы сами.
 */
const instituteSlugById = new Map<number, string>([
  [1, 'institut-klinicheskoy-prikladnoy-kineziologii'],
  [2, 'institut-apledzhera'],
  [3, 'institut-barralya'],
]);

const programById = new Map(programs.map((p) => [p.id, p]));

/** `институт/программа` — идентификатор группы курсов в нашей схеме. */
function groupPath(program: ProgramItem | undefined): string | null {
  if (!program) return null;
  const inst = instituteSlugById.get(program.institute?.id ?? 0);
  return inst ? `${inst}/${program.slug}` : null;
}

// ── Раскладка в нашу схему
/**
 * ВАЖНО про контент семинара.
 *
 * В API у семинара НЕТ основного описательного текста — только четыре секции
 * (учебный план, как проходит обучение, выдаваемые документы, рекомендации).
 * Основной текст на живой странице приходит из другого места, а у нас он уже
 * перенесён и лежит в description_html.
 *
 * Поэтому обновление НЕ перезаписывает контент: у существующих семинаров
 * description_html сохраняется как есть, а из API берётся то, чего у нас не
 * было или что устарело — порядок, привязки, статус, список преподавателей. Для
 * НОВЫХ семинаров контент собирается из секций API: другого источника нет.
 *
 * Проверка ниже («контента стало заметно меньше») ловит ровно эту ошибку: на
 * первом прогоне с перезаписью она показала потерю у 112 семинаров из 125.
 */
/**
 * Актуально запланированные семинары — по расписанию, а не по полю `events`.
 * Сам вывод живёт в `./lib/planned-seminars.ts`: там он проверяется фикстурами
 * с фиксированной датой, а не живыми данными, ход времени которых красил гейт.
 */
const scheduleEntries = JSON.parse(
  readFileSync(join(ENTITIES, 'schedule_entries.json'), 'utf-8'),
) as Array<{ status?: string; startAt?: string; endAt?: string; seminar?: { slug?: string } | null }>;

const plannedSlugs = derivePlannedSlugs(scheduleEntries, calendarToday());
console.log(`семинаров с будущими датами по расписанию: ${plannedSlugs.size}`);

const oldSeminars = JSON.parse(readFileSync(join(ENTITIES, 'seminars.json'), 'utf-8')) as Array<{
  slug: string;
  description_html?: string;
  description_text?: string;
  images?: string[];
  seo_title?: string;
  seo_description?: string;
}>;
const oldBySlug = new Map(oldSeminars.map((s) => [s.slug, s]));
let contentFromApi = 0;

/**
 * Контент, собранный НАМИ из секций API, отличим от перенесённого с сайта: он
 * начинается нашим же заголовком секции. Такой пересобираем при каждом
 * обновлении — иначе ошибка в соответствии полей осталась бы навсегда, потому
 * что слияние сохраняет старое.
 */
function isApiGenerated(html: string): boolean {
  const trimmed = html.trim();
  return Object.values(SECTION_TITLES).some((h) => trimmed.startsWith(`<h2>${h}</h2>`));
}

const nextSeminars = seminars.map((s) => {
  const prev = oldBySlug.get(s.slug);
  const prevHtml = prev?.description_html?.trim() ?? '';
  // перенесённый контент сохраняем, свой собственный — пересобираем
  const reuse = prevHtml && !isApiGenerated(prevHtml);
  const html = reuse ? prevHtml : sectionsHtml(s);
  if (!reuse) contentFromApi += 1;

  const program = programById.get(s.program?.id ?? 0);
  const group = groupPath(program);

  return {
  legacy_id: group ? `${group}/${s.slug}` : s.slug,
  legacy_url: group ? `/${group}/${s.slug}` : `/${s.slug}`,
  name: s.name,
  slug: s.slug,
  course_group_legacy_id: group,
  // seo-поля: живой API отдаёт их пустыми у 120 семинаров из 126 (сайт собирает
  // заголовок шаблоном на месте). Перезапись пустым значением обнулила <title>
  // на 138 страницах — поэтому здесь тот же принцип, что и с контентом: пустое
  // из API не затирает уже имеющееся.
  seo_title: s.seoTitle?.trim() || prev?.seo_title || '',
  seo_description: s.seoDescription?.trim() || prev?.seo_description || '',
  description_html: html,
  description_text: reuse && prev?.description_text?.trim() ? prev.description_text : text(html),
  images: prev?.images ?? ([] as string[]),
  status: plannedSlugs.has(s.slug) ? 'planned' : 'not_planned',
  order: s.priority,
  institute_legacy_id: instituteSlugById.get(s.institute?.id ?? 0) ?? null,
  teachers: (s.teachers ?? []).map((t) => ({ legacy_id: t.id, name: t.fullName, order: t.priority })),
  };
});

const oldGroups = JSON.parse(readFileSync(join(ENTITIES, 'course_groups.json'), 'utf-8')) as Array<{
  slug: string;
  seo_title?: string;
  seo_description?: string;
  description_html?: string;
  images?: string[];
}>;
const oldGroupBySlug = new Map(oldGroups.map((g) => [g.slug, g]));

const nextGroups = programs.map((p) => ({
  legacy_id: groupPath(p) ?? p.slug,
  legacy_url: `/${groupPath(p) ?? p.slug}`,
  name: p.name,
  slug: p.slug,
  institute_legacy_id: instituteSlugById.get(p.institute?.id ?? 0) ?? null,
  seo_title: p.seoTitle?.trim() || oldGroupBySlug.get(p.slug)?.seo_title || '',
  seo_description: p.seoDescription?.trim() || oldGroupBySlug.get(p.slug)?.seo_description || '',
  description_html: (p.content ?? '').trim() || oldGroupBySlug.get(p.slug)?.description_html || '',
  description_text: text((p.content ?? '').trim() || oldGroupBySlug.get(p.slug)?.description_html),
  images: [imageUrl(p.image)].filter(Boolean).length
    ? [imageUrl(p.image)]
    : (oldGroupBySlug.get(p.slug)?.images ?? []),
  order: p.priority,
}));

const nextTeachers = teachers.map((t) => ({
  legacy_id: t.id,
  legacy_url: `/teachers/${t.id}`,
  name: t.fullName,
  slug: String(t.id),
  institute_legacy_id: instituteSlugById.get(t.institutes?.[0]?.id ?? 0) ?? null,
  bio_html: t.description ?? '',
  bio_text: text(t.description),
  photo: imageUrl(t.image),
  order: t.priority,
}));

// ── Расхождения
function diff(label: string, oldArr: Array<{ slug: string }>, nextArr: Array<{ slug: string }>): void {
  const a = new Set(oldArr.map((x) => x.slug));
  const b = new Set(nextArr.map((x) => x.slug));
  const added = [...b].filter((s) => !a.has(s));
  const gone = [...a].filter((s) => !b.has(s));
  console.log(`\n${label}: было ${a.size}, стало ${b.size}`);
  if (added.length) console.log(`  появилось (${added.length}): ${added.slice(0, 14).join(', ')}`);
  if (gone.length) console.log(`  исчезло с живого (${gone.length}): ${gone.slice(0, 14).join(', ')}`);
}

diff('семинары', oldSeminars, nextSeminars);
diff(
  'группы курсов',
  JSON.parse(readFileSync(join(ENTITIES, 'course_groups.json'), 'utf-8')),
  nextGroups,
);
diff(
  'преподаватели',
  JSON.parse(readFileSync(join(ENTITIES, 'teachers.json'), 'utf-8')),
  nextTeachers,
);

// сохранность секций: сравниваем объём контента, чтобы обновление не оказалось
// потерей — именно так однажды и приехал пустой каталог
const lostContent = nextSeminars.filter((s) => {
  const before = (oldBySlug.get(s.slug)?.description_html ?? '').length;
  return before > 400 && s.description_html.length < before / 2;
});
console.log(`\nконтент из API (новые семинары, другого источника нет): ${contentFromApi}`);
console.log(
  `семинаров, где контента стало заметно меньше: ${lostContent.length}` +
    (lostContent.length ? ` → ${lostContent.slice(0, 5).map((s) => s.slug).join(', ')}` : ''),
);

/**
 * Записи, исчезнувшие с живого сайта, НЕ удаляем молча: у нас на них есть
 * собранные страницы, они проиндексированы, и решение «снято с программы или
 * просто перестало показываться» принимает заказчик, а не скрипт. Оставляем в
 * конце списка (order намеренно большой) и сообщаем в логе — вопрос уходит в
 * список к заказчику.
 */
function keepVanished<T extends { slug: string; order?: number }>(
  oldArr: T[],
  nextArr: T[],
  label: string,
): T[] {
  const live = new Set(nextArr.map((x) => x.slug));
  const vanished = oldArr.filter((x) => !live.has(x.slug));
  if (vanished.length) {
    console.log(
      `  ${label}: сохранено ${vanished.length} записей, которых больше нет на живом — ` +
        vanished.map((v) => v.slug).join(', '),
    );
  }
  return [...nextArr, ...vanished.map((v) => ({ ...v, order: 9000 }))];
}

console.log('\nисчезнувшее с живого:');
const seminarsOut = keepVanished(oldSeminars as never[], nextSeminars as never[], 'семинары');
const teachersOut = keepVanished(
  JSON.parse(readFileSync(join(ENTITIES, 'teachers.json'), 'utf-8')),
  nextTeachers as never[],
  'преподаватели',
);

const lostSeo = nextSeminars.filter((s) => !s.seo_title.trim() || !s.seo_description.trim());
console.log(`семинаров без seo-заголовка или описания: ${lostSeo.length}` +
  (lostSeo.length ? ` → ${lostSeo.slice(0, 5).map((s) => s.slug).join(', ')}` : ''));

if (dryRun) {
  console.log('\n--dry: файлы не изменены');
  process.exit(0);
}

function save(file: string, data: unknown): void {
  const target = join(ENTITIES, file);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, 'utf-8');
  renameSync(tmp, target);
  console.log(`  записан ${file}`);
}

console.log('\nсохраняю:');
save('seminars.json', seminarsOut);
save('course_groups.json', nextGroups);
save('teachers.json', teachersOut);
console.log(
  '\nданные записаны. Медиа новых картинок НЕ скачано этим шагом — используйте' +
    '\n  npm run data:refresh   (обновление + скачивание медиа + производные)' +
    '\nиначе сборка сошлётся на локальный файл, которого нет.',
);
