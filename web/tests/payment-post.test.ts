import { afterEach, describe, expect, it } from 'vitest';
import {
  LEAD_ID_FIELD_NAMES,
  TEST_HMAC_CURRENT,
  TEST_HMAC_CURRENT_VERSION,
  prodEnv,
  validPayload,
} from './helpers/payment-contract';
import {
  jsonOf,
  postPayments,
  startPaymentService,
  type StartedService,
} from './helpers/payment-service';

let svc: StartedService | undefined;
afterEach(async () => {
  if (svc) await svc.stop();
  svc = undefined;
});

describe('3.1 POST /payments контракт', () => {
  it('валидное тело → 201 created с confirmationUrl', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const res = await jsonOf(await postPayments(svc.url, validPayload()));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'created' });
    expect(typeof (res.body as { confirmationUrl?: string }).confirmationUrl).toBe('string');
    expect((res.body as { confirmationUrl: string }).confirmationUrl.length).toBeGreaterThan(0);
  });

  it('повтор того же requestId до оплаты → 200 created', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    expect((await jsonOf(await postPayments(svc.url, body))).status).toBe(201);
    const second = await jsonOf(await postPayments(svc.url, body));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'created' });
  });
});

describe('3.1a receipt по явному RECEIPT_ENABLED', () => {
  it('RECEIPT_ENABLED=true — запрос к оператору содержит receipt.customer.email и items', async () => {
    svc = await startPaymentService({ env: prodEnv({ RECEIPT_ENABLED: 'true' }) });
    await postPayments(svc.url, validPayload({ email: 'receipt@example.com' }));
    const sent = svc.yookassa.creates.at(-1)?.body as Record<string, unknown>;
    expect(sent, 'мок создания не вызван').toBeTruthy();
    expect(sent).toHaveProperty('receipt');
    const receipt = sent.receipt as { customer?: { email?: string }; items?: unknown[] };
    expect(receipt.customer?.email).toBe('receipt@example.com');
    expect(Array.isArray(receipt.items) && receipt.items.length > 0).toBe(true);
  });

  it('RECEIPT_ENABLED=false — поле receipt отсутствует вовсе', async () => {
    svc = await startPaymentService({ env: prodEnv({ RECEIPT_ENABLED: 'false' }) });
    await postPayments(svc.url, validPayload());
    const sent = svc.yookassa.creates.at(-1)?.body as Record<string, unknown>;
    expect(sent).toBeTruthy();
    expect(sent).not.toHaveProperty('receipt');
  });

  it('ошибка валидации чека при true — общее error, не особое состояние', async () => {
    svc = await startPaymentService({ env: prodEnv({ RECEIPT_ENABLED: 'true' }) });
    svc.yookassa.setCreateHandler(() => ({
      status: 400,
      body: { type: 'error', description: 'Invalid receipt' },
    }));
    const res = await jsonOf(await postPayments(svc.url, validPayload()));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body).toMatchObject({ status: 'error' });
  });
});

describe('3.2 идемпотентность: совпадение в своей таблице не зовёт оператора', () => {
  it('два POST с одним requestId — второй не вызывает мок создания', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    expect((await jsonOf(await postPayments(svc.url, body))).status).toBe(201);
    expect(svc.yookassa.creates.length).toBe(1);
    const second = await jsonOf(await postPayments(svc.url, body));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'created' });
    expect(svc.yookassa.creates.length, 'второй POST вызвал создание у оператора').toBe(1);
  });
});

describe('3.2a отпечаток при нетерминальном статусе', () => {
  it('тот же requestId и то же содержимое при pending — обычный повтор', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const again = await jsonOf(await postPayments(svc.url, body));
    expect(again.status).toBe(200);
    expect((again.body as { status: string }).status).toBe('created');
  });

  it('тот же requestId, другая сумма, pending → 503 verification_required, не 409', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload({ amount: 1 });
    await postPayments(svc.url, body);
    const changed = await jsonOf(await postPayments(svc.url, { ...body, amount: 2 }));
    expect(changed.status).toBe(503);
    expect(changed.body).toMatchObject({ status: 'verification_required', requestId: body.requestId });
  });
});

describe('3.2b шесть случаев итогового порядка', () => {
  it('(а) после плановой ротации повтор с прежним содержимым — совпадение', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    expect((await jsonOf(await postPayments(svc.url, body))).status).toBe(201);
    const records = svc.readRecords();
    await svc.stop();
    svc = await startPaymentService({
      env: prodEnv({
        HMAC_KEY_CURRENT: 'rotated-current',
        HMAC_KEY_CURRENT_VERSION: '2026-08-14',
        HMAC_KEY_PREVIOUS: TEST_HMAC_CURRENT,
        HMAC_KEY_PREVIOUS_VERSION: TEST_HMAC_CURRENT_VERSION,
      }),
      seedRecords: records,
    });
    const again = await jsonOf(await postPayments(svc.url, body));
    expect(again.status).toBe(200);
    expect((again.body as { status: string }).status).toBe('created');
  });

  it('(б) две ротации подряд, pending → verification_required независимо от содержимого', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const records = svc.readRecords();
    await svc.stop();
    svc = await startPaymentService({
      env: prodEnv({
        HMAC_KEY_CURRENT: 'k3',
        HMAC_KEY_CURRENT_VERSION: 'v3',
        HMAC_KEY_PREVIOUS: 'k2',
        HMAC_KEY_PREVIOUS_VERSION: 'v2',
      }),
      seedRecords: records,
    });
    const again = await jsonOf(await postPayments(svc.url, body));
    expect(again.status).toBe(503);
    expect(again.body).toMatchObject({ status: 'verification_required' });
  });

  it('(в) succeeded со старой версией ключа → already_paid, отпечаток не проверяется', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const records = svc.readRecords().map((r) => ({ ...r, status: 'succeeded' }));
    await svc.stop();
    svc = await startPaymentService({
      env: prodEnv({
        HMAC_KEY_CURRENT: 'k3',
        HMAC_KEY_CURRENT_VERSION: 'v3',
        HMAC_KEY_PREVIOUS: 'k2',
        HMAC_KEY_PREVIOUS_VERSION: 'v2',
      }),
      seedRecords: records,
    });
    const again = await jsonOf(await postPayments(svc.url, body));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'already_paid' });
  });

  it('(г) pending, известная версия, другое содержимое → 503, не 409', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload({ amount: 1 });
    await postPayments(svc.url, body);
    const changed = await jsonOf(await postPayments(svc.url, { ...body, seminar: 'Другой семинар' }));
    expect(changed.status).toBe(503);
    expect((changed.body as { status: string }).status).toBe('verification_required');
  });

  it('(д) canceled, известная версия, другое содержимое → 409', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const records = svc.readRecords().map((r) => ({ ...r, status: 'canceled' }));
    svc.writeRecords(records);
    const changed = await jsonOf(await postPayments(svc.url, { ...body, amount: 5000 }));
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ status: 'rejected' });
  });

  it('(е) canceled, неизвестная версия ключа → 200 canceled, не verification_required и не 409', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const records = svc.readRecords().map((r) => ({
      ...r,
      status: 'canceled',
      keyVersion: 'ancient-version',
    }));
    await svc.stop();
    svc = await startPaymentService({
      env: prodEnv({
        HMAC_KEY_CURRENT: 'k3',
        HMAC_KEY_CURRENT_VERSION: 'v3',
        HMAC_KEY_PREVIOUS: 'k2',
        HMAC_KEY_PREVIOUS_VERSION: 'v2',
      }),
      seedRecords: records,
    });
    const again = await jsonOf(await postPayments(svc.url, body));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'canceled' });
  });
});

describe('3.6 сумма: только положительность, без границ', () => {
  it.each([0, -1, 'abc', 1.5])('%s отклонена', async (amount) => {
    svc = await startPaymentService({ env: prodEnv() });
    const res = await jsonOf(await postPayments(svc.url, { ...validPayload(), amount }));
    expect([400, 422]).toContain(res.status);
    expect(res.body).toMatchObject({ status: 'rejected' });
  });

  it('1 принята', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const res = await jsonOf(await postPayments(svc.url, validPayload({ amount: 1 })));
    expect(res.status).toBe(201);
  });

  it('200001 принята — забытая верхняя граница краснеет именно здесь', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const res = await jsonOf(await postPayments(svc.url, validPayload({ amount: 200001 })));
    expect(res.status).toBe(201);
  });
});

describe('3.6a формат requestId', () => {
  it('не-UUID отклоняется 400 до обращения к моку оператора', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const res = await jsonOf(await postPayments(svc.url, validPayload({ requestId: 'not-a-uuid' })));
    expect(res.status).toBe(400);
    expect(svc.yookassa.creates.length, 'невалидный requestId ушёл к оператору').toBe(0);
  });
});

describe('3.6b оплата не требует заявки и не создаёт её', () => {
  it('в схеме нет обязательного leadId/dealId, запрос без них создаёт платёж', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    for (const name of LEAD_ID_FIELD_NAMES) {
      expect(body).not.toHaveProperty(name);
    }
    const res = await jsonOf(await postPayments(svc.url, body));
    expect(res.status).toBe(201);
  });

  it('исходящие обращения — только мок оператора, не CRM', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    await postPayments(svc.url, validPayload());
    expect(svc.yookassa.creates.length).toBeGreaterThan(0);
    expect(svc.outbound.length, 'исходящих обращений нет — наблюдатель ничего не измерил').toBeGreaterThan(
      0,
    );
    const foreign = svc.outbound.filter((c) => !c.url.startsWith(svc!.yookassa.url));
    expect(foreign, `обработчик ходил мимо оператора: ${JSON.stringify(foreign)}`).toEqual([]);
  });
});

// Вторая половина задачи 3.3a: она была записана в задаче, но теста не имела — слово
// `capture` не встречалось ни в одном тесте и ни в одном исходнике. Именно этот пробел
// пропустил дефект: 17.08.2026 живой прогон против тестового магазина ЮKassa показал,
// что оплаченный платёж уходит в `waiting_for_capture` (`paid: true`, `expires_at` через
// 7 суток), а наш GET отдаёт `unknown` — то есть посетитель с замороженными деньгами
// видит «нужна сверка». Причинность закрыта контролем на том же магазине: тот же
// кошелёк и сумма, разница в одном поле — с `capture: true` статус `succeeded`
// (`captured_at` заполнен).
//
// Мок обнаружить это требование не мог и не может: он отвечает то, что ему велели. Тест
// ниже стережёт ПРОВОДКУ (поле уходит в запрос), а не поведение оператора; живой прогон
// остаётся задачей 7.4.
describe('3.3a (вторая половина) создание платежа объявляет одностадийный режим', () => {
  it('запрос к оператору содержит capture: true', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    await postPayments(svc.url, validPayload());
    const sent = svc.yookassa.creates.at(-1)?.body as Record<string, unknown>;
    expect(sent, 'мок создания не вызван').toBeTruthy();
    expect(sent.capture).toBe(true);
  });

  it('режим не оставлен на умолчание оператора: поле присутствует явно', async () => {
    svc = await startPaymentService({ env: prodEnv({ RECEIPT_ENABLED: 'true' }) });
    await postPayments(svc.url, validPayload());
    const sent = svc.yookassa.creates.at(-1)?.body as Record<string, unknown>;
    expect(Object.keys(sent)).toContain('capture');
    expect(sent.capture).toBe(true);
  });
});

// Наблюдение 17.08.2026: чек без `vat_code` ЮKassa отвергает — `400 invalid_request`,
// `parameter: receipt.items[0].vat_code`. Наш код его не отправлял вовсе, поэтому с
// включёнными чеками платёж не создавался НИКОГДА, а причина скрывалась за 502
// `{"status":"error"}`. Значение берётся из окружения: какой код НДС верен для ИКПК —
// ответ заказчика (2.9), константой это ставить нельзя.
describe('3.1b чек несёт vat_code из конфигурации', () => {
  it('каждый элемент чека несёт vat_code из RECEIPT_VAT_CODE', async () => {
    svc = await startPaymentService({ env: prodEnv({ RECEIPT_ENABLED: 'true', RECEIPT_VAT_CODE: '4' }) });
    await postPayments(svc.url, validPayload());
    const sent = svc.yookassa.creates.at(-1)?.body as Record<string, unknown>;
    const items = (sent.receipt as { items?: Array<Record<string, unknown>> }).items ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.vat_code).toBe(4);
  });
});
