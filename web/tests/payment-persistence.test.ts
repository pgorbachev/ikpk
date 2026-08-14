import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prodEnv, validPayload } from './helpers/payment-contract';
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
});
