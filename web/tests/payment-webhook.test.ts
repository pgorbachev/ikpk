import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prodEnv, validPayload } from './helpers/payment-contract';
import {
  jsonOf,
  postPayments,
  postWebhook,
  startPaymentService,
  type StartedService,
} from './helpers/payment-service';

let svc: StartedService | undefined;
afterEach(async () => {
  if (svc) await svc.stop();
  svc = undefined;
});

describe('3.10b webhook не доверяет телу', () => {
  it('тело с succeeded не меняет статус, пока мок API не подтвердит', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const rec = svc.readRecords()[0];
    expect(rec?.status).not.toBe('succeeded');
    svc.yookassa.setGetHandler((id) => ({ status: 200, body: { id, status: 'pending' } }));
    await postWebhook(svc.url, {
      event: 'payment.succeeded',
      object: { id: rec?.yookassaPaymentId, status: 'succeeded' },
    });
    expect(svc.readRecords()[0]?.status).not.toBe('succeeded');
  });

  it('запрос на путь webhook по HTTP не обрабатывается как действительное уведомление', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const before = svc.readRecords()[0]?.status;
    svc.yookassa.setGetHandler((id) => ({ status: 200, body: { id, status: 'succeeded' } }));
    await postWebhook(svc.url, {
      event: 'payment.succeeded',
      object: { id: svc.readRecords()[0]?.yookassaPaymentId, status: 'succeeded' },
    });
    expect(svc.url.startsWith('http://')).toBe(true);
    expect(svc.readRecords()[0]?.status).toBe(before);
  });
});

describe('3.10e незнакомый платёж не создаёт запись', () => {
  it('id отсутствует в таблице, даже если мок API говорит «действителен» — новой записи нет', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const stranger = `stranger-${randomUUID()}`;
    svc.yookassa.setGetHandler((id) => ({
      status: 200,
      body: { id, status: 'succeeded', metadata: { requestId: randomUUID(), source: 'ikpk-site' } },
    }));
    const before = svc.readRecords().length;
    await postWebhook(svc.url, { object: { id: stranger, status: 'succeeded' } });
    expect(svc.readRecords().length).toBe(before);
    expect(svc.readRecords().some((r) => r.yookassaPaymentId === stranger)).toBe(false);
  });
});

describe('3.10e-1 восстановление записи без yookassaPaymentId', () => {
  async function openUnknown() {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    svc.writeRecords(svc.readRecords().map((r) => ({ ...r, yookassaPaymentId: null, status: 'unknown' })));
    return body;
  }

  it('позитив: авторитетный ответ несёт наш requestId и признак канала, запись существует без id — id и статус записываются в существующую', async () => {
    const body = await openUnknown();
    const ykId = `yk-restored-${randomUUID()}`;
    svc!.yookassa.setGetHandler((id) => ({
      status: 200,
      body: {
        id,
        status: 'pending',
        metadata: { requestId: body.requestId, source: 'ikpk-site' },
      },
    }));
    const beforeCount = svc!.readRecords().length;
    await postWebhook(svc!.url, { object: { id: ykId } });
    const rec = svc!.readRecords().find((r) => r.requestId === body.requestId);
    expect(svc!.readRecords().length).toBe(beforeCount);
    expect(rec?.yookassaPaymentId).toBe(ykId);
    expect(rec?.status).toBe('pending');
  });

  it('(1) метаданных нет — игнор, записей не прибыло', async () => {
    const body = await openUnknown();
    const ykId = `yk-${randomUUID()}`;
    svc!.yookassa.setGetHandler((id) => ({ status: 200, body: { id, status: 'pending' } }));
    const before = structuredClone(svc!.readRecords());
    await postWebhook(svc!.url, { object: { id: ykId } });
    expect(svc!.readRecords()).toEqual(before);
    void body;
  });

  it('(2) признак канала не наш — игнор', async () => {
    const body = await openUnknown();
    const ykId = `yk-${randomUUID()}`;
    svc!.yookassa.setGetHandler((id) => ({
      status: 200,
      body: { id, status: 'pending', metadata: { requestId: body.requestId, source: 'bitrix-widget' } },
    }));
    const before = structuredClone(svc!.readRecords());
    await postWebhook(svc!.url, { object: { id: ykId } });
    expect(svc!.readRecords()).toEqual(before);
  });

  it('(3) requestId из метаданных неизвестен — игнор, новая запись не создана', async () => {
    await openUnknown();
    const ykId = `yk-${randomUUID()}`;
    svc!.yookassa.setGetHandler((id) => ({
      status: 200,
      body: {
        id,
        status: 'pending',
        metadata: { requestId: randomUUID(), source: 'ikpk-site' },
      },
    }));
    const before = structuredClone(svc!.readRecords());
    await postWebhook(svc!.url, { object: { id: ykId } });
    expect(svc!.readRecords()).toEqual(before);
  });

  it('(4) идентификатор уже связан с другой записью — игнор', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const a = validPayload();
    const b = validPayload({ seminar: 'Другой' });
    await postPayments(svc.url, a);
    await postPayments(svc.url, b);
    const aId = svc.readRecords().find((r) => r.requestId === a.requestId)!.yookassaPaymentId;
    svc.writeRecords(
      svc.readRecords().map((r) => (r.requestId === b.requestId ? { ...r, yookassaPaymentId: null } : r)),
    );
    svc.yookassa.setGetHandler((id) => ({
      status: 200,
      body: { id, status: 'pending', metadata: { requestId: b.requestId, source: 'ikpk-site' } },
    }));
    const before = structuredClone(svc.readRecords());
    await postWebhook(svc.url, { object: { id: aId } });
    expect(svc.readRecords().find((r) => r.requestId === b.requestId)?.yookassaPaymentId).toBeNull();
    expect(svc.readRecords().find((r) => r.requestId === a.requestId)?.yookassaPaymentId).toBe(aId);
    expect(svc.readRecords().length).toBe(before.length);
  });

  it('(5) тело уведомления врёт про наши метаданные, ответ API их не подтверждает — судится по записям', async () => {
    const body = await openUnknown();
    const ykId = `yk-${randomUUID()}`;
    svc!.yookassa.setGetHandler((id) => ({
      status: 200,
      body: { id, status: 'pending', metadata: { requestId: 'other', source: 'other' } },
    }));
    const before = structuredClone(svc!.readRecords());
    await postWebhook(svc!.url, {
      object: {
        id: ykId,
        metadata: { requestId: body.requestId, source: 'ikpk-site' },
      },
    });
    expect(svc!.readRecords()).toEqual(before);
  });
});
