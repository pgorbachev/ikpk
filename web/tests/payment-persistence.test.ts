import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prodEnv, TEST_HMAC_CURRENT, TEST_HMAC_CURRENT_VERSION, validPayload } from './helpers/payment-contract';
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

describe('3.10c состояние переживает перезапуск', () => {
  it('повторный POST после stop/start с тем же requestId распознан', async () => {
    svc = await startPaymentService({ env: prodEnv() });
    const body = validPayload();
    expect((await jsonOf(await postPayments(svc.url, body))).status).toBe(201);
    const records = svc.readRecords();
    expect(records.length).toBeGreaterThan(0);
    await svc.stop();
    svc = await startPaymentService({ env: prodEnv(), seedRecords: records });
    const again = await jsonOf(await postPayments(svc.url, body));
    expect(again.status).toBe(200);
    expect((again.body as { status: string }).status).toBe('created');
  });
});

describe('3.10c-1 повреждённое хранилище — fail-closed', () => {
  it('нечитаемый файл хранилища — процесс не слушает, причина в stderr', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ikpk-broken-store-'));
    writeFileSync(join(dataDir, 'payments.json'), '{broken');
    const fail = await spawnPaymentProcess({
      env: prodEnv({
        PAYMENT_DATA_DIR: dataDir,
        PAYMENT_STORAGE_PATH: join(dataDir, 'payments.json'),
      }),
    });
    expect(fail.listening).toBe(false);
    expect(fail.connection).toBe('refused');
    expect(fail.exitCode).not.toBe(0);
    expect(fail.stderr + fail.stdout).toMatch(/хран|storage|payments\.json|нечита/i);
  });

  it('r12-M3 {} / [] / null и records не-массив — fail-closed; {records:[]} допустим', async () => {
    for (const raw of ['{}', '[]', 'null', '{"records":{}}', '{"records":null}']) {
      const dataDir = mkdtempSync(join(tmpdir(), 'ikpk-store-shape-'));
      writeFileSync(join(dataDir, 'payments.json'), raw);
      const fail = await spawnPaymentProcess({
        env: prodEnv({
          PAYMENT_DATA_DIR: dataDir,
          PAYMENT_STORAGE_PATH: join(dataDir, 'payments.json'),
        }),
      });
      expect(fail.listening, `хранилище ${raw} открыло порт`).toBe(false);
      expect(fail.exitCode).not.toBe(0);
    }
    const okDir = mkdtempSync(join(tmpdir(), 'ikpk-store-empty-records-'));
    writeFileSync(join(okDir, 'payments.json'), JSON.stringify({ records: [] }));
    const ok = await spawnPaymentProcess({
      env: prodEnv({
        PAYMENT_DATA_DIR: okDir,
        PAYMENT_STORAGE_PATH: join(okDir, 'payments.json'),
        PAYMENT_LISTEN_PORT: '18771',
      }),
      waitMs: 2500,
    });
    expect(ok.listening, '{records:[]} отвергнут как пустое хранилище').toBe(true);
  });

  it('r13-M2 records:[null] и records:[{}] — fail-closed', async () => {
    const digest = createHmac('sha256', TEST_HMAC_CURRENT)
      .update('ikpk-hmac-canary-constant')
      .digest('hex');
    for (const raw of ['{"records":[null]}', '{"records":[{}]}']) {
      const dataDir = mkdtempSync(join(tmpdir(), 'ikpk-store-bad-record-'));
      writeFileSync(join(dataDir, 'payments.json'), raw);
      writeFileSync(
        join(dataDir, 'hmac-canary.json'),
        JSON.stringify({ [TEST_HMAC_CURRENT_VERSION]: digest }),
      );
      const fail = await spawnPaymentProcess({
        env: prodEnv({
          PAYMENT_DATA_DIR: dataDir,
          PAYMENT_STORAGE_PATH: join(dataDir, 'payments.json'),
          PAYMENT_CANARY_PATH: join(dataDir, 'hmac-canary.json'),
        }),
      });
      expect(fail.listening, `хранилище ${raw} открыло порт`).toBe(false);
      expect(fail.exitCode).not.toBe(0);
    }
  });

  it('r14-M2 семантически повреждённая запись не открывает порт', async () => {
    const canaryDigest = createHmac('sha256', TEST_HMAC_CURRENT)
      .update('ikpk-hmac-canary-constant')
      .digest('hex');
    const validRecord = {
      requestId: '00000000-0000-4000-8000-000000000007',
      yookassaPaymentId: 'yk-7',
      status: 'succeeded',
      fingerprint: 'f'.repeat(64),
      keyVersion: TEST_HMAC_CURRENT_VERSION,
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
    };
    const corruptions = [
      { label: 'malformed fingerprint', record: { ...validRecord, fingerprint: 'f' } },
      { label: 'malformed confirmedAt', record: { ...validRecord, confirmedAt: 'not-a-date' } },
      { label: 'malformed verificationAt', record: { ...validRecord, verificationAt: 'not-a-date' } },
      { label: 'empty yookassaPaymentId', record: { ...validRecord, yookassaPaymentId: '' } },
    ];

    for (const { label, record } of corruptions) {
      const dataDir = mkdtempSync(join(tmpdir(), 'ikpk-store-semantic-'));
      writeFileSync(join(dataDir, 'payments.json'), JSON.stringify({ records: [record] }));
      writeFileSync(
        join(dataDir, 'hmac-canary.json'),
        JSON.stringify({ [TEST_HMAC_CURRENT_VERSION]: canaryDigest }),
      );
      const fail = await spawnPaymentProcess({
        env: prodEnv({
          PAYMENT_DATA_DIR: dataDir,
          PAYMENT_STORAGE_PATH: join(dataDir, 'payments.json'),
          PAYMENT_CANARY_PATH: join(dataDir, 'hmac-canary.json'),
        }),
      });
      expect(fail.listening, `${label} открыл порт`).toBe(false);
      expect(fail.exitCode).not.toBe(0);
    }
  });
});
