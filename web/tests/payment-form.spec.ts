/**
 * Браузерный набор АРТЕФАКТА РОЛИ `stand` (задача 6.15; конфигурация —
 * `playwright.stand.config.ts`, артефакт — `dist-stand`).
 *
 * ПОЧЕМУ ИМЕННО РОЛЬ `stand`. Рабочая семантика контура — удержание незавершённой попытки,
 * сверка, продолжение попытки, подтверждение дубля, несколько удержаний — есть ТОЛЬКО у
 * установленных ролей (`specs/online-payment/spec.md`, Requirement «Роли `ci` и `preview` не
 * создают платежей, а развёрнутый стенд работает с тестовым магазином»: на артефакте
 * `preview` эти сценарии проверить нельзя, потому что удержания там нет по норме). Раньше
 * набор шёл на `dist` — сборке без объявленной роли; после задачи 5.10 у неё роль `ci` и
 * формы нет вовсе, то есть предмет исчез бы молча.
 *
 * ЖИВАЯ ЮKASSA НЕ УЧАСТВУЕТ, весь платёжный API перехвачен Playwright, и это закрыто
 * fail-closed guard'ом (`helpers/payment-network-guard.ts`) плюс мёртвым прокси в
 * конфигурации набора. Секреты ЮKassa этому прогону не нужны и в CI не передаются.
 *
 * ПЕРЕХВАТ НЕ МЕНЯЕТ ПРЕДМЕТ: ни `data-payment-role`, ни объявленную базу, ни ответы
 * продукта тесты не переписывают — роль и база читаются из артефакта как есть (первые две
 * проверки ниже), а перехват живёт только в транспорте.
 *
 * ОЖИДАНИЕ ПО ЦВЕТУ на `b4e80e7`: проверки роли и объявленной базы КРАСНЫЕ — артефакт роли
 * не объявляет вовсе (в разметке булев `data-payment-demo`), а объявленный адрес равен
 * боевому `https://api.ikpk.su`, тогда как роли `stand` полагается `http://193.124.115.99/api`.
 * Самопроверка взведённости guard'а ЗЕЛЁНАЯ: механизм перехвата от продукта не зависит.
 * Остальные проверки файла к 6.15 отношения не имеют и лишь переехали на свой артефакт.
 */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  PAYMENT_CONFIRM_DUPLICATE_ATTR,
  PAYMENT_ENDPOINT_ATTR,
  PAYMENT_ENDPOINT_BASE,
  PAYMENT_ROLE_ATTR,
  PAYMENT_CONTINUE_ATTR,
  PAYMENT_ENTRY_ATTR,
  PAYMENT_FORM_ATTR,
  PAYMENT_HOLD_WARNING_ATTR,
  PAYMENT_OTHER_SEMINAR_ATTR,
  PAYMENT_STATE_ATTR,
  PAYMENT_SUMMARY_ATTR,
  RETURN_PARAM,
} from './helpers/payment-contract';
import {
  expectNoEscapes,
  installFailClosedGuard,
  takeEscapes,
  type FailClosedGuard,
} from './helpers/payment-network-guard';
import {
  gotoOplata,
  interceptYooKassaNavigation,
  yooKassaFallbackHref,
  yooKassaNavigationUrls,
} from './helpers/yookassa-navigation';
import { installThirdPartyGuard } from './helpers/third-party-guard';

const FORM = `[${PAYMENT_FORM_ATTR}]`;
const STATE = (s: string) => `[${PAYMENT_STATE_ATTR}="${s}"]`;

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

async function mockApi(page: Page, handler: (req: { method: string; url: string; postData: string | null }) => { status: number; body: unknown }) {
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

/** Объявленная база роли `stand` (решение владельца 2026-08-18): origin стенда плюс `/api`. */
const STAND_BASE = PAYMENT_ENDPOINT_BASE.stand;

let guard: FailClosedGuard;

test.beforeEach(async ({ page }) => {
  // installThirdPartyGuard ПЕРВЫМ: тем же приёмом, что и ниже, отделяющим fail-closed
  // guard от мока конкретного теста — маршруты применяются в обратном порядке регистрации.
  await installThirdPartyGuard(page);
  // Guard ставится ПЕРВЫМ. Playwright применяет маршруты в обратном порядке регистрации:
  // моки конкретного теста, поставленные позже, забирают свои запросы, а guard видит ровно
  // то, что не забрал никто. Обратный порядок сделал бы guard'ом первый же мок.
  guard = await installFailClosedGuard(page, 'stand');
  await interceptYooKassaNavigation(page);
});

// Fail-closed постусловие КАЖДОГО теста файла: пропущенный мок роняет тест, а не уходит на
// живой контур молча. Зелёный тест с утечкой — это ложное зелёное: его исход получен не от
// того адресата, о котором он говорит.
test.afterEach(() => {
  expectNoEscapes(guard);
});

test.describe('6.15 артефакт набора: роль stand, её база и полнота перехвата', () => {
  test('артефакт объявляет роль stand, и другой роли в нём нет', async ({ page }) => {
    await openForm(page);
    const declared = await page.evaluate(
      (attr) => [...document.querySelectorAll(`[${attr}]`)].map((el) => el.getAttribute(attr)),
      PAYMENT_ROLE_ATTR,
    );
    // «Роль не объявлена» — это НЕПРОЙДЕННАЯ проверка, а не «нарушений не найдено»: без роли
    // предмет набора неизвестен, и любой его зелёный исход ничего не значит.
    expect(
      declared,
      `страница не объявляет ${PAYMENT_ROLE_ATTR} — предмет набора не подтверждён, проверка не пройдена`,
    ).not.toEqual([]);
    expect([...new Set(declared)]).toEqual(['stand']);
  });

  test('объявленная база остаётся http://193.124.115.99/api, и перехват её не меняет', async ({ page }) => {
    const posts: string[] = [];
    await page.route(/\/payments(\/|$)/, async (route) => {
      const request = route.request();
      if (request.method() === 'POST') posts.push(request.url());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'pending' }),
      });
    });

    await openForm(page);
    const before = await page.locator(FORM).getAttribute(PAYMENT_ENDPOINT_ATTR);
    expect(before, 'форма не объявляет базу эндпоинта — проверка не пройдена').toBe(STAND_BASE);

    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect.poll(() => posts.length).toBe(1);

    // Клиент дописывает `/payments` к БАЗЕ. `/api/payments` в качестве базы дало бы
    // `/api/payments/payments` — спека запрещает это прямо.
    expect(posts).toEqual([`${STAND_BASE}/payments`]);
    // Перехват не переписывает объявленный адрес: после отправки он тот же.
    expect(await page.locator(FORM).getAttribute(PAYMENT_ENDPOINT_ATTR)).toBe(STAND_BASE);
  });

  test('перехват полон: неперехваченный запрос к базе стенда и к живой ЮKassa останавливается и назван', async ({
    page,
  }) => {
    await gotoOplata(page);
    // Намеренные запросы БЕЗ мока — единственный способ проверить, что fail-closed взведён.
    // Обычный прогон такого не производит, поэтому «утечек нет» без этой проверки означало бы
    // лишь «никто не пробовал».
    const reached = await page.evaluate(async (urls) => {
      const out: string[] = [];
      for (const url of urls) {
        try {
          await fetch(url, { method: 'POST', body: '{}' });
          out.push('дошёл');
        } catch {
          out.push('остановлен');
        }
      }
      return out;
    }, [`${STAND_BASE}/payments`, 'https://api.yookassa.ru/v3/payments']);

    expect(reached).toEqual(['остановлен', 'остановлен']);
    // Судить по НАЗВАННОМУ предмету, а не по факту сетевого отказа: отказ даёт и мёртвый
    // прокси (слой 1), а назвать предмет умеет только перехват (слой 2).
    expect(takeEscapes(guard).map((e) => e.subject)).toEqual(['объявленная база роли', 'живая ЮKassa']);
  });
});

test.describe('3.8 клиент: подписи про оплату', () => {
  test('открытая форма не говорит про заявку', async ({ page }) => {
    await openForm(page);
    const text = await page.locator(FORM).innerText();
    expect(text).toMatch(/оплат/i);
    expect(text).not.toMatch(/записывайтесь к нам на обучение/i);
  });
});

test.describe('3.9b клиент: неизвестный ответ — общая ошибка адресата', () => {
  test('created_demo на боевом клиенте — ошибка, не успех', async ({ page }) => {
    await mockApi(page, () => ({ status: 200, body: { status: 'created_demo' } }));
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('error'))).toBeVisible();
    await expect(page.locator(STATE('created'))).toHaveCount(0);
  });

  test('код/тело вне контракта — общая ошибка адресата', async ({ page }) => {
    await mockApi(page, () => ({ status: 418, body: { teapot: true } }));
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('error'))).toBeVisible();
  });
});

test.describe('5.4 created: немедленный переход и ссылка-подстраховка', () => {
  test('created вызывает location.assign и оставляет ссылку на confirmationUrl', async ({ page }) => {
    await mockApi(page, () => ({
      status: 201,
      body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' },
    }));
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
    await expect.poll(() => ({
      urls: yooKassaNavigationUrls(page),
      href: yooKassaFallbackHref(page),
    })).toEqual({
      urls: ['https://yookassa.test/c'],
      href: 'https://yookassa.test/c',
    });
    expect(page.url()).not.toMatch(/yookassa\.test/);
  });
});

test.describe('r15 requestId без crypto.randomUUID (небезопасный контекст)', () => {
  test('отправка создаёт requestId резервным способом, когда crypto.randomUUID недоступен', async ({ page }) => {
    // Найдено живой приёмкой на стенде (`http://193.124.115.99`, без TLS, решение владельца
    // от 2026-08-13 — design.md, Решение 1): `crypto.randomUUID` — часть Web Crypto API,
    // недоступная в non-secure context. Браузер отдаёт для него `undefined` на любом origin,
    // кроме `https:` и loopback (`localhost`/`127.0.0.1`) — а весь остальной набор гоняется
    // именно на `127.0.0.1` (`playwright.stand.config.ts`), поэтому эту находку не мог
    // поймать НИ ОДИН из 65 существующих тестов файла: у них секьюрность контекста не
    // варьируется. Прежний код звал `crypto.randomUUID()` без проверки — на стенде это
    // синхронный `TypeError`, пойманный catch-ом обработчика отправки, и КАЖДАЯ попытка
    // оплаты падала в состояние `unknown` без единого сетевого запроса.
    await page.addInitScript(() => {
      delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID;
    });
    let capturedRequestId: string | undefined;
    await mockApi(page, ({ postData }) => {
      capturedRequestId = postData ? (JSON.parse(postData) as { requestId?: string }).requestId : undefined;
      return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
    });
    await openForm(page);
    const randomUUIDType = await page.evaluate(() => typeof crypto.randomUUID);
    expect(randomUUIDType, 'стенд эмулирует недоступность crypto.randomUUID').toBe('undefined');
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
    await expect.poll(() => capturedRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await expect(page.locator(STATE('unknown'))).toHaveCount(0);
  });
});

test.describe('3.10 возврат с параметром запускает опрос', () => {
  test('открытие /oplata?paymentRequest= запускает GET status и показывает исход без webhook', async ({ page }) => {
    const id = randomUUID();
    const gets: string[] = [];
    await page.route(/\/payments\//, async (route) => {
      gets.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'succeeded' }),
      });
    });
    await gotoOplata(page, `/oplata?${RETURN_PARAM}=${id}`);
    await expect.poll(() => gets.length).toBeGreaterThan(0);
    await expect(page.locator(STATE('succeeded'))).toBeVisible();
  });
});

test.describe('3.10a новый requestId после терминального исхода', () => {
  test('после canceled следующая отправка несёт новый requestId; already_paid не редиректит', async ({ page }) => {
    const ids: string[] = [];
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        const body = JSON.parse(req.postData ?? '{}') as { requestId: string };
        ids.push(body.requestId);
        if (ids.length === 1) return { status: 200, body: { status: 'canceled' } };
        return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
      }
      return { status: 200, body: { status: 'canceled' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('canceled'))).toBeVisible();
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect.poll(() => ids.length).toBeGreaterThanOrEqual(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test('повтор already_paid показывает «оплата уже подтверждена», не confirmationUrl', async ({ page }) => {
    await mockApi(page, () => ({ status: 200, body: { status: 'already_paid' } }));
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('already_paid'))).toBeVisible();
    expect(page.url()).not.toMatch(/yookassa/i);
  });
});

test.describe('3.10a-1 тот же requestId при verification_required', () => {
  test('кнопка продолжения открывает предзаполненную редактируемую форму; повтор — тот же requestId и изменённые данные', async ({ page }) => {
    const posts: { requestId: string; amount: number }[] = [];
    await mockApi(page, (req) => {
      if (req.method !== 'POST') return { status: 200, body: { status: 'pending' } };
      const body = JSON.parse(req.postData ?? '{}') as { requestId: string; amount: number };
      posts.push({ requestId: body.requestId, amount: body.amount });
      return { status: 503, body: { status: 'verification_required', requestId: body.requestId } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('verification_required'))).toBeVisible();
    expect(posts).toHaveLength(1);
    await page.locator(`[${PAYMENT_CONTINUE_ATTR}]`).click();
    const amount = page.locator(`${FORM} [name="amount"]`);
    await expect(amount).toBeVisible();
    await expect(amount).toBeEditable();
    await expect(amount).toHaveValue('1');
    expect(posts, 'продолжение не должно само отправлять сохранённые поля').toHaveLength(1);
    await amount.fill('2');
    await page.locator(`${FORM} [name="consent"]`).check();
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]?.requestId).toBe(posts[0]?.requestId);
    expect(posts[0]?.amount).toBe(1);
    expect(posts[1]?.amount).toBe(2);
  });
});

test.describe('3.10a-3 клиент переключается на канонический requestId', () => {
  test('опрос после перезагрузки идёт по каноническому; присланный id нигде не показан', async ({ page }) => {
    const canonical = randomUUID();
    let sent = '';
    const statusUrls: string[] = [];
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        sent = (JSON.parse(req.postData ?? '{}') as { requestId: string }).requestId;
        return { status: 503, body: { status: 'verification_required', requestId: canonical } };
      }
      statusUrls.push(req.url);
      return { status: 200, body: { status: 'verification_required' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('verification_required'))).toBeVisible();
    expect(sent).toBeTruthy();
    expect(sent).not.toBe(canonical);
    await expect(page.locator('body')).not.toContainText(sent);
    await expect(page.locator(`[${PAYMENT_SUMMARY_ATTR}]`)).toContainText(/Иван|Модуль 1/);
    await page.reload();
    await expect.poll(() => statusUrls.some((u) => u.includes(canonical))).toBe(true);
    expect(statusUrls.some((u) => u.includes(sent))).toBe(false);
    await expect(page.locator('body')).not.toContainText(sent);
    await expect(page.locator(`[${PAYMENT_SUMMARY_ATTR}]`)).toContainText(/Иван|Модуль 1/);
    await page.locator(`[${PAYMENT_CONTINUE_ATTR}]`).click();
    await expect(page.locator(`${FORM} [name="firstName"]`)).toHaveValue('Иван');
    await expect(page.locator(`${FORM} [name="seminar"]`)).toHaveValue('Модуль 1');
  });
});

test.describe('3.10a-2 удержание переживает перезагрузку', () => {
  test('после verification_required перезагрузка снова показывает сверку; исход с сервера, не из памяти', async ({ page }) => {
    const id = randomUUID();
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        return { status: 503, body: { status: 'verification_required', requestId: id } };
      }
      return { status: 200, body: { status: 'verification_required' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('verification_required'))).toBeVisible();
    await page.evaluate(() => {
      for (const key of Object.keys(sessionStorage)) sessionStorage.removeItem(key);
    });
    await page.reload();
    await expect(page.locator(STATE('verification_required'))).toBeVisible();
    await expect(page.locator(`[${PAYMENT_HOLD_WARNING_ATTR}]`)).toBeVisible();
    await expect(page.locator(`${FORM} [type="submit"]`)).toHaveCount(0);
  });

  test('проверка succeeded снимает удержание, новая отправка — новый requestId', async ({ page }) => {
    const ids: string[] = [];
    let status: string = 'pending';
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        const body = JSON.parse(req.postData ?? '{}') as { requestId: string };
        ids.push(body.requestId);
        if (ids.length === 1) return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
        return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c2' } };
      }
      return { status: 200, body: { status } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    status = 'succeeded';
    await gotoOplata(page);
    await expect(page.locator(STATE('succeeded'))).toBeVisible();
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    expect(new Set(ids).size).toBeGreaterThan(1);
  });

  // Разделено на три проверки негативной проверкой 6.7. Прежний единственный тест обещал
  // ИМЕНЕМ три вещи — «not_found снимает удержание; demo снимает без предупреждения;
  // >14 суток снимает», — а в теле был только `not_found`, причём без обращения к
  // хранилищу: он смотрел на доступность формы и отсутствие предупреждения. Мутация,
  // снимавшая обработку `demo` во ВСЕХ трёх местах кода, оставляла его зелёным. Правило
  // «судить по имени покрасневшего теста» опирается на честность имён, поэтому имя,
  // обещающее непроверенное, — дефект того же рода, что декоративный гейт.
  const holdsIn = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('ikpk-payment-holds') ?? '[]') as unknown[]);

  test('not_found снимает удержание', async ({ page }) => {
    await mockApi(page, (req) =>
      req.method === 'POST'
        ? { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } }
        : { status: 404, body: { status: 'not_found' } },
    );
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await gotoOplata(page);
    await expect(page.locator(FORM)).toBeVisible();
    await expect(page.locator(`[${PAYMENT_HOLD_WARNING_ATTR}]`)).toHaveCount(0);
    expect(await holdsIn(page), 'удержание осталось после not_found').toEqual([]);
  });

  test('demo снимает удержание и не показывает предупреждения', async ({ page }) => {
    await mockApi(page, (req) =>
      req.method === 'POST'
        ? { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } }
        : { status: 200, body: { status: 'demo' } },
    );
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await gotoOplata(page);
    await expect(page.locator(STATE('demo'))).toBeVisible();
    await expect(page.locator(`[${PAYMENT_HOLD_WARNING_ATTR}]`)).toHaveCount(0);
    expect(await holdsIn(page), 'удержание осталось после ответа demo').toEqual([]);
  });

  test('удержание старше 14 суток снимается', async ({ page }) => {
    await mockApi(page, () => ({ status: 200, body: { status: 'pending' } }));
    await gotoOplata(page);
    // Заведомо просроченное удержание кладётся напрямую: воспроизводить 14 суток ходом
    // времени нельзя, а срок — свойство записи, не хода часов.
    await page.evaluate(() => {
      const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
      localStorage.setItem(
        'ikpk-payment-holds',
        JSON.stringify([{ requestId: '11111111-1111-4111-8111-111111111111', createdAt: old }]),
      );
    });
    await gotoOplata(page);
    await expect(page.locator(`[${PAYMENT_ENTRY_ATTR}]`).first()).toBeEnabled();
    expect(await holdsIn(page), 'просроченное удержание не снято').toEqual([]);
  });
});

test.describe('3.10a-2c два хранилища', () => {
  test('после конца сессии удержание есть, сводки и полей нет; полей нет в localStorage сразу после отправки', async ({ page, context, browser }) => {
    await mockApi(page, () => ({
      status: 503,
      body: { status: 'verification_required', requestId: randomUUID() },
    }));
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('verification_required'))).toBeVisible();
    const local = await page.evaluate(() => JSON.stringify(localStorage));
    expect(local).not.toMatch(/Иван|ivan@example\.com|79111234567/i);
    const state = await context.storageState();
    const origins = state.origins.map((o) => ({ ...o, sessionStorage: [] as { name: string; value: string }[] }));
    const fresh = await browser.newContext({ storageState: { cookies: state.cookies, origins } });
    const p2 = await fresh.newPage();
    // Своя страница — свой guard: guard из `beforeEach` стоит на странице фикстуры и об
    // этой ничего не знает.
    await installThirdPartyGuard(p2);
    await mockApi(p2, () => ({ status: 200, body: { status: 'verification_required' } }));
    await p2.goto('/oplata');
    await expect(p2.locator(STATE('verification_required'))).toBeVisible();
    await expect(p2.locator(`[${PAYMENT_SUMMARY_ATTR}]`)).toHaveCount(0);
    await expect(p2.locator(`${FORM} [name="firstName"]`)).toHaveCount(0);
    await fresh.close();
  });
});

// Найдено ревью владельца (P1) по коммиту fa71ef6: прямое нарушение приватности —
// однострочная мутация `writeFields → localStorage` — оставалось зелёным. Проверка 3.10a-2c
// смотрит в хранилище только ПОСЛЕ ответа сервера, а к этому моменту `dropHold()` успевает
// перезаписать ключ пустым объектом, полученным из пустого `sessionStorage`. То есть утечка
// существует, но к моменту наблюдения её уже затёрли.
//
// Мутация одновременно чтения и записи покрасить умеет, но это ДРУГОЙ, более широкий дефект:
// она меняет и источник чтения. Требуемый негативный контроль — именно однострочная запись.
//
// Отсюда проверка ниже: ответ API задержан, и хранилище читается, пока POST ещё выполняется.
test.describe('3.10a-2c(2) значения полей не попадают в постоянное хранилище во время отправки', () => {
  test('пока POST в полёте, localStorage не содержит значений формы', async ({ page }) => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/payments(\/|$)/, async (route) => {
      await held;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'verification_required', requestId: randomUUID() }),
      });
    });
    await openForm(page);
    await fillValid(page);
    const inFlight = page.waitForRequest((r) => r.method() === 'POST' && /\/payments/.test(r.url()));
    await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
    await inFlight;
    const during = await page.evaluate(() => JSON.stringify(localStorage));
    release?.();
    expect(during, 'значения формы попали в постоянное хранилище').not.toMatch(
      /Иван|Петров|ivan@example\.com|79111234567/i,
    );
  });
});

test.describe('3.10a-2a удержание с момента отправки', () => {
  test('ответ на создание не получен, страница закрыта и открыта — попытка удержана', async ({ page }) => {
    await page.route(/\/payments$/, async (route) => {
      await new Promise((r) => setTimeout(r, 60_000));
      await route.abort();
    });
    // Проверка статуса после перезагрузки перехвачена ЯВНО (задача 6.15). Прежде этот GET
    // мока не имел и уходил в живую сеть: удержание сохранялось потому, что запрос падал
    // на разрешении имени боевого API. С базой установленного контура (`http://193.124.115.99/api`)
    // тот же запрос ушёл бы на живую машину, а исход теста продолжал бы зависеть от сети.
    // Отказ транспорта задан здесь тем же наблюдаемым, каким он был: запрос не доходит.
    await page.route(/\/payments\/[^/]+\/status$/, (route) => route.abort('failed'));
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click({ timeout: 2000 }).catch(() => undefined);
    await gotoOplata(page);
    await expect(page.locator(`[${PAYMENT_HOLD_WARNING_ATTR}]`)).toBeVisible();
    await expect(page.locator(`${FORM} [type="submit"]`)).toHaveCount(0);
  });
});

test.describe('3.10a-3c вопрос о повторной оплате', () => {
  test('duplicate_confirmation_required различим, платёж не уходит без действия, токен из ответа', async ({ page }) => {
    const posts: unknown[] = [];
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        posts.push(JSON.parse(req.postData ?? '{}'));
        if (posts.length === 1) {
          return { status: 409, body: { status: 'duplicate_confirmation_required', confirmationToken: 'tok-1' } };
        }
        return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
      }
      return { status: 200, body: { status: 'pending' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(STATE('duplicate_confirmation_required'))).toBeVisible();
    await expect(page.getByText(/по этим данным оплата уже подтверждена/i)).toBeVisible();
    await expect(page.locator(`[${PAYMENT_HOLD_WARNING_ATTR}]`)).toHaveCount(0);
    await expect(page.locator(`[${PAYMENT_CONTINUE_ATTR}]`)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(posts).toHaveLength(1);
    await page.locator(`[${PAYMENT_CONFIRM_DUPLICATE_ATTR}]`).click();
    await expect.poll(() => posts.length).toBe(2);
    const second = posts[1] as { requestId: string; duplicateConfirmationToken?: string };
    expect(second.requestId).toBe((posts[0] as { requestId: string }).requestId);
    expect(second.duplicateConfirmationToken).toBe('tok-1');
  });
});

test.describe('3.10a-4a / 3.10a-4b / 3.10a-4d удержания и «другой семинар»', () => {
  test('элемент продолжения шлёт тот же requestId; элемента новой попытки вместо удерживаемой нет', async ({ page }) => {
    const ids: string[] = [];
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        const body = JSON.parse(req.postData ?? '{}') as { requestId: string };
        ids.push(body.requestId);
        return { status: 503, body: { status: 'verification_required', requestId: body.requestId } };
      }
      return { status: 200, body: { status: 'verification_required' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator(`[${PAYMENT_CONTINUE_ATTR}]`)).toBeVisible();
    await page.locator(`[${PAYMENT_CONTINUE_ATTR}]`).click();
    await expect(page.locator(`${FORM} [name="amount"]`)).toBeEditable();
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect.poll(() => ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    await expect(page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`)).toBeVisible();
  });

  test('3.10a-4b два различимых действия; перечень при двух удержаниях; поля не в localStorage', async ({ page }) => {
    let n = 0;
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        n += 1;
        const body = JSON.parse(req.postData ?? '{}') as { requestId: string; seminar: string };
        if (n === 2 && body.seminar === 'Модуль 1') {
          return { status: 503, body: { status: 'verification_required', requestId: 'canonical-a' } };
        }
        return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
      }
      return { status: 200, body: { status: 'pending' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await gotoOplata(page);
    await page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`).click();
    await expect(page.getByText(/остаётся незавершённой/i)).toBeVisible();
    await fillValid(page);
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 2');
    await page.locator(`${FORM} [type="submit"]`).click();
    await gotoOplata(page);
    await expect(page.locator(`[data-payment-attempts] [data-payment-attempt]`)).toHaveCount(2);
    const local = await page.evaluate(() => JSON.stringify(localStorage));
    expect(local).not.toMatch(/Иван|ivan@example/i);
  });

  test('перечень показывает статус каждой попытки и переключает панель, не только последнюю', async ({ page }) => {
    const ids: string[] = [];
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        const body = JSON.parse(req.postData ?? '{}') as { requestId: string };
        ids.push(body.requestId);
        return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
      }
      const url = req.url;
      if (ids[0] && url.includes(ids[0])) return { status: 200, body: { status: 'pending' } };
      if (ids[1] && url.includes(ids[1])) return { status: 200, body: { status: 'verification_required' } };
      return { status: 200, body: { status: 'pending' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
    await expect.poll(() => yooKassaNavigationUrls(page).length).toBeGreaterThan(0);
    await gotoOplata(page);
    await expect(page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`)).toBeVisible();
    await page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`).click();
    await fillValid(page);
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 2');
    await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
    await expect.poll(() => yooKassaNavigationUrls(page).length).toBeGreaterThan(1);
    await gotoOplata(page);
    await expect(page.locator(`[${PAYMENT_ENTRY_ATTR}]`).first()).toBeEnabled();
    const items = page.locator('[data-payment-attempt]');
    await expect(items).toHaveCount(2);
    const statuses = await items.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-payment-attempt-status') ?? ''),
    );
    expect(statuses.some((s) => s === 'pending'), `статусы перечня: ${statuses.join(',')}`).toBe(true);
    expect(statuses.some((s) => s === 'verification_required'), `статусы перечня: ${statuses.join(',')}`).toBe(
      true,
    );
    const pendingItem = page.locator('[data-payment-attempt][data-payment-attempt-status="pending"]');
    const verifyItem = page.locator(
      '[data-payment-attempt][data-payment-attempt-status="verification_required"]',
    );
    await pendingItem.locator('[data-payment-attempt-select]').click();
    await expect(page.locator(STATE('pending'))).toBeVisible();
    await verifyItem.locator('[data-payment-attempt-select]').click();
    await expect(page.locator(STATE('verification_required'))).toBeVisible();
    await expect(page.locator(STATE('pending'))).toHaveCount(0);
  });

  test('3.10a-4d при пяти удержаниях «оплатить другой семинар» недоступно', async ({ page }) => {
    test.setTimeout(30_000);
    // Собираем отправленные идентификаторы: одного ЧИСЛА попыток недостаточно. Найдено
    // негативной проверкой 6.10(13) — при молчаливом вытеснении старейшего их снова пять, и
    // проверка по количеству остаётся зелёной, хотя состав подменён. Требование говорит
    // «вытеснения нет», то есть предмет — состав, а не размер.
    const posted: string[] = [];
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        posted.push((JSON.parse(req.postData ?? '{}') as { requestId: string }).requestId);
        return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
      }
      return { status: 200, body: { status: 'pending' } };
    });
    await openForm(page);
    for (let i = 0; i < 5; i += 1) {
      if (i > 0) await page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`).click();
      await fillValid(page);
      await page.locator(`${FORM} [name="seminar"]`).fill(`Семинар ${i}`);
      const posted = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/payments/.test(r.url()),
      );
      await page.locator(`${FORM} [type="submit"]`).click();
      await posted;
      await gotoOplata(page);
    }
    await expect(page.locator(`[data-payment-attempt]`)).toHaveCount(5);
    await expect(page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`)).toBeHidden();
    const shown = await page
      .locator('[data-payment-attempt]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-payment-attempt-id') ?? ''));
    expect(new Set(shown), `состав удержаний подменён: отправляли ${posted.join(',')}`).toEqual(
      new Set(posted),
    );
  });

  // Требование «завершение одной попытки SHALL NOT снимать удержание другой» не имело теста
  // вовсе: найдено негативной проверкой 6.10(18) — мутация «терминальный ответ снимает все
  // удержания» проходила зелёной, потому что независимость снятия ничем не наблюдалась.
  test('3.10a-4b(2) завершение одной попытки оставляет вторую удержанной', async ({ page }) => {
    // Две фазы: сначала обе попытки висят незавершёнными, и только потом первая становится
    // терминальной. Иначе она снимается уже при восстановлении, кнопки «другой семинар» к
    // этому моменту нет, и вторую попытку создать нечем — так первая редакция теста и
    // упиралась в таймаут (дефект теста, не продукта).
    const ids: string[] = [];
    let phase: 1 | 2 = 1;
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        ids.push((JSON.parse(req.postData ?? '{}') as { requestId: string }).requestId);
        return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
      }
      if (phase === 2 && ids[0] && req.url.includes(ids[0])) {
        return { status: 200, body: { status: 'succeeded' } };
      }
      return { status: 200, body: { status: 'pending' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
    await gotoOplata(page);
    await page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`).click();
    await fillValid(page);
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 2');
    await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
    await gotoOplata(page);
    await expect(page.locator('[data-payment-attempt]')).toHaveCount(2);
    phase = 2;
    await gotoOplata(page);
    expect(ids.length, 'обе попытки не отправились').toBe(2);
    // Снятие удержания идёт по асинхронной проверке статуса, поэтому состояние ОЖИДАЕТСЯ, а
    // не читается сразу после перезагрузки. Первая редакция читала немедленно и была зелёной
    // локально, но упала в CI («завершённая первая попытка осталась удержанной») — гонка в
    // тесте, не дефект продукта. Ожидание не делает проверку вакуумной: если снятие не
    // произойдёт вовсе, `expect.poll` исчерпает срок и покраснеет.
    const holdIds = () =>
      page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem('ikpk-payment-holds') ?? '[]') as Array<{ requestId: string }>
          ).map((h) => h.requestId),
      );
    await expect
      .poll(async () => (await holdIds()).includes(ids[0]!), {
        message: 'завершённая первая попытка осталась удержанной',
      })
      .toBe(false);
    const holds = await holdIds();
    expect(holds, `терминальный исход первой снял и вторую: осталось ${holds.join(',')}`).toContain(ids[1]);
  });
});

test.describe('3.10a-5 состояние «нужна сверка»', () => {
  // Утверждения про копирование идентификатора убраны: спека их запрещает (решение
  // владельца от 2026-08-18). Отсутствие показа и копирования проверяется в 3.15(1) —
  // здесь остаётся предмет этого теста: машинный признак, действия панели, сводка.
  test('машинный признак, действия панели, сводка не поля ввода', async ({ page }) => {
    const canonical = randomUUID();
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        return { status: 503, body: { status: 'verification_required', requestId: canonical } };
      }
      return { status: 200, body: { status: 'verification_required' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    const panel = page.locator(STATE('verification_required'));
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/мог быть создан|повторять оплату не нужно/i)).toBeVisible();
    await expect(page.locator(`[${PAYMENT_CONTINUE_ATTR}]`)).toBeVisible();
    await expect(page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`)).toBeVisible();
    await expect(page.locator(`[${PAYMENT_SUMMARY_ATTR}] input`)).toHaveCount(0);
  });
});

test.describe('3.10d канал корреляции возврата', () => {
  test('параметр исчезает из адреса; обновление не опрашивает по адресу; без параметра и без удержания опроса нет', async ({ page }) => {
    const gets: string[] = [];
    await page.route(/\/payments\//, async (route) => {
      gets.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'succeeded' }),
      });
    });
    const id = randomUUID();
    await gotoOplata(page, `/oplata?${RETURN_PARAM}=${id}`);
    await expect.poll(() => gets.length).toBeGreaterThan(0);
    await expect.poll(() => new URL(page.url()).searchParams.get(RETURN_PARAM)).toBeNull();
    const afterClean = gets.length;
    await page.reload();
    expect(gets.length).toBe(afterClean);
    await gotoOplata(page);
    await page.waitForTimeout(300);
    expect(gets.length).toBe(afterClean);
  });
});

test.describe('3.5a-1 клиент: пять GET на загрузке при пяти удержаниях', () => {
  test('одна загрузка /oplata даёт пять GET status и ни один не 429', async ({ page }) => {
    test.setTimeout(30_000);
    const gets: string[] = [];
    await page.route(/\/payments(\/|$)/, async (route) => {
      const req = route.request();
      if (req.method() === 'GET' && /\/status/.test(req.url())) {
        gets.push(req.url());
        expect(route.request().url()).toBeTruthy();
      }
      if (req.method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'created', confirmationUrl: 'https://yookassa.test/c' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'pending' }),
      });
    });
    for (let i = 0; i < 5; i += 1) {
      await gotoOplata(page);
      const other = page.locator('[data-payment-other-seminar]');
      if (i > 0) {
        await expect(other).toBeVisible();
        await other.click();
      } else {
        const entry = page.locator('[data-payment-entry]');
        if ((await entry.count()) > 0) {
          await expect(entry.first()).toBeEnabled();
          await entry.first().click();
        } else await page.getByRole('button', { name: /оплат/i }).click();
      }
      await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
      await page.locator(`${FORM} [name="lastName"]`).fill('Петров');
      await page.locator(`${FORM} [name="seminar"]`).fill(`Семинар ${i}`);
      await page.locator(`${FORM} [name="amount"]`).fill('1');
      await page.locator(`${FORM} [name="email"]`).fill('ivan@example.com');
      await page.locator(`${FORM} [name="phone"]`).fill('79111234567');
      await page.locator(`${FORM} [name="consent"]`).check();
      await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
      await expect.poll(() => yooKassaNavigationUrls(page).length).toBe(i + 1);
    }
    gets.length = 0;
    await gotoOplata(page);
    await expect.poll(() => gets.length).toBe(5);
    expect(gets).toHaveLength(5);
  });
});

const HOLD_KEY = 'ikpk-payment-holds';

async function seedHolds(page: Page, ids: string[]) {
  await page.addInitScript(
    ({ key, holds }) => {
      const flag = `${key}:seeded`;
      if (sessionStorage.getItem(flag) === '1') return;
      sessionStorage.setItem(flag, '1');
      localStorage.setItem(key, JSON.stringify(holds));
    },
    { key: HOLD_KEY, holds: ids.map((requestId) => ({ requestId, createdAt: Date.now() })) },
  );
}

test.describe('r13-M3 клиент: нераспознанный GET → unknown', () => {
  async function assertUnknownKeepsHold(page: Page, fulfill: { status: number; body: string }) {
    const id = randomUUID();
    await seedHolds(page, [id]);
    await page.route(/\/payments(\/|$)/, async (route) => {
      await route.fulfill({
        status: fulfill.status,
        contentType: 'application/json',
        body: fulfill.body,
      });
    });
    await gotoOplata(page);
    await expect(page.locator(STATE('unknown'))).toBeVisible();
    const stored = await page.evaluate((key) => localStorage.getItem(key), HOLD_KEY);
    expect(stored).toContain(id);
  }

  test('GET 500 status=error → unknown, удержание сохраняется', async ({ page }) => {
    await assertUnknownKeepsHold(page, { status: 500, body: JSON.stringify({ status: 'error' }) });
  });

  test('GET 500 status=succeeded → unknown, удержание сохраняется', async ({ page }) => {
    await assertUnknownKeepsHold(page, { status: 500, body: JSON.stringify({ status: 'succeeded' }) });
  });

  test('GET 503 status=error → unknown, удержание сохраняется', async ({ page }) => {
    await assertUnknownKeepsHold(page, { status: 503, body: JSON.stringify({ status: 'error' }) });
  });

  test('GET с пустым телом → unknown, удержание сохраняется', async ({ page }) => {
    await assertUnknownKeepsHold(page, { status: 200, body: '' });
  });

  test('GET с неизвестным status → unknown, удержание сохраняется', async ({ page }) => {
    await assertUnknownKeepsHold(page, { status: 200, body: JSON.stringify({ status: 'blargh' }) });
  });

  test('GET 503 verification_required не нормализуется в unknown', async ({ page }) => {
    const id = randomUUID();
    await seedHolds(page, [id]);
    await page.route(/\/payments(\/|$)/, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'verification_required', requestId: id }),
      });
    });
    await gotoOplata(page);
    await expect(page.locator(STATE('verification_required'))).toBeVisible();
    await expect(page.locator(STATE('unknown'))).toHaveCount(0);
  });
});

test.describe('r12-M1 клиент: 429 при проверке статуса', () => {
  test('GET 429 rejected → unknown, удержание сохраняется', async ({ page }) => {
    const id = randomUUID();
    await seedHolds(page, [id]);
    await page.route(/\/payments(\/|$)/, async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'rejected', errors: [{ field: '_rateLimit' }] }),
      });
    });
    await gotoOplata(page);
    await expect(page.locator(STATE('unknown'))).toBeVisible();
    const stored = await page.evaluate((key) => localStorage.getItem(key), HOLD_KEY);
    expect(stored).toContain(id);
  });
});

test.describe('r12-M4 возврат paymentRequest и остальные удержания', () => {
  test('сначала исход возврата, затем статусы остальных; фоновая проверка не затирает панель', async ({ page }) => {
    const returned = randomUUID();
    const other = randomUUID();
    await seedHolds(page, [returned, other]);
    await page.route(/\/payments(\/|$)/, async (route) => {
      const url = route.request().url();
      if (url.includes(returned)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'succeeded' }),
        });
        return;
      }
      if (url.includes(other)) {
        await new Promise((r) => setTimeout(r, 400));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'pending' }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'pending' }) });
    });
    await gotoOplata(page, `/oplata?${RETURN_PARAM}=${returned}`);
    await expect(page.locator(STATE('succeeded'))).toBeVisible();
    await expect.poll(async () => {
      const raw = await page.evaluate((key) => localStorage.getItem(key), HOLD_KEY);
      return raw ?? '';
    }).toContain(other);
    await expect.poll(async () => page.locator('[data-payment-attempt]').count()).toBeGreaterThan(0);
    await expect(page.locator(`[data-payment-attempt-id="${other}"]`)).toHaveAttribute(
      'data-payment-attempt-status',
      'pending',
    );
    await expect(page.locator(STATE('succeeded'))).toBeVisible();
    await expect(page.locator(STATE('pending'))).toHaveCount(0);
    const stored = await page.evaluate((key) => localStorage.getItem(key), HOLD_KEY);
    expect(stored).toContain(other);
    await expect.poll(async () => {
      const raw = await page.evaluate((key) => localStorage.getItem(key), HOLD_KEY);
      return raw?.includes(returned) ?? true;
    }).toBe(false);
  });
});

test.describe('r12-M5 гонка restoreOnLoad', () => {
  test('вход недоступен, пока проверка удержаний не завершилась', async ({ page }) => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await seedHolds(page, ids);
    await page.route(/\/payments(\/|$)/, async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'pending' }),
      });
    });
    await gotoOplata(page);
    const entry = page.locator(`[${PAYMENT_ENTRY_ATTR}]`).first();
    await expect(entry).toBeVisible();
    await expect(entry).toBeDisabled();
    await expect(entry).toBeEnabled({ timeout: 10_000 });
  });

  test('при пяти удержаниях новая попытка не уходит на сервер и шестой requestId не теряется молча', async ({
    page,
  }) => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await seedHolds(page, ids);
    const posts: string[] = [];
    await page.route(/\/payments(\/|$)/, async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        posts.push(req.postData() ?? '');
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'created', confirmationUrl: 'https://yookassa.test/c' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'pending' }),
      });
    });
    await gotoOplata(page);
    await expect(page.locator(`[${PAYMENT_ENTRY_ATTR}]`).first()).toBeEnabled({ timeout: 10_000 });
    await page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`).evaluate((el) => {
      el.removeAttribute('hidden');
      (el as HTMLButtonElement).click();
    });
    await fillValid(page);
    await page.locator(`${FORM} [name="seminar"]`).fill('Шестой');
    await page.locator(`${FORM} [type="submit"]`).click();
    await page.waitForTimeout(400);
    expect(posts, 'шестая попытка ушла на сервер').toHaveLength(0);
    const stored = await page.evaluate((key) => localStorage.getItem(key), HOLD_KEY);
    for (const id of ids) expect(stored).toContain(id);
    expect(stored?.match(/"requestId"/g)?.length ?? 0).toBe(5);
  });
});

test.describe('r12-m2 предел опроса 15 секунд', () => {
  test('молчащий сервер после pending не держит опрос дольше 15с', async ({ page }) => {
    test.setTimeout(40_000);
    const id = randomUUID();
    const started = Date.now();
    await page.route(/\/payments(\/|$)/, async (route) => {
      if (Date.now() - started < 12_000) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'pending' }),
        });
        return;
      }
      await new Promise(() => undefined);
    });
    await gotoOplata(page, `/oplata?${RETURN_PARAM}=${id}`);
    await expect(page.locator(STATE('unknown'))).toBeVisible({ timeout: 35_000 });
    expect(Date.now() - started, 'опрос превысил 15с с допуском').toBeLessThan(18_000);
  });
});

// ─── 3.15 Показ идентификатора убран (решение владельца от 2026-08-18) ────────
//
// Критерии взяты из спеки, а не из tasks.md: Requirement «Состояние „нужна сверка“
// удерживает от второй оплаты и даёт, чем себя объяснить» (запрет показа и копирования
// `requestId`) и Requirement про перечень удержаний (порядковый номер, время создания,
// состояние человеческим языком, семинар и сумма — только при сводке текущей сессии,
// постоянное хранилище не расширяется).
//
// Предмет первой проверки — ЗНАЧЕНИЕ идентификатора в доступном выводе, а не наличие
// элемента с прежним именем `data-payment-copy-id`: проверка по имени обошлась бы
// переименованием кнопки.
const HOLDS_KEY = 'ikpk-payment-holds';
const FIELDS_SESSION_KEY = 'ikpk-payment-fields';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Весь текст окна оплаты, который доступен посетителю (видимый + доступные имена). */
async function dialogAccessibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector('.payment-dialog');
    if (!root) return '';
    const parts: string[] = [root instanceof HTMLElement ? root.innerText : ''];
    for (const el of root.querySelectorAll('*')) {
      for (const attr of ['aria-label', 'title', 'value', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (v) parts.push(v);
      }
    }
    return parts.join('\n');
  });
}

/** Ставит наблюдателя за буфером обмена до загрузки страницы. */
async function spyClipboard(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    const spy = (text: string) => {
      (window as unknown as { __copied: string[] }).__copied.push(text);
      return Promise.resolve();
    };
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: spy, readText: () => Promise.resolve('') },
      });
    } catch {
      /* окружение без clipboard — наблюдать нечего */
    }
  });
}

const copied = (page: Page) =>
  page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []);


/**
 * Текст каждой строки перечня, разложенный по дочерним элементам. Склеенный `innerText`
 * для поиска порядкового номера не годится: «Попытка 1» и «18 августа» сливаются в
 * «Попытка 118 августа», и отдельное число уже не найти (проверено на себе). Разложение
 * по детям не привязано к тому, какой именно элемент несёт номер.
 */
async function attemptRowTokens(page: Page): Promise<string[][]> {
  return page.locator('[data-payment-attempt]').evaluateAll((els) =>
    els.map((el) => [
      ...[...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim()),
      ...[...el.children]
        .filter((c) => !c.hasAttribute('data-payment-attempt-summary'))
        .map((c) => (c.textContent ?? '').trim()),
    ].filter((t) => t.length > 0)),
  );
}

/**
 * Есть ли среди токенов строки ПОДПИСЬ с порядковым номером `n`.
 *
 * Критерий: в токене ровно одно число, и оно равно `n` («Попытка 1»). Прежняя редакция
 * искала «отдельно стоящую цифру n» где угодно в строке и была ложно зелёной дважды: её
 * удовлетворяли сводка «Модуль 1 · 1 ₽» и, по случайности, цифра внутри UUID
 * («…-a1b-…»). Обе поддержки исчезают, если требовать, чтобы токен НЕС номер, а не
 * содержал цифру: время («18 августа в 11:07» — три числа), сводка (два числа) и UUID
 * (много чисел) отбраковываются по построению.
 *
 * Сводка исключается отдельно: спека требует, чтобы перечень оставался пригодным БЕЗ неё,
 * значит номер обязан жить вне сводки.
 */
const hasOrdinal = (tokens: string[], n: number) =>
  tokens.some((t) => {
    const numbers = t.match(/\d+/g) ?? [];
    return numbers.length === 1 && numbers[0] === String(n);
  });

test.describe('3.15 идентификатор попытки не показывается и не копируется', () => {
  test('3.15(1) в состоянии «нужна сверка» ни один идентификатор не показан и не скопирован', async ({
    page,
  }) => {
    const canonical = randomUUID();
    await spyClipboard(page);
    await mockApi(page, (req) =>
      req.method === 'POST'
        ? { status: 503, body: { status: 'verification_required', requestId: canonical } }
        : { status: 200, body: { status: 'verification_required' } },
    );
    const sent = await submitForVerification(page);

    const text = await dialogAccessibleText(page);
    expect(text, 'канонический requestId предъявлен посетителю').not.toContain(canonical);
    expect(text, 'отправленный requestId предъявлен посетителю').not.toContain(sent.requestId);
    expect(text.match(UUID_RE)?.[0] ?? '', 'в окне оплаты показан UUID').toBe('');

    // Ни один элемент управления не копирует идентификатор. Кнопки перебираются по
    // ИНДЕКСУ, а не по имени атрибута, и панель перед каждым нажатием восстанавливается:
    // первая же кнопка может оказаться «Закрыть», и без восстановления цикл кончался бы,
    // не дойдя до остальных, — проверка прошла бы вакуумно (так и было в первой редакции).
    // Самопроверка прибора: если подмена `navigator.clipboard` не удалась, «ничего не
    // скопировано» означает «я не смогла посмотреть», а не «нарушений нет». Первая редакция
    // этой проверки была зелёной именно поэтому.
    await page.evaluate(() => navigator.clipboard.writeText('__probe__')).catch(() => undefined);
    expect(
      await copied(page),
      'наблюдатель за буфером обмена не установлен — проверка ничего не измеряет',
    ).toContain('__probe__');
    await page.evaluate(() => {
      (window as unknown as { __copied: string[] }).__copied = [];
    });

    const total = await page.locator('.payment-dialog button:visible').count();
    expect(total, 'в панели нет кнопок — перебирать нечего').toBeGreaterThan(0);
    for (let i = 0; i < total; i += 1) {
      // Панель пересобирается ПЕРЕД каждым нажатием, а не только когда кнопок не хватило:
      // иначе нажатие меняет состав, индексы съезжают между итерациями и часть кнопок не
      // проверяется вовсе. Первая редакция была зелёной именно из-за этого.
      await submitForVerification(page);
      const buttons = page.locator('.payment-dialog button:visible');
      await expect(buttons).toHaveCount(total);
      const label = (await buttons.nth(i).textContent())?.trim() ?? `№${i + 1}`;
      await buttons.nth(i).click({ noWaitAfter: true }).catch(() => undefined);
      const clip = await copied(page);
      expect(
        clip.filter((c) => UUID_RE.test(c)),
        `кнопка «${label}» скопировала идентификатор: ${clip.join('|')}`,
      ).toEqual([]);
    }
  });

  test('3.15(1) в перечне удержаний идентификатор не показан', async ({ page }) => {
    await seedTwoHolds(page);
    const ids = await page
      .locator('[data-payment-attempt]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-payment-attempt-id') ?? ''));
    expect(ids.length, 'перечень не собран').toBe(2);
    const text = await dialogAccessibleText(page);
    for (const id of ids) expect(text, `requestId ${id} показан в перечне`).not.toContain(id);
    expect(text.match(UUID_RE)?.[0] ?? '', 'в перечне показан UUID').toBe('');
  });

  test('3.15(2) попытки различимы по номеру и состоянию человеческим языком', async ({ page }) => {
    await seedTwoHolds(page);
    const rows = page.locator('[data-payment-attempt]');
    await expect(rows).toHaveCount(2);
    const seen = await rows.evaluateAll((els) =>
      els.map((el) => ({
        text: el instanceof HTMLElement ? el.innerText : '',
        status: el.getAttribute('data-payment-attempt-status') ?? '',
      })),
    );
    const tokens = await attemptRowTokens(page);
    seen.forEach((row, i) => {
      expect(
        hasOrdinal(tokens[i] ?? [], i + 1),
        `строка ${i + 1} без порядкового номера: ${JSON.stringify(tokens[i])}`,
      ).toBe(true);
    });
    for (const row of seen) {
      if (!row.status) continue;
      expect(
        row.text.includes(row.status),
        `состояние подписано техническим именем «${row.status}»: «${row.text}»`,
      ).toBe(false);
    }
  });

  test('3.15(3) семинар и сумма — только при сводке текущей сессии', async ({ page }) => {
    await seedTwoHolds(page);
    const withSummary = await page.locator('[data-payment-attempt]').first().innerText();
    expect(withSummary, 'при сохранённой сводке семинар не показан').toMatch(/Модуль/);
    expect(withSummary, 'при сохранённой сводке сумма не показана').toMatch(/1/);

    await page.evaluate((k) => sessionStorage.removeItem(k), FIELDS_SESSION_KEY);
    await gotoOplata(page);
    const rows = page.locator('[data-payment-attempt]');
    await expect(rows).toHaveCount(2);
    const rest = await rows.first().innerText();
    expect(rest, 'сводка очищена, а семинар всё ещё показан').not.toMatch(/Модуль/);
    expect(rest.trim().length, 'без сводки строка перечня пуста — попытка неразличима').toBeGreaterThan(0);
    const restTokens = await attemptRowTokens(page);
    expect(
      hasOrdinal(restTokens[0] ?? [], 1),
      `без сводки нет номера: ${JSON.stringify(restTokens[0])}`,
    ).toBe(true);
    await rows.first().locator('[data-payment-attempt-select]').click();
    await expect(page.locator(`[${PAYMENT_STATE_ATTR}]`)).toBeVisible();
  });

  test('3.15(4) постоянное хранилище не расширено', async ({ page }) => {
    await seedTwoHolds(page);
    const holds = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k) ?? '[]') as Array<Record<string, unknown>>,
      HOLDS_KEY,
    );
    expect(holds.length).toBe(2);
    for (const h of holds) {
      expect(Object.keys(h).sort(), `в удержании лишние поля: ${JSON.stringify(h)}`).toEqual([
        'createdAt',
        'requestId',
      ]);
    }
    const persisted = await page.evaluate(() =>
      Object.keys(localStorage)
        .map((k) => `${k}=${localStorage.getItem(k) ?? ''}`)
        .join('\n'),
    );
    expect(persisted, 'семинар попал в постоянное хранилище').not.toMatch(/Модуль/);
    expect(persisted, 'почта попала в постоянное хранилище').not.toMatch(/ivan@example\.com/);
  });

  test('3.15 выбор попытки обращается к её внутреннему requestId', async ({ page }) => {
    await seedTwoHolds(page);
    const rows = page.locator('[data-payment-attempt]');
    const second = rows.nth(1);
    const wanted = await second.getAttribute('data-payment-attempt-id');
    await second.locator('[data-payment-attempt-select]').click();
    const cont = page.locator(`[${PAYMENT_CONTINUE_ATTR}]`);
    if (await cont.count()) await cont.first().click();
    const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/payments/.test(r.url()));
    await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
    const body = JSON.parse((await posted).postData() ?? '{}') as { requestId?: string };
    expect(body.requestId, 'продолжение пошло не по выбранной попытке').toBe(wanted);
  });
});

/** Два удержания с разными состояниями, сводка полей сохранена сессией. */
async function seedTwoHolds(page: Page) {
  let n = 0;
  await mockApi(page, (req) => {
    if (req.method === 'POST') {
      n += 1;
      return n === 2
        ? { status: 503, body: { status: 'verification_required', requestId: randomUUID() } }
        : { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
    }
    return { status: 200, body: { status: 'pending' } };
  });
  await openForm(page);
  await fillValid(page);
  await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
  await gotoOplata(page);
  await page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`).click();
  await fillValid(page);
  await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 2');
  await page.locator(`${FORM} [type="submit"]`).click({ noWaitAfter: true });
  await gotoOplata(page);
  await expect(page.locator('[data-payment-attempt]')).toHaveCount(2);
}

/**
 * Отправляет форму так, чтобы сервер ответил `verification_required`; отдаёт отправленный id.
 * Хранилища очищаются перед каждым проходом: с сохранённым удержанием диалог открывается сам
 * при загрузке, и нажатие входа перехватывается его оверлеем — восстановление панели без
 * сброса состояния недетерминированно (проверено: таймаут 10 с на повторном проходе).
 */
async function submitForVerification(page: Page): Promise<{ requestId: string }> {
  await gotoOplata(page);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await gotoOplata(page);
  await openForm(page);
  await fillValid(page);
  const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/payments/.test(r.url()));
  await page.locator(`${FORM} [type="submit"]`).click();
  const sent = JSON.parse((await posted).postData() ?? '{}') as { requestId: string };
  await expect(page.locator(STATE('verification_required'))).toBeVisible();
  return sent;
}
