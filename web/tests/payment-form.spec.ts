import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  PAYMENT_CONFIRM_DUPLICATE_ATTR,
  PAYMENT_CONTINUE_ATTR,
  PAYMENT_COPY_ID_ATTR,
  PAYMENT_ENTRY_ATTR,
  PAYMENT_FORM_ATTR,
  PAYMENT_HOLD_WARNING_ATTR,
  PAYMENT_OTHER_SEMINAR_ATTR,
  PAYMENT_STATE_ATTR,
  PAYMENT_SUMMARY_ATTR,
  RETURN_PARAM,
} from './helpers/payment-contract';
import {
  gotoOplata,
  interceptYooKassaNavigation,
  yooKassaFallbackHref,
  yooKassaNavigationUrls,
} from './helpers/yookassa-navigation';

const FORM = `[${PAYMENT_FORM_ATTR}]`;
const STATE = (s: string) => `[${PAYMENT_STATE_ATTR}="${s}"]`;

async function openForm(page: Page) {
  await gotoOplata(page);
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

test.beforeEach(async ({ page }) => {
  await interceptYooKassaNavigation(page);
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
    expect(page.url()).toMatch(/\/oplata/);
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

  test('not_found снимает удержание; demo снимает без предупреждения; >14 суток снимает', async ({ page }) => {
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
        return { status: 201, body: { status: 'created', confirmationUrl: 'https://yookassa.test/c' } };
      }
      return { status: 404, body: { status: 'not_found' } };
    });
    await openForm(page);
    await fillValid(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    await gotoOplata(page);
    await expect(page.locator(FORM)).toBeVisible();
    await expect(page.locator(`[${PAYMENT_HOLD_WARNING_ATTR}]`)).toHaveCount(0);
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
    await mockApi(p2, () => ({ status: 200, body: { status: 'verification_required' } }));
    await p2.goto('/oplata');
    await expect(p2.locator(STATE('verification_required'))).toBeVisible();
    await expect(p2.locator(`[${PAYMENT_SUMMARY_ATTR}]`)).toHaveCount(0);
    await expect(p2.locator(`${FORM} [name="firstName"]`)).toHaveCount(0);
    await fresh.close();
  });
});

test.describe('3.10a-2a удержание с момента отправки', () => {
  test('ответ на создание не получен, страница закрыта и открыта — попытка удержана', async ({ page }) => {
    await page.route(/\/payments$/, async (route) => {
      await new Promise((r) => setTimeout(r, 60_000));
      await route.abort();
    });
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
    await page.locator(`${FORM} [type="submit"]`).click();
    await gotoOplata(page);
    await page.locator(`[${PAYMENT_OTHER_SEMINAR_ATTR}]`).click();
    await fillValid(page);
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 2');
    await page.locator(`${FORM} [type="submit"]`).click();
    await gotoOplata(page);
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
    await mockApi(page, (req) => {
      if (req.method === 'POST') {
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
  });
});

test.describe('3.10a-5 состояние «нужна сверка»', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  test('машинный признак, копирование канонического id, фокус в панели, сводка не поля ввода', async ({ page }) => {
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
    await page.locator(`[${PAYMENT_COPY_ID_ATTR}]`).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(canonical);
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
      if (i > 0) await other.click();
      else {
        const entry = page.locator('[data-payment-entry]');
        if ((await entry.count()) > 0) await entry.first().click();
        else await page.getByRole('button', { name: /оплат/i }).click();
      }
      await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
      await page.locator(`${FORM} [name="lastName"]`).fill('Петров');
      await page.locator(`${FORM} [name="seminar"]`).fill(`Семинар ${i}`);
      await page.locator(`${FORM} [name="amount"]`).fill('1');
      await page.locator(`${FORM} [name="email"]`).fill('ivan@example.com');
      await page.locator(`${FORM} [name="phone"]`).fill('79111234567');
      await page.locator(`${FORM} [name="consent"]`).check();
      await page.locator(`${FORM} [type="submit"]`).click();
    }
    gets.length = 0;
    await gotoOplata(page);
    await expect.poll(() => gets.length).toBe(5);
    expect(gets).toHaveLength(5);
  });
});
