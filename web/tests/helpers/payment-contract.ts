/**
 * Наблюдаемый контракт оплаты для тестов раздела 3 / 3a.
 *
 * Имена атрибутов и путей — из `design.md` (Решение 2, 8) и спеки. Поля ЮKassa
 * (`vat_code`, `payment_subject`, `payment_mode`, имя флага одностадийности) сюда
 * не входят: задача 2.2a не закрыта, выдумывать их нельзя.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..', '..');

/** Точка входа сервера, которого ещё нет — отсутствие файла делает серверные тесты красными. */
export const PAYMENT_SERVICE_ENTRY = join(repoRoot, 'payments', 'src', 'app.ts');
export const PAYMENT_SERVICE_MAIN = join(repoRoot, 'payments', 'src', 'main.ts');

export const PAYMENT_FORM_ATTR = 'data-payment-form';
export const PAYMENT_ENDPOINT_ATTR = 'data-payment-endpoint';
export const PAYMENT_ENTRY_ATTR = 'data-payment-entry';
export const PAYMENT_STATE_ATTR = 'data-payment-state';
export const PAYMENT_CONTINUE_ATTR = 'data-payment-continue';
export const PAYMENT_OTHER_SEMINAR_ATTR = 'data-payment-other-seminar';
export const PAYMENT_COPY_ID_ATTR = 'data-payment-copy-id';
export const PAYMENT_CONFIRM_DUPLICATE_ATTR = 'data-payment-confirm-duplicate';
export const PAYMENT_ATTEMPTS_ATTR = 'data-payment-attempts';
export const PAYMENT_HOLD_WARNING_ATTR = 'data-payment-hold-warning';
export const PAYMENT_SUMMARY_ATTR = 'data-payment-summary';
export const RETURN_PARAM = 'paymentRequest';

export const STALE_LEAD_IN_COPY =
  'Готовы произвести оплату за семинар? Кликайте на кнопку, выбирайте направление и записывайтесь к нам на обучение!';

export const TEST_YOOKASSA_SECRET = 'test-yookassa-secret-DO-NOT-SHIP';
export const TEST_HMAC_CURRENT = 'test-hmac-current-material-v1';
export const TEST_HMAC_PREVIOUS = 'test-hmac-previous-material-v0';
export const TEST_HMAC_CURRENT_VERSION = '2026-08-01';
export const TEST_HMAC_PREVIOUS_VERSION = '2026-07-01';

export const CHANNEL_SOURCE_KEY = 'source';

export type PaymentPayload = {
  requestId: string;
  firstName: string;
  lastName: string;
  seminar: string;
  amount: number;
  startDate: string | null;
  venue: string | null;
  email: string;
  phone: string;
  consent: true;
  duplicateConfirmed?: boolean;
  duplicateConfirmationToken?: string;
};

export function validPayload(overrides: Partial<PaymentPayload> = {}): PaymentPayload {
  return {
    requestId: randomUUID(),
    firstName: 'Иван',
    lastName: 'Петров',
    seminar: 'Прикладная кинезиология, модуль 1',
    amount: 1,
    startDate: '2026-09-01',
    venue: 'Санкт-Петербург',
    email: 'ivan.petrov@example.com',
    phone: '79111234567',
    consent: true,
    ...overrides,
  };
}

/** Канон из design.md, Решение 3а: фиксированный порядок, null вместо отсутствующих. */
export function canonicalFingerprintSource(body: PaymentPayload): string {
  return JSON.stringify({
    firstName: body.firstName,
    lastName: body.lastName,
    seminar: body.seminar,
    amount: body.amount,
    startDate: body.startDate,
    venue: body.venue,
    email: body.email,
    phone: body.phone,
  });
}

export function fingerprintOf(body: PaymentPayload, key: string): string {
  return createHmac('sha256', key).update(canonicalFingerprintSource(body)).digest('hex');
}

export function prodEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    PAYMENT_MODE: 'prod',
    RECEIPT_ENABLED: 'false',
    YOOKASSA_SHOP_ID: 'test-shop',
    YOOKASSA_SECRET_KEY: TEST_YOOKASSA_SECRET,
    HMAC_KEY_CURRENT: TEST_HMAC_CURRENT,
    HMAC_KEY_CURRENT_VERSION: TEST_HMAC_CURRENT_VERSION,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

export const LEAD_ID_FIELD_NAMES = [
  'leadId',
  'lead_id',
  'dealId',
  'deal_id',
  'bitrixId',
  'bitrix_id',
  'crmId',
  'applicationId',
  'zayavkaId',
  'userId',
] as const;

export type PaymentRecord = {
  requestId: string;
  yookassaPaymentId: string | null;
  status: string;
  fingerprint: string;
  keyVersion: string;
  createdAt: string;
  confirmedAt?: string | null;
  verificationAt?: string | null;
  verificationReason?: string | null;
};

export type VerificationJournalEntry = {
  requestId: string;
  at: string;
  reason: string;
};
