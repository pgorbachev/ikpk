/**
 * Матрица контуров: РОЛИ УСТАНОВЛЕННОГО СЕРВИСА и readiness (задачи 4.10, 4.10a, 3.16).
 *
 * Предмет — поведение процесса, а не текст конфигурации: режим сервиса (`test|prod`),
 * его привязка к закреплённому магазину, несекретный `GET /readyz`, база возврата
 * контура и изоляция записей между контурами.
 *
 * Источник требований (change `online-payment-flow`):
 *  - `specs/online-payment/spec.md`, Requirement «Единая проверка обязательных секретов
 *    при старте, один исход», сценарии «Роль сервиса не совпадает с магазином» и «Не
 *    заданный или нераспознанный режим останавливает запуск тем же способом»;
 *  - там же, Requirement «Личность контура сообщается несекретным readiness-ответом»
 *    (три поля — исчерпывающий состав, `/readyz` наружу не публикуется);
 *  - там же, Requirement «Установленные платёжные контуры нельзя публиковать
 *    выключенными или перепутанными», сценарии «Возврат после оплаты приходит на тот же
 *    контур», «Стенд публикуется только с тестовым магазином», «Одинаковый идентификатор
 *    в двух контурах не связывает записи»;
 *  - там же, Requirement «CI/preview не создаёт платежей, а развёрнутый стенд работает с
 *    тестовым магазином», сценарий «Развёрнутый стенд создаёт тестовый платёж».
 *
 * ПОЧЕМУ ЭТИ ТЕСТЫ КРАСНЫЕ СЕЙЧАС: `payments/src/app.ts` знает ровно два режима
 * (`demo`, `prod`), не сверяет `YOOKASSA_SHOP_ID` с режимом вовсе и не имеет маршрута
 * `/readyz` (проверено на `12f2135` (продуктовый код с `ac4089b` не менялся: обе поставки — спека и тесты), `validateProdEnv` и `dispatch`). То есть красное —
 * отсутствие реализации, а не сломанная обвязка: `assertPaymentServiceExists` отличает
 * «файла нет» от «порт не слушает» ещё до проверки порта.
 *
 * ШОВ, ВЫБРАННЫЙ ТЕСТАМИ (спека называет наблюдаемое, а не имена переменных):
 * `PAYMENT_MODE=test|prod`, `YOOKASSA_SHOP_ID`, `PAYMENT_RETURN_BASE`,
 * `PAYMENT_LISTEN_HOST`/`PAYMENT_LISTEN_PORT` — имена уже существующие в коде;
 * `GET /readyz` — имя из спеки. Переименование любого из них ломает эти тесты, и это
 * осознанная жёсткая связь, а не случайная.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  PAYMENT_ROLES,
  PAYMENT_RETURN_BASE_PROD,
  PAYMENT_RETURN_BASE_STAND,
  READYZ_PATH,
  SERVICE_SHOP_ID,
  TEST_HMAC_CURRENT,
  TEST_HMAC_PREVIOUS,
  TEST_YOOKASSA_SECRET,
  prodEnv,
  validPayload,
} from './helpers/payment-contract';
import {
  getStatus,
  jsonOf,
  postPayments,
  spawnPaymentProcess,
  startPaymentService,
  type StartedService,
} from './helpers/payment-service';

/** Полный набор платёжной конфигурации для контура: меняется только режим и магазин. */
function contourEnv(
  mode: 'test' | 'prod',
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  return prodEnv({
    PAYMENT_MODE: mode,
    YOOKASSA_SHOP_ID: SERVICE_SHOP_ID[mode],
    PAYMENT_RETURN_BASE: mode === 'test' ? PAYMENT_RETURN_BASE_STAND : PAYMENT_RETURN_BASE_PROD,
    ...overrides,
  });
}

const started: StartedService[] = [];
async function startContour(
  mode: 'test' | 'prod',
  overrides: Record<string, string | undefined> = {},
): Promise<StartedService> {
  const s = await startPaymentService({ env: contourEnv(mode, overrides) });
  started.push(s);
  return s;
}

afterEach(async () => {
  while (started.length) {
    const s = started.pop();
    if (s) await s.stop().catch(() => undefined);
  }
});

describe('4.10 роль установленного сервиса — только test|prod, и каждая привязана к своему магазину', () => {
  it('test с тестовым магазином 1440249 открывает порт', async () => {
    const r = await spawnPaymentProcess({ env: contourEnv('test') });
    expect(r.listening, `test/1440249 не слушает:\n${r.stderr}${r.stdout}`).toBe(true);
  });

  it('prod с боевым магазином 409285 открывает порт', async () => {
    const r = await spawnPaymentProcess({ env: contourEnv('prod') });
    expect(r.listening, `prod/409285 не слушает:\n${r.stderr}${r.stdout}`).toBe(true);
  });

  it('test с БОЕВЫМ магазином не открывает порт — тем же исходом, что недостающий секрет', async () => {
    const r = await spawnPaymentProcess({
      env: contourEnv('test', { YOOKASSA_SHOP_ID: SERVICE_SHOP_ID.prod }),
    });
    expect(r.listening).toBe(false);
    expect(r.connection).toBe('refused');
    expect(r.exitCode).not.toBe(0);
  });

  it('prod с ТЕСТОВЫМ магазином не открывает порт', async () => {
    const r = await spawnPaymentProcess({
      env: contourEnv('prod', { YOOKASSA_SHOP_ID: SERVICE_SHOP_ID.test }),
    });
    expect(r.listening).toBe(false);
    expect(r.connection).toBe('refused');
    expect(r.exitCode).not.toBe(0);
  });

  it('test без магазина не открывает порт', async () => {
    const r = await spawnPaymentProcess({ env: contourEnv('test', { YOOKASSA_SHOP_ID: undefined }) });
    expect(r.listening).toBe(false);
    expect(r.connection).toBe('refused');
  });

  // Битый идентификатор магазина — отдельная ветвь: «похоже на тестовый» не значит
  // «тестовый». Пробел на конце и лишний символ уводят запрос в чужой магазин так же
  // надёжно, как другое число, а по журналу это выглядит опечаткой, не отказом.
  it.each(['1440249 ', ' 1440249', '01440249', '1440249\n', 'shop-1440249', ''])(
    'test с битым shopId %j не открывает порт',
    async (shopId) => {
      const r = await spawnPaymentProcess({ env: contourEnv('test', { YOOKASSA_SHOP_ID: shopId }) });
      expect(r.listening).toBe(false);
      expect(r.connection).toBe('refused');
    },
  );

  // Роль СБОРКИ и режим СЕРВИСА — разные значения (спека: «Совпадение имён не
  // предполагается»). Подстановка роли сборки в режим сервиса — ошибка, а не синоним, и
  // перечень таких значений НЕ выписан руками: он выведен из набора ролей, поэтому новая
  // роль попадает под проверку сама. Совпадающее имя (`prod`) из перечня исключено — там
  // отображение как раз законно.
  const SERVICE_MODES = ['demo', 'test', 'prod'];
  const ROLE_NAMES_THAT_ARE_NOT_MODES = PAYMENT_ROLES.filter((r) => !SERVICE_MODES.includes(r));

  it.each([...ROLE_NAMES_THAT_ARE_NOT_MODES, 'TEST', 'Prod', 'mock', 'staging', 'test,prod'])(
    'нераспознанный режим %j не открывает порт и не трактуется как демонстрационный',
    async (mode) => {
      const r = await spawnPaymentProcess({ env: contourEnv('test', { PAYMENT_MODE: mode }) });
      expect(r.listening).toBe(false);
      expect(r.connection).toBe('refused');
      expect(r.exitCode).not.toBe(0);
    },
  );
});

describe('4.10a GET /readyz — несекретный признак личности контура', () => {
  it('test отвечает 200, application/json и РОВНО тремя полями test/1440249', async () => {
    const s = await startContour('test');
    const res = await fetch(`${s.url}${READYZ_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^application\/json\b/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ready', mode: 'test', shopId: SERVICE_SHOP_ID.test });
    expect(Object.keys(body).sort()).toEqual(['mode', 'shopId', 'status']);
  });

  it('prod отвечает теми же тремя полями prod/409285', async () => {
    const s = await startContour('prod');
    const res = await fetch(`${s.url}${READYZ_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ready', mode: 'prod', shopId: SERVICE_SHOP_ID.prod });
  });

  it('отвечает без учётных данных: запрос без заголовков авторизации получает 200', async () => {
    const s = await startContour('test');
    const res = await fetch(`${s.url}${READYZ_PATH}`, { headers: {} });
    expect(res.status).toBe(200);
  });

  it('в ответе нет ни секрета ЮKassa, ни ключей отпечатка, ни диагностических подробностей', async () => {
    const s = await startContour('test');
    const text = await (await fetch(`${s.url}${READYZ_PATH}`)).text();
    for (const secret of [TEST_YOOKASSA_SECRET, TEST_HMAC_CURRENT, TEST_HMAC_PREVIOUS]) {
      expect(text.includes(secret), `readiness раскрыл секрет: ${secret.slice(0, 12)}…`).toBe(false);
    }
    // Состав ИСЧЕРПЫВАЮЩИЙ, а не минимальный: лишнее поле — тоже отклонение.
    expect(text).not.toMatch(/version|path|dataDir|env|key|storage|journal/i);
  });

  // CI/mock не выдаётся за установленный контур: иначе гейт публикации примет
  // демонстрационный процесс за стенд с настоящим тестовым магазином.
  it('демонстрационный режим не сообщает mode test|prod', async () => {
    const s = await startPaymentService({ env: { PAYMENT_MODE: 'demo' } });
    started.push(s);
    const res = await fetch(`${s.url}${READYZ_PATH}`);
    if (res.status === 200) {
      const body = (await res.json()) as Record<string, unknown>;
      expect(['test', 'prod']).not.toContain(body.mode);
      expect(body.shopId).not.toBe(SERVICE_SHOP_ID.test);
      expect(body.shopId).not.toBe(SERVICE_SHOP_ID.prod);
    } else {
      expect(res.status).not.toBe(200);
    }
  });
});

describe('3.16(2)/5.10e стенд создаёт платёж в 1440249 и возвращает посетителя на свой origin', () => {
  it('создание платежа в режиме test уходит в магазин 1440249, а не 409285', async () => {
    const s = await startContour('test');
    const res = await postPayments(s.url, validPayload());
    expect(res.status, `создание платежа не прошло: ${await res.text()}`).toBe(200);
    expect(s.yookassa.creates.length).toBe(1);
    const auth = s.yookassa.creates[0]!.headers.authorization ?? '';
    const decoded = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    expect(decoded.startsWith(`${SERVICE_SHOP_ID.test}:`), `магазин в запросе: ${decoded.split(':')[0]}`).toBe(true);
    expect(decoded.startsWith(`${SERVICE_SHOP_ID.prod}:`)).toBe(false);
  });

  it('return_url строится от базы возврата ЭТОГО контура, а не от боевого сайта', async () => {
    const s = await startContour('test');
    const payload = validPayload();
    const res = await postPayments(s.url, payload);
    expect(res.status).toBe(200);
    const body = s.yookassa.creates[0]!.body as { confirmation?: { return_url?: string } };
    const returnUrl = body.confirmation?.return_url ?? '';
    expect(returnUrl).toBe(`${PAYMENT_RETURN_BASE_STAND}/oplata?paymentRequest=${payload.requestId}`);
    expect(returnUrl.startsWith(PAYMENT_RETURN_BASE_PROD)).toBe(false);
  });

  // Умолчание, указывающее на боевой сайт, для стенда недопустимо. Объективный исход
  // выбран тот же, что у любого недостающего обязательного значения: порт не открыт.
  // Если владелец предпочтёт «только конфигурацией инстанции, без fail-closed», предмет
  // проверки переезжает в конфигурацию — см. отчёт сессии, пункт A1.
  it('режим test без PAYMENT_RETURN_BASE не открывает порт, а не подставляет боевой origin', async () => {
    const r = await spawnPaymentProcess({
      env: contourEnv('test', { PAYMENT_RETURN_BASE: undefined }),
    });
    expect(r.listening).toBe(false);
    expect(r.connection).toBe('refused');
  });
});

describe('3.16(6) одинаковый requestId в двух контурах адресует независимые записи', () => {
  it('production не находит стендовую запись и не обращается по ней к тестовому магазину', async () => {
    const stand = await startContour('test');
    const prod = await startContour('prod');

    const payload = validPayload();
    const created = await postPayments(stand.url, payload);
    expect(created.status).toBe(200);
    expect(stand.readRecords().map((r) => r.requestId)).toContain(payload.requestId);

    const yooGetsBefore = prod.yookassa.gets.length;
    const answer = await jsonOf(await getStatus(prod.url, payload.requestId));
    expect(answer.status, `production ответил про чужую запись: ${JSON.stringify(answer.body)}`).toBe(404);
    expect(prod.readRecords()).toEqual([]);
    expect(prod.yookassa.gets.length).toBe(yooGetsBefore);
    // Обратная сторона: чужой запрос не изменил стендовую запись.
    expect(stand.readRecords().length).toBe(1);
  });
});
