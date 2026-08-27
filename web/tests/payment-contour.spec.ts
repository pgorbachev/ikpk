/**
 * Матрица контуров: КЛИЕНТ ОПУБЛИКОВАННОЙ СТРАНИЦЫ при недоступном API (задача 3.16(4)).
 *
 * Источник требования (change `online-payment-flow`, `specs/online-payment/spec.md`,
 * Requirement «Установленные платёжные контуры нельзя публиковать выключенными или
 * перепутанными», сценарий «Недоступность API после публикации не переключает контур»):
 * клиент показывает предусмотренное состояние ошибки и НЕ отключает форму, НЕ вызывает
 * mock и НЕ переключается на другой магазин.
 *
 * Почему браузерный тест: предмет — поведение уже опубликованной страницы, а сборка и
 * build-гейты его не видят (сборка зелёная и на клиенте, который молча уходит на другой
 * адрес).
 *
 * ЧТО ИМЕННО УТВЕРЖДАЕТСЯ, и почему не «видно состояние ошибки» и всё: какое именно
 * состояние показывает клиент при неотвеченном создании платежа, уже закреплено другим
 * требованием (удержание попытки, `payment-form.spec.ts`, 3.10a-2a). Здесь предмет —
 * инвариант контура: адрес не подменён, посторонних адресатов не появилось, форма со
 * страницы не исчезла. Проверять здесь ещё и «какое состояние» значило бы дать двум
 * проверкам один предмет с риском разных ответов.
 *
 * АРТЕФАКТ — РОЛЬ `stand` (`dist-stand`, `playwright.stand.config.ts`), решение владельца
 * 2026-08-19; прежде набор шёл основной конфигурацией по боевому `dist`, то есть по сборке
 * роли `ci`, у которой формы по контракту нет. Объявленная база берётся из артефакта КАК
 * ЕСТЬ и ничем не подменяется: предмет — что клиент после сбоя не уходит мимо неё, а не
 * какое именно значение там записано. Перехват (`payment-network-guard.ts`) взведён тем же
 * способом, что и в остальных наборах роли, и живёт только в транспорте.
 *
 * ОЖИДАНИЕ ПО ЦВЕТУ: этот инвариант, по наблюдению на `12f2135` (продуктовый код с `ac4089b` не менялся: обе поставки — спека и тесты), уже выполняется —
 * проверка предъявляется как ЗЕЛЁНАЯ и закрепляет свойство, а не доказывает
 * нереализованное. Красными в этой сессии предъявлены проверки роли, readiness, базы
 * возврата и гейта; см. отчёт сессии.
 */

import { expect, test, type Page, type Request } from '@playwright/test';
import { PAYMENT_ENDPOINT_ATTR, PAYMENT_ENTRY_ATTR, PAYMENT_FORM_ATTR } from './helpers/payment-contract';
import { gotoOplata, interceptYooKassaNavigation } from './helpers/yookassa-navigation';
import {
  expectNoEscapes,
  installFailClosedGuard,
  type FailClosedGuard,
} from './helpers/payment-network-guard';
import { installThirdPartyGuard } from './helpers/third-party-guard';

const FORM = `[${PAYMENT_FORM_ATTR}]`;

async function openForm(page: Page) {
  await gotoOplata(page);
  const entry = page.locator(`[${PAYMENT_ENTRY_ATTR}]`);
  if ((await entry.count()) > 0) {
    await expect(entry.first()).toBeEnabled();
    await entry.first().click();
  } else await page.getByRole('button', { name: /оплат/i }).click();
  await expect(page.locator(FORM)).toBeVisible();
}

async function fillValid(page: Page) {
  await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
  await page.locator(`${FORM} [name="lastName"]`).fill('Петров');
  await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 1');
  await page.locator(`${FORM} [name="amount"]`).fill('1');
  await page.locator(`${FORM} [name="email"]`).fill('ivan@example.com');
  await page.locator(`${FORM} [name="phone"]`).fill('79111234567');
  await page.locator(`${FORM} [name="consent"]`).check();
}

let guard: FailClosedGuard;

test.beforeEach(async ({ page }) => {
  // installThirdPartyGuard ПЕРВЫМ: маршруты применяются в обратном порядке регистрации,
  // и этим же приёмом ниже отделяется fail-closed guard от мока конкретного теста.
  await installThirdPartyGuard(page);
  // Guard ПЕРВЫМ: маршруты применяются в обратном порядке регистрации, поэтому обрыв
  // `/payments` самим тестом (это и есть его предмет — недоступный API) забирает свои
  // запросы, а guard видит только то, что не забрал никто.
  guard = await installFailClosedGuard(page, 'stand');
  await interceptYooKassaNavigation(page);
});

test.afterEach(() => {
  expectNoEscapes(guard);
});

test.describe('3.16(4) недоступность API не переключает контур', () => {
  test('после сбоя адрес не подменён, посторонних адресатов нет, форма на месте', async ({ page }) => {
    const seen: string[] = [];
    page.on('request', (req: Request) => {
      if (/\/payments(\/|$|\?)/.test(req.url())) seen.push(req.url());
    });
    await page.route(/\/payments(\/|$)/, (route) => route.abort('failed'));

    await openForm(page);
    const declared = await page.locator(FORM).getAttribute(PAYMENT_ENDPOINT_ATTR);
    expect(declared, 'форма не объявляет адрес платёжного эндпоинта').toBeTruthy();

    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await page.waitForTimeout(1000);

    // Форма не отключена: недоступность API — не повод убрать возможность со страницы.
    await expect(page.locator(FORM)).toHaveCount(1);
    // Адрес не подменён после сбоя.
    expect(await page.locator(FORM).getAttribute(PAYMENT_ENDPOINT_ATTR)).toBe(declared);
    // Ни одного обращения мимо объявленной базы: ни mock, ни другой контур.
    const base = new URL(declared!, page.url()).origin;
    const strangers = seen.filter((u) => new URL(u).origin !== base);
    expect(strangers, `клиент обратился мимо объявленного контура: ${strangers.join(', ')}`).toEqual([]);
  });
});
