/**
 * Матрица контуров: РОЛЬ КЛИЕНТСКОЙ СБОРКИ (задачи 5.10, 5.10a).
 *
 * Источник требований (change `online-payment-flow`, `specs/online-payment/spec.md`):
 *  - Requirement «Роль сборки объявлена перечислением, а не признаком «демо»»: значение
 *    из набора `ci|stand|prod`, признак `data-payment-demo` удалён, роль сборки и режим
 *    сервиса — разные значения;
 *  - Requirement «Адрес платёжного эндпоинта опознаётся в сборке», сценарий «Объявленный
 *    адрес соответствует режиму сборки»: mock для `ci`, база `<origin стенда>/api` для
 *    `stand`, база боевого API для `prod`;
 *  - Requirement «CI/preview не создаёт платежей…»: объявляется БАЗА, а не путь —
 *    значение `/api/payments` в качестве базы запрещено, иначе запрос уходит на
 *    `/api/payments/payments`;
 *  - задача 5.10: неизвестная роль останавливает сборку, отсутствие роли даёт безопасную
 *    CI-сборку без формы.
 *
 * ПРЕДМЕТ — разрешение роли и адреса на сборке, то есть модуль `src/lib/forms.ts`
 * (сейчас он экспортирует `paymentEndpoint()` и решает вопрос булевым `isDemoForms`).
 * Проверять это через полную `astro build` на каждое значение роли — минуты на случай;
 * здесь проверяется тот самый вычислитель, который сборка и вызывает.
 *
 * ШОВ, ВЫБРАННЫЙ ТЕСТАМИ: переменная сборки `PAYMENT_ROLE` и экспорт
 * `paymentRole(): 'ci'|'stand'|'prod'`, бросающий на неизвестном значении. Спека
 * называет наблюдаемое в артефакте (`data-payment-role`) и не называет ни имени
 * переменной, ни имени функции — поэтому связь объявлена здесь явно: при переименовании
 * правится этот файл, но НЕ ослабляется требование. Артефактная сторона того же
 * требования проверяется отдельно и от имён не зависит — `payment-role-dist.test.ts`.
 *
 * ПОЧЕМУ КРАСНЫЕ СЕЙЧАС: на `12f2135` (продуктовый код с `ac4089b` не менялся: обе поставки — спека и тесты) роли нет вовсе — ни переменной, ни экспорта;
 * `paymentEndpoint()` выбирает адрес по `DEMO_FORMS` (признак форм ЗАЯВКИ, чужой
 * предмет), а стендовая база `http://193.124.115.99/api` не существует в коде.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_ENDPOINT_BASE,
  PAYMENT_ROLES,
  PREVIEW_MOCK_ENDPOINT,
  RETIRED_STAND_ENDPOINT,
} from './helpers/payment-contract';

const MODULE = '../src/lib/forms';

type FormsModule = {
  paymentRole?: () => string;
  paymentEndpoint?: () => string;
};

async function loadWithRole(role: string | undefined): Promise<FormsModule> {
  vi.resetModules();
  if (role === undefined) vi.stubEnv('PAYMENT_ROLE', '');
  else vi.stubEnv('PAYMENT_ROLE', role);
  return (await import(MODULE)) as FormsModule;
}

function role(mod: FormsModule): () => string {
  if (typeof mod.paymentRole !== 'function') {
    throw new Error(
      'src/lib/forms.ts не экспортирует paymentRole(): роль сборки не реализована. ' +
        'Красное — отсутствие реализации, а не сломанный шов.',
    );
  }
  return mod.paymentRole;
}

function endpoint(mod: FormsModule): () => string {
  if (typeof mod.paymentEndpoint !== 'function') {
    throw new Error('src/lib/forms.ts не экспортирует paymentEndpoint()');
  }
  // Адрес обязан выводиться ИЗ РОЛИ. Без экспорта роли совпадение значения — случайность:
  // сегодня `paymentEndpoint()` отдаёт боевую базу просто потому, что `DEMO_FORMS` пуста,
  // и проверка была бы зелёной на нереализованной матрице.
  role(mod);
  return mod.paymentEndpoint;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('5.10a роль сборки — перечисление из четырёх значений', () => {
  it.each(PAYMENT_ROLES)('роль %s разрешается сама в себя', async (value) => {
    const mod = await loadWithRole(value);
    expect(role(mod)()).toBe(value);
  });

  it('роль не задана — безопасная CI-сборка, а не артефакт установленного контура', async () => {
    const mod = await loadWithRole(undefined);
    expect(role(mod)()).toBe('ci');
  });

  // Неизвестная роль останавливает сборку. Молчаливое приведение к `ci` тут хуже
  // отказа: опечатка `stnad` дала бы артефакт без формы там, где заказан стенд, и
  // расхождение всплыло бы только у посетителя.
  it.each(['stnad', 'staging', 'demo', 'test', 'PROD', 'Preview', 'ci prod', 'true'])(
    'неизвестная роль %j — отказ, а не молчаливое приведение к ci',
    async (value) => {
      const mod = await loadWithRole(value);
      // Сначала предъявляем шов, и только потом требуем отказа: иначе тест зелёный
      // просто потому, что экспорта нет вовсе — отсутствие реализации выдавалось бы за
      // выполненное требование.
      const resolve = role(mod);
      expect(() => resolve()).toThrow();
    },
  );
});

describe('5.10 объявляемый адрес соответствует роли', () => {
  it('prod объявляет явно заданную базу боевого API буквально', async () => {
    vi.resetModules();
    vi.stubEnv('PAYMENT_ROLE', 'prod');
    vi.stubEnv('PAYMENT_ENDPOINT_PROD', PAYMENT_ENDPOINT_BASE.prod);
    const mod = (await import(MODULE)) as FormsModule;
    expect(endpoint(mod)()).toBe(PAYMENT_ENDPOINT_BASE.prod);
  });

  // Внесено решением владельца 2026-08-20/21: production endpoint не выбран этим change,
  // поэтому у роли `prod` не может быть неявного умолчания — раньше здесь молча
  // подставлялся захардкоженный `https://api.ikpk.su`.
  it('prod без явного PAYMENT_ENDPOINT_PROD — отказ, а не умолчание', async () => {
    const mod = await loadWithRole('prod');
    expect(() => endpoint(mod)()).toThrow(/PAYMENT_ENDPOINT_PROD/);
  });

  it('stand объявляет базу на своём origin, а не недостижимый .invalid прежней матрицы', async () => {
    const mod = await loadWithRole('stand');
    const value = endpoint(mod)();
    expect(value).toBe(PAYMENT_ENDPOINT_BASE.stand);
    expect(value).not.toBe(RETIRED_STAND_ENDPOINT);
  });

  // Объявляется БАЗА: клиент дописывает `/payments` сам. База, уже содержащая путь
  // запроса, отправила бы создание платежа на `/api/payments/payments`.
  it('база stand не содержит пути запроса и не заканчивается на /payments', async () => {
    const mod = await loadWithRole('stand');
    const value = endpoint(mod)();
    expect(value.endsWith('/payments')).toBe(false);
    expect(value).not.toMatch(/\/payments(\/|$)/);
  });

  // Роль `ci` формы не несёт, значит и базы у неё нет: ожидаемое для неё значение —
  // ОТСУТСТВИЕ адреса, а не какая-то строка. Шов: `paymentEndpoint()` отдаёт `null`.
  it('ci не объявляет базы вовсе', async () => {
    const mod = await loadWithRole('ci');
    expect(endpoint(mod)()).toBeNull();
  });

  it('preview объявляет mock-адрес: ни боевой базы, ни стендовой, ни адреса ЮKassa', async () => {
    const mod = await loadWithRole('preview');
    const value = endpoint(mod)();
    expect(value).toBe(PREVIEW_MOCK_ENDPOINT);
    expect(value).not.toBe(PAYMENT_ENDPOINT_BASE.prod);
    expect(value).not.toBe(PAYMENT_ENDPOINT_BASE.stand);
    expect(value).not.toMatch(/yookassa|ykassa/i);
  });

  // Роль сборки не выводится из режима форм ЗАЯВКИ: `DEMO_FORMS` держит чужой предмет
  // (CRM-формы Bitrix24), и связывание двух предметов одним признаком — ровно то, из-за
  // чего стенд с настоящим тестовым магазином был невыразим.
  it('роль не зависит от DEMO_FORMS', async () => {
    vi.resetModules();
    vi.stubEnv('DEMO_FORMS', 'stub');
    vi.stubEnv('PAYMENT_ROLE', 'prod');
    vi.stubEnv('PAYMENT_ENDPOINT_PROD', PAYMENT_ENDPOINT_BASE.prod);
    const mod = (await import(MODULE)) as FormsModule;
    expect(role(mod)()).toBe('prod');
    expect(endpoint(mod)()).toBe(PAYMENT_ENDPOINT_BASE.prod);
  });
});
