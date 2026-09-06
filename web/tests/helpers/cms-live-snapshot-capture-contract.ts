// Контракт того, чего ЕЩЁ НЕТ: change `cms-live-snapshot-capture`.
//
// Тесты по спеке пишутся раньше реализации (AGENTS.md, «Тесты по спеке пишутся в отдельной
// сессии и раньше кода»). Здесь объявлены: пути будущих модулей, форма объявленного
// соответствия полей, имя отметки происхождения и оснастка — HTTP-заглушка системы
// управления и запуск шага снятия снимка отдельным процессом.
//
// Почему заглушка, а не живой `cms` на sqlite (tasks.md 1.1 требует выбрать и назвать):
//  - живая система управления уже занимает порт 1337 в этой машине, поднимать вторую
//    нельзя; заглушка берёт порт 0 и получает свободный от системы;
//  - предмет проверки — поведение ШАГА СНЯТИЯ снимка (постраничный обход, отказ вместо
//    подмены, отметка происхождения), а не поведение Strapi. Заглушка позволяет задать
//    недоступность, ответ 500 и нарушение контракта прямо, без наполнения базы;
//  - проверка на настоящих данных остаётся отдельной задачей (tasks.md 4.1–4.3) и заглушкой
//    не подменяется.
//
// Имена модулей и полей — единственное место, где они названы. Реализация вправе выбрать
// другое расположение и другое имя поля, но тогда обязана поправить константы ЗДЕСЬ,
// а не завести второй набор имён.

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, WEB_ROOT, loadModule } from './cms-content-publication-contract';

export { REPO_ROOT, WEB_ROOT, loadModule };

/** Пути будущих и существующих модулей этого change. */
export const LIVE_MODULES = {
  /** Объявленное соответствие «поле снимка ← источник» и проверки по нему. */
  fieldMap: '../../scripts/lib/content-field-map.ts',
  /** Контракт снимка: сюда добавляется перечислимый список обязательных полей. */
  contract: '../../scripts/lib/content-contract.ts',
} as const;

/** Шаг снятия снимка — предмет доработки. */
export const CAPTURE_SCRIPT = join(WEB_ROOT, 'scripts', 'capture-content-snapshot.ts');
export const TSX = join(WEB_ROOT, 'node_modules', '.bin', 'tsx');
export const PINNED_DIR = join(REPO_ROOT, 'fixtures', 'content-snapshot');

/**
 * Имя поля снимка, несущего происхождение. Отдельно от `provenance`: то поле уже занято
 * числами журнала (`observedEntry`, `revision`, `highWaterMark`) и читается гейтом публикации
 * (`web/scripts/publication-cli.ts:107`, `observedEntry: snap.provenance?.observedEntry`).
 * Совмещение двух смыслов в одном поле сломало бы гейт молча — см. отчёт о дефектах спеки.
 */
export const SNAPSHOT_ORIGIN_FIELD = 'origin';

export interface SnapshotOrigin {
  /** Живой захват или закреплённая фикстура. */
  kind: 'live' | 'pinned';
  /** Адрес системы управления — только для живого. */
  url?: string;
  /** Время снятия, ISO — только для живого. */
  capturedAt?: string;
}

// ------------------------------------------------------- соответствие полей

export interface FieldMapEntry {
  /** Тип снимка: `articles`, `seminars`, `course_groups`, … */
  type: string;
  /** Поле записи снимка: `body_html`, `seo_title`, `image`. */
  field: string;
  /**
   * Путь к источнику в записи системы управления: `body`, `seo.seo_title`, `image.url`.
   * Без объявленного источника преобразования не бывает (design.md, решение 1).
   */
  source: string;
  transform?: string;
}

/** Пара «тип снимка ↔ источник»: адрес REST и файл схемы. */
export interface SourceType {
  /** Имя типа в снимке: `course_groups`. */
  type: string;
  /** Множественное имя в REST: `course-groups` — адрес `/api/course-groups`. */
  endpoint: string;
  /** Путь к схеме от корня репозитория. */
  schema: string;
}

/** Схема типа или компонента системы управления, как она лежит на диске. */
export interface CmsSchema {
  attributes: Record<string, { type: string; component?: string }>;
}

/** Группа обязательных полей контракта: достаточно любого имени из группы. */
export interface RequiredFieldGroup {
  type: string;
  anyOf: readonly string[];
}

export interface FieldMapModule {
  FIELD_MAP: readonly FieldMapEntry[];
  SOURCE_TYPES: readonly SourceType[];
  /**
   * Полнота относительно КОНТРАКТА снимка, а не относительно фикстуры: фикстура сама может
   * быть неполной (design.md, Risks). Соответствие, не покрывшее ни одного поля, — не успех,
   * а непройденная проверка.
   */
  checkFieldMapCompleteness(input: {
    map: readonly FieldMapEntry[];
    required: readonly RequiredFieldGroup[];
  }): { ok: boolean; missing: { type: string; field: string }[]; vacuous: boolean };
  /**
   * Сверка со схемой источника: исчезнувший источник — отказ с названием ОБОИХ имён;
   * поле схемы, не названное ни в одном соответствии, — не отказ, но и не тишина.
   */
  checkFieldMapAgainstSchema(input: {
    map: readonly FieldMapEntry[];
    schemas: Record<string, CmsSchema>;
    components: Record<string, CmsSchema>;
  }): {
    ok: boolean;
    missingSources: { type: string; field: string; source: string }[];
    unmapped: { type: string; field: string }[];
  };
}

/** Контракт снимка после доработки: список обязательных полей становится перечислимым. */
export interface ContractWithRequiredFields {
  REQUIRED_SNAPSHOT_FIELDS: readonly RequiredFieldGroup[];
  validateSnapshotContract(snapshot: { content: { types: Record<string, Record<string, unknown>[]>; media: unknown[] }; referenceDate: string }): {
    ok: boolean;
    violations: { type: string; recordId: string; field?: string; rule: string }[];
  };
}

export const fieldMapModule = (): Promise<FieldMapModule> =>
  loadModule<FieldMapModule>(LIVE_MODULES.fieldMap);
export const contractModule = (): Promise<ContractWithRequiredFields> =>
  loadModule<ContractWithRequiredFields>(LIVE_MODULES.contract);

export function readSchema(relativePath: string): CmsSchema {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf-8')) as CmsSchema;
}

// --------------------------------------------------- заглушка системы управления

/**
 * Предел `pageSize` у заглушки. У Strapi предел выдачи настраиваемый и по умолчанию не
 * бесконечный; здесь он задан явно, чтобы «попросить всё одной страницей» было НЕВОЗМОЖНО и
 * постраничный обход проверялся, а не подразумевался.
 */
export const STUB_MAX_PAGE_SIZE = 100;
/** Умолчание Strapi: 25 записей на страницу. Без обхода снимок молча теряет остальные. */
export const STUB_DEFAULT_PAGE_SIZE = 25;

export interface StubCollection {
  /** Записи в форме плоского REST Strapi 5. */
  records: Record<string, unknown>[];
  /** Отвечать этим кодом вместо данных: имитация сбоя одного запроса. */
  status?: number;
}

export interface CmsStub {
  url: string;
  /** Журнал запросов: по нему видно, был ли постраничный обход. */
  requests: { endpoint: string; page: number; pageSize: number }[];
  /** Журнал обращений к каталогу загрузок: по нему видно, скачивались ли байты медиа. */
  uploadRequests: string[];
  close(): Promise<void>;
}

/**
 * Файл каталога загрузок: байты либо код отказа. Ключ — путь целиком (`/uploads/img-1.webp`),
 * а не имя: у Strapi адрес медиа приходит в поле `url` записи, и заглушка обязана отвечать
 * ровно на него, иначе проверка «скачано ли» подтверждала бы другое обращение.
 */
export interface StubUpload {
  bytes?: Buffer;
  /** Отвечать этим кодом вместо байтов: имитация недокачанного файла. */
  status?: number;
}

function collectionOf(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

/** Разбирает и `pagination[page]`/`pagination[pageSize]`, и `pagination[start]`/`[limit]`. */
function paginationOf(params: URLSearchParams): { page: number; pageSize: number } {
  const rawSize = params.get('pagination[pageSize]') ?? params.get('pagination[limit]');
  const pageSize = Math.min(
    rawSize ? Number(rawSize) : STUB_DEFAULT_PAGE_SIZE,
    STUB_MAX_PAGE_SIZE,
  );
  const start = params.get('pagination[start]');
  if (start !== null) return { page: Math.floor(Number(start) / pageSize) + 1, pageSize };
  return { page: Number(params.get('pagination[page]') ?? '1'), pageSize };
}

export async function startCmsStub(
  dataset: Record<string, StubCollection>,
  uploads: Record<string, StubUpload> = {},
): Promise<CmsStub> {
  const requests: CmsStub['requests'] = [];
  const uploadRequests: string[] = [];

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const parsed = new URL(req.url ?? '/', 'http://localhost');

    // Каталог загрузок отвечает БАЙТАМИ, а не JSON: снятие снимка обязано скачать файл, а не
    // прочитать про него запись. Ветка стоит до разбора коллекций: последний сегмент
    // `/uploads/img-1.webp` — имя файла, и обычный разбор принял бы его за тип контента.
    const upload = uploads[parsed.pathname];
    if (parsed.pathname.startsWith('/uploads/') || upload) {
      uploadRequests.push(parsed.pathname);
      if (!upload) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('нет такого файла');
        return;
      }
      if (upload.status && upload.status >= 400) {
        res.writeHead(upload.status, { 'content-type': 'text/plain' });
        res.end('сбой отдачи файла');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/webp' });
      res.end(upload.bytes ?? Buffer.alloc(0));
      return;
    }

    const endpoint = collectionOf(parsed.pathname);
    const collection = dataset[endpoint];
    if (!collection) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { status: 404, message: `нет типа ${endpoint}` } }));
      return;
    }
    const { page, pageSize } = paginationOf(parsed.searchParams);
    requests.push({ endpoint, page, pageSize });
    if (collection.status && collection.status >= 400) {
      res.writeHead(collection.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { status: collection.status, message: 'сбой' } }));
      return;
    }
    const total = collection.records.length;
    const data = collection.records.slice((page - 1) * pageSize, page * pageSize);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data,
        meta: { pagination: { page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), total } },
      }),
    );
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('заглушка не получила порт');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    uploadRequests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Свободный порт, на котором ГАРАНТИРОВАННО никто не слушает: для проверки недоступности. */
export async function closedPortUrl(): Promise<string> {
  const stub = await startCmsStub({});
  await stub.close();
  return stub.url;
}

// ------------------------------------------------------------- запуск захвата

export interface CaptureRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout и stderr вместе: требование говорит «вывод», не разделяя потоки. */
  output: string;
}

/**
 * Запуск захвата ДОЧЕРНИМ процессом, асинхронно.
 *
 * Синхронный запуск здесь невозможен по построению: заглушка CMS живёт в ЭТОМ же процессе, а
 * `spawnSync` останавливает его цикл событий на всё время работы ребёнка. Заглушка перестаёт
 * отвечать, дочерний `fetch` честно упирается в свой таймаут, и падают все сценарии, которым
 * нужна живая CMS. Измерено: тот же прогон синхронно — 16 с и отказ по таймауту, асинхронно —
 * 1 с и настоящий результат.
 */
export function runCapture(env: Record<string, string | undefined>): Promise<CaptureRun> {
  const clean = { ...process.env };
  // Адрес не должен приезжать из окружения разработчика: сценарий «адрес не задан» обязан
  // быть воспроизводимым на машине, где живая система управления запущена.
  delete clean.CMS_URL;
  delete clean.STRAPI_URL;
  delete clean.CONTENT_SNAPSHOT_DIR;

  return new Promise<CaptureRun>((resolve) => {
    const child = spawn(TSX, [CAPTURE_SCRIPT], {
      cwd: WEB_ROOT,
      env: { ...clean, ...env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const guard = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => {
      clearTimeout(guard);
      resolve({ status, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

export function pinnedSnapshot(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PINNED_DIR, 'snapshot.json'), 'utf-8')) as Record<string, unknown>;
}
