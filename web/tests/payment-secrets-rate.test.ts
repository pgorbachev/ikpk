import { afterEach, describe, expect, it } from 'vitest';
import { TEST_HMAC_CURRENT, TEST_YOOKASSA_SECRET, prodEnv, validPayload } from './helpers/payment-contract';
import {
  jsonOf,
  postPayments,
  spawnPaymentProcess,
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
    const headers = { 'x-real-ip': '203.0.113.10' };
    // Разный семинар/сумма при том же IP: предмет — лимит частоты, не отпечаток.
    // Одинаковый состав дал бы законный verification_required на втором POST.
    expect(
      (await jsonOf(await postPayments(svc.url, validPayload({ seminar: 'Модуль 1', amount: 1 }), headers))).status,
    ).toBe(201);
    expect(
      (await jsonOf(await postPayments(svc.url, validPayload({ seminar: 'Модуль 2', amount: 2 }), headers))).status,
    ).toBe(201);
    const third = await jsonOf(
      await postPayments(svc.url, validPayload({ seminar: 'Модуль 3', amount: 3 }), headers),
    );
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ status: 'rejected' });
    expect((third.body as { status?: string }).status).not.toBe('verification_required');
    const errors = (third.body as { errors?: { field?: string }[] }).errors ?? [];
    expect(errors.some((e) => e.field === '_rateLimit')).toBe(true);
  });

  it('3.5a N+1-й GET status → видимая ошибка, не статус чужого платежа', async () => {
    svc = await startPaymentService({
      env: prodEnv({ PAYMENT_GET_RATE_LIMIT: '5', PAYMENT_RATE_LIMIT_WINDOW_MS: '60000' }),
    });
    const body = validPayload();
    await postPayments(svc.url, body);
    const headers = { 'x-real-ip': '203.0.113.11' };
    const { getStatus } = await import('./helpers/payment-service');
    for (let i = 0; i < 5; i += 1) {
      expect((await jsonOf(await getStatus(svc.url, body.requestId, headers))).status).toBe(200);
    }
    const sixth = await jsonOf(await getStatus(svc.url, body.requestId, headers));
    expect(sixth.status).toBe(429);
    expect((sixth.body as { status?: string }).status).not.toBe('pending');
    expect((sixth.body as { status?: string }).status).not.toBe('succeeded');
  });

  it('3.5a-1 пять GET status подряд при пяти удержаниях не получают 429', async () => {
    svc = await startPaymentService({
      env: prodEnv({ PAYMENT_GET_RATE_LIMIT: '5', PAYMENT_RATE_LIMIT_WINDOW_MS: '60000' }),
    });
    const headers = { 'x-real-ip': '203.0.113.12' };
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

  it('prod без PAYMENT_POST_RATE_LIMIT не стартует', async () => {
    const r = await spawnPaymentProcess({ env: prodEnv({ PAYMENT_POST_RATE_LIMIT: undefined }) });
    expect(r.listening, 'порт открыт без лимита POST').toBe(false);
    expect(r.connection).toBe('refused');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/PAYMENT_POST_RATE_LIMIT/i);
  });

  it('prod без PAYMENT_GET_RATE_LIMIT не стартует', async () => {
    const r = await spawnPaymentProcess({ env: prodEnv({ PAYMENT_GET_RATE_LIMIT: undefined }) });
    expect(r.listening, 'порт открыт без лимита GET').toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/PAYMENT_GET_RATE_LIMIT/i);
  });

  it('r12-M1 prod с PAYMENT_GET_RATE_LIMIT 1–4 не стартует', async () => {
    for (const value of ['1', '2', '3', '4']) {
      const r = await spawnPaymentProcess({ env: prodEnv({ PAYMENT_GET_RATE_LIMIT: value }) });
      expect(r.listening, `порт открыт при PAYMENT_GET_RATE_LIMIT=${value}`).toBe(false);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/PAYMENT_GET_RATE_LIMIT/i);
    }
  });

  it('r12-M6 нечисловой или неположительный PAYMENT_RATE_LIMIT_WINDOW_MS — процесс не слушает', async () => {
    for (const value of ['', '0', '-1', 'abc', '1.5']) {
      const r = await spawnPaymentProcess({ env: prodEnv({ PAYMENT_RATE_LIMIT_WINDOW_MS: value }) });
      expect(r.listening, `порт открыт при PAYMENT_RATE_LIMIT_WINDOW_MS=${JSON.stringify(value)}`).toBe(
        false,
      );
      expect(r.exitCode).not.toBe(0);
    }
  });

  it('некорректный PAYMENT_POST_RATE_LIMIT — процесс не слушает', async () => {
    for (const value of ['', '0', '-1', 'abc']) {
      const r = await spawnPaymentProcess({ env: prodEnv({ PAYMENT_POST_RATE_LIMIT: value }) });
      expect(r.listening, `порт открыт при PAYMENT_POST_RATE_LIMIT=${JSON.stringify(value)}`).toBe(false);
      expect(r.exitCode).not.toBe(0);
    }
  });

  it('подмена X-Forwarded-For не открывает новое ведро', async () => {
    svc = await startPaymentService({
      env: prodEnv({ PAYMENT_POST_RATE_LIMIT: '2', PAYMENT_RATE_LIMIT_WINDOW_MS: '60000' }),
    });
    const trusted = { 'x-real-ip': '203.0.113.40' };
    expect(
      (await jsonOf(await postPayments(svc.url, validPayload({ seminar: 'Модуль 1', amount: 1 }), trusted)))
        .status,
    ).toBe(201);
    expect(
      (await jsonOf(await postPayments(svc.url, validPayload({ seminar: 'Модуль 2', amount: 2 }), trusted)))
        .status,
    ).toBe(201);
    const spoofed = { 'x-real-ip': '203.0.113.40', 'x-forwarded-for': '198.51.100.1' };
    const third = await jsonOf(
      await postPayments(svc.url, validPayload({ seminar: 'Модуль 3', amount: 3 }), spoofed),
    );
    expect(third.status).toBe(429);
  });

  it('клиентский X-Forwarded-For без X-Real-IP не разделяет вёдра', async () => {
    svc = await startPaymentService({
      env: prodEnv({ PAYMENT_POST_RATE_LIMIT: '2', PAYMENT_RATE_LIMIT_WINDOW_MS: '60000' }),
    });
    expect(
      (
        await jsonOf(
          await postPayments(svc.url, validPayload({ seminar: 'A', amount: 1 }), {
            'x-forwarded-for': '198.51.100.1',
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await jsonOf(
          await postPayments(svc.url, validPayload({ seminar: 'B', amount: 2 }), {
            'x-forwarded-for': '198.51.100.2',
          }),
        )
      ).status,
    ).toBe(201);
    const third = await jsonOf(
      await postPayments(svc.url, validPayload({ seminar: 'C', amount: 3 }), {
        'x-forwarded-for': '198.51.100.3',
      }),
    );
    expect(third.status, 'подмена XFF открыла новое ведро').toBe(429);
  });

  it('nginx не берёт клиентский X-Forwarded-For как единственный источник', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { repoRoot } = await import('./helpers/payment-contract');
    const conf = readFileSync(join(repoRoot, 'payments/deploy/nginx-api.conf'), 'utf8');
    const headers = conf
      .split('\n')
      .filter((line) => /^\s*proxy_set_header\s/.test(line))
      .join('\n');
    expect(headers).not.toMatch(/\$proxy_add_x_forwarded_for/);
    expect(headers).toMatch(/X-Forwarded-For\s+\$remote_addr/);
    expect(headers).toMatch(/X-Real-IP\s+\$remote_addr/);
  });
});
