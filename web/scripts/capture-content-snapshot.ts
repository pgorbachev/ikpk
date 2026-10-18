/**
 * Снятие снимка контента. Живой путь читает CMS по REST, когда `CMS_URL`/`STRAPI_URL` задан;
 * без адреса — закреплённая фикстура. Неудача живого захвата при заданном адресе — ОТКАЗ, а
 * не тихий переход на фикстуру (openspec/changes/cms-live-snapshot-capture).
 *
 * Имя скрипта входит в признак производителя снимка в проверках pipeline.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCaptureSnapshotContract } from './lib/capture-snapshot-contract.ts';
import {
  FIELD_MAP,
  SOURCE_TYPES,
  UNMAPPED_SCHEMA_FIELDS,
  UNMAPPED_SEO_FIELDS,
  checkFieldMapAgainstSchema,
  filledUnshownContentFields,
  hasValue,
  missingSourceFields,
  unknownRecordFields,
  type CmsSchema,
  type FieldMapEntry,
} from './lib/content-field-map.ts';
import { contentFingerprint, snapshotId, type DemoCaptureProof, type Snapshot, type SnapshotContent } from './lib/content-snapshot.ts';
import { contentIdOf, readFromStore } from './lib/content-media-store.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');
const outDir = process.env.CONTENT_SNAPSHOT_DIR || join(webRoot, '.snapshot');

const cmsUrl = process.env.CMS_URL ?? process.env.STRAPI_URL ?? '';

interface SealedCaptureMedia {
  url: string;
  file: string;
  sha256: string;
  verifiedStoredSha256?: string;
}

interface Staging193Capture {
  directory: string;
  media: SealedCaptureMedia[];
  readback: { collections: Record<string, unknown[]>; schemaDigest: string };
  manifest: { capturedAt: string };
  proof: DemoCaptureProof;
}

// An explicit sealed server input supersedes any earlier capture attempt. Invalidate the
// prior snapshot before bundle verification, which can fail before liveCapture starts.
if (process.argv[2] === '--server-capture') {
  rmSync(join(outDir, 'snapshot.json'), { force: true });
}

async function serverInput(): Promise<Staging193Capture | undefined> {
  const args = process.argv.slice(2);
  if (args.length === 0) return undefined;
  if (args[0] !== '--server-capture' || args.length !== 2 || cmsUrl) {
    throw new Error('staging193 server capture requires --server-capture BUNDLE and no CMS_URL');
  }
  const { verifyStaging193Bundle } = await import('../../scripts/lib/staging193-capture-bundle.mjs');
  return verifyStaging193Bundle(args[1]!, join(repoRoot, 'cms', 'src')) as Staging193Capture;
}
const serverCapture = await serverInput();

/**
 * Предел ожидания ОДНОГО обращения к CMS.
 *
 * Было 15 секунд — «недоступная CMS обязана быть быстрым отказом, а не подвисанием». Замысел
 * верен, но число смешивало два разных состояния: «порт закрыт» и «жива, но медленная». Первое
 * отказывает мгновенно само (ECONNREFUSED), таймаут для этого не нужен вовсе; второе на нашей
 * машине в 15 секунд не укладывается.
 *
 * Измерено на стенде 23.09.2026 через туннель (948 МБ памяти, узкий канал), ответы прогретой
 * CMS: teachers 18,3 с, articles 16,2 с, pages 5,4 с, course-groups 4,5 с (холодным — 15,4 с),
 * остальные типы меньше пяти. То есть два типа из десяти не проходили порог ДАЖЕ прогретыми, и
 * съём срывался не по вине CMS, а по вине числа.
 *
 * Новое значение выбрано с запасом к худшему замеру, а не подогнано под него: машина медленнее
 * под нагрузкой, и повторять эту правку при каждом росте контента не хочется.
 */
const CMS_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Предел на ВЕСЬ съём — отдельно от предела на один запрос, и по другой причине.
 *
 * Предыдущий предел в 15 секунд служил сразу двум целям: ограничивал один запрос и заодно
 * держал общее время маленьким. Подняв его до 120 с, вторую цель пришлось назвать отдельно:
 * последний живой снимок тянул 132 медиафайла плюс постраничные выборки по десяти типам, и
 * при деградирующей CMS это сотни запросов по две минуты каждый.
 *
 * Чем это кончается без своего предела — известно точно. Пусковой скрипт даёт работнику час
 * (`scripts/publication-launcher.mjs`, `timeout: 3_600_000`), и убитый по этому сроку процесс
 * даёт `result.status === null`, то есть `refuse('publication-worker-failed')` — ТОТ ЖЕ код
 * отказа, что и упавший работник. Оператор не отличает «съём не уложился» от «работник
 * сломался», а это ровно запрещённое правилами «не смогла проверить», выданное за вердикт.
 *
 * Поэтому съём отказывается сам и по имени, не дожидаясь анонимного убийства по сроку.
 * Двадцать минут — с большим запасом к замеру (весь прогретый обход десяти типов занял 55 с)
 * и с запасом же внутри часа, который делится с остальными шагами публикации.
 */
/*
 * Переопределяется окружением ровно ради проверяемости: сценарий «срок вышел» иначе требовал
 * бы двадцатиминутного теста, то есть не проверялся бы никогда. Оператору этот ключ не нужен
 * и нигде не объявлен — значение по умолчанию и есть рабочее.
 */
const CAPTURE_TOTAL_BUDGET_MS = Number(process.env.CAPTURE_TOTAL_BUDGET_MS ?? 1_200_000);

const captureStartedAt = Date.now();

/** Отказ по общему сроку: по имени и с числами, а не молчаливым убийством процесса. */
function assertWithinBudget(what: string): void {
  const spent = Date.now() - captureStartedAt;
  if (spent <= CAPTURE_TOTAL_BUDGET_MS) return;
  throw new Error(
    `живой захват не уложился в общий срок: ${Math.round(spent / 1000)} с ` +
      `при пределе ${Math.round(CAPTURE_TOTAL_BUDGET_MS / 1000)} с (остановлено на ${what}). ` +
      `CMS отвечает, но слишком медленно — это отказ съёма, а не поломка работника публикации.`,
  );
}
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
  assertCaptureSnapshotContract(snap);
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
 * Сайт показывает одно медиа из `image` (см. `singleMedia`); в снимке рядом живут оба поля: `image` — объект с
 * идентификатором содержимого, `images` — список адресов. Совмещать их нельзя: их читают
 * разные места.
 */
function mediaUrlList(value: unknown): unknown {
  const ref = mediaRef(value) as { url?: string } | undefined;
  return ref?.url ? [ref.url] : undefined;
}

/**
 * Преподаватели проведения. Прежнее JSON-поле давало `{id, fullName}` — эту форму ищет страница
 * семинара; установленная CMS отдаёт связь с записью преподавателя, и она сводится к той же
 * форме. Связь без `legacy_id` или имени — отказ: страница построила бы ссылку в никуда.
 */
function entryTeachers(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    const t = item as Record<string, unknown> | null;
    if (t && typeof t === 'object' && 'fullName' in t) return t;
    const id = t?.legacy_id;
    if (t && typeof t.name === 'string' && (typeof id === 'string' || typeof id === 'number') && id !== '') {
      return { id, fullName: t.name };
    }
    throw new Error(
      `schedule_entries.teachers: у преподавателя в связи нет legacy_id или имени — заполнить их у ` +
        `преподавателя в CMS (${JSON.stringify(t)?.slice(0, 120)})`,
    );
  });
}

const MEDIA_TRANSFORMS = new Set(['mediaRef', 'mediaUrl', 'mediaUrlList']);

/**
 * Установленная CMS отдаёт медиа списком (`multiple: true`), прежняя схема — объектом. Сайт
 * показывает одно изображение: список из одного элемента разворачивается, из нескольких — отказ,
 * потому что молча выбрать одно значило бы потерять остальные. Любая другая форма — тоже отказ:
 * так 13.10.2026 пропали все фото, а съём остался зелёным.
 */
function singleMedia(value: unknown, where: string): unknown {
  if (Array.isArray(value) && value.length > 1) {
    throw new Error(`${where}: ${value.length} файла в поле, сайт показывает одно`);
  }
  const item = Array.isArray(value) ? (value[0] ?? null) : value;
  if (item === null || item === undefined) return item;
  const url = item && typeof item === 'object' ? (item as Record<string, unknown>).url : undefined;
  if (typeof url !== 'string' || url === '') {
    throw new Error(`${where}: неподдерживаемая форма медиа ${JSON.stringify(item)?.slice(0, 120)}`);
  }
  return item;
}

const TRANSFORMS: Record<string, (value: unknown) => unknown> = {
  htmlToText: (value) => (typeof value === 'string' ? htmlToText(value) : value),
  mediaRef,
  mediaUrl,
  mediaUrlList,
  refList,
  entryTeachers,
  // `legacy_url` в CMS нет: выводится из `legacy_id`, тем же способом, что и
  // `scripts/refresh-catalog.ts` (`legacy_url: `/${group}/${s.slug}``) — относительный путь,
  // без домена.
  legacyUrlFromId: (value) => (typeof value === 'string' && value !== '' ? `/${value}` : undefined),
};

/** Запись в сообщениях об отказе: по ней редактор находит, что исправить. */
function recordKey(record: Record<string, unknown>): string {
  return String(record.legacy_id || record.slug || record.documentId || record.id || '?');
}

function applyEntry(record: Record<string, unknown>, entry: FieldMapEntry, out: Record<string, unknown>): void {
  let value = resolveSource(record, entry.source);
  if (entry.transform) {
    const fn = TRANSFORMS[entry.transform];
    if (!fn) throw new Error(`неизвестное преобразование ${entry.transform} (${entry.type}.${entry.field})`);
    try {
      if (MEDIA_TRANSFORMS.has(entry.transform)) value = singleMedia(value, `${entry.type}.${entry.source}`);
      value = fn(value);
    } catch (err) {
      throw new Error(`${(err as Error).message} (запись ${recordKey(record)})`, { cause: err });
    }
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
  if (serverCapture) {
    const collections = serverCapture.readback.collections as Record<string, Record<string, unknown>[]>;
    const records = collections[endpoint];
    if (!Array.isArray(records)) throw new Error(`server SQLite capture omitted ${endpoint}`);
    return records;
  }
  const records: Record<string, unknown>[] = [];
  let page = 1;
  for (;;) {
    assertWithinBudget(`${endpoint}, страница ${page}`);
    const url = `${cmsUrl}/api/${endpoint}?status=published&pagination[page]=${page}&pagination[pageSize]=100&populate=*`;
    const res = await fetch(url, {
      headers: cmsToken ? { Authorization: `Bearer ${cmsToken}` } : {},
      // Недоступная CMS (закрытый порт, зависший сокет) обязана быть быстрым отказом, а не
      // подвисанием: спека требует ОТКАЗА при недоступности, а не таймаута процесса. Закрытый
      // порт отказывает сразу и без таймаута; предел нужен только против зависшего сокета.
      signal: AbortSignal.timeout(CMS_REQUEST_TIMEOUT_MS),
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
function uploadRefsIn(value: unknown, includeStatic = false): string[] {
  const found = new Set<string>();
  // A quoted value is the boundary for both relative and absolute URLs. Including `=` here
  // would also match the query value in `https://third.example/?next=/uploads/x` and make an
  // unrelated external URL look like a CMS asset.
  const pattern = /(?:^|["'])((?:https?:\/\/[^/"'\s]+)?\/(?:uploads|media)\/[A-Za-z0-9._~!$&()*+,;=@%/-]+)/g;

  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      pattern.lastIndex = 0;
      for (const match of node.matchAll(pattern)) {
        const candidate = match[1]!;
        const normalized = normalizeCmsMediaUrl(candidate);
        if (normalized.startsWith('/uploads/') || (includeStatic && normalized.startsWith('/media/'))) found.add(normalized);
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
  const refs = uploadRefsIn(types, Boolean(serverCapture));
  const storeDir = join(outDir, 'media');
  const media: SnapshotContent['media'] = [];
  const captureMedia = serverCapture?.media ?? [];
  const mediaByUrl = new Map(captureMedia.map((item) => [item.url, item]));

  for (const sourceRef of refs) {
    assertWithinBudget(`медиа ${sourceRef}`);
    let bytes: Uint8Array;
    if (serverCapture) {
      const saved = mediaByUrl.get(sourceRef);
      const digest = saved?.sha256 ?? saved?.verifiedStoredSha256;
      if (!saved || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`sealed capture has no verified media row for ${sourceRef}`);
      const path = join(serverCapture.directory, saved.file);
      bytes = new Uint8Array(readFileSync(path));
      if (createHash('sha256').update(bytes).digest('hex') !== digest) {
        throw new Error(`sealed media bytes do not match the capture witness for ${sourceRef}`);
      }
    } else {
      const url = new URL(sourceRef, cmsUrl).toString();
      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(CMS_REQUEST_TIMEOUT_MS) });
      } catch (err) {
        throw new Error(`медиа ${sourceRef}: не удалось скачать (${(err as Error).message})`, { cause: err });
      }
      if (!response.ok) {
        throw new Error(`медиа ${sourceRef}: HTTP ${response.status}`);
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (bytes.length === 0) {
      throw new Error(`медиа ${sourceRef}: CMS вернула пустой файл`);
    }
    const contentId = contentIdOf(bytes);
    mkdirSync(storeDir, { recursive: true });
    const stored = join(storeDir, contentId);
    // Имя файла И ЕСТЬ хеш его содержимого, поэтому расхождение лечится записью, а не отказом:
    // байты у нас на руках и они заведомо верные. Прежняя ветвь отказывала — и прерывание
    // посреди записи заклинивало хранилище навсегда: обрезанный файл под именем-хешем давал
    // `content-id-mismatch`, никто его не перезаписывал, и каждый следующий съём падал, пока
    // человек не сотрёт руками файл, названный sha256.
    //
    // Запись через временное имя с переименованием: обрыв не оставляет усечённого файла под
    // финальным именем. Тот же приём, что в `make-derivatives.ts` (`writeAtomic`).
    const intact = existsSync(stored) && readFromStore({ storeDir, contentId }).ok;
    if (!intact) {
      const tmp = `${stored}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, stored);
    }

    // The snapshot keeps the source records in CMS form. The separate media index is already
    // in the static-site address space, so build steps can use it without another rewrite.
    const ref = serverCapture && sourceRef.startsWith('/media/') ? sourceRef : `/media${sourceRef}`;
    if (!media.some((item) => item.ref === ref)) media.push({ ref, contentId });
  }
  return media;
}

async function liveCapture(): Promise<void> {
  // Прежний снимок убирается ДО первого запроса, а не переписывается в конце. Каталог съёма
  // переиспользуют, и при отказе на середине — скажем, на 60-м файле из 131 — старый
  // `snapshot.json` оставался лежать рядом с наполовину заполненным хранилищем. Отказ съёма
  // при этом честно возвращал ненулевой код, а следующая сборка молча брала прежний снимок:
  // «недокачанный файл — отказ, а не тихий пропуск» было верно про код возврата и неверно про
  // последствие.
  rmSync(join(outDir, 'snapshot.json'), { force: true });

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
  // Первая сверка — против схем в checkout: исчезнувший из схемы источник — отказ. Схема в
  // checkout может отставать от установленной CMS, поэтому ниже та же карта сверяется ещё и с
  // ответом CMS по каждой записи.
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

  // Ответ CMS сверяется с картой по каждой записи: схема в checkout может расходиться с
  // установленной CMS, и расходятся именно они. Три отказа — поле без решения, исчезнувший
  // ключ-источник (null и [] — не отказ) и заполненное поле содержимого, которое сайт не показывает.
  const unknown = new Set<string>();
  const missing: string[] = [];
  const unshown: string[] = [];
  const filledUnmapped = new Map<string, number>();
  for (const st of SOURCE_TYPES) {
    for (const record of rawByType[st.type]!) {
      for (const name of unknownRecordFields(st.type, record)) unknown.add(name);
      for (const name of missingSourceFields(st.type, record)) missing.push(`${name} (запись ${recordKey(record)})`);
      for (const name of filledUnshownContentFields(st.type, record)) unshown.push(`${name} (запись ${recordKey(record)})`);
      const seo = (record.seo ?? {}) as Record<string, unknown>;
      const filled = [
        ...Object.keys(UNMAPPED_SCHEMA_FIELDS[st.type] ?? {}).filter((f) => hasValue(record[f])).map((f) => `${st.type}.${f}`),
        ...Object.keys(UNMAPPED_SEO_FIELDS).filter((f) => hasValue(seo[f])).map((f) => `${st.type}.seo.${f}`),
      ];
      for (const name of filled) filledUnmapped.set(name, (filledUnmapped.get(name) ?? 0) + 1);
    }
  }
  // Все три класса — одним отказом: оператор исправляет их за один прогон, а не по очереди.
  const first = (list: string[]): string => `${list.slice(0, 10).join(', ')}${list.length > 10 ? ` … всего ${list.length}` : ''}`;
  const refusals = [
    unknown.size > 0 &&
      `поля CMS без решения: ${first([...unknown].sort())} — добавить в FIELD_MAP или в ` +
        'UNMAPPED_SCHEMA_FIELDS (web/scripts/lib/content-field-map.ts)',
    missing.length > 0 &&
      `источник исчез из ответа CMS: ${first(missing)} — поле удалено или переименовано в CMS; ` +
        'обновить FIELD_MAP',
    unshown.length > 0 &&
      `заполнены поля, которые сайт ещё не показывает: ${first(unshown)} — правка не дойдёт до сайта; ` +
        'нужен вывод на сайте или очистка поля в CMS',
  ].filter(Boolean);
  if (refusals.length > 0) throw new Error(`${refusals.join('; ')}; снимок не записан`);

  const types: Record<string, Record<string, unknown>[]> = {};
  for (const st of SOURCE_TYPES) {
    types[st.type] = rawByType[st.type]!.map((record) => mapRecord(st.type, record));
  }

  const unclassifiedPeople = (types.teachers ?? [])
    .filter((person) => person.trait !== 'teacher' && person.trait !== 'method-author')
    .map((person) => String(person.legacy_id ?? '(без legacy_id)'));
  if (unclassifiedPeople.length > 0) {
    throw new Error(
      `живой захват: trait не задан у персон (${unclassifiedPeople.join(', ')}) — снимок не записан`,
    );
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
    const instituteBySlug = new Map(
      (types.institutes ?? []).map((r) => [String(r.slug ?? ''), r] as const),
    );

    for (const entry of types.schedule_entries ?? []) {
      const rawSeminar = entry.seminar as Record<string, unknown> | undefined;
      if (!rawSeminar) continue;
      const slug = String(rawSeminar.slug ?? '');
      entry.seminar = { id: rawSeminar.id, name: rawSeminar.name, slug };

      const seminar = seminarBySlug.get(slug);
      const group = seminar ? groupByLegacyId.get(String(seminar.course_group_legacy_id ?? '')) : undefined;
      const institute = group ? instituteBySlug.get(String(group.institute_legacy_id ?? '')) : undefined;
      // An empty institute collection is rejected by the existing required-type
      // check below. Keep that more useful diagnostic for skeletal captures;
      // when institutes are present, however, an unresolved relation is a
      // broken join and must not silently produce a partial schedule entry.
      if (group && instituteBySlug.size > 0 && !institute) {
        throw new Error(
          `живой захват: проведение ${String(entry.legacy_id ?? entry.id ?? '(без id)')} ` +
            `не разрешает институт по slug ${String(group.institute_legacy_id ?? '(пусто)')}`,
        );
      }
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
  const snapshotBase = {
    content,
    referenceDate,
    fingerprint,
    snapshotId: snapshotId({ fingerprint, referenceDate }),
  };
  const snap: Snapshot = serverCapture
    ? { ...snapshotBase, origin: { kind: 'server-db', sourceId: 'demo193-cms', capturedAt: serverCapture.manifest.capturedAt },
        sourcePolicy: 'demo-publication-only', sourceAge: 'untracked', captureProof: serverCapture.proof as DemoCaptureProof }
    : { ...snapshotBase, origin: { kind: 'live', url: cmsUrl, capturedAt: new Date().toISOString() } };

  // ПУСТОЙ съём — это «не смог измерить», а не «нарушений нет». Контракт на пустоте проходит
  // по определению: он перебирает записи, а перебирать нечего. Замерено 06.09.2026 — снятие
  // пришлось на перезапуск CMS после смены артефакта, снимок вышел с нулём записей, контракт
  // его пропустил, и сайт собрался бы БЕЗ содержимого.
  //
  // Порога «хоть один тип населён» мало: одного населённого `institutes` хватало, чтобы пустые
  // статьи и семинары прошли предупреждением. Предмет отказа — КАРКАС САЙТА, и состав его
  // задан принятой спекой (`openspec/specs/cms-content-source/spec.md`, требование
  // «Недоступный или неполный контент останавливает сборку»): институты, программы, семинары,
  // статьи, преподаватели — «пустота там означает сбой получения, а не решение редактора».
  //
  // Выводить состав из списков контракта нельзя, хотя соблазн есть: те списки написаны под
  // другое правило (обязательные поля и связи), и расходятся с каркасом в обе стороны — в них
  // нет `institutes` и есть `schedule_entries`. Пустое расписание в межсезонье законно, и
  // отказ на нём останавливал бы выкладку без причины.
  const SKELETON_TYPES = ['institutes', 'course_groups', 'seminars', 'articles', 'teachers'];

  const emptyTypes = Object.entries(types)
    .filter(([, rows]) => rows.length === 0)
    .map(([name]) => name);
  const emptySkeleton = emptyTypes.filter((name) => SKELETON_TYPES.includes(name));
  if (emptySkeleton.length > 0) {
    throw new Error(
      `живой съём с ${cmsUrl}: каркасные типы пусты (${emptySkeleton.join(', ')}) — ` +
        'контракт на нуле записей проходит по определению, поэтому это отказ, а не ' +
        'предупреждение; снимок не записан',
    );
  }
  if (emptyTypes.length > 0) {
    console.warn(`snapshot:capture: пустые типы (${emptyTypes.length}): ${emptyTypes.join(', ')}`);
  }

  // Тот же контракт, что и у фикстуры (design.md, решение 2): второго, более слабого контракта
  // для живого пути нет. Снимок не должен появиться на диске, пока не прошёл эту проверку.
  assertCaptureSnapshotContract(snap);

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
    if (!existsSync(from)) {
      throw new Error(
        `snapshot:capture: нет ${from}. Живой снимок без этого файла не собирается: страница оплаты читает панели безусловно.`,
      );
    }
    cpSync(from, join(outDir, name));
  }

  console.log(`snapshot:capture → живой снимок с ${cmsUrl} в ${outDir}`);
  for (const st of SOURCE_TYPES) {
    console.log(`  ${st.type}: ${types[st.type]!.length} записей`);
  }
  // Непереносимые поля называются вместе с причиной и числом записей, где у них есть данные:
  // решение не переносить видно в каждом съёме, а не только в коде.
  for (const [type, fields] of Object.entries(UNMAPPED_SCHEMA_FIELDS)) {
    for (const [field, reason] of Object.entries(fields)) {
      console.log(`  поле схемы вне соответствия: ${type}.${field} — с данными в ${filledUnmapped.get(`${type}.${field}`) ?? 0} записях (${reason})`);
    }
  }
  for (const [name, count] of [...filledUnmapped].filter(([n]) => n.includes('.seo.'))) {
    console.log(`  поле схемы вне соответствия: ${name} — с данными в ${count} записях (${UNMAPPED_SEO_FIELDS[name.split('.')[2]!]})`);
  }
}

if (cmsUrl || serverCapture) {
  await liveCapture();
} else {
  copyPinned();
}
