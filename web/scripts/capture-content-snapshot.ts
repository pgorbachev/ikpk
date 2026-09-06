/**
 * Снятие снимка контента. Живой путь читает CMS по REST, когда `CMS_URL`/`STRAPI_URL` задан;
 * без адреса — закреплённая фикстура. Неудача живого захвата при заданном адресе — ОТКАЗ, а
 * не тихий переход на фикстуру (openspec/changes/cms-live-snapshot-capture).
 *
 * Имя скрипта входит в признак производителя снимка в проверках pipeline.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSnapshotContract } from './lib/content-contract.ts';
import {
  FIELD_MAP,
  SOURCE_TYPES,
  checkFieldMapAgainstSchema,
  type CmsSchema,
  type FieldMapEntry,
} from './lib/content-field-map.ts';
import { contentFingerprint, snapshotId, type Snapshot, type SnapshotContent } from './lib/content-snapshot.ts';
import { contentIdOf, readFromStore } from './lib/content-media-store.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');
const outDir = process.env.CONTENT_SNAPSHOT_DIR || join(webRoot, '.snapshot');

const cmsUrl = process.env.CMS_URL ?? process.env.STRAPI_URL ?? '';
const cmsToken = process.env.CMS_TOKEN ?? process.env.STRAPI_API_TOKEN ?? '';

function copyPinned(): void {
  const pinned = join(repoRoot, 'fixtures', 'content-snapshot');
  const source = join(pinned, 'snapshot.json');
  if (!existsSync(source)) {
    throw new Error(`нет закреплённого снимка ${pinned}`);
  }

  // Контракт проверяется ДО записи, а не после. Прежний порядок — скопировать, потом проверить —
  // оставлял на диске снимок, не прошедший проверку: следующая сборка молча брала именно его,
  // потому что `prepare-snapshot.ts` контракт не запускает вовсе.
  const snap = JSON.parse(readFileSync(source, 'utf-8')) as Snapshot;
  assertSnapshotContract(snap);
  snap.origin = { kind: 'pinned' };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(snap, null, 2));
  const panels = join(pinned, 'collapsible_panels.json');
  if (existsSync(panels)) cpSync(panels, join(outDir, 'collapsible_panels.json'));
  const urlMap = join(pinned, 'url_map.csv');
  if (existsSync(urlMap)) cpSync(urlMap, join(outDir, 'url_map.csv'));
  console.log(`snapshot:capture → используется закреплённая фикстура в ${outDir}`);
}

// ───────────────────────────────────────────────────────────── живой путь

function resolveSource(record: Record<string, unknown>, path: string): unknown {
  let value: unknown = record;
  for (const segment of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ссылка на медиа без хоста CMS: то, что отдал REST в `url` (обычно относительный путь). */
function normalizeCmsMediaUrl(value: string): string {
  if (value.startsWith('/')) return value.split(/[?#]/, 1)[0]!;
  try {
    const parsed = new URL(value);
    if (parsed.pathname.startsWith('/uploads/') && parsed.origin === new URL(cmsUrl).origin) {
      return parsed.pathname;
    }
  } catch {
    // Обычный контракт снимка сообщит о некорректном значении позже.
  }
  return value;
}

function mediaRef(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.url !== 'string' || v.url === '') return undefined;
  return { url: normalizeCmsMediaUrl(v.url), id: v.documentId ?? v.id };
}

/** Поля, которые сайт читает именно как строковый адрес, а не как MediaRef. */
function mediaUrl(value: unknown): unknown {
  if (value === null) return null;
  const ref = mediaRef(value) as { url?: string } | undefined;
  return ref?.url;
}

function refList(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const r = item as Record<string, unknown>;
    // `order` входит в форму связи, а не только в саму запись: главная страница выбирает
    // преподавателя семинара по нему, и без него выбор становится произвольным.
    const ref: Record<string, unknown> = {
      legacy_id: r.legacy_id ?? r.id,
      name: r.name ?? r.fullName,
    };
    if (r.order !== undefined && r.order !== null) ref.order = r.order;
    return ref;
  });
}

/**
 * Массив URL медиа — форма, которую читает сайт (`inst.images?.[0]` в компонентах главной).
 * В CMS медиа одно и лежит в `image`; в снимке рядом живут оба поля: `image` — объект с
 * идентификатором содержимого, `images` — список адресов. Совмещать их нельзя: их читают
 * разные места.
 */
function mediaUrlList(value: unknown): unknown {
  const ref = mediaRef(value) as { url?: string } | undefined;
  return ref?.url ? [ref.url] : undefined;
}

const TRANSFORMS: Record<string, (value: unknown) => unknown> = {
  htmlToText: (value) => (typeof value === 'string' ? htmlToText(value) : value),
  mediaRef,
  mediaUrl,
  mediaUrlList,
  refList,
  // `legacy_url` в CMS нет: выводится из `legacy_id`, тем же способом, что и
  // `scripts/refresh-catalog.ts` (`legacy_url: `/${group}/${s.slug}``) — относительный путь,
  // без домена.
  legacyUrlFromId: (value) => (typeof value === 'string' && value !== '' ? `/${value}` : undefined),
};

function applyEntry(record: Record<string, unknown>, entry: FieldMapEntry, out: Record<string, unknown>): void {
  let value = resolveSource(record, entry.source);
  if (entry.transform) {
    const fn = TRANSFORMS[entry.transform];
    if (!fn) throw new Error(`неизвестное преобразование ${entry.transform} (${entry.type}.${entry.field})`);
    value = fn(value);
  }
  if (value !== undefined) out[entry.field] = value;
}

function mapRecord(type: string, record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Системные поля Strapi — не часть схемы (`attributes` их не перечисляет), поэтому вне
  // объявленного соответствия: передаются как есть, когда присутствуют.
  for (const sys of ['id', 'createdAt', 'updatedAt', 'publishedAt'] as const) {
    if (record[sys] !== undefined) out[sys] = record[sys];
  }
  // Специфический для teachers случай: в схеме `teacher` нет отношения `institute` (только
  // `seminars`), но данные (в т.ч. в тестовой заглушке) могут его нести. Раз источника в схеме
  // нет, соответствие им не управляет — прямой passthrough, вне FIELD_MAP.
  if (type === 'teachers' && record.institute && typeof record.institute === 'object') {
    const inst = record.institute as Record<string, unknown>;
    if (inst.legacy_id !== undefined) out.institute_legacy_id = inst.legacy_id;
  }
  for (const entry of FIELD_MAP) {
    if (entry.type === type) applyEntry(record, entry, out);
  }
  return out;
}

interface StrapiPage {
  data: Record<string, unknown>[];
  meta: { pagination: { page: number; pageCount: number } };
}

async function fetchAllPages(endpoint: string): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  let page = 1;
  for (;;) {
    const url = `${cmsUrl}/api/${endpoint}?pagination[page]=${page}&pagination[pageSize]=100&populate=*`;
    const res = await fetch(url, {
      headers: cmsToken ? { Authorization: `Bearer ${cmsToken}` } : {},
      // Недоступная CMS (закрытый порт, зависший сокет) обязана быть быстрым отказом, а не
      // подвисанием: спека требует ОТКАЗА при недоступности, а не таймаута процесса.
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`${endpoint}: HTTP ${res.status}`);
    }
    const body = (await res.json()) as StrapiPage;
    records.push(...body.data);
    if (page >= body.meta.pagination.pageCount) break;
    page += 1;
  }
  return records;
}

/** Finds actual root upload URLs in mapped records, including rich HTML fields. */
function uploadRefsIn(value: unknown): string[] {
  const found = new Set<string>();
  const pattern = /(?:^|["'=])((?:https?:\/\/[^/"'\s]+)?\/uploads\/[A-Za-z0-9._~!$&()*+,;=@%/-]+)/g;

  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      pattern.lastIndex = 0;
      for (const match of node.matchAll(pattern)) {
        const candidate = match[1]!;
        const normalized = normalizeCmsMediaUrl(candidate);
        if (normalized.startsWith('/uploads/')) found.add(normalized);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const item of Object.values(node as Record<string, unknown>)) walk(item);
    }
  };

  walk(value);
  return [...found];
}

async function captureMedia(types: Record<string, Record<string, unknown>[]>): Promise<SnapshotContent['media']> {
  const refs = uploadRefsIn(types);
  const storeDir = join(outDir, 'media');
  const media: SnapshotContent['media'] = [];

  for (const sourceRef of refs) {
    const url = new URL(sourceRef, cmsUrl).toString();
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new Error(`медиа ${sourceRef}: не удалось скачать (${(err as Error).message})`, { cause: err });
    }
    if (!response.ok) {
      throw new Error(`медиа ${sourceRef}: HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error(`медиа ${sourceRef}: CMS вернула пустой файл`);
    }
    const contentId = contentIdOf(bytes);
    mkdirSync(storeDir, { recursive: true });
    const stored = join(storeDir, contentId);
    if (existsSync(stored)) {
      const existing = readFromStore({ storeDir, contentId });
      if (!existing.ok) {
        throw new Error(`медиа ${sourceRef}: хранилище повреждено (${existing.reason})`);
      }
    } else {
      writeFileSync(stored, bytes);
    }

    // The snapshot keeps the source records in CMS form. The separate media index is already
    // in the static-site address space, so build steps can use it without another rewrite.
    media.push({ ref: `/media${sourceRef}`, contentId });
  }
  return media;
}

async function liveCapture(): Promise<void> {
  const rawByType: Record<string, Record<string, unknown>[]> = {};
  for (const st of SOURCE_TYPES) {
    try {
      rawByType[st.type] = await fetchAllPages(st.endpoint);
    } catch (err) {
      // Отказ вместо подмены фикстурой: неудача одного типа — неудача всего захвата, а не
      // снимок без одного типа.
      throw new Error(
        `живой захват сорвался на ${st.endpoint} (${cmsUrl}): ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  // Соответствие проверяется ПРОТИВ СХЕМ, а не против полученных записей: запись, где поле
  // просто пустое, неотличима от записи, у которой источник исчез из схемы. Исчезнувший
  // источник — отказ; поле схемы, не участвующее в соответствии, — не отказ, но и не тишина.
  const schemas: Record<string, CmsSchema> = {};
  for (const st of SOURCE_TYPES) {
    schemas[st.type] = JSON.parse(readFileSync(join(repoRoot, st.schema), 'utf-8')) as CmsSchema;
  }
  const components: Record<string, CmsSchema> = {};
  const componentsDir = join(repoRoot, 'cms', 'src', 'components');
  if (existsSync(componentsDir)) {
    for (const group of readdirSync(componentsDir)) {
      const groupDir = join(componentsDir, group);
      if (!statSync(groupDir).isDirectory()) continue;
      for (const file of readdirSync(groupDir)) {
        if (!file.endsWith('.json')) continue;
        const name = `${group}.${file.replace(/\.json$/, '')}`;
        components[name] = JSON.parse(readFileSync(join(groupDir, file), 'utf-8')) as CmsSchema;
      }
    }
  }

  const mapCheck = checkFieldMapAgainstSchema({ map: FIELD_MAP, schemas, components });
  if (!mapCheck.ok) {
    const first = mapCheck.missingSources[0]!;
    throw new Error(
      `источник исчез из схемы: поле снимка ${first.type}.${first.field} ждёт ${first.source}`,
    );
  }

  const types: Record<string, Record<string, unknown>[]> = {};
  for (const st of SOURCE_TYPES) {
    types[st.type] = rawByType[st.type]!.map((record) => mapRecord(st.type, record));
  }

  // Связи расписания достраиваются ПОСЛЕ отображения всех типов: они требуют перекрёстного
  // поиска, которого построчное отображение не умеет по построению.
  //
  // Два разных пробела, и оба ломали сборку:
  //  * `seminar` протаскивался из CMS сырым — со всем HTML описания, тогда как снимок ждёт
  //    `{id, name, slug}`. Снимок раздувался, а форма не совпадала;
  //  * `institute` у записи расписания в CMS ОТСУТСТВУЕТ как поле. Сайт его читает
  //    (`raspisanie-i-tseny.astro:67`, `entry.institute.name`), поэтому его надо выводить по
  //    цепочке семинар → программа → институт, а не объявлять отсутствующим.
  {
    const seminarBySlug = new Map(
      (types.seminars ?? []).map((r) => [String(r.slug ?? ''), r] as const),
    );
    const groupByLegacyId = new Map(
      (types.course_groups ?? []).map((r) => [String(r.legacy_id ?? ''), r] as const),
    );
    const instituteByLegacyId = new Map(
      (types.institutes ?? []).map((r) => [String(r.legacy_id ?? ''), r] as const),
    );

    for (const entry of types.schedule_entries ?? []) {
      const rawSeminar = entry.seminar as Record<string, unknown> | undefined;
      if (!rawSeminar) continue;
      const slug = String(rawSeminar.slug ?? '');
      entry.seminar = { id: rawSeminar.id, name: rawSeminar.name, slug };

      const seminar = seminarBySlug.get(slug);
      const group = seminar ? groupByLegacyId.get(String(seminar.course_group_legacy_id ?? '')) : undefined;
      const institute = group ? instituteByLegacyId.get(String(group.institute_legacy_id ?? '')) : undefined;
      if (group) {
        // `program` сайт читает наравне с `institute`
        // (`raspisanie-i-tseny.astro`, `entry.program.name`), и в CMS его тоже нет полем.
        entry.program = { id: group.id, slug: group.slug, name: group.name };
      }
      if (institute) {
        entry.institute = {
          id: institute.id,
          name: institute.name,
          shortname: institute.shortname ?? institute.name,
        };
      }
    }
  }

  const media = await captureMedia(types);
  const content: SnapshotContent = { types, media };
  const fingerprint = contentFingerprint(content);
  const referenceDate = new Date().toISOString().slice(0, 10);
  const snap: Snapshot = {
    content,
    referenceDate,
    fingerprint,
    snapshotId: snapshotId({ fingerprint, referenceDate }),
    origin: { kind: 'live', url: cmsUrl, capturedAt: new Date().toISOString() },
  };

  // Тот же контракт, что и у фикстуры (design.md, решение 2): второго, более слабого контракта
  // для живого пути нет. Снимок не должен появиться на диске, пока не прошёл эту проверку.
  assertSnapshotContract(snap);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(snap, null, 2));

  // Задача 3.5: `url_map.csv` и `collapsible_panels.json` — артефакты легаси-скрейпа (карта
  // редиректов старых адресов и восстановленные раскрывающиеся панели), у CMS источника для них
  // нет. Решение: живой путь ПЕРЕНОСИТ их из закреплённой фикстуры.
  //
  // Первая редакция их сознательно не писала — и это ломало сборку: `data.ts` читает
  // `collapsible_panels.json` безусловно, поэтому сайт из живого снимка не собирался вовсе
  // (`ENOENT` на рендере `/oplata`). «Нет источника» не означает «можно не отдавать»: пока файл
  // остаётся частью артефакта снимка, живой путь обязан его дать.
  const pinnedDir = join(repoRoot, 'fixtures', 'content-snapshot');
  for (const name of ['collapsible_panels.json', 'url_map.csv']) {
    const from = join(pinnedDir, name);
    if (existsSync(from)) cpSync(from, join(outDir, name));
  }

  console.log(`snapshot:capture → живой снимок с ${cmsUrl} в ${outDir}`);
  for (const st of SOURCE_TYPES) {
    console.log(`  ${st.type}: ${types[st.type]!.length} записей`);
  }
  // Незаявленное поле — это либо забытое соответствие, либо лишнее поле в схеме. Молчать о нём
  // нельзя: обе причины стоит увидеть, но ни одна не повод остановить захват.
  for (const item of mapCheck.unmapped) {
    console.log(`  поле схемы вне соответствия: ${item.type}.${item.field}`);
  }
}

if (cmsUrl) {
  await liveCapture();
} else {
  copyPinned();
}
