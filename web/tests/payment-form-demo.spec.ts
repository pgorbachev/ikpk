import { expect, test, type Page } from '@playwright/test';
import {
  PAYMENT_ENTRY_ATTR,
  PAYMENT_FORM_ATTR,
  PAYMENT_HOLD_WARNING_ATTR,
  PAYMENT_STATE_ATTR,
} from './helpers/payment-contract';

const FORM = `[${PAYMENT_FORM_ATTR}]`;
const STATE = (s: string) => `[${PAYMENT_STATE_ATTR}="${s}"]`;

async function openForm(page: Page) {
  await page.goto('/oplata');
  const entry = page.locator(`[${PAYMENT_ENTRY_ATTR}]`);
  if ((await entry.count()) > 0) await entry.first().click();
  else await page.getByRole('button', { name: /оплат/i }).click();
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

async function mockApi(
  page: Page,
  handler: (req: { method: string; url: string; postData: string | null }) => { status: number; body: unknown },
) {
  await page.route(/\/payments(\/|$)/, async (route) => {
    const req = route.request();
    const reply = handler({ method: req.method(), url: req.url(), postData: req.postData() });
    await route.fulfill({
      status: reply.status,
      contentType: 'application/json',
      body: JSON.stringify(reply.body),
    });
  });
}

test.beforeEach(async ({ page }) => {
  page.on('framenavigated', (frame) => {
    void frame.url();
  });
  await page.route(/yookassa|ykassa/i, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><p>intercepted-confirmation</p>',
    });
  });
});

test.describe('3.9 клиент: демо-состояние, не редирект', () => {
  test('отправка в демо показывает состояние демо-режима, не уходит на ЮKassa', async ({ page }) => {
    await mockApi(page, () => ({ status: 200, body: { status: 'created_demo' } }));
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('demo'))).toBeVisible();
    expect(page.url()).not.toMatch(/yookassa|ykassa/i);
  });
});

test.describe('3.10a-2b демо не создаёт удержания', () => {
  test('две отправки одного состава — оба раза demo, форма доступна, удержания нет', async ({ page }) => {
    await mockApi(page, () => ({ status: 200, body: { status: 'created_demo' } }));
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('demo'))).toBeVisible();
    await expect(page.locator(FORM)).toBeVisible();
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('demo'))).toBeVisible();
    await expect(page.locator(`[${PAYMENT_HOLD_WARNING_ATTR}]`)).toHaveCount(0);
    await expect(page.locator(`${FORM} [type="submit"]`)).toBeVisible();

    // Предмет проверки — ХРАНИЛИЩЕ, а не наблюдаемые следствия. Найдено негативной
    // проверкой 6.7(3): после снятия обеих защит демо-режима (исключение в `upsertHold`
    // и снятие удержания в демо-ветви ответа) тест оставался зелёным, потому что
    // состояние `demo`, доступность формы и отсутствие предупреждения верны и при
    // ЗАПИСАННОМ удержании. То есть имя теста обещало то, чего он не проверял.
    const holds = await page.evaluate(
      () => JSON.parse(localStorage.getItem('ikpk-payment-holds') ?? '[]') as unknown[],
    );
    expect(holds, `демо-сборка записала удержания: ${JSON.stringify(holds)}`).toEqual([]);
  });
});

// Найдено негативной проверкой 6.7(3): требование «демо-сборка удержания НЕ создаёт»
// защищено двумя механизмами подряд — исключение в `upsertHold` и снятие удержания в
// демо-ветви ответа. По концу потока они неразличимы: «не записал» и «записал и сразу
// снял» дают одно и то же пустое хранилище, поэтому снятие ОДНОГО из двух механизмов
// не ловилось ничем. Требование при этом говорит «не создаёт», а не «не оставляет».
//
// Проверка смотрит в хранилище, пока запрос ещё в полёте: ответ задержан обработчиком
// маршрута, и в этот момент удержание либо есть, либо нет.
test.describe('3.10a-2b(2) демо не создаёт удержания даже во время отправки', () => {
  test('пока запрос в полёте, постоянное хранилище пусто', async ({ page }) => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/payments(\/|$)/, async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'created_demo' }),
      });
    });
    await openForm(page);
    await fillValid(page);
    const inFlight = page.waitForRequest((r) => r.method() === 'POST' && /\/payments/.test(r.url()));
    await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
    await inFlight;
    const during = await page.evaluate(
      () => JSON.parse(localStorage.getItem('ikpk-payment-holds') ?? '[]') as unknown[],
    );
    release?.();
    expect(during, `во время отправки демо записала удержания: ${JSON.stringify(during)}`).toEqual([]);
  });
});
