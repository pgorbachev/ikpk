import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prodEnv, validPayload } from './helpers/payment-contract';
import {
  getStatus,
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

describe('3.3 GET .../status: сопоставление и два предела', () => {
  it('pending оператора → pending клиенту', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const res = await jsonOf(await getStatus(svc.url, body.requestId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'pending' });
  });

  it('succeeded оператора → succeeded', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const id = svc.readRecords()[0]?.yookassaPaymentId ?? '';
    svc.yookassa.setGetHandler(() => ({ status: 200, body: { id, status: 'succeeded' } }));
    const res = await jsonOf(await getStatus(svc.url, body.requestId));
    expect(res.body).toMatchObject({ status: 'succeeded' });
  });

  it('canceled оператора → canceled', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    svc.yookassa.setGetHandler((id) => ({ status: 200, body: { id, status: 'canceled' } }));
    const res = await jsonOf(await getStatus(svc.url, body.requestId));
    expect(res.body).toMatchObject({ status: 'canceled' });
  });

  it('мок оператора молчит 9 секунд — сервер отвечает unknown за счёт внутреннего 8с, не клиентского 15с', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    svc.yookassa.setGetHandler(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: 200, body: { status: 'pending' } }), 9000);
        }),
    );
    const started = Date.now();
    const res = await jsonOf(await getStatus(svc.url, body.requestId));
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'unknown' });
    expect(elapsed, 'сервер ждал дольше внутреннего предела 8с').toBeLessThan(12000);
    expect(elapsed, 'сервер ответил раньше внутреннего таймаута — не отличить от мгновенного unknown').toBeGreaterThan(7000);
  }, 20000);
});

describe('3.3b серверный домен GET', () => {
  it('verificationAt, нет yookassaPaymentId, нетерминальный → verification_required', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const records = svc.readRecords().map((r) => ({
      ...r,
      yookassaPaymentId: null,
      status: 'unknown',
      verificationAt: new Date().toISOString(),
      verificationReason: 'unknown_key_version',
    }));
    svc.writeRecords(records);
    const res = await jsonOf(await getStatus(svc.url, body.requestId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'verification_required' });
  });

  it('verificationAt ЕСТЬ, yookassaPaymentId ЕСТЬ, нетерминальный → фактический статус, не verification_required', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const records = svc.readRecords().map((r) => ({
      ...r,
      status: 'pending',
      verificationAt: new Date().toISOString(),
      verificationReason: 'fingerprint_match',
    }));
    svc.writeRecords(records);
    svc.yookassa.setGetHandler((id) => ({ status: 200, body: { id, status: 'pending' } }));
    const res = await jsonOf(await getStatus(svc.url, body.requestId));
    expect(res.body).toMatchObject({ status: 'pending' });
    expect((res.body as { status: string }).status).not.toBe('verification_required');
  });

  it('verificationAt + терминальный succeeded → succeeded, не verification_required', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const records = svc.readRecords().map((r) => ({
      ...r,
      status: 'succeeded',
      verificationAt: new Date().toISOString(),
    }));
    svc.writeRecords(records);
    const res = await jsonOf(await getStatus(svc.url, body.requestId));
    expect(res.body).toMatchObject({ status: 'succeeded' });
  });

  it('незнакомый requestId → 404 not_found, отличимо от unknown', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const res = await jsonOf(await getStatus(svc.url, randomUUID()));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 'not_found' });
  });

  it('запись без определённого статуса → unknown', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const records = svc.readRecords().map((r) => ({ ...r, status: 'unknown' }));
    svc.writeRecords(records);
    svc.yookassa.setGetHandler(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: 200, body: { status: 'pending' } }), 9000);
        }),
    );
    const res = await jsonOf(await getStatus(svc.url, body.requestId));
    expect(res.body).toMatchObject({ status: 'unknown' });
  }, 20000);

  it('демонстрационный обработчик GET → { status: demo }', async () => {
    svc = await startPaymentService({ env: { PAYMENT_MODE: 'demo' } });
    const res = await jsonOf(await getStatus(svc.url, randomUUID()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'demo' });
  });

  it('GET статуса не создаёт платёж у оператора', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const creates = svc.yookassa.creates.length;
    await getStatus(svc.url, body.requestId);
    expect(svc.yookassa.creates.length, 'GET создал платёж').toBe(creates);
  });
});

describe('3.3a неизвестный статус оператора → unknown, никогда success', () => {
  it('статус вне succeeded/canceled/pending, в том числе не из сегодняшнего перечня, → unknown', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    svc.yookassa.setGetHandler((id) => ({
      status: 200,
      body: { id, status: 'future_unknown_status_zz9' },
    }));
    const res = await jsonOf(await getStatus(svc.url, body.requestId));
    expect(res.body).toMatchObject({ status: 'unknown' });
    expect((res.body as { status: string }).status).not.toBe('succeeded');
  });

  it('повтор по такой записи идёт как нетерминальный: новый requestId не нужен, verification_required при смене содержимого', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    svc.yookassa.setGetHandler((id) => ({
      status: 200,
      body: { id, status: 'future_unknown_status_zz9' },
    }));
    await getStatus(svc.url, body.requestId);
    const changed = await jsonOf(await postPayments(svc.url, { ...body, amount: 2 }));
    expect(changed.status).toBe(503);
    expect(changed.body).toMatchObject({ status: 'verification_required' });
  });
});
