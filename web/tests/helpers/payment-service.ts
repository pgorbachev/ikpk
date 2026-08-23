/**
 * Обвязка серверных тестов оплаты. Без неё нельзя отличить «сервиса нет» от
 * «сервис слушает и отвечает неверно»: оба выглядят как красный прогон.
 *
 * Ожидаемый экспорт `payments/src/app.ts`:
 *   createPaymentService({ env, fetch, now }) → { start, stop, storagePath, journalPath }
 * Процесс `payments/src/main.ts` — запасной путь для тестов старта (3.0a*).
 *
 * Исход «файла нет» — это FAIL, не «порт не открыт». Иначе 3.0a была бы зелёной
 * на отсутствии реализации.
 */

import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { PAYMENT_SERVICE_ENTRY, PAYMENT_SERVICE_MAIN, type PaymentRecord, type VerificationJournalEntry } from './payment-contract';

export type YooKassaCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

export type YooKassaMock = {
  url: string;
  calls: YooKassaCall[];
  creates: YooKassaCall[];
  gets: YooKassaCall[];
  setCreateHandler: (
    fn: (call: YooKassaCall) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
  ) => void;
  setGetHandler: (
    fn: (id: string, call: YooKassaCall) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
  ) => void;
  close: () => Promise<void>;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function headerMap(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(',');
  }
  return out;
}

export async function startYooKassaMock(): Promise<YooKassaMock> {
  const calls: YooKassaCall[] = [];
  type Reply = { status: number; body: unknown };
  let createHandler: (call: YooKassaCall) => Reply | Promise<Reply> = (call) => ({
    status: 200,
    body: {
      id: `yk-${calls.length + 1}`,
      status: 'pending',
      confirmation: { confirmation_url: `https://yookassa.test/confirm/${call.body ? 'ok' : 'x'}` },
      metadata: typeof call.body === 'object' && call.body && 'metadata' in (call.body as object)
        ? (call.body as { metadata?: unknown }).metadata
        : undefined,
    },
  });
  let getHandler: (id: string, _call: YooKassaCall) => Reply | Promise<Reply> = (id) => ({
    status: 200,
    body: { id, status: 'pending' },
  });

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    const call: YooKassaCall = {
      method: req.method ?? 'GET',
      url,
      headers: headerMap(req),
      body: parsed,
    };
    calls.push(call);

    const maybe =
      req.method === 'POST' && /\/v3\/payments\/?$/.test(url)
        ? createHandler(call)
        : getHandler(url.split('/').filter(Boolean).at(-1) ?? '', call);
    const reply = await Promise.resolve(maybe);
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('yookassa mock: no address');
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    calls,
    get creates() {
      return calls.filter((c) => c.method === 'POST' && /\/v3\/payments\/?$/.test(c.url));
    },
    get gets() {
      return calls.filter((c) => c.method === 'GET');
    },
    setCreateHandler(fn) {
      createHandler = fn;
    },
    setGetHandler(fn) {
      getHandler = fn;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export function assertPaymentServiceExists(): void {
  if (!existsSync(PAYMENT_SERVICE_ENTRY) && !existsSync(PAYMENT_SERVICE_MAIN)) {
    throw new Error(
      `платёжный сервис не найден (${PAYMENT_SERVICE_ENTRY} / ${PAYMENT_SERVICE_MAIN}). ` +
        'Тест красный, потому что реализации ещё нет — не потому что порт не слушает.',
    );
  }
}

export type StartedService = {
  url: string;
  port: number;
  dataDir: string;
  storagePath: string;
  canaryPath: string;
  journalPath: string;
  yookassa: YooKassaMock;
  outbound: { url: string; method: string }[];
  stop: () => Promise<void>;
  readRecords: () => PaymentRecord[];
  writeRecords: (records: PaymentRecord[]) => void;
  readJournal: () => VerificationJournalEntry[];
  writeJournal: (entries: VerificationJournalEntry[]) => void;
  readCanary: () => unknown;
};

type AppModule = {
  createPaymentService: (opts: {
    env: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    now?: () => Date;
  }) => {
    start: () => Promise<{ port: number; url: string }>;
    stop: () => Promise<void>;
    storagePath?: string;
    journalPath?: string;
    canaryPath?: string;
  };
};

function dataPaths(dir: string) {
  return {
    storagePath: join(dir, 'payments.json'),
    canaryPath: join(dir, 'hmac-canary.json'),
    journalPath: join(dir, 'verification-journal.json'),
  };
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export async function startPaymentService(opts: {
  env?: Record<string, string>;
  now?: () => Date;
  receiptEnabled?: boolean;
  seedRecords?: PaymentRecord[];
  seedJournal?: VerificationJournalEntry[];
  seedCanary?: unknown;
  emptyFingerprints?: boolean;
}): Promise<StartedService> {
  assertPaymentServiceExists();
  const yookassa = await startYooKassaMock();
  const dataDir = mkdtempSync(join(tmpdir(), 'ikpk-pay-'));
  const paths = dataPaths(dataDir);
  mkdirSync(dataDir, { recursive: true });
  if (opts.seedRecords) writeFileSync(paths.storagePath, JSON.stringify({ records: opts.seedRecords }));
  else if (opts.emptyFingerprints) writeFileSync(paths.storagePath, JSON.stringify({ records: [] }));
  if (opts.seedJournal) writeFileSync(paths.journalPath, JSON.stringify({ entries: opts.seedJournal }));

  const env: Record<string, string> = {
    PAYMENT_DATA_DIR: dataDir,
    PAYMENT_STORAGE_PATH: paths.storagePath,
    PAYMENT_CANARY_PATH: paths.canaryPath,
    PAYMENT_VERIFICATION_JOURNAL_PATH: paths.journalPath,
    YOOKASSA_API_BASE: yookassa.url,
    ...(opts.env ?? {}),
  };
  if (opts.now) env.PAYMENT_NOW = opts.now().toISOString();

  if (opts.seedCanary !== undefined) writeFileSync(paths.canaryPath, JSON.stringify(opts.seedCanary));
  else if (env.HMAC_KEY_CURRENT && env.HMAC_KEY_CURRENT_VERSION) {
    // In-process тесты передают fetch для мока ЮKassa; охрана canary от этого не
    // зависит. Журнал сажается отдельно, а не через отключение fail-closed.
    const digest = createHmac('sha256', env.HMAC_KEY_CURRENT)
      .update('ikpk-hmac-canary-constant')
      .digest('hex');
    writeFileSync(paths.canaryPath, JSON.stringify({ [env.HMAC_KEY_CURRENT_VERSION]: digest }));
  }

  const mod: AppModule = await import(pathToFileURL(PAYMENT_SERVICE_ENTRY).href);
  if (typeof mod.createPaymentService !== 'function') {
    await yookassa.close();
    throw new Error('payments/src/app.ts не экспортирует createPaymentService');
  }
  const outbound: { url: string; method: string }[] = [];
  const wrappedFetch: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    outbound.push({ url, method: String(init?.method ?? 'GET').toUpperCase() });
    return fetch(input, init);
  };
  const clock = opts.now;
  const app = mod.createPaymentService({
    env,
    fetch: wrappedFetch,
    now: clock,
  });
  const started = await app.start();
  return {
    url: started.url.replace(/\/$/, ''),
    port: started.port,
    dataDir,
    ...paths,
    yookassa,
    outbound,
    stop: async () => {
      await app.stop();
      await yookassa.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    readRecords: () => {
      const raw = readJson<{ records?: PaymentRecord[] }>(paths.storagePath, {});
      return raw.records ?? [];
    },
    writeRecords: (records) => writeFileSync(paths.storagePath, JSON.stringify({ records })),
    readJournal: () => {
      const raw = readJson<{ entries?: VerificationJournalEntry[] }>(paths.journalPath, {});
      return raw.entries ?? [];
    },
    writeJournal: (entries) => writeFileSync(paths.journalPath, JSON.stringify({ entries })),
    readCanary: () => readJson(paths.canaryPath, null),
  };
}

export type SpawnOutcome = 'exited' | 'listening' | 'timeout';

export type SpawnResult = {
  /**
   * ФАКТИЧЕСКИЙ исход, а не снимок по таймеру:
   *  - `exited` — процесс завершился сам (и вывод дочитан до конца потоков);
   *  - `listening` — процесс отвечает на своём порту и продолжает жить;
   *  - `timeout` — не случилось ни того, ни другого за `deadlineMs`. Это «измерить не
   *    удалось», а не «отказ подтверждён», и по умолчанию наружу такой исход не отдаётся
   *    вовсе (см. `allowTimeout`).
   */
  outcome: SpawnOutcome;
  /** Процесс завершился САМ в пределах deadline. */
  exited: boolean;
  /**
   * Код выхода: ЧИСЛО, если процесс завершился сам; `null`, если он ещё жив или был убит
   * сигналом. Отличать обязательно: `null !== 0` проходит проверку «код не ноль» и на
   * живом процессе — именно так fail-closed проверки были зелёными, ничего не проверив.
   */
  exitCode: number | null;
  /** Сигнал, которым процесс завершился, если завершился сигналом. */
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  listening: boolean;
  connection: 'refused' | 'open' | 'http-error';
  /** Сколько ждали исхода и каков был предел — для сообщений об отказе. */
  waitedMs: number;
  deadlineMs: number;
};

/**
 * Предел ожидания ФАКТИЧЕСКОГО исхода. Прежняя обвязка ждала фиксированные 1500 мс и
 * возвращала `child.exitCode` — то есть `null`, если процесс к этому моменту ещё не
 * успел ни упасть, ни подняться. Под нагрузкой (шестнадцать файлов vitest на одной
 * машине) старт `node --import tsx` в эти 1500 мс не укладывался, и один и тот же набор
 * давал разное число красных: 41 против 40 на двух одинаковых прогонах.
 *
 * Ожидание кончается по СОБЫТИЮ, а не по таймеру, поэтому увеличение предела ничего не
 * замедляет: исправный fail-closed процесс завершается за десятки миллисекунд, исправный
 * рабочий — открывает порт и тоже прекращает ожидание.
 */
const DEFAULT_DEADLINE_MS = 10_000;
const POLL_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Гасим процесс сами: SIGTERM, затем SIGKILL. Возврат — когда потоки закрыты. */
async function terminate(child: ChildProcess, closed: () => boolean): Promise<void> {
  if (closed() || !child.pid) return;
  child.kill('SIGTERM');
  for (let waited = 0; waited < 500 && !closed(); waited += POLL_MS) await sleep(POLL_MS);
  if (closed()) return;
  child.kill('SIGKILL');
  for (let waited = 0; waited < 500 && !closed(); waited += POLL_MS) await sleep(POLL_MS);
}

async function probe(port: number): Promise<SpawnResult['connection']> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/payments`, {
      method: 'GET',
      signal: AbortSignal.timeout(300),
    });
    return res.ok ? 'open' : 'http-error';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /ECONNREFUSED|fetch failed/i.test(msg) ? 'refused' : 'http-error';
  }
}

/**
 * Запуск процесса сервиса. Предмет — ФАКТИЧЕСКИЙ исход старта: завершился процесс сам
 * (и с каким кодом) или поднялся и слушает.
 *
 * Отсутствие бинаря — FAIL до всякой проверки порта (`assertPaymentServiceExists`).
 *
 * Исход `timeout` по умолчанию ПОДНИМАЕТ ИСКЛЮЧЕНИЕ, а не возвращается вызывающему:
 * «процесс не подал признаков ни в одну сторону» — это непройденное измерение, и любой
 * вывод из него («порт не открыт, значит fail-closed») был бы ложным. Вызывающий, чей
 * предмет — сам исход (`expectFailClosedStart`), просит `allowTimeout: true` и обязан
 * утверждать про `outcome` сам.
 */
export async function spawnPaymentProcess(opts: {
  env: Record<string, string>;
  deadlineMs?: number;
  allowTimeout?: boolean;
}): Promise<SpawnResult> {
  assertPaymentServiceExists();
  const dataDir = mkdtempSync(join(tmpdir(), 'ikpk-pay-spawn-'));
  const paths = dataPaths(dataDir);
  const env = {
    ...process.env,
    PAYMENT_DATA_DIR: dataDir,
    PAYMENT_STORAGE_PATH: paths.storagePath,
    PAYMENT_CANARY_PATH: paths.canaryPath,
    PAYMENT_VERIFICATION_JOURNAL_PATH: paths.journalPath,
    PAYMENT_LISTEN_HOST: '127.0.0.1',
    PAYMENT_LISTEN_PORT: '0',
    ...opts.env,
  };
  const entry = existsSync(PAYMENT_SERVICE_MAIN) ? PAYMENT_SERVICE_MAIN : PAYMENT_SERVICE_ENTRY;
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', entry], {
    env,
    cwd: join(PAYMENT_SERVICE_ENTRY, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c) => {
    stdout += String(c);
  });
  child.stderr?.on('data', (c) => {
    stderr += String(c);
  });

  // Ждём `close`, а не `exit`: `exit` наступает до дочитывания stderr, и причина отказа
  // приходит уже после снимка. Ровно так проверка «в stderr названа причина» краснела на
  // исправном коде.
  let closed = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  child.on('close', (code, sig) => {
    closed = true;
    exitCode = code;
    signal = sig;
  });

  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const startedAt = Date.now();
  const declaredPort = env.PAYMENT_LISTEN_PORT !== '0' ? Number(env.PAYMENT_LISTEN_PORT) : 0;
  const announcedPort = (): number =>
    Number(`${stdout}\n${stderr}`.match(/listening[^\d]*(\d{2,5})/i)?.[1] ?? 0);

  let listening = false;
  let connection: SpawnResult['connection'] = 'refused';
  // Гасила ли процесс сама обвязка — фиксируется ДО SIGTERM. Без этого признака `closed` к
  // моменту вычисления исхода уже true (его сделал наш же SIGTERM из `finally`), и процесс,
  // не подавший признаков ни в одну сторону, выглядел бы завершившимся САМ — с `exitCode:
  // null` при исходе `exited`. Найдено негативной мутацией (предел ожидания 1 мс), а не
  // рассуждением.
  let killedByHelper = false;
  try {
    while (!closed && Date.now() - startedAt < deadlineMs) {
      const port = declaredPort > 0 ? declaredPort : announcedPort();
      if (port > 0) {
        const probed = await probe(port);
        if (probed !== 'refused') {
          listening = true;
          connection = probed;
          break;
        }
      }
      await sleep(POLL_MS);
    }
    // Процесс завершился — состояние порта всё равно спрашиваем: «порт закрыт» должно
    // быть измерено, а не выведено из факта завершения.
    if (closed && !listening) {
      const port = declaredPort > 0 ? declaredPort : announcedPort();
      if (port > 0) {
        connection = await probe(port);
        listening = connection !== 'refused';
      }
    }
  } finally {
    if (!closed) killedByHelper = true;
    await terminate(child, () => closed);
    rmSync(dataDir, { recursive: true, force: true });
  }

  const waitedMs = Date.now() - startedAt;
  const outcome: SpawnOutcome =
    closed && !killedByHelper ? 'exited' : listening ? 'listening' : 'timeout';
  const result: SpawnResult = {
    outcome,
    exited: outcome === 'exited',
    exitCode: outcome === 'exited' ? exitCode : null,
    signal: outcome === 'exited' ? signal : null,
    stderr,
    stdout,
    listening,
    connection,
    waitedMs,
    deadlineMs,
  };
  if (outcome === 'timeout' && opts.allowTimeout !== true) {
    throw new Error(
      `процесс сервиса за ${deadlineMs} мс не завершился и не открыл порт — измерения нет, ` +
        'и «порт не открыт» здесь ничего не доказывает. ' +
        `env: ${JSON.stringify(pickEnvForDiagnostics(opts.env))}\nstderr: ${stderr.slice(0, 600)}\nstdout: ${stdout.slice(0, 300)}`,
    );
  }
  return result;
}

/** Диагностика без секретов: имена переданных переменных и значения только режима. */
function pickEnvForDiagnostics(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = /MODE|SHOP|PORT|HOST|ENABLED|VAT/i.test(key) ? value : '<задано>';
  }
  return out;
}

export async function postPayments(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function getStatus(url: string, requestId: string, headers: Record<string, string> = {}) {
  return fetch(`${url}/payments/${requestId}/status`, { headers });
}

/** Тестовый шов HTTPS: как nginx `proxy_set_header X-Forwarded-Proto $scheme`. */
export const WEBHOOK_HTTPS_HEADERS = { 'x-forwarded-proto': 'https' };

export async function postWebhook(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function jsonOf(res: Response): Promise<{ status: number; body: Record<string, unknown> | string }> {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: res.status, body: text };
  }
}
