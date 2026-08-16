import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PAYMENT_SERVICE_ENTRY,
  TEST_HMAC_CURRENT_VERSION,
  TEST_HMAC_PREVIOUS,
  prodEnv,
} from './helpers/payment-contract';
import { spawnPaymentProcess } from './helpers/payment-service';

const VALID_STORED_FINGERPRINT = 'f'.repeat(64);

describe('3.0a PAYMENT_MODE=prod fail-closed до открытия порта', () => {
  it(
    'не задан RECEIPT_ENABLED — процесс не слушает, connection refused, причина в stderr',
    async () => {
      const r = await spawnPaymentProcess({
        env: prodEnv({ RECEIPT_ENABLED: undefined }),
      });
      expect(r.listening, 'порт открыт при незаданном RECEIPT_ENABLED').toBe(false);
      expect(r.connection).toBe('refused');
      expect(r.exitCode, 'процесс остался жить').not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/RECEIPT_ENABLED/i);
    },
  );

  it(
    'пустой RECEIPT_ENABLED — тот же исход, не 5xx',
    async () => {
      const r = await spawnPaymentProcess({ env: prodEnv({ RECEIPT_ENABLED: '' }) });
      expect(r.listening).toBe(false);
      expect(r.connection).toBe('refused');
      expect(r.exitCode).not.toBe(0);
    },
  );

  it(
    'RECEIPT_ENABLED не true/false — тот же исход',
    async () => {
      const r = await spawnPaymentProcess({ env: prodEnv({ RECEIPT_ENABLED: 'yes' }) });
      expect(r.listening).toBe(false);
      expect(r.connection).toBe('refused');
      expect(r.exitCode).not.toBe(0);
    },
  );

  it(
    'не задан HMAC_KEY_CURRENT — тот же единственный исход',
    async () => {
      const r = await spawnPaymentProcess({ env: prodEnv({ HMAC_KEY_CURRENT: undefined }) });
      expect(r.listening).toBe(false);
      expect(r.connection).toBe('refused');
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/HMAC_KEY_CURRENT/i);
    },
  );

  it(
    'не задан HMAC_KEY_CURRENT_VERSION — тот же единственный исход',
    async () => {
      const r = await spawnPaymentProcess({
        env: prodEnv({ HMAC_KEY_CURRENT_VERSION: undefined }),
      });
      expect(r.listening).toBe(false);
      expect(r.connection).toBe('refused');
      expect(r.exitCode).not.toBe(0);
    },
  );

  it(
    'PAYMENT_MODE=demo стартует без боевых секретов',
    async () => {
      const r = await spawnPaymentProcess({
        env: {
          PAYMENT_MODE: 'demo',
          PAYMENT_LISTEN_PORT: '18765',
        },
        waitMs: 2500,
      });
      expect(r.listening, 'демо-режим не стартовал без секретов').toBe(true);
      expect(r.exitCode).toBeNull();
    },
  );
});

describe('3.0a-2 парность и уникальность HMAC_PREVIOUS', () => {
  it(
    'HMAC_KEY_PREVIOUS без VERSION — fail-closed, порт не открыт',
    async () => {
      const r = await spawnPaymentProcess({
        env: prodEnv({ HMAC_KEY_PREVIOUS: TEST_HMAC_PREVIOUS }),
      });
      expect(r.listening).toBe(false);
      expect(r.connection).toBe('refused');
      expect(r.exitCode).not.toBe(0);
    },
  );

  it(
    'одинаковые CURRENT_VERSION и PREVIOUS_VERSION — fail-closed',
    async () => {
      const r = await spawnPaymentProcess({
        env: prodEnv({
          HMAC_KEY_PREVIOUS: TEST_HMAC_PREVIOUS,
          HMAC_KEY_PREVIOUS_VERSION: TEST_HMAC_CURRENT_VERSION,
        }),
      });
      expect(r.listening).toBe(false);
      expect(r.connection).toBe('refused');
      expect(r.exitCode).not.toBe(0);
    },
  );
});

describe('3.0a-3 сам PAYMENT_MODE нормативен', () => {
  it('не задан PAYMENT_MODE — fail-closed, не demo по умолчанию', async () => {
    const r = await spawnPaymentProcess({
      env: prodEnv({ PAYMENT_MODE: undefined }),
    });
    expect(r.listening).toBe(false);
    expect(r.connection).toBe('refused');
    expect(r.exitCode).not.toBe(0);
  });

  it('пустой PAYMENT_MODE — fail-closed', async () => {
    const r = await spawnPaymentProcess({ env: prodEnv({ PAYMENT_MODE: '' }) });
    expect(r.listening).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it('production не трактуется как prod', async () => {
    const r = await spawnPaymentProcess({ env: prodEnv({ PAYMENT_MODE: 'production' }) });
    expect(r.listening).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it('Prod не трактуется как prod', async () => {
    const r = await spawnPaymentProcess({ env: prodEnv({ PAYMENT_MODE: 'Prod' }) });
    expect(r.listening).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });
});

describe('3.0a-4 canary материала ключа', () => {
  it(
    'известная версия, тот же материал — запуск проходит',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-ok-'));
      const first = await spawnPaymentProcess({
        env: prodEnv({
          PAYMENT_DATA_DIR: dir,
          PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
          PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
          PAYMENT_LISTEN_PORT: '18766',
        }),
        waitMs: 2500,
      });
      expect(first.listening).toBe(true);
      const second = await spawnPaymentProcess({
        env: prodEnv({
          PAYMENT_DATA_DIR: dir,
          PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
          PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
          PAYMENT_LISTEN_PORT: '18767',
        }),
        waitMs: 2500,
      });
      expect(second.listening, 'повторный старт с тем же материалом ключа отвергнут').toBe(true);
    },
  );

  it(
    'известная версия, другой материал — fail-closed',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-bad-'));
      const first = await spawnPaymentProcess({
        env: prodEnv({
          PAYMENT_DATA_DIR: dir,
          PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
          PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
          PAYMENT_LISTEN_PORT: '18768',
        }),
        waitMs: 2500,
      });
      expect(first.listening).toBe(true);
      const second = await spawnPaymentProcess({
        env: prodEnv({
          HMAC_KEY_CURRENT: 'different-material-same-version',
          PAYMENT_DATA_DIR: dir,
          PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
          PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
        }),
      });
      expect(second.listening).toBe(false);
      expect(second.connection).toBe('refused');
      expect(second.exitCode).not.toBe(0);
    },
  );

  it(
    'версия впервые, файл canary есть, хранилище отпечатков непусто — запуск и canary сохранён',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-new-'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'hmac-canary.json'),
        JSON.stringify({ 'old-version': 'a'.repeat(64) }),
      );
      writeFileSync(
        join(dir, 'payments.json'),
        JSON.stringify({
          records: [
            {
              requestId: '00000000-0000-4000-8000-000000000001',
              yookassaPaymentId: 'yk-1',
              status: 'pending',
              fingerprint: VALID_STORED_FINGERPRINT,
              keyVersion: 'old-version',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );
      const r = await spawnPaymentProcess({
        env: prodEnv({
          HMAC_KEY_CURRENT_VERSION: 'brand-new-version',
          PAYMENT_DATA_DIR: dir,
          PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
          PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
          PAYMENT_LISTEN_PORT: '18769',
        }),
        waitMs: 2500,
      });
      expect(r.listening, 'плановая ротация на новую версию отвергнута').toBe(true);
    },
  );
});

describe('3.0a-5 журнал canary: файл vs пустое хранилище', () => {
  it('повреждённый журнал canary — fail-closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-corrupt-'));
    writeFileSync(join(dir, 'hmac-canary.json'), '{not-json');
    const r = await spawnPaymentProcess({
      env: prodEnv({
        PAYMENT_DATA_DIR: dir,
        PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
        PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
      }),
    });
    expect(r.listening).toBe(false);
    expect(r.connection).toBe('refused');
    expect(r.exitCode).not.toBe(0);
  });

  it(
    'нет файла canary и пустое хранилище отпечатков — законный первый запуск',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-first-'));
      writeFileSync(join(dir, 'payments.json'), JSON.stringify({ records: [] }));
      const r = await spawnPaymentProcess({
        env: prodEnv({
          PAYMENT_DATA_DIR: dir,
          PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
          PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
          PAYMENT_LISTEN_PORT: '18770',
        }),
        waitMs: 2500,
      });
      expect(r.listening, 'первый запуск с пустым хранилищем отвергнут').toBe(true);
    },
  );

  it(
    'нет файла canary при непустом хранилище отпечатков — fail-closed',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-missing-'));
      writeFileSync(
        join(dir, 'payments.json'),
        JSON.stringify({
          records: [
            {
              requestId: '00000000-0000-4000-8000-000000000002',
              yookassaPaymentId: 'yk-2',
              status: 'pending',
              fingerprint: VALID_STORED_FINGERPRINT,
              keyVersion: TEST_HMAC_CURRENT_VERSION,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );
      const r = await spawnPaymentProcess({
        env: prodEnv({
          PAYMENT_DATA_DIR: dir,
          PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
          PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
        }),
      });
      expect(r.listening, 'потеря журнала при существующих отпечатках прошла молча').toBe(false);
      expect(r.connection).toBe('refused');
      expect(r.exitCode).not.toBe(0);
    },
  );

  it('r12-M2 canary [] — fail-closed, не тихий старт', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-array-'));
    writeFileSync(join(dir, 'hmac-canary.json'), '[]');
    writeFileSync(
      join(dir, 'payments.json'),
      JSON.stringify({
        records: [
          {
            requestId: '00000000-0000-4000-8000-000000000004',
            yookassaPaymentId: 'yk-4',
            status: 'pending',
            fingerprint: VALID_STORED_FINGERPRINT,
            keyVersion: TEST_HMAC_CURRENT_VERSION,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const r = await spawnPaymentProcess({
      env: prodEnv({
        PAYMENT_DATA_DIR: dir,
        PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
        PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
      }),
    });
    expect(r.listening, 'canary-массив прошёл как журнал').toBe(false);
    expect(r.connection).toBe('refused');
    expect(r.exitCode).not.toBe(0);
  });

  it('r12-M2 пустой объект canary при непустом хранилище — fail-closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-empty-obj-'));
    writeFileSync(join(dir, 'hmac-canary.json'), '{}');
    writeFileSync(
      join(dir, 'payments.json'),
      JSON.stringify({
        records: [
          {
            requestId: '00000000-0000-4000-8000-000000000005',
            yookassaPaymentId: 'yk-5',
            status: 'pending',
            fingerprint: VALID_STORED_FINGERPRINT,
            keyVersion: TEST_HMAC_CURRENT_VERSION,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const r = await spawnPaymentProcess({
      env: prodEnv({
        PAYMENT_DATA_DIR: dir,
        PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
        PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
      }),
    });
    expect(r.listening, 'пустой canary восстановил защиту молча').toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it('r13-M1 пустой digest текущей версии — fail-closed, не перезапись canary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-empty-digest-'));
    writeFileSync(join(dir, 'hmac-canary.json'), JSON.stringify({ [TEST_HMAC_CURRENT_VERSION]: '' }));
    writeFileSync(
      join(dir, 'payments.json'),
      JSON.stringify({
        records: [
          {
            requestId: '00000000-0000-4000-8000-000000000006',
            yookassaPaymentId: 'yk-6',
            status: 'pending',
            fingerprint: VALID_STORED_FINGERPRINT,
            keyVersion: TEST_HMAC_CURRENT_VERSION,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const r = await spawnPaymentProcess({
      env: prodEnv({
        PAYMENT_DATA_DIR: dir,
        PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
        PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
        PAYMENT_LISTEN_PORT: '18772',
      }),
      waitMs: 2500,
    });
    expect(r.listening, '{"v1":""} перезаписал canary и открыл порт').toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it('opts.fetch не снимает fail-closed при непустом хранилище без canary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-canary-fetch-'));
    writeFileSync(
      join(dir, 'payments.json'),
      JSON.stringify({
        records: [
          {
            requestId: '00000000-0000-4000-8000-000000000003',
            yookassaPaymentId: 'yk-3',
            status: 'pending',
            fingerprint: VALID_STORED_FINGERPRINT,
            keyVersion: TEST_HMAC_CURRENT_VERSION,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const mod = await import(pathToFileURL(PAYMENT_SERVICE_ENTRY).href);
    const app = mod.createPaymentService({
      env: prodEnv({
        PAYMENT_DATA_DIR: dir,
        PAYMENT_CANARY_PATH: join(dir, 'hmac-canary.json'),
        PAYMENT_STORAGE_PATH: join(dir, 'payments.json'),
        PAYMENT_LISTEN_PORT: '0',
      }),
      fetch: globalThis.fetch,
    });
    await expect(app.start()).rejects.toThrow(/canary/i);
  });
});
