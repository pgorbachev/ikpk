/**
 * Матрица контуров: ГЕЙТ ВЫКЛАДКИ получает роль артефакта и ожидает по роли
 * (задачи 6.13, 6.14; дельта `specs/deploy-gating/spec.md`).
 *
 * Проверяется ПОВЕДЕНИЕ функции на подставных каталогах сборки, а не текст скрипта:
 * греп исходника утверждал бы, что гейт написан, но не что он что-то ловит. Каждая ветвь
 * отказа проходится хотя бы раз.
 *
 * Источник требований (change `online-payment-flow`):
 *  - `specs/deploy-gating/spec.md`, `MODIFIED` Requirement «Проверки демо-режима входят в
 *    обязательный прогон»: «Предмет проверки определяется объявленной ролью артефакта, и
 *    отсутствие предмета по контракту роли отличается от его потери»; сценарии «роль без
 *    формы проверяется на отсутствие формы», «роль с формой проверяется на её наличие»,
 *    «роль не объявлена»;
 *  - `specs/online-payment/spec.md`, Requirement «Установленные платёжные контуры нельзя
 *    публиковать выключенными или перепутанными»: определение «активной формы» — четыре
 *    условия, из которых (3) буквальное равенство базы ожидаемой для роли и (4) роль
 *    объявлена и равна `stand` либо `prod`;
 *  - там же: «Прежняя матрица объявлена устаревшей, и это касается уже написанного кода»
 *    — отображение роли на ожидаемый адрес живёт в `scripts/deploy-web.sh`, а сама
 *    функция `payment_endpoint_matches` принимает ожидаемое значение аргументом.
 *
 * ШОВ, ВЫБРАННЫЙ ТЕСТАМИ: третий позиционный аргумент `payment_endpoint_matches` —
 * ОЖИДАЕМАЯ РОЛЬ (`ci|stand|prod`), а не булев признак «демо». Спека требует, чтобы
 * проверка получала роль на вход, но имени аргумента не называет; связь объявлена здесь
 * явно. Прежний третий аргумент (`true|false` для `data-payment-demo`) больше не
 * существует — признак удалён решением владельца 2026-08-18.
 *
 * РАСХОЖДЕНИЕ НАЗВАНО: `deploy-checks.test.ts` проверяет ту же функцию по ПРЕЖНЕЙ матрице
 * (фикстуры с `data-payment-demo`, третий аргумент — булев). До выполнения задачи 6.14 два
 * файла дают разные ответы про одну функцию; здесь ответ по спеке.
 *
 * ПОЧЕМУ КРАСНЫЕ СЕЙЧАС: на `12f2135` (продуктовый код с `ac4089b` не менялся: обе поставки — спека и тесты) функция сверяет `data-payment-demo` и про роль не
 * знает вовсе (`scripts/lib/deploy-checks.sh`), а отображение в `scripts/deploy-web.sh`
 * даёт стенду недостижимый `https://demo-api.ikpk.invalid`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAYMENT_ENDPOINT_BASE,
  PREVIEW_MOCK_ENDPOINT,
  READYZ_PATH,
  RETIRED_DEMO_ATTR,
  SERVICE_SHOP_ID,
  repoRoot,
} from './helpers/payment-contract';

const execFileAsync = promisify(execFile);
const LIB = join(repoRoot, 'scripts', 'lib', 'deploy-checks.sh');

async function runFn(script: string): Promise<number> {
  const child = execFileAsync('bash', ['-c', `set -uo pipefail; source '${LIB}'; ${script}`]);
  child.child.stdin?.end('');
  try {
    await child;
    return 0;
  } catch (err) {
    return (err as { code?: number }).code ?? 1;
  }
}

/**
 * Существование функции гейта предъявляется ОТДЕЛЬНО и до негативных случаев.
 * Иначе весь набор «отказ на плохом ответе» зелёный вхолостую: несуществующая функция
 * даёт ненулевой код на любом входе, то есть отсутствие реализации читалось бы как
 * работающий гейт.
 */
async function requireFn(name: string): Promise<void> {
  const rc = await runFn(`declare -F ${name} >/dev/null`);
  if (rc !== 0) {
    throw new Error(
      `функция ${name} не определена в scripts/lib/deploy-checks.sh — гейт не реализован; ` +
        'негативные случаи ниже без неё ничего не доказывают',
    );
  }
}

function mkDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-role-dist-'));
  for (const [name, html] of Object.entries(files)) writeFileSync(join(dir, name), html, 'utf-8');
  return dir;
}

/** Страница с активной формой: признак формы, объявленная база и роль артефакта. */
const withForm = (base: string, role: string): string =>
  `<!doctype html><html data-payment-role="${role}"><body>` +
  `<form data-payment-form data-payment-endpoint="${base}" hidden></form></body></html>`;

/** Страница роли без формы: роль объявлена, платёжного эндпоинта нет вовсе. */
const withoutForm = (role: string): string =>
  `<!doctype html><html data-payment-role="${role}"><body><p>Оплата по счёту</p></body></html>`;

const gate = (dist: string, base: string, role: string) =>
  runFn(`payment_endpoint_matches '${dist}' '${base}' '${role}'`);

describe('payment_endpoint_matches — ожидание по роли артефакта', () => {
  it('stand: роль и база стенда на своём origin проходят', async () => {
    const dist = mkDist({ 'index.html': withForm(PAYMENT_ENDPOINT_BASE.stand, 'stand') });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).toBe(0);
  });

  it('prod: роль и база боевого API проходят', async () => {
    const dist = mkDist({ 'index.html': withForm(PAYMENT_ENDPOINT_BASE.prod, 'prod') });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.prod, 'prod')).toBe(0);
  });

  // Негативная проверка задачи 6.14 в её же формулировке: подсунуть stand-артефакт с
  // mock-адресом. Зелёный гейт здесь означал бы mock, выданный за стенд.
  it('stand с mock-адресом роли preview не проходит', async () => {
    const dist = mkDist({ 'index.html': withForm(PREVIEW_MOCK_ENDPOINT, 'stand') });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  it('stand без формы вовсе не проходит: ноль форм в установленном контуре — отказ', async () => {
    const dist = mkDist({ 'index.html': withoutForm('stand') });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  it('роль артефакта не та, что ожидается выкладкой — отказ, хотя база верна', async () => {
    const dist = mkDist({ 'index.html': withForm(PAYMENT_ENDPOINT_BASE.stand, 'ci') });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  it('артефакт объявляет prod, выкладка ожидает stand — отказ', async () => {
    const dist = mkDist({ 'index.html': withForm(PAYMENT_ENDPOINT_BASE.prod, 'prod') });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  // «Роль не объявлена» — НЕПРОЙДЕННАЯ проверка, а не «предмета нет». Иначе потерянная
  // роль читается как разрешение пропустить проверку.
  it('роль не объявлена — отказ даже при верной базе', async () => {
    const dist = mkDist({
      'index.html':
        `<!doctype html><form data-payment-form data-payment-endpoint="${PAYMENT_ENDPOINT_BASE.stand}"></form>`,
    });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  it(`артефакт прежней матрицы (${RETIRED_DEMO_ATTR}, без роли) не проходит`, async () => {
    const dist = mkDist({
      'index.html':
        `<!doctype html><form data-payment-form data-payment-endpoint="${PREVIEW_MOCK_ENDPOINT}" ` +
        `${RETIRED_DEMO_ATTR}="true"></form>`,
    });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  it('preview: роль объявлена, форма ведёт на mock — проверка проходит', async () => {
    const dist = mkDist({ 'index.html': withForm(PREVIEW_MOCK_ENDPOINT, 'preview') });
    expect(await gate(dist, PREVIEW_MOCK_ENDPOINT, 'preview')).toBe(0);
  });

  it('preview без формы вовсе — отказ: у этой роли форма есть по контракту', async () => {
    const dist = mkDist({ 'index.html': withoutForm('preview') });
    expect(await gate(dist, PREVIEW_MOCK_ENDPOINT, 'preview')).not.toBe(0);
  });

  it('preview с базой установленного контура — отказ', async () => {
    const dist = mkDist({ 'index.html': withForm(PAYMENT_ENDPOINT_BASE.stand, 'preview') });
    expect(await gate(dist, PREVIEW_MOCK_ENDPOINT, 'preview')).not.toBe(0);
  });

  it('артефакт роли preview отвергается выкладкой stand', async () => {
    const dist = mkDist({ 'index.html': withForm(PREVIEW_MOCK_ENDPOINT, 'preview') });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  it('ci: роль объявлена, формы и эндпоинта нет по контракту роли — проверка проходит', async () => {
    const dist = mkDist({ 'index.html': withoutForm('ci') });
    expect(await gate(dist, '', 'ci')).toBe(0);
  });

  it('ci с базой установленного контура — отказ: артефакт роли ci не несёт активной формы', async () => {
    const dist = mkDist({ 'index.html': withForm(PAYMENT_ENDPOINT_BASE.prod, 'ci') });
    expect(await gate(dist, '', 'ci')).not.toBe(0);
  });

  // У роли `ci` эндпоинта нет ВОВСЕ, включая mock: адрес без формы всё равно обещает контур,
  // которого в артефакте нет, и дельта `deploy-gating` называет это отказом.
  it('ci с mock-адресом — тоже отказ, а не «почти ci»', async () => {
    const dist = mkDist({ 'index.html': withForm(PREVIEW_MOCK_ENDPOINT, 'ci') });
    expect(await gate(dist, '', 'ci')).not.toBe(0);
  });

  it('одна верная страница не покрывает вторую с чужой базой', async () => {
    const dist = mkDist({
      'index.html': withForm(PAYMENT_ENDPOINT_BASE.stand, 'stand'),
      'other.html': withForm('https://evil.example/api', 'stand'),
    });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  it('каталога сборки нет — отказ, а не проход', async () => {
    expect(await gate('/nonexistent-dist-ikpk-role', PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  it('пустой каталог сборки — отказ: предмета нет, значит проверка не выполнена', async () => {
    const dist = mkDist({});
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  // Задача 3.16(1): ОДИН И ТОТ ЖЕ артефакт CI отвергается и для stand, и для prod.
  // Проверяется обе выкладки, а не одна: «отвергается вообще» — не то же, что
  // «отвергается на том пути, который мы попробовали».
  it('артефакт роли ci отвергается выкладкой stand', async () => {
    const dist = mkDist({ 'index.html': withoutForm('ci') });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.stand, 'stand')).not.toBe(0);
  });

  it('артефакт роли ci отвергается выкладкой prod', async () => {
    const dist = mkDist({ 'index.html': withoutForm('ci') });
    expect(await gate(dist, PAYMENT_ENDPOINT_BASE.prod, 'prod')).not.toBe(0);
  });
});

/**
 * Гейт readiness (задача 6.13; спека, Requirement «Личность контура сообщается несекретным
 * readiness-ответом»). ШОВ: `payment_readiness_matches <url> <ожидаемый mode> <ожидаемый shopId>`.
 * Спека называет и адрес (`http://127.0.0.1:8787/readyz`), и точный состав ответа, но не имя
 * функции гейта — связь объявлена здесь.
 *
 * Отвечает подставной сервер: предмет — разбор ответа гейтом, а не работа платёжного сервиса.
 * Отсутствие ответа и «ответил, но не тем» различать не требуется — оба останавливают
 * публикацию, и это сознательно.
 */
describe('payment_readiness_matches — положительный признак ожидаемого контура', () => {
  let server: Server;
  let port = 0;
  let reply: { status: number; type: string; body: string } = {
    status: 200,
    type: 'application/json',
    body: JSON.stringify({ status: 'ready', mode: 'test', shopId: SERVICE_SHOP_ID.test }),
  };

  beforeAll(async () => {
    await requireFn('payment_readiness_matches');
    server = createServer((_req, res) => {
      res.writeHead(reply.status, { 'Content-Type': reply.type });
      res.end(reply.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const check = (mode: string, shopId: string, at = `http://127.0.0.1:${port}${READYZ_PATH}`) =>
    runFn(`payment_readiness_matches '${at}' '${mode}' '${shopId}'`);

  const json = (body: unknown, status = 200, type = 'application/json') => {
    reply = { status, type, body: typeof body === 'string' ? body : JSON.stringify(body) };
  };

  it('ожидаемый контур подтверждён: 200, ready, тот же mode и shopId', async () => {
    json({ status: 'ready', mode: 'test', shopId: SERVICE_SHOP_ID.test });
    expect(await check('test', SERVICE_SHOP_ID.test)).toBe(0);
  });

  it('чужой магазин при верном адресе останавливает публикацию', async () => {
    json({ status: 'ready', mode: 'test', shopId: SERVICE_SHOP_ID.prod });
    expect(await check('test', SERVICE_SHOP_ID.test)).not.toBe(0);
  });

  it('чужой режим при верном магазине останавливает публикацию', async () => {
    json({ status: 'ready', mode: 'prod', shopId: SERVICE_SHOP_ID.test });
    expect(await check('test', SERVICE_SHOP_ID.test)).not.toBe(0);
  });

  it('status не ready — отказ', async () => {
    json({ status: 'starting', mode: 'test', shopId: SERVICE_SHOP_ID.test });
    expect(await check('test', SERVICE_SHOP_ID.test)).not.toBe(0);
  });

  it('не-JSON содержимое — отказ', async () => {
    json('ready', 200, 'text/plain');
    expect(await check('test', SERVICE_SHOP_ID.test)).not.toBe(0);
  });

  it('неразбираемый JSON — отказ', async () => {
    json('{"status":"ready","mode":', 200);
    expect(await check('test', SERVICE_SHOP_ID.test)).not.toBe(0);
  });

  it.each([
    ['status', { mode: 'test', shopId: SERVICE_SHOP_ID.test }],
    ['mode', { status: 'ready', shopId: SERVICE_SHOP_ID.test }],
    ['shopId', { status: 'ready', mode: 'test' }],
  ])('нет поля %s — отказ', async (_field, body) => {
    json(body);
    expect(await check('test', SERVICE_SHOP_ID.test)).not.toBe(0);
  });

  // Три поля — состав ИСЧЕРПЫВАЮЩИЙ, а не минимальный: лишнее поле в readiness — это
  // канал утечки конфигурации, и гейт обязан считать его отклонением.
  it('лишнее поле в ответе — отказ', async () => {
    json({
      status: 'ready',
      mode: 'test',
      shopId: SERVICE_SHOP_ID.test,
      dataDir: '/var/lib/ikpk-payments/stand',
    });
    expect(await check('test', SERVICE_SHOP_ID.test)).not.toBe(0);
  });

  it('код ответа не 200 — отказ', async () => {
    json({ status: 'ready', mode: 'test', shopId: SERVICE_SHOP_ID.test }, 503);
    expect(await check('test', SERVICE_SHOP_ID.test)).not.toBe(0);
  });

  it('сервис не ответил вовсе — отказ тем же способом', async () => {
    // Закрытый порт: тот же исход, что «ответил, но не тем».
    expect(await check('test', SERVICE_SHOP_ID.test, `http://127.0.0.1:1${READYZ_PATH}`)).not.toBe(0);
  });
});

/**
 * Гейт CORS для КРОСС-ORIGIN контура (задача 6.13; спека: «Для контура, у которого API
 * раздаётся на origin, отличном от origin сайта, SHALL дополнительно проверяться CORS с origin
 * сайта»). ШОВ: `payment_cors_allows <база API> <origin сайта>`.
 *
 * Стенда это не касается по построению: он same-origin, и CORS в допуске запроса не
 * участвует — поэтому проверки «CORS у стенда» здесь нет намеренно, а не по забывчивости.
 */
describe('payment_cors_allows — прод-контур разрешает origin сайта', () => {
  let server: Server;
  let port = 0;
  let allowOrigin: string | null = 'https://ikpk.su';

  beforeAll(async () => {
    await requireFn('payment_cors_allows');
    server = createServer((_req, res) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
      res.writeHead(204, headers);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const check = () => runFn(`payment_cors_allows 'http://127.0.0.1:${port}' 'https://ikpk.su'`);

  it('разрешение для origin сайта проходит', async () => {
    allowOrigin = 'https://ikpk.su';
    expect(await check()).toBe(0);
  });

  it('заголовка нет вовсе — отказ, а не «проверять нечего»', async () => {
    allowOrigin = null;
    expect(await check()).not.toBe(0);
  });

  it('разрешение для чужого origin — отказ', async () => {
    allowOrigin = 'https://evil.example';
    expect(await check()).not.toBe(0);
  });
});

/**
 * Проба доступности ПУБЛИЧНОГО пути (задача 6.13; спека, Requirement «Установленные платёжные
 * контуры нельзя публиковать выключенными или перепутанными»: «Доступность публичного пути
 * проверяется `OPTIONS <объявленная база>/payments` с ожиданием `204`»).
 *
 * ШОВ: `payment_endpoint_reachable <объявленная база>`. Функция сама дописывает `/payments` —
 * ровно так же, как это делает клиент, и по той же причине: в артефакте объявлена БАЗА.
 *
 * Предмет здесь двойной, и второе не менее важно первого: проба обязана быть БЕЗОПАСНОЙ.
 * Поэтому проверяется не только код возврата гейта, но и то, ЧТО именно увидел сервер: один
 * запрос методом `OPTIONS` по пути `/payments`, и ни одного `POST`/`GET`. Без этой половины
 * гейт мог бы «проверять доступность» созданием платежа, и проверка выкладки стала бы
 * источником мусорных записей в тестовом магазине.
 */
describe('payment_endpoint_reachable — безопасная проба публичного пути', () => {
  let server: Server;
  let port = 0;
  let status = 204;
  let seen: { method: string; url: string }[] = [];

  beforeAll(async () => {
    await requireFn('payment_endpoint_reachable');
    server = createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '' });
      res.writeHead(status, status === 204 ? {} : { 'Content-Type': 'application/json' });
      res.end(status === 204 ? undefined : '{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const probe = (base = `http://127.0.0.1:${port}`) => {
    seen = [];
    return runFn(`payment_endpoint_reachable '${base}'`);
  };

  it('204 на OPTIONS — проба пройдена', async () => {
    status = 204;
    expect(await probe()).toBe(0);
  });

  it('проба идёт методом OPTIONS по пути /payments и ничего не создаёт', async () => {
    status = 204;
    await probe();
    expect(seen.length, `сервер увидел запросов: ${JSON.stringify(seen)}`).toBe(1);
    expect(seen[0]!.method).toBe('OPTIONS');
    expect(seen[0]!.url).toBe('/payments');
    expect(seen.some((r) => r.method === 'POST' || r.method === 'GET')).toBe(false);
  });

  it.each([200, 404, 500, 301])('код %i вместо 204 — отказ', async (code) => {
    status = code;
    expect(await probe()).not.toBe(0);
  });

  it('путь недостижим вовсе — отказ тем же способом', async () => {
    expect(await probe('http://127.0.0.1:1')).not.toBe(0);
  });
});
