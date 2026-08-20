import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEDUP_MS = 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const YOOKASSA_TIMEOUT_MS = 8000;
const CHANNEL_SOURCE = 'ikpk-site';
const CANARY_CONSTANT = 'ikpk-hmac-canary-constant';
const ALLOWED_ORIGIN = 'https://ikpk.su';
// Решение 13 (design.md): роль установленного сервиса `test|prod` привязана к
// закреплённому магазину ЮKassa намертво — совпадение проверяется на старте (задача 4.10).
const YOOKASSA_TEST_SHOP_ID = '1440249';
const YOOKASSA_PROD_SHOP_ID = '409285';
const SERVICE_MODES = ['demo', 'test', 'prod'] as const;
type ServiceMode = (typeof SERVICE_MODES)[number];

export type PaymentRecord = {
  requestId: string;
  yookassaPaymentId: string | null;
  status: string;
  fingerprint: string;
  keyVersion: string;
  createdAt: string;
  confirmedAt?: string | null;
  verificationAt?: string | null;
  verificationReason?: string | null;
};

type JournalEntry = { requestId: string; at: string; reason: string };

type DuplicateToken = {
  token: string;
  requestId: string;
  fingerprint: string;
  expiresAt: number;
  used: boolean;
};

type PaymentBody = {
  requestId: string;
  firstName: string;
  lastName: string;
  seminar: string;
  amount: number;
  startDate: string | null;
  venue: string | null;
  email: string;
  phone: string;
  consent: true;
  duplicateConfirmed?: boolean;
  duplicateConfirmationToken?: string;
};

type FieldError = { field: string; message: string };

type ServiceOpts = {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
};

function fail(message: string): never {
  throw new Error(message);
}

function parseJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function parseRecordsFile(raw: unknown): PaymentRecord[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('хранилище payments.json имеет неверную форму');
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'records')) {
    fail('хранилище payments.json имеет неверную форму');
  }
  const records = (raw as { records: unknown }).records;
  if (!Array.isArray(records)) {
    fail('хранилище payments.json имеет неверную форму');
  }
  return records.map((item, index) => parsePaymentRecord(item, index));
}

function parsePaymentRecord(raw: unknown, index: number): PaymentRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`хранилище payments.json имеет неверную форму: records[${index}]`);
  }
  const o = raw as Record<string, unknown>;
  const requestId = o.requestId;
  if (typeof requestId !== 'string' || !isUuid(requestId)) {
    fail(`хранилище payments.json имеет неверную форму: records[${index}].requestId`);
  }
  if (
    o.yookassaPaymentId !== null &&
    (typeof o.yookassaPaymentId !== 'string' || o.yookassaPaymentId.length === 0)
  ) {
    fail(`хранилище payments.json имеет неверную форму: records[${index}].yookassaPaymentId`);
  }
  if (typeof o.status !== 'string' || o.status.length === 0) {
    fail(`хранилище payments.json имеет неверную форму: records[${index}].status`);
  }
  if (!isHmacDigest(o.fingerprint)) {
    fail(`хранилище payments.json имеет неверную форму: records[${index}].fingerprint`);
  }
  if (typeof o.keyVersion !== 'string' || o.keyVersion.length === 0) {
    fail(`хранилище payments.json имеет неверную форму: records[${index}].keyVersion`);
  }
  if (typeof o.createdAt !== 'string' || Number.isNaN(Date.parse(o.createdAt))) {
    fail(`хранилище payments.json имеет неверную форму: records[${index}].createdAt`);
  }
  const record: PaymentRecord = {
    requestId,
    yookassaPaymentId: o.yookassaPaymentId,
    status: o.status,
    fingerprint: o.fingerprint,
    keyVersion: o.keyVersion,
    createdAt: o.createdAt,
  };
  if (o.confirmedAt !== undefined) {
    if (
      o.confirmedAt !== null &&
      (typeof o.confirmedAt !== 'string' || Number.isNaN(Date.parse(o.confirmedAt)))
    ) {
      fail(`хранилище payments.json имеет неверную форму: records[${index}].confirmedAt`);
    }
    record.confirmedAt = o.confirmedAt;
  }
  if (o.verificationAt !== undefined) {
    if (
      o.verificationAt !== null &&
      (typeof o.verificationAt !== 'string' || Number.isNaN(Date.parse(o.verificationAt)))
    ) {
      fail(`хранилище payments.json имеет неверную форму: records[${index}].verificationAt`);
    }
    record.verificationAt = o.verificationAt;
  }
  if (o.verificationReason !== undefined) {
    if (o.verificationReason !== null && typeof o.verificationReason !== 'string') {
      fail(`хранилище payments.json имеет неверную форму: records[${index}].verificationReason`);
    }
    record.verificationReason = o.verificationReason;
  }
  return record;
}

const HMAC_DIGEST = /^[0-9a-f]{64}$/;

function isHmacDigest(value: unknown): value is string {
  return typeof value === 'string' && HMAC_DIGEST.test(value);
}

function parseCanaryFile(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('hmac canary file has invalid shape');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || !isHmacDigest(v)) fail('hmac canary file has invalid shape');
    out[k] = v;
  }
  return out;
}

function canonicalFingerprintSource(body: PaymentBody): string {
  return JSON.stringify({
    firstName: body.firstName,
    lastName: body.lastName,
    seminar: body.seminar,
    amount: body.amount,
    startDate: body.startDate,
    venue: body.venue,
    email: body.email,
    phone: body.phone,
  });
}

function fingerprintOf(body: PaymentBody, key: string): string {
  return createHmac('sha256', key).update(canonicalFingerprintSource(body)).digest('hex');
}

function canaryOf(key: string): string {
  return createHmac('sha256', key).update(CANARY_CONSTANT).digest('hex');
}

function isUuid(value: string): boolean {
  return UUID_V4.test(value);
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'canceled';
}

function mapYooKassaStatus(status: unknown): string {
  if (status === 'succeeded' || status === 'canceled' || status === 'pending') return status;
  return 'unknown';
}

function clientIp(req: IncomingMessage): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function isHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0]!.trim() === 'https') return true;
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validateProdEnv(env: NodeJS.ProcessEnv): void {
  const modeRaw = env.PAYMENT_MODE;
  if (!(SERVICE_MODES as readonly string[]).includes(modeRaw ?? '')) {
    fail(`PAYMENT_MODE must be one of ${SERVICE_MODES.join('|')}, got ${JSON.stringify(modeRaw ?? '')}`);
  }
  const mode = modeRaw as ServiceMode;
  if (mode === 'demo') return;

  const required = [
    'YOOKASSA_SHOP_ID',
    'YOOKASSA_SECRET_KEY',
    'HMAC_KEY_CURRENT',
    'HMAC_KEY_CURRENT_VERSION',
    'RECEIPT_ENABLED',
    // Задача 5.10e: адрес возврата — свойство контура, умолчание на боевой сайт для
    // стенда недопустимо. Тот же единственный исход, что у любого другого недостающего
    // обязательного значения — порт не открыт до всякого запроса посетителя.
    'PAYMENT_RETURN_BASE',
  ];
  for (const name of required) {
    if (!env[name]) fail(`${name} is required when PAYMENT_MODE=${mode}`);
  }

  // Роль сервиса привязана к закреплённому магазину намертво (design.md, Решение 13):
  // `test` — только 1440249, `prod` — только 409285. Сверка буквальная, без trim: пробел
  // или префикс уводят запрос в чужой магазин так же надёжно, как другое число.
  const expectedShopId = mode === 'test' ? YOOKASSA_TEST_SHOP_ID : YOOKASSA_PROD_SHOP_ID;
  if (env.YOOKASSA_SHOP_ID !== expectedShopId) {
    fail(
      `YOOKASSA_SHOP_ID must be ${expectedShopId} when PAYMENT_MODE=${mode}, got ${JSON.stringify(env.YOOKASSA_SHOP_ID ?? '')}`,
    );
  }

  // PAYMENT_RETURN_BASE обязана быть КАНОНИЧЕСКИМ http(s)-origin: посетитель стенда
  // обязан вернуться на /oplata ЭТОГО ЖЕ контура, а неразбираемое значение проявилось бы
  // только на последнем шаге оплаты у живого посетителя. «Ненулевого origin» мало
  // (найдено ревью владельца, P1, 2026-08-20): https://ikpk.su/foo разбирался и давал
  // /foo/oplata — страницу, которой нет. Путь, query, fragment и credentials — отказ;
  // хвостовой слэш — законная запись того же origin (pathname «/» у обеих форм).
  let returnBase: URL | undefined;
  try {
    returnBase = new URL(env.PAYMENT_RETURN_BASE!);
  } catch {
    returnBase = undefined;
  }
  if (
    !returnBase ||
    (returnBase.protocol !== 'http:' && returnBase.protocol !== 'https:') ||
    returnBase.username !== '' ||
    returnBase.password !== '' ||
    returnBase.pathname !== '/' ||
    returnBase.search !== '' ||
    returnBase.hash !== ''
  ) {
    fail(
      `PAYMENT_RETURN_BASE must be a canonical http(s) origin without credentials, path, query or hash, got ${JSON.stringify(env.PAYMENT_RETURN_BASE ?? '')}`,
    );
  }

  const receipt = env.RECEIPT_ENABLED;
  if (receipt !== 'true' && receipt !== 'false') {
    fail(`RECEIPT_ENABLED must be true or false, got ${JSON.stringify(receipt)}`);
  }
  // Код НДС обязателен ровно тогда, когда чеки включены: ЮKassa отвергает чек без
  // `vat_code` (наблюдено 17.08.2026 на тестовом магазине: 400 invalid_request,
  // parameter receipt.items[0].vat_code), а негодное значение отвергает так же. Без
  // проверки на запуске опечатка доживает до первого плательщика и выглядит как 502
  // без причины. Диапазон допустимых кодов НЕ перечисляется: наблюдением известно
  // только, что 1 принимается и 99 отвергается, а список чужих кодов отставал бы молча.
  if (receipt === 'true') {
    const raw = env.RECEIPT_VAT_CODE;
    if (!raw) fail('RECEIPT_VAT_CODE is required when RECEIPT_ENABLED=true');
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      fail(`RECEIPT_VAT_CODE must be a positive integer, got ${JSON.stringify(raw)}`);
    }
  }
  const prevKey = env.HMAC_KEY_PREVIOUS;
  const prevVer = env.HMAC_KEY_PREVIOUS_VERSION;
  if (Boolean(prevKey) !== Boolean(prevVer)) {
    fail('HMAC_KEY_PREVIOUS and HMAC_KEY_PREVIOUS_VERSION must be set together');
  }
  if (prevVer && prevVer === env.HMAC_KEY_CURRENT_VERSION) {
    fail('HMAC_KEY_CURRENT_VERSION must differ from HMAC_KEY_PREVIOUS_VERSION');
  }
  for (const name of ['PAYMENT_POST_RATE_LIMIT'] as const) {
    const raw = env[name];
    if (!raw) fail(`${name} is required when PAYMENT_MODE=${mode}`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      fail(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
  }
  {
    const raw = env.PAYMENT_GET_RATE_LIMIT;
    if (!raw) fail(`PAYMENT_GET_RATE_LIMIT is required when PAYMENT_MODE=${mode}`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 5) {
      fail(`PAYMENT_GET_RATE_LIMIT must be an integer >= 5, got ${JSON.stringify(raw)}`);
    }
  }
  if (env.PAYMENT_RATE_LIMIT_WINDOW_MS !== undefined) {
    const n = Number(env.PAYMENT_RATE_LIMIT_WINDOW_MS);
    if (!Number.isInteger(n) || n <= 0) {
      fail(
        `PAYMENT_RATE_LIMIT_WINDOW_MS must be a positive integer, got ${JSON.stringify(env.PAYMENT_RATE_LIMIT_WINDOW_MS)}`,
      );
    }
  }
}

function validatePayload(raw: unknown): { ok: true; body: PaymentBody } | { ok: false; status: number; errors: FieldError[] } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 400, errors: [{ field: '_body', message: 'invalid json' }] };
  }
  const o = raw as Record<string, unknown>;
  const errors: FieldError[] = [];
  const requestId = typeof o.requestId === 'string' ? o.requestId : '';
  if (!isUuid(requestId)) {
    return { ok: false, status: 400, errors: [{ field: 'requestId', message: 'must be UUID v4' }] };
  }
  const str = (key: string, min: number, max: number) => {
    const v = o[key];
    if (typeof v !== 'string' || v.trim().length < min || v.length > max) {
      errors.push({ field: key, message: 'invalid' });
      return '';
    }
    return v.trim();
  };
  const firstName = str('firstName', 1, 100);
  const lastName = str('lastName', 1, 100);
  const seminar = str('seminar', 1, 300);
  const emailRaw = typeof o.email === 'string' ? o.email.trim() : '';
  if (!emailRaw.includes('@') || !emailRaw.split('@')[1]?.includes('.')) {
    errors.push({ field: 'email', message: 'invalid' });
  }
  const phoneRaw = typeof o.phone === 'string' ? o.phone : '';
  const digits = phoneRaw.replace(/\D/g, '');
  if (digits.length < 10) errors.push({ field: 'phone', message: 'invalid' });
  if (o.consent !== true) errors.push({ field: 'consent', message: 'required' });

  const amount = o.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    errors.push({ field: 'amount', message: 'must be a positive integer' });
  }

  let startDate: string | null = null;
  if (o.startDate !== undefined && o.startDate !== null) {
    if (typeof o.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.startDate)) {
      errors.push({ field: 'startDate', message: 'invalid' });
    } else startDate = o.startDate;
  }
  let venue: string | null = null;
  if (o.venue !== undefined && o.venue !== null) {
    if (typeof o.venue !== 'string' || o.venue.length > 300) errors.push({ field: 'venue', message: 'invalid' });
    else venue = o.venue;
  }

  if (errors.length) {
    const status = errors.some((e) => e.field === 'amount' || e.field === 'consent') ? 422 : 400;
    return { ok: false, status: errors.some((e) => e.field === 'amount') ? 422 : status, errors };
  }

  return {
    ok: true,
    body: {
      requestId,
      firstName,
      lastName,
      seminar,
      amount: amount as number,
      startDate,
      venue,
      email: emailRaw,
      phone: phoneRaw,
      consent: true,
      duplicateConfirmed: o.duplicateConfirmed === true,
      duplicateConfirmationToken: typeof o.duplicateConfirmationToken === 'string' ? o.duplicateConfirmationToken : undefined,
    },
  };
}

function jsonHeaders(origin: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  };
  if (origin === ALLOWED_ORIGIN) headers['access-control-allow-origin'] = ALLOWED_ORIGIN;
  return headers;
}

export function createPaymentService(opts: ServiceOpts) {
  const env = opts.env;
  const doFetch = opts.fetch ?? fetch;
  const nowFn = opts.now ?? (() => (env.PAYMENT_NOW ? new Date(env.PAYMENT_NOW) : new Date()));

  const dataDir = env.PAYMENT_DATA_DIR ?? join(process.cwd(), 'data');
  const storagePath = env.PAYMENT_STORAGE_PATH ?? join(dataDir, 'payments.json');
  const canaryPath = env.PAYMENT_CANARY_PATH ?? join(dataDir, 'hmac-canary.json');
  const journalPath = env.PAYMENT_VERIFICATION_JOURNAL_PATH ?? join(dataDir, 'verification-journal.json');
  const tokensPath = join(dirname(storagePath), 'duplicate-tokens.json');

  let server: Server | undefined;
  const buckets = new Map<string, number[]>();
  let chain: Promise<unknown> = Promise.resolve();

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function hmacKeys(): Map<string, string> {
    const map = new Map<string, string>();
    if (env.HMAC_KEY_CURRENT && env.HMAC_KEY_CURRENT_VERSION) {
      map.set(env.HMAC_KEY_CURRENT_VERSION, env.HMAC_KEY_CURRENT);
    }
    if (env.HMAC_KEY_PREVIOUS && env.HMAC_KEY_PREVIOUS_VERSION) {
      map.set(env.HMAC_KEY_PREVIOUS_VERSION, env.HMAC_KEY_PREVIOUS);
    }
    return map;
  }

  function loadRecords(): PaymentRecord[] {
    if (!existsSync(storagePath)) return [];
    return parseRecordsFile(parseJsonFile<unknown>(storagePath, { records: [] }));
  }

  function saveRecords(records: PaymentRecord[]): void {
    mkdirSync(dirname(storagePath), { recursive: true });
    writeFileSync(storagePath, JSON.stringify({ records }));
  }

  function loadJournal(): JournalEntry[] {
    return parseJsonFile<{ entries?: JournalEntry[] }>(journalPath, { entries: [] }).entries ?? [];
  }

  function saveJournal(entries: JournalEntry[]): void {
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, JSON.stringify({ entries }));
  }

  function loadTokens(): DuplicateToken[] {
    return parseJsonFile<{ tokens?: DuplicateToken[] }>(tokensPath, { tokens: [] }).tokens ?? [];
  }

  function saveTokens(tokens: DuplicateToken[]): void {
    mkdirSync(dirname(tokensPath), { recursive: true });
    writeFileSync(tokensPath, JSON.stringify({ tokens }));
  }

  function appendJournal(requestId: string, reason: string): void {
    const entries = loadJournal();
    entries.push({ requestId, at: nowFn().toISOString(), reason });
    saveJournal(entries);
  }

  function markVerification(records: PaymentRecord[], requestId: string, reason: string): PaymentRecord[] {
    const at = nowFn().toISOString();
    return records.map((r) =>
      r.requestId === requestId && !r.yookassaPaymentId
        ? { ...r, verificationAt: at, verificationReason: reason }
        : r,
    );
  }

  function rateLimited(kind: 'POST' | 'GET', ip: string): boolean {
    const max = Number(kind === 'POST' ? env.PAYMENT_POST_RATE_LIMIT : env.PAYMENT_GET_RATE_LIMIT);
    if (!Number.isFinite(max) || max <= 0) return false;
    const windowMs = Number(env.PAYMENT_RATE_LIMIT_WINDOW_MS ?? 60_000);
    const key = `${kind}:${ip}`;
    const t = nowFn().getTime();
    const hits = (buckets.get(key) ?? []).filter((x) => t - x < windowMs);
    if (hits.length >= max) {
      buckets.set(key, hits);
      return true;
    }
    hits.push(t);
    buckets.set(key, hits);
    return false;
  }

  function yooHeaders(idempotenceKey?: string): Record<string, string> {
    const shop = env.YOOKASSA_SHOP_ID ?? '';
    const secret = env.YOOKASSA_SECRET_KEY ?? '';
    const auth = Buffer.from(`${shop}:${secret}`).toString('base64');
    const headers: Record<string, string> = {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
    };
    if (idempotenceKey) headers['idempotence-key'] = idempotenceKey;
    return headers;
  }

  function apiBase(): string {
    return (env.YOOKASSA_API_BASE ?? 'https://api.yookassa.ru').replace(/\/$/, '');
  }

  async function yooCreate(body: PaymentBody): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false }> {
    const value = `${body.amount}.00`;
    const payload: Record<string, unknown> = {
      amount: { value, currency: 'RUB' },
      // Одностадийный платёж: успешная оплата списывается сразу и не требует отдельного
      // действия сотрудника (спека, требование «Оплата подтверждается без отдельного
      // действия сотрудника»). Умолчание ЮKassa — двухстадийный: без этого поля
      // оплаченный платёж уходит в `waiting_for_capture`, деньги посетителя удержаны и
      // истекают через 7 суток, а наш GET отдаёт `unknown`, то есть «нужна сверка».
      // Наблюдено и закрыто контролем 17.08.2026 на тестовом магазине.
      capture: true,
      confirmation: {
        type: 'redirect',
        // Задача 5.10e: PAYMENT_RETURN_BASE обязательна и провалидирована как
        // канонический origin ДО открытия порта (validateProdEnv) для любого режима, в
        // котором этот код исполним (test|prod — demo возвращается из handlePost раньше).
        // Умолчание на боевой сайт здесь означало бы ровно тот дефект, который 5.10e
        // устраняет. Адрес строится от РАЗОБРАННОГО origin, не от сырой строки: сырой
        // «https://host/» дал бы «//oplata» (ревью владельца, P1, 2026-08-20).
        return_url: `${new URL(env.PAYMENT_RETURN_BASE!).origin}/oplata?paymentRequest=${body.requestId}`,
      },
      description: `Оплата за семинар: ${body.seminar}, ${body.firstName} ${body.lastName}`,
      metadata: { requestId: body.requestId, source: CHANNEL_SOURCE },
    };
    if (env.RECEIPT_ENABLED === 'true') {
      payload.receipt = {
        customer: { email: body.email },
        items: [
          {
            description: body.seminar.slice(0, 128),
            quantity: '1.00',
            amount: { value, currency: 'RUB' },
            // Обязателен для ЮKassa; значение — из окружения, потому что верный код НДС
            // для ИКПК определяет заказчик (`tasks.md`, 2.9), а не этот код. Наличие и
            // годность проверены на запуске (fail-closed), поэтому здесь Number безопасен.
            vat_code: Number(env.RECEIPT_VAT_CODE),
          },
        ],
      };
    }
    try {
      const res = await doFetch(`${apiBase()}/v3/payments`, {
        method: 'POST',
        headers: yooHeaders(body.requestId),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(YOOKASSA_TIMEOUT_MS),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) return { ok: false };
      return { ok: true, json };
    } catch {
      return { ok: false };
    }
  }

  async function yooGet(id: string): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false }> {
    try {
      const res = await doFetch(`${apiBase()}/v3/payments/${id}`, {
        method: 'GET',
        headers: yooHeaders(),
        signal: AbortSignal.timeout(YOOKASSA_TIMEOUT_MS),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) return { ok: false };
      return { ok: true, json };
    } catch {
      return { ok: false };
    }
  }

  function confirmationUrlOf(json: Record<string, unknown>): string | undefined {
    const confirmation = json.confirmation;
    if (confirmation && typeof confirmation === 'object' && 'confirmation_url' in confirmation) {
      const url = (confirmation as { confirmation_url?: unknown }).confirmation_url;
      if (typeof url === 'string' && url) return url;
    }
    return undefined;
  }

  function issueToken(requestId: string, fingerprint: string): string {
    const tokens = loadTokens().filter((t) => t.expiresAt > nowFn().getTime());
    const token = randomBytes(24).toString('hex');
    tokens.push({
      token,
      requestId,
      fingerprint,
      expiresAt: nowFn().getTime() + TOKEN_TTL_MS,
      used: false,
    });
    saveTokens(tokens);
    return token;
  }

  function takeToken(token: string, requestId: string, fingerprint: string): 'ok' | 'expired' | 'bad' {
    const tokens = loadTokens();
    const found = tokens.find((t) => t.token === token);
    if (!found) return 'bad';
    if (found.used) return 'bad';
    if (found.requestId !== requestId || found.fingerprint !== fingerprint) return 'bad';
    if (found.expiresAt <= nowFn().getTime()) return 'expired';
    found.used = true;
    saveTokens(tokens);
    return 'ok';
  }

  function fingerprintFor(body: PaymentBody, version: string, keys: Map<string, string>): string | null {
    const key = keys.get(version);
    if (!key) return null;
    return fingerprintOf(body, key);
  }

  async function handlePost(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    if (env.PAYMENT_MODE === 'demo') {
      await readBody(req).catch(() => '');
      return { status: 200, body: { status: 'created_demo' } };
    }
    if (rateLimited('POST', clientIp(req))) {
      return {
        status: 429,
        body: { status: 'rejected', errors: [{ field: '_rateLimit', message: 'too many requests' }] },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return { status: 400, body: { status: 'rejected', errors: [{ field: '_body', message: 'invalid json' }] } };
    }
    const validated = validatePayload(parsed);
    if (!validated.ok) {
      return { status: validated.status, body: { status: 'rejected', errors: validated.errors } };
    }
    const body = validated.body;
    const keys = hmacKeys();
    const currentVersion = env.HMAC_KEY_CURRENT_VERSION!;
    const currentFp = fingerprintOf(body, env.HMAC_KEY_CURRENT!);
    const t = nowFn().getTime();

    let records = loadRecords();
    const existing = records.find((r) => r.requestId === body.requestId);

    if (!existing) {
      const live = records.find((r) => {
        if (!isLiveUnfinished(r, t, keys)) return false;
        const fp = fingerprintFor(body, r.keyVersion, keys);
        return fp !== null && fp === r.fingerprint;
      });
      if (live) {
        if (!live.yookassaPaymentId) {
          records = markVerification(records, live.requestId, 'fingerprint_match');
          saveRecords(records);
          appendJournal(live.requestId, 'fingerprint_match');
        }
        return { status: 503, body: { status: 'verification_required', requestId: live.requestId } };
      }

      const confirmed = records.find((r) => {
        if (!isFreshConfirmed(r, t, keys)) return false;
        const fp = fingerprintFor(body, r.keyVersion, keys);
        return fp !== null && fp === r.fingerprint;
      });
      if (confirmed) {
        const token = body.duplicateConfirmationToken;
        if (!token) {
          return {
            status: 409,
            body: { status: 'duplicate_confirmation_required', confirmationToken: issueToken(body.requestId, currentFp) },
          };
        }
        const taken = takeToken(token, body.requestId, currentFp);
        if (taken !== 'ok') {
          return {
            status: 409,
            body: { status: 'duplicate_confirmation_required', confirmationToken: issueToken(body.requestId, currentFp) },
          };
        }
        const liveAgain = loadRecords().find((r) => {
          if (!isLiveUnfinished(r, nowFn().getTime(), keys)) return false;
          const fp = fingerprintFor(body, r.keyVersion, keys);
          return fp !== null && fp === r.fingerprint;
        });
        if (liveAgain) {
          return { status: 503, body: { status: 'verification_required', requestId: liveAgain.requestId } };
        }
        records = loadRecords();
      }

      const createdAt = nowFn().toISOString();
      const draft: PaymentRecord = {
        requestId: body.requestId,
        yookassaPaymentId: null,
        status: 'unknown',
        fingerprint: currentFp,
        keyVersion: currentVersion,
        createdAt,
      };
      records = [...records, draft];
      saveRecords(records);

      const created = await yooCreate(body);
      records = loadRecords();
      if (!created.ok) {
        return { status: 502, body: { status: 'error' } };
      }
      const ykId = typeof created.json.id === 'string' ? created.json.id : null;
      const ykStatus = mapYooKassaStatus(created.json.status);
      const url = confirmationUrlOf(created.json);
      records = records.map((r) =>
        r.requestId === body.requestId
          ? {
              ...r,
              yookassaPaymentId: ykId,
              status: ykStatus,
              confirmedAt: ykStatus === 'succeeded' ? nowFn().toISOString() : r.confirmedAt,
            }
          : r,
      );
      saveRecords(records);
      return { status: 201, body: { status: 'created', confirmationUrl: url ?? '' } };
    }

    if (existing.status === 'succeeded') {
      return { status: 200, body: { status: 'already_paid' } };
    }

    if (existing.status === 'canceled') {
      const key = keys.get(existing.keyVersion);
      if (!key) return { status: 200, body: { status: 'canceled' } };
      const fp = fingerprintOf(body, key);
      if (fp === existing.fingerprint) return { status: 200, body: { status: 'canceled' } };
      return {
        status: 409,
        body: { status: 'rejected', errors: [{ field: '_content', message: 'payload changed' }] },
      };
    }

    const key = keys.get(existing.keyVersion);
    if (!key) {
      if (!existing.yookassaPaymentId) {
        records = markVerification(records, existing.requestId, 'unknown_key_version');
        saveRecords(records);
        appendJournal(existing.requestId, 'unknown_key_version');
      }
      return { status: 503, body: { status: 'verification_required', requestId: existing.requestId } };
    }

    const fp = fingerprintOf(body, key);
    if (fp !== existing.fingerprint) {
      return { status: 503, body: { status: 'verification_required', requestId: existing.requestId } };
    }

    if (existing.yookassaPaymentId) {
      const got = await yooGet(existing.yookassaPaymentId);
      if (!got.ok) return { status: 200, body: { status: 'created', confirmationUrl: '' } };
      const mapped = mapYooKassaStatus(got.json.status);
      records = loadRecords().map((r) =>
        r.requestId === existing.requestId
          ? {
              ...r,
              status: mapped,
              confirmedAt: mapped === 'succeeded' ? nowFn().toISOString() : r.confirmedAt,
            }
          : r,
      );
      saveRecords(records);
      if (mapped === 'succeeded') return { status: 200, body: { status: 'already_paid' } };
      if (mapped === 'canceled') return { status: 200, body: { status: 'canceled' } };
      const url = confirmationUrlOf(got.json);
      return { status: 200, body: { status: 'created', confirmationUrl: url ?? '' } };
    }

    const age = t - Date.parse(existing.createdAt);
    if (age > DEDUP_MS) {
      return { status: 503, body: { status: 'verification_required', requestId: existing.requestId } };
    }

    const retried = await yooCreate(body);
    if (!retried.ok) return { status: 502, body: { status: 'error' } };
    const ykId = typeof retried.json.id === 'string' ? retried.json.id : null;
    const ykStatus = mapYooKassaStatus(retried.json.status);
    records = loadRecords().map((r) =>
      r.requestId === existing.requestId
        ? {
            ...r,
            yookassaPaymentId: ykId,
            status: ykStatus,
            confirmedAt: ykStatus === 'succeeded' ? nowFn().toISOString() : r.confirmedAt,
          }
        : r,
    );
    saveRecords(records);
    return { status: 200, body: { status: 'created', confirmationUrl: confirmationUrlOf(retried.json) ?? '' } };
  }

  function isLiveUnfinished(r: PaymentRecord, t: number, keys: Map<string, string>): boolean {
    if (isTerminal(r.status)) return false;
    if (!Number.isFinite(Date.parse(r.createdAt)) || t - Date.parse(r.createdAt) > TTL_MS) return false;
    return keys.has(r.keyVersion);
  }

  function isFreshConfirmed(r: PaymentRecord, t: number, keys: Map<string, string>): boolean {
    if (r.status !== 'succeeded') return false;
    const at = r.confirmedAt ?? r.createdAt;
    if (!Number.isFinite(Date.parse(at)) || t - Date.parse(at) > TTL_MS) return false;
    return keys.has(r.keyVersion);
  }

  async function handleGetStatus(req: IncomingMessage, requestId: string): Promise<{ status: number; body: unknown }> {
    if (env.PAYMENT_MODE === 'demo') return { status: 200, body: { status: 'demo' } };
    if (rateLimited('GET', clientIp(req))) {
      return {
        status: 429,
        body: { status: 'rejected', errors: [{ field: '_rateLimit', message: 'too many requests' }] },
      };
    }
    if (!isUuid(requestId)) {
      return { status: 400, body: { status: 'rejected', errors: [{ field: 'requestId', message: 'must be UUID v4' }] } };
    }
    const records = loadRecords();
    const rec = records.find((r) => r.requestId === requestId);
    if (!rec) return { status: 404, body: { status: 'not_found' } };

    if (rec.verificationAt && !rec.yookassaPaymentId && !isTerminal(rec.status)) {
      return { status: 200, body: { status: 'verification_required' } };
    }
    if (isTerminal(rec.status)) return { status: 200, body: { status: rec.status } };

    if (!rec.yookassaPaymentId) return { status: 200, body: { status: rec.status === 'unknown' ? 'unknown' : rec.status } };

    const got = await yooGet(rec.yookassaPaymentId);
    if (!got.ok) return { status: 200, body: { status: 'unknown' } };
    const mapped = mapYooKassaStatus(got.json.status);
    const next = loadRecords().map((r) =>
      r.requestId === rec.requestId
        ? {
            ...r,
            status: mapped,
            confirmedAt: mapped === 'succeeded' ? nowFn().toISOString() : r.confirmedAt,
          }
        : r,
    );
    saveRecords(next);
    return { status: 200, body: { status: mapped } };
  }

  async function handleWebhook(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const https = isHttps(req);
    if (!https) {
      await readBody(req).catch(() => '');
      return { status: 200, body: { ok: true } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return { status: 200, body: { ok: true } };
    }
    const id =
      parsed && typeof parsed === 'object' && 'object' in parsed
        ? (parsed as { object?: { id?: unknown } }).object?.id
        : undefined;
    if (typeof id !== 'string' || !id) return { status: 200, body: { ok: true } };

    const records = loadRecords();
    const byYk = records.find((r) => r.yookassaPaymentId === id);

    const got = await yooGet(id);
    if (!got.ok) return { status: 200, body: { ok: true } };
    const mapped = mapYooKassaStatus(got.json.status);
    const metadata =
      got.json.metadata && typeof got.json.metadata === 'object'
        ? (got.json.metadata as Record<string, unknown>)
        : {};
    const metaRequestId = typeof metadata.requestId === 'string' ? metadata.requestId : '';
    const metaSource = typeof metadata.source === 'string' ? metadata.source : '';

    if (byYk) {
      const next = records.map((r) =>
        r.yookassaPaymentId === id
          ? {
              ...r,
              status: mapped,
              confirmedAt: mapped === 'succeeded' ? nowFn().toISOString() : r.confirmedAt,
            }
          : r,
      );
      saveRecords(next);
      return { status: 200, body: { ok: true } };
    }

    if (metaSource !== CHANNEL_SOURCE || !metaRequestId) return { status: 200, body: { ok: true } };
    const target = records.find((r) => r.requestId === metaRequestId);
    if (!target || target.yookassaPaymentId) return { status: 200, body: { ok: true } };
    if (records.some((r) => r.yookassaPaymentId === id)) return { status: 200, body: { ok: true } };

    const next = records.map((r) =>
      r.requestId === metaRequestId
        ? {
            ...r,
            yookassaPaymentId: id,
            status: mapped,
            confirmedAt: mapped === 'succeeded' ? nowFn().toISOString() : r.confirmedAt,
          }
        : r,
    );
    saveRecords(next);
    return { status: 200, body: { ok: true } };
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, jsonHeaders(origin));
      res.end(payload);
    };

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...jsonHeaders(origin),
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end();
        return;
      }

      // Задача 4.10a: несекретный readiness-ответ, ровно три поля. Наружу этот маршрут не
      // публикуется (5.10c) — гейт спрашивает его изнутри host. `demo`/`ci` (нет процесса
      // вовсе) не выдают себя за установленный контур: тот же ответ, что на неизвестный путь.
      if (req.method === 'GET' && url.pathname === '/readyz') {
        if (env.PAYMENT_MODE === 'test' || env.PAYMENT_MODE === 'prod') {
          send(200, { status: 'ready', mode: env.PAYMENT_MODE, shopId: env.YOOKASSA_SHOP_ID });
        } else {
          send(404, { status: 'not_found' });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/payments') {
        const result = await exclusive(() => handlePost(req));
        send(result.status, result.body);
        return;
      }
      const statusMatch = url.pathname.match(/^\/payments\/([^/]+)\/status$/);
      if (req.method === 'GET' && statusMatch) {
        const result = await handleGetStatus(req, decodeURIComponent(statusMatch[1]!));
        send(result.status, result.body);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/payments/webhook') {
        const result = await exclusive(() => handleWebhook(req));
        send(result.status, result.body);
        return;
      }
      send(404, { status: 'not_found' });
    } catch {
      send(500, { status: 'error' });
    }
  }

  function checkCanary(): void {
    // Задача 4.10: `test` — такой же реальный платёжный режим, как `prod` (свой ключ
    // отпечатка, свои записи идемпотентности), и защита canary обязана работать для обоих.
    // Пропускается только `demo` — там ни HMAC-ключа, ни хранилища отпечатков не бывает.
    if (env.PAYMENT_MODE === 'demo') return;
    mkdirSync(dirname(canaryPath), { recursive: true });
    let canary: Record<string, string> | null = null;
    if (existsSync(canaryPath)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(canaryPath, 'utf8'));
      } catch {
        fail(`hmac canary file is unreadable: ${canaryPath}`);
      }
      canary = parseCanaryFile(raw);
    }
    let records: PaymentRecord[] = [];
    if (existsSync(storagePath)) {
      try {
        records = parseRecordsFile(JSON.parse(readFileSync(storagePath, 'utf8')));
      } catch (err) {
        if (err instanceof Error && /неверную форму/.test(err.message)) throw err;
        fail(`хранилище payments.json нечитаемо: ${storagePath}`);
      }
    }
    if (!canary) {
      if (records.length > 0) {
        fail('hmac canary file is missing while fingerprint storage is not empty');
      }
      canary = {};
    } else if (Object.keys(canary).length === 0 && records.length > 0) {
      fail('hmac canary file is empty while fingerprint storage is not empty');
    }
    const version = env.HMAC_KEY_CURRENT_VERSION!;
    const computed = canaryOf(env.HMAC_KEY_CURRENT!);
    if (Object.prototype.hasOwnProperty.call(canary, version)) {
      const stored = canary[version];
      if (!isHmacDigest(stored)) {
        fail('hmac canary digest for this version is invalid');
      }
      const a = Buffer.from(stored);
      const b = Buffer.from(computed);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        fail('HMAC_KEY_CURRENT material does not match canary for this version');
      }
    } else {
      canary[version] = computed;
      writeFileSync(canaryPath, JSON.stringify(canary));
    }
  }

  function checkStorage(): void {
    if (!existsSync(storagePath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(storagePath, 'utf8'));
    } catch {
      fail(`хранилище payments.json нечитаемо: ${storagePath}`);
    }
    parseRecordsFile(raw);
  }

  async function start(): Promise<{ port: number; url: string }> {
    validateProdEnv(env);
    mkdirSync(dataDir, { recursive: true });
    checkStorage();
    checkCanary();
    const host = env.PAYMENT_LISTEN_HOST ?? '127.0.0.1';
    const port = Number(env.PAYMENT_LISTEN_PORT ?? 0);
    server = createServer((req, res) => {
      void dispatch(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, host, () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') fail('failed to bind payment service');
    const url = `http://${host}:${addr.port}`;
    return { port: addr.port, url };
  }

  async function stop(): Promise<void> {
    const s = server;
    server = undefined;
    if (!s) return;
    await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  }

  return { start, stop, storagePath, journalPath, canaryPath };
}
