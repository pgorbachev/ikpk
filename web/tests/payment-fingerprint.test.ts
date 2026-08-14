import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
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

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

describe('3.10a-3 поиск по отпечатку, канонический requestId, пометка', () => {
  it('неизвестный requestId, тот же отпечаток живой незавершённой → 503 с каноническим id, платёж не создаётся', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload();
    expect((await jsonOf(await postPayments(svc.url, first))).status).toBe(201);
    const creates = svc.yookassa.creates.length;
    const second = { ...first, requestId: randomUUID() };
    const res = await jsonOf(await postPayments(svc.url, second));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'verification_required', requestId: first.requestId });
    expect((res.body as { requestId: string }).requestId).not.toBe(second.requestId);
    expect(svc.yookassa.creates.length).toBe(creates);
  });

  it('совпала canceled без живой незавершённой и без свежей confirmed → платёж создаётся', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload();
    await postPayments(svc.url, first);
    svc.writeRecords(svc.readRecords().map((r) => ({ ...r, status: 'canceled' })));
    const second = { ...first, requestId: randomUUID() };
    const res = await jsonOf(await postPayments(svc.url, second));
    expect(res.status).toBe(201);
  });

  it('отличающееся хотя бы одним полем содержимое → платёж создаётся (названное отклонение)', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload({ amount: 1 });
    await postPayments(svc.url, first);
    const second = { ...first, requestId: randomUUID(), amount: 2 };
    const res = await jsonOf(await postPayments(svc.url, second));
    expect(res.status).toBe(201);
  });

  it('незавершённая старше 14 суток без живой confirmed того же состава → платёж создаётся', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload();
    await postPayments(svc.url, first);
    svc.writeRecords(svc.readRecords().map((r) => ({ ...r, createdAt: daysAgo(15) })));
    const second = { ...first, requestId: randomUUID() };
    const res = await jsonOf(await postPayments(svc.url, second));
    expect(res.status).toBe(201);
  });

  it('совпавшая запись с yookassaPaymentId не помечается и не пишется в журнал', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload();
    await postPayments(svc.url, first);
    const before = svc.readRecords()[0];
    expect(before?.yookassaPaymentId).toBeTruthy();
    const journalBefore = svc.readJournal().length;
    await postPayments(svc.url, { ...first, requestId: randomUUID() });
    const after = svc.readRecords().find((r) => r.requestId === first.requestId);
    expect(after?.verificationAt ?? null).toBe(before?.verificationAt ?? null);
    expect(svc.readJournal().length).toBe(journalBefore);
  });

  it('совпавшая запись без yookassaPaymentId помечается и попадает в журнал', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload();
    await postPayments(svc.url, first);
    svc.writeRecords(svc.readRecords().map((r) => ({ ...r, yookassaPaymentId: null, status: 'unknown' })));
    await postPayments(svc.url, { ...first, requestId: randomUUID() });
    const after = svc.readRecords().find((r) => r.requestId === first.requestId);
    expect(after?.verificationAt).toBeTruthy();
    expect(svc.readJournal().some((e) => e.requestId === first.requestId)).toBe(true);
  });
});

describe('3.10a-3a атомарность двух разных requestId с одним содержимым', () => {
  it('мок создания вызван ровно один раз; второй получает verification_required', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const a = validPayload();
    const b = { ...a, requestId: randomUUID() };
    const [ra, rb] = await Promise.all([postPayments(svc.url, a), postPayments(svc.url, b)]);
    const ja = await jsonOf(ra);
    const jb = await jsonOf(rb);
    expect(svc.yookassa.creates.length, `созданий у мока: ${svc.yookassa.creates.length}`).toBe(1);
    const statuses = [ja, jb].map((r) => (r.body as { status?: string }).status);
    expect(statuses).toContain('verification_required');
    expect(statuses.filter((s) => s === 'created').length).toBe(1);
  });
});

describe('3.10a-3b подтверждение повторной оплаты', () => {
  async function succeededRecord() {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload();
    await postPayments(svc.url, first);
    svc.writeRecords(
      svc.readRecords().map((r) => ({
        ...r,
        status: 'succeeded',
        confirmedAt: new Date().toISOString(),
      })),
    );
    return first;
  }

  it('совпала confirmed <14 суток без токена → 409 duplicate_confirmation_required, мок не вызван, requestId прежней записи нет, токен есть', async () => {
    const first = await succeededRecord();
    const creates = svc!.yookassa.creates.length;
    const second = { ...first, requestId: randomUUID() };
    const res = await jsonOf(await postPayments(svc!.url, second));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 'duplicate_confirmation_required' });
    expect((res.body as { requestId?: string }).requestId).toBeUndefined();
    expect(typeof (res.body as { confirmationToken?: string }).confirmationToken).toBe('string');
    expect(svc!.yookassa.creates.length).toBe(creates);
    expect(svc!.readRecords().find((r) => r.requestId === first.requestId)?.status).toBe('succeeded');
  });

  it('тот же запрос с действительным токеном создаёт ровно один платёж', async () => {
    const first = await succeededRecord();
    const second = { ...first, requestId: randomUUID() };
    const ask = await jsonOf(await postPayments(svc!.url, second));
    const token = (ask.body as { confirmationToken: string }).confirmationToken;
    const creates = svc!.yookassa.creates.length;
    const confirm = await jsonOf(
      await postPayments(svc!.url, { ...second, duplicateConfirmationToken: token }),
    );
    expect(confirm.status).toBe(201);
    expect(svc!.yookassa.creates.length).toBe(creates + 1);
  });

  it('(1) canceled без живой незавершённой и без свежей confirmed → платёж без вопроса', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload();
    await postPayments(svc.url, first);
    svc.writeRecords(svc.readRecords().map((r) => ({ ...r, status: 'canceled' })));
    const res = await jsonOf(await postPayments(svc.url, { ...first, requestId: randomUUID() }));
    expect(res.status).toBe(201);
  });

  it('(2) якорь — момент подтверждения, не создания записи', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload();
    await postPayments(svc.url, first);
    svc.writeRecords(
      svc.readRecords().map((r) => ({
        ...r,
        status: 'succeeded',
        createdAt: daysAgo(20),
        confirmedAt: daysAgo(2),
      })),
    );
    const ask = await jsonOf(await postPayments(svc.url, { ...first, requestId: randomUUID() }));
    expect(ask.body).toMatchObject({ status: 'duplicate_confirmation_required' });
    svc.writeRecords(
      svc.readRecords().map((r) =>
        r.requestId === first.requestId ? { ...r, confirmedAt: daysAgo(20) } : r,
      ),
    );
    const late = await jsonOf(await postPayments(svc.url, { ...first, requestId: randomUUID() }));
    expect(late.status).toBe(201);
  });

  it('(3) отпечаток совпадает независимо от признака подтверждения и токена', async () => {
    const first = await succeededRecord();
    const withFlag = await jsonOf(
      await postPayments(svc!.url, {
        ...first,
        requestId: randomUUID(),
        duplicateConfirmed: true,
      }),
    );
    expect(withFlag.body).toMatchObject({ status: 'duplicate_confirmation_required' });
  });

  it('(4) два одновременных подтверждённых запроса с одним новым requestId — мок ровно один раз', async () => {
    const first = await succeededRecord();
    const second = { ...first, requestId: randomUUID() };
    const token = ((await jsonOf(await postPayments(svc!.url, second))).body as { confirmationToken: string })
      .confirmationToken;
    const creates = svc!.yookassa.creates.length;
    await Promise.all([
      postPayments(svc!.url, { ...second, duplicateConfirmationToken: token }),
      postPayments(svc!.url, { ...second, duplicateConfirmationToken: token }),
    ]);
    expect(svc!.yookassa.creates.length).toBe(creates + 1);
  });

  it('(5) признак подтверждения без выданного токена платежа не создаёт', async () => {
    const first = await succeededRecord();
    const res = await jsonOf(
      await postPayments(svc!.url, {
        ...first,
        requestId: randomUUID(),
        duplicateConfirmed: true,
      }),
    );
    expect(res.body).toMatchObject({ status: 'duplicate_confirmation_required' });
    expect(typeof (res.body as { confirmationToken?: string }).confirmationToken).toBe('string');
  });

  it('(6) повторное предъявление того же токена платежа не создаёт', async () => {
    const first = await succeededRecord();
    const second = { ...first, requestId: randomUUID() };
    const token = ((await jsonOf(await postPayments(svc!.url, second))).body as { confirmationToken: string })
      .confirmationToken;
    expect((await jsonOf(await postPayments(svc!.url, { ...second, duplicateConfirmationToken: token }))).status).toBe(
      201,
    );
    const again = await jsonOf(
      await postPayments(svc!.url, { ...second, duplicateConfirmationToken: token }),
    );
    expect(again.status).not.toBe(201);
    expect((again.body as { status?: string }).status).not.toBe('created');
  });

  it('(7) живая незавершённая приоритетнее confirmed → verification_required, не вопрос', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const live = validPayload();
    await postPayments(svc.url, live);
    const paid = { ...live, requestId: randomUUID(), seminar: live.seminar };
    await postPayments(svc.url, { ...paid, amount: live.amount + 1 });
    svc.writeRecords(
      svc.readRecords().map((r) =>
        r.requestId === paid.requestId
          ? { ...r, status: 'succeeded', fingerprint: svc!.readRecords().find((x) => x.requestId === live.requestId)!.fingerprint, confirmedAt: new Date().toISOString() }
          : r,
      ),
    );
    const third = await jsonOf(await postPayments(svc.url, { ...live, requestId: randomUUID() }));
    expect(third.body).toMatchObject({ status: 'verification_required' });
    expect((third.body as { status: string }).status).not.toBe('duplicate_confirmation_required');
  });

  it('(8) между выдачей токена и подтверждением появилась незавершённая — платёж не создаётся', async () => {
    const first = await succeededRecord();
    const second = { ...first, requestId: randomUUID() };
    const token = ((await jsonOf(await postPayments(svc!.url, second))).body as { confirmationToken: string })
      .confirmationToken;
    const existing = svc!.readRecords();
    const succeeded = existing.find((r) => r.requestId === first.requestId);
    expect(succeeded?.fingerprint).toBeTruthy();
    // Сочетание состояний готовится записью в хранилище, не публичным POST:
    // POST того же состава упёрся бы в 409 и живой незавершённой бы не появилось.
    svc!.writeRecords([
      ...existing,
      {
        requestId: randomUUID(),
        yookassaPaymentId: 'yk-live-between-token-and-confirm',
        status: 'pending',
        fingerprint: succeeded!.fingerprint,
        keyVersion: succeeded!.keyVersion,
        createdAt: new Date().toISOString(),
      },
    ]);
    const creates = svc!.yookassa.creates.length;
    const confirm = await jsonOf(
      await postPayments(svc!.url, { ...second, duplicateConfirmationToken: token }),
    );
    expect((confirm.body as { status?: string }).status).not.toBe('created');
    expect(confirm.status).not.toBe(201);
    expect(confirm.body).toMatchObject({ status: 'verification_required' });
    expect(svc!.yookassa.creates.length).toBe(creates);
  });

  it('(9) confirmed с ключом, ставшим PREVIOUS после ротации → вопрос, не создание', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const first = validPayload();
    await postPayments(svc.url, first);
    const records = svc.readRecords().map((r) => ({
      ...r,
      status: 'succeeded',
      confirmedAt: new Date().toISOString(),
    }));
    await svc.stop();
    svc = await startPaymentService({
      env: prodEnv({
        HMAC_KEY_CURRENT: 'new-material',
        HMAC_KEY_CURRENT_VERSION: '2026-08-14',
        HMAC_KEY_PREVIOUS: TEST_HMAC_CURRENT,
        HMAC_KEY_PREVIOUS_VERSION: TEST_HMAC_CURRENT_VERSION,
      }),
      seedRecords: records,
    });
    const res = await jsonOf(await postPayments(svc.url, { ...first, requestId: randomUUID() }));
    expect(res.body).toMatchObject({ status: 'duplicate_confirmation_required' });
  });

  it('(10) токен, вычисленный клиентом без серверного состояния, платежа не создаёт', async () => {
    const first = await succeededRecord();
    const res = await jsonOf(
      await postPayments(svc!.url, {
        ...first,
        requestId: randomUUID(),
        duplicateConfirmationToken: 'forged-not-issued-by-server',
      }),
    );
    expect((res.body as { status?: string }).status).not.toBe('created');
    expect(res.status).not.toBe(201);
  });

  it('(11) токен после 15 минут — платёж не создаётся, ответ с новым токеном', async () => {
    let now = Date.now();
    svc = await startPaymentService({
      env: prodEnv(),
      now: () => new Date(now),
    });
    const first = validPayload();
    await postPayments(svc.url, first);
    svc.writeRecords(
      svc.readRecords().map((r) => ({ ...r, status: 'succeeded', confirmedAt: new Date(now).toISOString() })),
    );
    const second = { ...first, requestId: randomUUID() };
    const ask = await jsonOf(await postPayments(svc.url, second));
    const token = (ask.body as { confirmationToken: string }).confirmationToken;
    now += 16 * 60 * 1000;
    const late = await jsonOf(
      await postPayments(svc.url, { ...second, duplicateConfirmationToken: token }),
    );
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ status: 'duplicate_confirmation_required' });
    expect((late.body as { confirmationToken: string }).confirmationToken).not.toBe(token);
  });

  it('(12) истёкшая незавершённая + живая confirmed → вопрос, не создание', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const stale = validPayload();
    await postPayments(svc.url, stale);
    const paid = { ...stale, requestId: randomUUID() };
    await postPayments(svc.url, { ...paid, amount: stale.amount + 1 });
    const staleFp = svc.readRecords().find((r) => r.requestId === stale.requestId)!.fingerprint;
    svc.writeRecords(
      svc.readRecords().map((r) => {
        if (r.requestId === stale.requestId) {
          return { ...r, createdAt: daysAgo(15), status: 'unknown' };
        }
        return {
          ...r,
          status: 'succeeded',
          fingerprint: staleFp,
          confirmedAt: daysAgo(2),
        };
      }),
    );
    const res = await jsonOf(await postPayments(svc.url, { ...stale, requestId: randomUUID() }));
    expect(res.body).toMatchObject({ status: 'duplicate_confirmation_required' });
    expect(res.status).not.toBe(201);
  });
});

describe('3.10a-4 безопасное продолжение без yookassaPaymentId', () => {
  it('повтор в окне дедупликации обращается к моку с тем же ключом идемпотентности', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    svc.writeRecords(svc.readRecords().map((r) => ({ ...r, yookassaPaymentId: null, status: 'unknown' })));
    const creates = svc.yookassa.creates.length;
    const key = svc.yookassa.creates[0]?.headers['idempotence-key'];
    await postPayments(svc.url, body);
    expect(svc.yookassa.creates.length).toBe(creates + 1);
    expect(svc.yookassa.creates.at(-1)?.headers['idempotence-key']).toBe(key);
  });

  it('запись старше окна дедупликации — обращения к моку нет, 503 verification_required', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    svc.writeRecords(
      svc.readRecords().map((r) => ({
        ...r,
        yookassaPaymentId: null,
        status: 'unknown',
        createdAt: daysAgo(2),
      })),
    );
    const creates = svc.yookassa.creates.length;
    const res = await jsonOf(await postPayments(svc.url, body));
    expect(svc.yookassa.creates.length).toBe(creates);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'verification_required', requestId: body.requestId });
  });
});

describe('3.10a-4c продолжение уже созданного платежа', () => {
  it('сервер спрашивает оператора по yookassaPaymentId, второй платёж не создаёт, в ответе адрес подтверждения', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    const created = await jsonOf(await postPayments(svc.url, body));
    const url1 = (created.body as { confirmationUrl: string }).confirmationUrl;
    const creates = svc.yookassa.creates.length;
    svc.yookassa.setGetHandler((id) => ({
      status: 200,
      body: {
        id,
        status: 'pending',
        confirmation: { confirmation_url: url1 },
      },
    }));
    const again = await jsonOf(await postPayments(svc.url, body));
    expect(svc.yookassa.creates.length).toBe(creates);
    expect(svc.yookassa.gets.length).toBeGreaterThan(0);
    expect(again.body).toMatchObject({ status: 'created', confirmationUrl: url1 });
    expect((again.body as { confirmationUrl?: string }).confirmationUrl).toBeTruthy();
  });
});

describe('3.10a-6 журнал «нужна сверка»', () => {
  it('шаг 6 (неизвестная версия ключа) пишет requestId, время, причину без ПДн и секретов', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    await postPayments(svc.url, body);
    const records = svc.readRecords().map((r) => ({
      ...r,
      yookassaPaymentId: null,
      status: 'unknown',
      keyVersion: 'gone',
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
    await postPayments(svc.url, body);
    const entries = svc.readJournal();
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries.find((e) => e.requestId === body.requestId);
    expect(entry?.at).toBeTruthy();
    expect(entry?.reason).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(body.email);
    expect(JSON.stringify(entry)).not.toContain(body.firstName);
    expect(JSON.stringify(entry)).not.toContain(TEST_HMAC_CURRENT);
  });

  it('шаг 5 (несовпадение содержимого) журнал не пишет и verificationAt не ставит', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload({ amount: 1 });
    await postPayments(svc.url, body);
    const before = svc.readRecords()[0];
    const journalBefore = svc.readJournal().length;
    await postPayments(svc.url, { ...body, amount: 2 });
    const after = svc.readRecords().find((r) => r.requestId === body.requestId);
    expect(after?.verificationAt ?? null).toBe(before?.verificationAt ?? null);
    expect(svc.readJournal().length).toBe(journalBefore);
  });
});
