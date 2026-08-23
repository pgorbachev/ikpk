import { afterEach, describe, expect, it } from 'vitest';
import { prodEnv, validPayload } from './helpers/payment-contract';
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

describe('3.9a демо-обработчик не ходит к api.yookassa.ru', () => {
  it('при любых входных данных исходящих к оператору нет', async () => {
    svc = await startPaymentService({ env: { PAYMENT_MODE: 'demo' } });
    await postPayments(svc.url, validPayload());
    await postPayments(svc.url, { ...validPayload(), amount: -1 });
    expect(svc.yookassa.creates.length, 'демо-обработчик вызвал мок оператора').toBe(0);
    expect(svc.outbound.filter((c) => /yookassa|ykassa/i.test(c.url))).toEqual([]);
  });
});

describe('3.9b рассогласование demo-сервер × боевой клиент', () => {
  it('демо-обработчик всегда 200 created_demo независимо от тела', async () => {
    svc = await startPaymentService({ env: { PAYMENT_MODE: 'demo' } });
    const ok = await jsonOf(await postPayments(svc.url, validPayload()));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'created_demo' });
    const junk = await jsonOf(await postPayments(svc.url, { not: 'a payment' }));
    expect(junk.status).toBe(200);
    expect(junk.body).toEqual({ status: 'created_demo' });
  });
});

describe('3.12a заголовки API', () => {
  it('ответ запрещает кеширование', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const res = await postPayments(svc.url, validPayload());
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc, 'Cache-Control не запрещает кеш').toMatch(/no-store|private/i);
  });

  it('ошибка — JSON, не HTML error_page', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const res = await postPayments(svc.url, validPayload({ requestId: 'bad' }));
    const type = res.headers.get('content-type') ?? '';
    expect(type).toMatch(/json/i);
    const text = await res.text();
    expect(text.trimStart().startsWith('<'), 'ошибка отдана HTML-страницей сайта').toBe(false);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe('3.12b CORS', () => {
  it('origin https://ikpk.su получает разрешающие заголовки', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const res = await postPayments(svc.url, validPayload(), { origin: 'https://ikpk.su' });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://ikpk.su');
  });

  it('посторонний origin, включая отражение себя, заголовков не получает', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const evil = 'https://evil.example';
    const res = await postPayments(svc.url, validPayload(), { origin: evil });
    const allow = res.headers.get('access-control-allow-origin');
    expect(allow).not.toBe(evil);
    expect(allow).not.toBe('*');
  });

  it('preflight OPTIONS с тем же составом правил', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const preflight = await fetch(`${svc.url}/payments`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://ikpk.su',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://ikpk.su');
    const post = await postPayments(svc.url, validPayload(), { origin: 'https://ikpk.su' });
    expect(post.headers.get('access-control-allow-origin')).toBe(
      preflight.headers.get('access-control-allow-origin'),
    );
  });
});
