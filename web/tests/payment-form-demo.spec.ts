/**
 * Браузерный набор АРТЕФАКТА РОЛИ `preview` (задача 6.15; конфигурация —
 * `playwright.preview.config.ts`, артефакт — `dist-demo`).
 *
 * ПРЕДМЕТ ОГРАНИЧЕН РОЛЬЮ: демо-исход, повторяемость показа, отсутствие удержания и то, что
 * форма ведёт ТОЛЬКО на mock. Рабочей семантики (удержание, сверка, продолжение, дубль) у
 * этой роли нет по норме, и проверять её здесь нельзя — она живёт в наборе роли `stand`
 * (`payment-form.spec.ts`). Источник: `specs/online-payment/spec.md`, Requirements «Роли `ci`
 * и `preview` не создают платежей, а развёрнутый стенд работает с тестовым магазином» и «Роль
 * сборки объявлена перечислением, а не признаком «демо»» (таблица четырёх ролей).
 *
 * РАЗВЕДЕНИЕ ИДЁТ ПО РОЛИ, А НЕ ПО `DEMO_FORMS`: прежняя конфигурация
 * `playwright.demo.config.ts` противопоставлялась основной по признаку форм ЗАЯВКИ
 * (Bitrix24), у которого с платёжным контуром общего только история.
 *
 * ЖИВАЯ ЮKASSA НЕ УЧАСТВУЕТ: fail-closed guard (`helpers/payment-network-guard.ts`) роняет
 * тест на любом неперехваченном обращении к платёжному контуру или к настоящей ЮKassa, а
 * мёртвый прокси в конфигурации не даёт запросу уйти с машины вовсе.
 *
 * ОЖИДАНИЕ ПО ЦВЕТУ на `b4e80e7`: проверка объявленной роли КРАСНАЯ — артефакт `dist-demo`
 * несёт булев `data-payment-demo="true"` и роли не объявляет. Проверки mock-адреса,
 * терминальности демо-исхода, отсутствия удержания и повторяемости — ЗЕЛЁНЫЕ уже сегодня
 * (характеризация: поведение есть, 6.15 переносит его на артефакт своей роли).
 */
import { expect, test, type Page } from '@playwright/test';
import {
  PAYMENT_ENDPOINT_ATTR,
  PAYMENT_ENTRY_ATTR,
  PAYMENT_FORM_ATTR,
  PAYMENT_HOLD_WARNING_ATTR,
  PAYMENT_ROLE_ATTR,
  PAYMENT_STATE_ATTR,
  PREVIEW_MOCK_ENDPOINT,
} from './helpers/payment-contract';
import {
  expectNoEscapes,
  installFailClosedGuard,
  takeEscapes,
  type FailClosedGuard,
} from './helpers/payment-network-guard';
import { installThirdPartyGuard } from './helpers/third-party-guard';

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

let guard: FailClosedGuard;

test.beforeEach(async ({ page }) => {
  // installThirdPartyGuard ПЕРВЫМ: маршруты применяются в обратном порядке регистрации,
  // и этим же приёмом ниже отделяется fail-closed guard от мока конкретного теста.
  await installThirdPartyGuard(page);
  page.on('framenavigated', (frame) => {
    void frame.url();
  });
  // Прежде здесь стоял ЗАГЛУШАЮЩИЙ маршрут на `/yookassa|ykassa/i`: обращение к настоящей
  // ЮKassa он превращал в безобидную страницу, то есть утечка проходила молча и тест
  // оставался зелёным. По задаче 6.15 такое обращение обязано РОНЯТЬ тест, поэтому мок
  // заменён на fail-closed guard, который предмет называет.
  guard = await installFailClosedGuard(page, 'preview');
});

test.afterEach(() => {
  expectNoEscapes(guard);
});

test.describe('6.15 артефакт набора: роль preview и только mock-адрес', () => {
  test('артефакт объявляет роль preview, и другой роли в нём нет', async ({ page }) => {
    await openForm(page);
    const declared = await page.evaluate(
      (attr) => [...document.querySelectorAll(`[${attr}]`)].map((el) => el.getAttribute(attr)),
      PAYMENT_ROLE_ATTR,
    );
    // «Роль не объявлена» — непройденная проверка, а не «нарушений нет»: без роли неизвестно,
    // на каком артефакте идёт набор, и его зелёный исход ничего не значит.
    expect(
      declared,
      `страница не объявляет ${PAYMENT_ROLE_ATTR} — предмет набора не подтверждён, проверка не пройдена`,
    ).not.toEqual([]);
    expect([...new Set(declared)]).toEqual(['preview']);
  });

  test('форма ведёт только на mock: база равна mock-адресу, запрос уходит туда и больше никуда', async ({
    page,
  }) => {
    const seen: string[] = [];
    await page.route(/\/payments(\/|$)/, async (route) => {
      seen.push(`${route.request().method()} ${route.request().url()}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'created_demo' }),
      });
    });

    await openForm(page);
    expect(
      await page.locator(FORM).getAttribute(PAYMENT_ENDPOINT_ATTR),
      'форма роли preview не объявляет базу эндпоинта — проверка не пройдена',
    ).toBe(PREVIEW_MOCK_ENDPOINT);

    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('demo'))).toBeVisible();

    // Ни одного обращения мимо mock-адреса. Обращение к установленному контуру или к живой
    // ЮKassa поймал бы ещё и guard в afterEach — здесь предмет уже́, чем у него: адресат
    // ИМЕННО отправки формы.
    expect(seen).toEqual([`POST ${PREVIEW_MOCK_ENDPOINT}/payments`]);
  });

  test('демо-исход терминален: перезагрузка не опрашивает статус и не показывает состояния попытки', async ({
    page,
  }) => {
    const statusGets: string[] = [];
    await page.route(/\/payments(\/|$)/, async (route) => {
      const request = route.request();
      if (request.method() === 'GET') statusGets.push(request.url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'created_demo' }),
      });
    });

    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('demo'))).toBeVisible();

    // Терминальность — не «в этой сессии всё выглядит хорошо», а отсутствие продолжения
    // попытки после перезагрузки. Проверка соседняя, но НЕ та же, что «две отправки одного
    // состава»: там предмет — повторяемость показа внутри сессии и пустое хранилище.
    await page.reload();
    await page.waitForTimeout(1000);
    expect(statusGets, `демо-исход оставил попытку живой: опрос статуса ${statusGets.join(', ')}`).toEqual([]);
    await expect(page.locator(`[${PAYMENT_HOLD_WARNING_ATTR}]`)).toHaveCount(0);
    const entry = page.locator(`[${PAYMENT_ENTRY_ATTR}]`);
    if ((await entry.count()) > 0) await expect(entry.first()).toBeEnabled();
  });

  test('перехват полон: неперехваченный запрос к живой ЮKassa останавливается и назван', async ({ page }) => {
    await page.goto('/oplata');
    // Намеренный запрос БЕЗ мока: иначе «утечек не было» означало бы лишь «никто не пробовал».
    // Раньше на этом месте стоял заглушающий маршрут, и обращение к настоящей ЮKassa прошло бы
    // молча — ровно то, что запрещает 6.15.
    const reached = await page.evaluate(async () => {
      try {
        await fetch('https://api.yookassa.ru/v3/payments', { method: 'POST', body: '{}' });
        return 'дошёл';
      } catch {
        return 'остановлен';
      }
    });
    expect(reached).toBe('остановлен');
    // Судить по НАЗВАННОМУ предмету, а не по сетевому отказу: отказ даёт и мёртвый прокси.
    expect(takeEscapes(guard).map((e) => e.subject)).toEqual(['живая ЮKassa']);
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
