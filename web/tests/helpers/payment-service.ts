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

export type SpawnResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  listening: boolean;
  connection: 'refused' | 'open' | 'http-error';
};

/**
 * Запуск процесса для 3.0a*: предмет — слушает ли порт. Отсутствие бинаря — FAIL
 * до проверки порта.
 */
export async function spawnPaymentProcess(opts: {
  env: Record<string, string>;
  waitMs?: number;
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

  const waitMs = opts.waitMs ?? 1500;
  const exitCode = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => resolve(child.exitCode), waitMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });

  const portMatch = `${stdout}\n${stderr}`.match(/listening[^\d]*(\d{2,5})/i);
  const port = env.PAYMENT_LISTEN_PORT !== '0' ? Number(env.PAYMENT_LISTEN_PORT) : Number(portMatch?.[1] ?? 0);

  let connection: SpawnResult['connection'] = 'refused';
  let listening = false;
  if (port > 0) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/payments`, { method: 'GET', signal: AbortSignal.timeout(300) });
      listening = true;
      connection = res.ok ? 'open' : 'http-error';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ECONNREFUSED|fetch failed/i.test(msg)) connection = 'refused';
      else connection = 'http-error';
    }
  }

  if (child.exitCode === null && child.pid) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(dataDir, { recursive: true, force: true });

  return { exitCode, stderr, stdout, listening, connection };
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
