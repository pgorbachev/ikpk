/**
 * Транспорт заявки на оплату: модальность, доступность полей, согласие, честные состояния,
 * поведение без скриптов, защита от ботов, повторная отправка.
 *
 * АРТЕФАКТ — РОЛЬ `stand` (`dist-stand`, `playwright.stand.config.ts`), решение владельца
 * 2026-08-19. Прежде набор шёл основной конфигурацией по боевому `dist`: после 5.10 это
 * сборка роли `ci`, у которой платёжной формы по контракту нет вовсе — то есть каждый тест
 * здесь падал бы на «формы нет» либо, что хуже, читался бы как «проверять нечего, значит
 * прошло». Предмет транспорта требует живой формы, а живая форма есть у ролей `preview` и
 * `stand`; рабочая семантика контура — только у `stand`.
 *
 * FAIL-CLOSED GUARD взведён так же, как в остальных наборах роли (задача 6.15, пятый пункт):
 * любой запрос к объявленной базе контура, к чужому контуру или к живой ЮKassa, не
 * перехваченный самим тестом, обрывается до сети и РОНЯЕТ тест. Guard ставится ПЕРВЫМ:
 * Playwright применяет маршруты в обратном порядке регистрации, поэтому моки каждого теста,
 * поставленные позже, забирают свои запросы, а guard видит ровно то, что не забрал никто.
 *
 * Guard НЕ МЕНЯЕТ предмет: ни `data-payment-role`, ни объявленную базу, ни ответы продукта
 * он не переписывает — он живёт только в транспорте.
 */

import { expect, test, type Page } from '@playwright/test';
import { PAYMENT_FORM_ATTR } from './helpers/payment-contract';
import { gotoOplata, interceptYooKassaNavigation } from './helpers/yookassa-navigation';
import {
  expectNoEscapes,
  installFailClosedGuard,
  type FailClosedGuard,
} from './helpers/payment-network-guard';

const FORM = `[${PAYMENT_FORM_ATTR}]`;
const DIALOG = '[role="dialog"]';

async function openForm(page: Page) {
  await gotoOplata(page);
  const entry = page.locator('[data-payment-entry]');
  if ((await entry.count()) > 0) {
    await expect(entry.first()).toBeEnabled();
    await entry.first().click();
  } else await page.getByRole('button', { name: /оплат/i }).click();
  await expect(page.locator(DIALOG)).toBeVisible();
}

let guard: FailClosedGuard;

test.beforeEach(async ({ page }) => {
  guard = await installFailClosedGuard(page, 'stand');
  await interceptYooKassaNavigation(page);
});

// Fail-closed постусловие КАЖДОГО теста файла: пропущенный мок роняет тест, а не уходит на
// живой контур молча. Зелёный тест с утечкой — ложное зелёное: его исход получен не от того
// адресата, о котором он говорит.
test.afterEach(() => {
  expectNoEscapes(guard);
});

test.describe('3a.1 модальность и клавиатура', () => {
  test('роль диалога, имя, кнопка закрытия; фокус входит и возвращается', async ({ page }) => {
    await gotoOplata(page);
    const opener = page.locator('[data-payment-entry]').first();
    await expect(opener).toBeEnabled();
    await opener.focus();
    await opener.press('Enter');
    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const name = await dialog.getAttribute('aria-labelledby') ?? await dialog.getAttribute('aria-label');
    expect(name).toBeTruthy();
    await expect(dialog.getByRole('button', { name: /закрыть|close/i })).toBeVisible();
    const focusInside = await page.evaluate((sel) => {
      const d = document.querySelector(sel);
      return Boolean(d && d.contains(document.activeElement));
    }, DIALOG);
    expect(focusInside).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Escape закрывает без отправки', async ({ page }) => {
    const posts: string[] = [];
    await page.route(/\/payments$/, async (route) => {
      posts.push(route.request().url());
      await route.abort();
    });
    await openForm(page);
    await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
    expect(posts).toEqual([]);
  });

  test('фон исключён из фокуса и чтения', async ({ page }) => {
    await openForm(page);
    const inert = await page.locator('body > *').evaluateAll((nodes) =>
      nodes
        .filter((n) => !n.querySelector?.('[role="dialog"]') && n.getAttribute('role') !== 'dialog')
        .every((n) => n.hasAttribute('inert') || n.getAttribute('aria-hidden') === 'true'),
    );
    expect(inert).toBe(true);
  });
});

test.describe('3a.3 доступность полей и ошибок', () => {
  test('каждое поле связано с подписью программно', async ({ page }) => {
    await openForm(page);
    const unlabeled = await page.locator(`${FORM} input, ${FORM} textarea, ${FORM} select`).evaluateAll((els) =>
      els
        .filter((el) => {
          if ((el as HTMLInputElement).type === 'hidden') return false;
          if (el.getAttribute('aria-hidden') === 'true') return false;
          const id = el.id;
          const byFor = id && document.querySelector(`label[for="${id}"]`);
          const wrapped = el.closest('label');
          const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
          return !(byFor || wrapped || labelled);
        })
        .map((el) => el.getAttribute('name') || el.outerHTML.slice(0, 80)),
    );
    expect(unlabeled).toEqual([]);
  });

  test('ошибка связана с полем; фокус на первом ошибочном', async ({ page }) => {
    await openForm(page);
    await page.locator(`${FORM} [type="submit"]`).click();
    const firstInvalid = page.locator(`${FORM} :invalid, ${FORM} [aria-invalid="true"]`).first();
    await expect(firstInvalid).toBeFocused();
    const described = await firstInvalid.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    const msg = page.locator(`#${described}`);
    await expect(msg).toBeVisible();
  });
});

// ─── 3a.3a та же ошибка, но на НИЗКОМ экране ─────────────────────────────────
//
// Отдельные describe, потому что нужен свой viewport: тест выше идёт на 1280×720, где
// липкий футер занимает малую долю панели и перекрыть поле не может. Дефект найден
// владельцем на ревью PR #151 и живёт в геометрии: ошибка согласия увеличивает футер,
// панель ограничена `calc(100vh - 2rem)`, и на низком экране футер накрывает
// сфокусированное поле вместе с его сообщением. Браузер при этом не прокручивает ничего:
// поле формально внутри scrollport, а про липкий слой поверх него он не знает.
//
// Высоты не произвольные, и их ДВЕ, потому что у продукта здесь две ветви, а непройденная
// ветвь — такое же обещание, как непроверенный гейт:
//
//   390×400 — телефон в landscape (у iPhone 12/13/14 короткая сторона 390 CSS px) и он же
//       в portrait с поднятой экранной клавиатурой. Места хватает, футер остаётся липким,
//       и поле выводится из-под него прокруткой;
//   390×320 — landscape iPhone SE. Места нет физически: футер с ошибкой согласия занимает
//       237 px из 288 доступных при блоке поля 102 px. Прилипание снимается — иначе
//       требование «поле и сообщение видимы» невыполнимо ни при какой прокрутке.
//
// Каждый тест ЗАЯВЛЯЕТ ожидаемую ветвь (`cramped`), а не только исход: без этого оба
// прошли бы по одной и той же ветви, и вторая осталась бы непроверенной при зелёном
// наборе — ровно тот случай, когда зелёный цвет получен не от того, о чём тест говорит.
//
// Про сам предмет: `toBeVisible` у Playwright видит элемент под непрозрачным слоем как
// видимый (он занимает место и не `display: none`), поэтому здесь два независимых
// измерения — попадание курсора и геометрия. Первое отвечает «увидит ли посетитель»,
// второе даёт числа для сообщения об ошибке.
const LOW_VIEWPORTS = [
  { label: 'места хватает — футер остаётся липким', height: 400, cramped: false },
  { label: 'места нет — футер перестаёт прилипать', height: 320, cramped: true },
] as const;

for (const vp of LOW_VIEWPORTS) {
  test.describe(`3a.3a первая ошибка видима при 390×${vp.height} (${vp.label})`, () => {
    test.use({ viewport: { width: 390, height: vp.height } });

    test('сфокусированное невалидное поле и его сообщение не закрыты футером', async ({ page }) => {
      await openForm(page);
      await page.locator(`${FORM} [type="submit"]`).click();

      // Поле берётся то, которое СКРИПТ счёл первым ошибочным, а не названное по имени:
      // иначе проверка сторожила бы порядок полей, а не видимость ошибки.
      // Результат размечен дискриминантом `ok`: «прибор не смог измерить» и «измерено» —
      // разные исходы, и различать их проверкой на `undefined` у одного из чисел нельзя.
      // Именно так отсутствие сигнала и выдаётся за отсутствие проблемы.
      const probe = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const form = document.querySelector('[data-payment-form]');
        if (!active || !form?.contains(active)) {
          return { ok: false as const, reason: 'после отправки пустой формы фокус не внутри формы' };
        }
        const err = document.getElementById(active.getAttribute('aria-describedby') ?? '');
        const footer = document.querySelector('.payment-footer');
        const panel = document.querySelector('.payment-dialog-panel');
        if (!active.closest('.payment-field') || !err || err.hidden || !footer || !panel) {
          return { ok: false as const, reason: 'нет блока поля, сообщения об ошибке, футера или панели' };
        }
        const box = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1) };
        };
        // Попадание курсора: если в центре поля или сообщения лежит футер (или его
        // потомок), посетитель их не видит. Это про фактическую отрисовку, не про рамки.
        const coveredByFooter = (el: Element) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          return Boolean(at && footer.contains(at));
        };
        return {
          ok: true as const,
          name: (active as HTMLInputElement).name,
          input: box(active),
          error: box(err),
          footer: box(footer),
          panel: box(panel),
          inputCovered: coveredByFooter(active),
          errorCovered: coveredByFooter(err),
          cramped: panel.classList.contains('payment-panel-cramped'),
        };
      });

      if (!probe.ok) {
        expect(probe.ok, `прибор не смог измерить: ${probe.reason}`).toBe(true);
        return;
      }

      const geometry = `поле ${probe.name} y=${probe.input.top}–${probe.input.bottom}, `
        + `сообщение y=${probe.error.top}–${probe.error.bottom}, `
        + `футер y=${probe.footer.top}–${probe.footer.bottom}, `
        + `панель y=${probe.panel.top}–${probe.panel.bottom}`;

      // Ветвь заявлена, а не выведена из исхода: если продукт выберет другую, тест
      // покраснеет даже при видимом поле — потому что тогда он проверил не то, о чём
      // говорит, и вторая ветвь осталась непройденной.
      expect(probe.cramped, `ожидалась ветвь cramped=${vp.cramped} (${geometry})`).toBe(vp.cramped);

      expect(probe.inputCovered, `сфокусированное поле закрыто футером (${geometry})`).toBe(false);
      expect(probe.errorCovered, `сообщение об ошибке закрыто футером (${geometry})`).toBe(false);
      // Геометрия отдельно от попадания курсора: поле может выглядывать краем, и тогда
      // курсор в центр ещё попадает, а прочитать подпись и сообщение уже нельзя.
      expect(probe.input.bottom, `низ поля ниже верха футера (${geometry})`).toBeLessThanOrEqual(probe.footer.top);
      expect(probe.error.bottom, `низ сообщения ниже верха футера (${geometry})`).toBeLessThanOrEqual(probe.footer.top);
      // И то и другое должно лежать в видимой части панели, а не быть уведено за её край
      // прокруткой: «не закрыто футером» само по себе достижимо и вывозом за кадр.
      expect(probe.input.top, `верх поля выше верха панели (${geometry})`).toBeGreaterThanOrEqual(probe.panel.top);
      expect(probe.error.bottom, `низ сообщения ниже низа панели (${geometry})`).toBeLessThanOrEqual(probe.panel.bottom);
    });
  });
}

test.describe('3a.4 согласие на ПДн', () => {
  test('при открытии не отмечено; без отметки не уходит; цель названа; ссылка на нашем домене отвечает', async ({ page }) => {
    const posts: string[] = [];
    await page.route(/\/payments$/, async (route) => {
      posts.push(route.request().url());
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ status: 'created', confirmationUrl: 'https://yookassa.test/c' }) });
    });
    await openForm(page);
    const consent = page.locator(`${FORM} [name="consent"]`);
    await expect(consent).not.toBeChecked();
    await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
    await page.locator(`${FORM} [name="lastName"]`).fill('Петров');
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 1');
    await page.locator(`${FORM} [name="amount"]`).fill('1');
    await page.locator(`${FORM} [name="email"]`).fill('ivan@example.com');
    await page.locator(`${FORM} [name="phone"]`).fill('79111234567');
    await page.locator(`${FORM} [type="submit"]`).click();
    expect(posts).toEqual([]);
    await expect(page.getByText(/соглас/i)).toBeVisible();
    const consentId = await consent.getAttribute('id');
    expect(consentId, 'у отметки согласия нет id для label[for]').toBeTruthy();
    const labelled = page.locator(`${FORM} label[for="${consentId}"]`);
    const label =
      (await labelled.count()) > 0 ? labelled : consent.locator('xpath=ancestor::label[1]');
    await expect(label).toBeVisible();
    const labelText = await label.innerText();
    expect(labelText).toMatch(/оплат|платеж/i);
    const link = page.locator(`${FORM} a[href*="персонал"], ${FORM} a[href*="конфиденциал"], ${FORM} a[href*="/terms/"]`).first();
    const href = await link.getAttribute('href');
    expect(href).toBeTruthy();
    expect(href).not.toMatch(/^https?:\/\/(?!([^/]*\.)?ikpk\.su)/);
    const res = await page.request.get(new URL(href!, page.url()).href);
    expect(res.ok()).toBe(true);
  });
});

test.describe('3a.5 честные состояния', () => {
  test('смена состояния объявляется без перевода фокуса', async ({ page }) => {
    await page.route(/\/payments$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'already_paid' }),
      });
    });
    await openForm(page);
    await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
    await page.locator(`${FORM} [name="lastName"]`).fill('Петров');
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 1');
    await page.locator(`${FORM} [name="amount"]`).fill('1');
    await page.locator(`${FORM} [name="email"]`).fill('ivan@example.com');
    await page.locator(`${FORM} [name="phone"]`).fill('79111234567');
    await page.locator(`${FORM} [name="consent"]`).check();
    const submit = page.locator(`${FORM} [type="submit"]`);
    await submit.focus();
    const focusAtSubmit = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return Boolean(el && (el.getAttribute('type') === 'submit' || el.hasAttribute('data-payment-submit')));
    });
    expect(focusAtSubmit, 'перед отправкой фокус должен стоять на элементе submit').toBe(true);
    await submit.click();
    const live = page.locator(`${FORM} [aria-live], [data-payment-state-host][aria-live], [data-payment-state][aria-live], [role="status"]`);
    await expect(live.first()).toBeVisible();
    await expect(page.locator('[data-payment-state="already_paid"]')).toBeVisible();
    const movedIntoPanel = await page.evaluate(() => {
      const panel = document.querySelector('[data-payment-state]');
      const el = document.activeElement;
      return Boolean(panel && el && (panel === el || panel.contains(el)));
    });
    expect(movedIntoPanel, 'фокус не переводится внутрь панели исхода').toBe(false);
  });
});

test.describe('3a.6 без скриптов', () => {
  test('способ связаться виден, управления формой нет', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    // Своя страница — свой guard: guard из `beforeEach` стоит на странице фикстуры и об этой
    // ничего не знает, а «на этой странице перехвата не было» — это не «утечек не было».
    const ownGuard = await installFailClosedGuard(page, 'stand');
    await gotoOplata(page);
    await expect(page.locator(FORM)).toHaveCount(1);
    await expect(page.locator('#oplata-svyaz')).toBeVisible();
    await expect(page.locator('[data-payment-entry]')).toHaveCount(0);
    expectNoEscapes(ownGuard);
    await context.close();
  });
});

test.describe('3a.7 защита от ботов', () => {
  test('поле-приманка скрыто от AT; срабатывание — видимая ошибка', async ({ page }) => {
    const posts: number[] = [];
    await page.route(/\/payments$/, async (route) => {
      posts.push(1);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ status: 'created', confirmationUrl: 'https://yookassa.test/c' }) });
    });
    await openForm(page);
    const honeypot = page.locator(`${FORM} input[aria-hidden="true"], ${FORM} [hidden] input, ${FORM} .visually-hidden input, ${FORM} .sr-only input`);
    await expect(honeypot.first()).toHaveCount(1);
    const accessible = await honeypot.first().evaluate((el) => {
      let n: HTMLElement | null = el as HTMLElement;
      while (n) {
        if (n.getAttribute('aria-hidden') === 'true' || n.hidden) return false;
        n = n.parentElement;
      }
      return true;
    });
    expect(accessible).toBe(false);
    await honeypot.first().fill('bot', { force: true });
    await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
    await page.locator(`${FORM} [name="lastName"]`).fill('Петров');
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 1');
    await page.locator(`${FORM} [name="amount"]`).fill('1');
    await page.locator(`${FORM} [name="email"]`).fill('ivan@example.com');
    await page.locator(`${FORM} [name="phone"]`).fill('79111234567');
    await page.locator(`${FORM} [name="consent"]`).check();
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator('[data-payment-state="error"]')).toBeVisible();
    expect(posts).toEqual([]);
  });
});

test.describe('3a.7a повторная отправка не создаёт вторую заявку', () => {
  test('повторное нажатие во время отправки не начинает вторую', async ({ page }) => {
    let posts = 0;
    await page.route(/\/payments$/, async (route) => {
      posts += 1;
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'created', confirmationUrl: 'https://yookassa.test/c' }),
      });
    });
    await openForm(page);
    await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
    await page.locator(`${FORM} [name="lastName"]`).fill('Петров');
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 1');
    await page.locator(`${FORM} [name="amount"]`).fill('1');
    await page.locator(`${FORM} [name="email"]`).fill('ivan@example.com');
    await page.locator(`${FORM} [name="phone"]`).fill('79111234567');
    await page.locator(`${FORM} [name="consent"]`).check();
    await page.locator(`${FORM} [type="submit"]`).click();
    await page.locator(`${FORM} [type="submit"]`).click({ trial: true }).catch(() => undefined);
    await page.locator(`${FORM} [type="submit"]`).click({ timeout: 500 }).catch(() => undefined);
    await page.waitForTimeout(1800);
    expect(posts).toBe(1);
  });

  test('повтор после неизвестного исхода уходит с тем же id, либо с каноническим из ответа', async ({ page }) => {
    const ids: string[] = [];
    let n = 0;
    await page.route(/\/payments$/, async (route) => {
      n += 1;
      const body = JSON.parse(route.request().postData() ?? '{}') as { requestId: string };
      ids.push(body.requestId);
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 50));
        await route.abort();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'verification_required', requestId: ids[0] }),
      });
    });
    await openForm(page);
    await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
    await page.locator(`${FORM} [name="lastName"]`).fill('Петров');
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 1');
    await page.locator(`${FORM} [name="amount"]`).fill('1');
    await page.locator(`${FORM} [name="email"]`).fill('ivan@example.com');
    await page.locator(`${FORM} [name="phone"]`).fill('79111234567');
    await page.locator(`${FORM} [name="consent"]`).check();
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator('[data-payment-state="unknown"]')).toBeVisible();
    await page.locator('[data-payment-continue]').click();
    await expect(page.locator(`${FORM} [name="firstName"]`)).toBeEditable();
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect.poll(() => ids.length).toBeGreaterThan(1);
    expect(ids[1] === ids[0] || ids[1] === 'canonical').toBe(true);
  });
});
