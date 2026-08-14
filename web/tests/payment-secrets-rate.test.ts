import { afterEach, describe, expect, it } from 'vitest';
import { TEST_HMAC_CURRENT, TEST_YOOKASSA_SECRET, prodEnv, validPayload } from './helpers/payment-contract';
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

describe('3.4 секреты не в ответе и не в логе', () => {
  it('401 от мока оператора не протекает ни тестовым секретом ЮKassa, ни HMAC-ключом', async () => {
    const logs: string[] = [];
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return stderrWrite(chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return stdoutWrite(chunk as never, ...(rest as never[]));
    }) as typeof process.stdout.write;
    try {
      svc = await startPaymentService({ env: prodEnv() });
      svc.yookassa.setCreateHandler(() => ({
        status: 401,
        body: { type: 'error', description: 'Unauthorized' },
      }));
      const res = await jsonOf(await postPayments(svc.url, validPayload()));
      const payload = JSON.stringify(res.body);
      expect(payload).not.toContain(TEST_YOOKASSA_SECRET);
      expect(payload).not.toContain(TEST_HMAC_CURRENT);
      const joined = logs.join('\n');
      expect(joined).not.toContain(TEST_YOOKASSA_SECRET);
      expect(joined).not.toContain(TEST_HMAC_CURRENT);
    } finally {
      process.stderr.write = stderrWrite;
      process.stdout.write = stdoutWrite;
    }
  });
});

describe('3.5 / 3.5a лимит частоты', () => {
  it('3.5 N+1-й POST с одного источника → видимая ошибка, не 200 и не тихий отказ', async () => {
    svc = await startPaymentService({
      env: prodEnv({ PAYMENT_POST_RATE_LIMIT: '2', PAYMENT_RATE_LIMIT_WINDOW_MS: '60000' }),
    });
    const headers = { 'x-forwarded-for': '203.0.113.10' };
    expect((await jsonOf(await postPayments(svc.url, validPayload(), headers))).status).toBe(201);
    expect((await jsonOf(await postPayments(svc.url, validPayload(), headers))).status).toBe(201);
    const third = await jsonOf(await postPayments(svc.url, validPayload(), headers));
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ status: 'rejected' });
    const errors = (third.body as { errors?: { field?: string }[] }).errors ?? [];
    expect(errors.some((e) => e.field === '_rateLimit')).toBe(true);
  });

  it('3.5a N+1-й GET status → видимая ошибка, не статус чужого платежа', async () => {
    svc = await startPaymentService({
      env: prodEnv({ PAYMENT_GET_RATE_LIMIT: '2', PAYMENT_RATE_LIMIT_WINDOW_MS: '60000' }),
    });
    const body = validPayload();
    await postPayments(svc.url, body);
    const headers = { 'x-forwarded-for': '203.0.113.11' };
    const { getStatus } = await import('./helpers/payment-service');
    expect((await jsonOf(await getStatus(svc.url, body.requestId, headers))).status).toBe(200);
    expect((await jsonOf(await getStatus(svc.url, body.requestId, headers))).status).toBe(200);
    const third = await jsonOf(await getStatus(svc.url, body.requestId, headers));
    expect(third.status).toBe(429);
    expect((third.body as { status?: string }).status).not.toBe('pending');
    expect((third.body as { status?: string }).status).not.toBe('succeeded');
  });

  it('3.5a-1 пять GET status подряд при пяти удержаниях не получают 429', async () => {
    svc = await startPaymentService({
      env: prodEnv({ PAYMENT_GET_RATE_LIMIT: '5', PAYMENT_RATE_LIMIT_WINDOW_MS: '60000' }),
    });
    const headers = { 'x-forwarded-for': '203.0.113.12' };
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const body = validPayload({ seminar: `Семинар ${i}` });
      const created = await jsonOf(await postPayments(svc.url, body, headers));
      expect(created.status).toBe(201);
      ids.push(body.requestId);
    }
    const { getStatus } = await import('./helpers/payment-service');
    const codes: number[] = [];
    for (const id of ids) {
      codes.push((await jsonOf(await getStatus(svc.url, id, headers))).status);
    }
    expect(codes, 'лимит GET не пропускает штатные пять удержаний').toEqual([200, 200, 200, 200, 200]);
  });
});
