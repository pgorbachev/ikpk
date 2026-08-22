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
import AxeBuilder from '@axe-core/playwright';
import { contrastRatio, parseRgb } from './helpers/contrast';
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

  // ── Панель модального окна должна лежать ВЫШЕ шапки страницы ───────────────
  //
  // Дефект найден на ревью PR #151 и существовал до него. `.payment-dialog` объявляет
  // `z-index: 80`, а `header.topnav` — 100 при высоте 74 px. Форма выше окна, поэтому
  // панель прижимается к `top: 16`, и её «голова» — заголовок диалога и кнопка «Закрыть» —
  // уходит под шапку.
  //
  // ПОПАДАНИЕМ КУРСОРА ЭТОТ ДЕФЕКТ НЕ ИЗМЕРЯЕТСЯ, и первая редакция теста была из-за
  // этого зелёной на всех проверках кроме сравнения слоёв. При открытии диалога скрипт
  // ставит `inert` на элементы вне диалога, а Chrome исключает inert-поддерево из
  // hit-testing целиком: `elementsFromPoint` в точке заголовка не содержит шапку вовсе,
  // хотя `visibility: visible` и `opacity: 1` — то есть шапка ПО-ПРЕЖНЕМУ рисуется
  // поверх. Измерено: стек в точке заголовка начинается с `H2`, шапки в нём нет.
  // Поэтому предмет здесь — порядок ОТРИСОВКИ, а он задаётся `z-index` двух соседних
  // контекстов наложения; числа читаются из вычисленного стиля, а не из написания в CSS.
  test('панель лежит выше шапки: голова диалога не под ней', async ({ page }) => {
    await openForm(page);
    const probe = await page.evaluate(() => {
      const dialog = document.querySelector('.payment-dialog');
      const head = document.querySelector('.payment-dialog-head');
      const header = document.querySelector('header.topnav');
      if (!dialog || !head || !header) {
        return { ok: false as const, reason: 'нет панели, головы диалога или шапки' };
      }
      const layer = (el: Element) => {
        const z = getComputedStyle(el).zIndex;
        return z === 'auto' ? Number.NaN : Number(z);
      };
      const hd = head.getBoundingClientRect();
      const hr = header.getBoundingClientRect();
      return {
        ok: true as const,
        head: { top: +hd.top.toFixed(1), bottom: +hd.bottom.toFixed(1) },
        header: { top: +hr.top.toFixed(1), bottom: +hr.bottom.toFixed(1) },
        overlaps: hd.top < hr.bottom && hd.bottom > hr.top,
        dialogZ: layer(dialog),
        headerZ: layer(header),
        headerPainted: getComputedStyle(header).visibility === 'visible'
          && Number(getComputedStyle(header).opacity) > 0,
      };
    });

    if (!probe.ok) {
      expect(probe.ok, `прибор не смог измерить: ${probe.reason}`).toBe(true);
      return;
    }

    const geometry = `голова y=${probe.head.top}–${probe.head.bottom}, шапка y=${probe.header.top}–${probe.header.bottom}, `
      + `z-index ${probe.dialogZ} против ${probe.headerZ}`;

    // Голова в кадре — иначе «не под шапкой» достижимо вывозом за верхнюю кромку окна.
    expect(probe.head.top, `голова диалога выше верхней кромки окна (${geometry})`).toBeGreaterThanOrEqual(0);
    // Условие теста заявлено, а не выведено из исхода: проверка имеет смысл только когда
    // голова и шапка действительно пересекаются. Если геометрия изменится и пересечения
    // не станет, тест обязан покраснеть и потребовать пересмотра, а не тихо проверять
    // пустое множество.
    expect(probe.overlaps, `голова и шапка не пересекаются — предмет проверки исчез (${geometry})`).toBe(true);
    expect(probe.headerPainted, `шапка не рисуется — сравнивать слои незачем (${geometry})`).toBe(true);
    expect(probe.dialogZ, `у панели нет числового z-index (${geometry})`).not.toBeNaN();
    expect(probe.headerZ, `у шапки нет числового z-index (${geometry})`).not.toBeNaN();
    expect(probe.dialogZ, `шапка рисуется поверх головы диалога (${geometry})`).toBeGreaterThan(probe.headerZ);
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

// ─── 3a.3a-2 пересчёт полосы футера подписан и на visual viewport ─────────────
//
// ЭТО ГЕЙТ НА ПРОВОДКУ, А НЕ НА ПОВЕДЕНИЕ ПЛАТФОРМЫ, и путать одно с другим нельзя.
// Предмет: экранная клавиатура названа прямо в дефекте про липкий футер, а iOS Safari при
// её поднятии размер окна не меняет и `resize` на `window` не даёт вовсе — меняется только
// visual viewport. Проверить сам iOS здесь нечем: в наборах только Chromium. Поэтому
// проверяется то, что проверить можно — что событие visual viewport ведёт к пересчёту, —
// а поведение iOS остаётся на стендовой проверке руками. Гейт, названный «работает на
// iOS», был бы ложным.
//
// Прибор: значение полосы намеренно портится, затем шлётся событие. Если подписки нет,
// испорченное значение остаётся — то есть красное здесь означает именно потерянную
// подписку, а не что-нибудь ещё.
test.describe('3a.3a-2 проводка пересчёта полосы футера', () => {
  test.use({ viewport: { width: 390, height: 700 } });

  test('событие visual viewport пересчитывает полосу футера', async ({ page }) => {
    await openForm(page);
    const probe = await page.evaluate(async () => {
      const panel = document.querySelector<HTMLElement>('.payment-dialog-panel');
      if (!panel) return { ok: false as const, reason: 'нет панели диалога' };
      if (!window.visualViewport) {
        return { ok: false as const, reason: 'в этом браузере нет visualViewport — проводку проверять нечем' };
      }
      const before = panel.style.getPropertyValue('--payment-footer-height');
      panel.style.setProperty('--payment-footer-height', '-1px');
      window.visualViewport.dispatchEvent(new Event('resize'));
      // Два кадра: пересчёт склеен через requestAnimationFrame.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        ok: true as const,
        before,
        after: panel.style.getPropertyValue('--payment-footer-height'),
      };
    });

    if (!probe.ok) {
      expect(probe.ok, `прибор не смог измерить: ${probe.reason}`).toBe(true);
      return;
    }
    // Значение до порчи осмысленно: иначе «после совпало с до» означало бы, что обе
    // величины пусты, и подписки могло не быть вовсе.
    expect(probe.before, 'полоса футера не выставлена при открытии — портить нечего').toMatch(/^\d+(\.\d+)?px$/);
    expect(
      probe.after,
      `событие visual viewport не пересчитало полосу футера: осталось ${probe.after} вместо ${probe.before}`,
    ).toBe(probe.before);
  });
});

// ─── 3a.3a-3 состояние «места нет» снимается, когда место появилось ───────────
//
// Находка независимого ревью (P2). `validate()` начинается с `clearErrors()`, от которого
// футер УМЕНЬШАЕТСЯ, но пересчёт полосы стоял только в ветви `firstInvalid` — то есть
// после «сначала ошиблись, потом исправили» признак `payment-panel-cramped` оставался
// висеть, и футер не прилипал до поворота экрана или переоткрытия окна.
//
// Почему этого не поймали 68 проверок набора: все они либо не доходят до валидной
// отправки на низком окне, либо смотрят на видимость поля, а здесь предмет — ОСТАВШЕЕСЯ
// состояние, которое само по себе ничего не портит немедленно. Порча наступает позже,
// когда посетитель вернётся к форме.
//
// Проверяются оба конца перехода: что признак сначала действительно появился (иначе тест
// зелен вакуумно — снимать было бы нечего) и что после валидной отправки он снят.
test.describe('3a.3a-3 признак «места нет» снимается после исправления полей', () => {
  test.use({ viewport: { width: 390, height: 320 } });

  test('признак снят после валидной отправки с терминальным ответом', async ({ page }) => {
    await page.route(/\/payments$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'already_paid' }),
      });
    });
    await openForm(page);

    const cramped = () =>
      page.evaluate(() =>
        document.querySelector('.payment-dialog-panel')?.classList.contains('payment-panel-cramped') ?? null,
      );

    await page.locator(`${FORM} [type="submit"]`).click();
    expect(
      await cramped(),
      'после отправки пустой формы признак не появился — снимать нечего, проверка вакуумна',
    ).toBe(true);

    await page.locator(`${FORM} [name="firstName"]`).fill('Иван');
    await page.locator(`${FORM} [name="lastName"]`).fill('Петров');
    await page.locator(`${FORM} [name="seminar"]`).fill('Модуль 1');
    await page.locator(`${FORM} [name="amount"]`).fill('1');
    await page.locator(`${FORM} [name="email"]`).fill('ivan@example.com');
    await page.locator(`${FORM} [name="phone"]`).fill('79111234567');
    await page.locator(`${FORM} [name="consent"]`).check();
    await page.locator(`${FORM} [type="submit"]`).click();
    await expect(page.locator('[data-payment-state="already_paid"]')).toBeVisible();

    expect(
      await cramped(),
      'ошибки убраны и футер стал ниже, но признак «места нет» остался — футер не прилипает '
        + 'до поворота экрана или переоткрытия окна',
    ).toBe(false);
  });
});

// ─── 3a.3b текст ошибки читаем в ОБЕИХ темах ──────────────────────────────────
//
// Дефект найден на ревью PR #151 и существовал до него: `.payment-error` был задан
// литералом `#8a1f1f`, который в тёмной теме ложится на подложку панели `#1f241f` и даёт
// 1.73:1 при требуемых по WCAG 1.4.3 4.5:1 для обычного текста. В светлой теме тот же
// цвет даёт 9.14:1 — то есть дефект жил ровно в одной теме, и гейт по одной теме его бы
// не увидел. Отсюда обе темы в цикле.
//
// Мерится ВЫЧИСЛЕННЫЙ цвет, а не написание токена: в проекте уже был гейт, сверявший
// литерал и не замечавший переопределения темой. Подложка тоже берётся вычисленной у
// панели, а не предполагается белой.
test.describe('3a.3b контраст текста ошибки', () => {
  const MIN_RATIO = 4.5;

  for (const theme of ['light', 'dark'] as const) {
    test(`сообщение об ошибке поля читаемо в теме ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('ikpk.theme', t);
        } catch {
          /* приватный режим — тест просто пройдёт по светлой теме */
        }
      }, theme);
      await openForm(page);
      // Тема применена фактически, а не только запрошена: иначе «тёмная» проверка мерила
      // бы светлую и была бы зелёной вдвойне впустую.
      if (theme === 'dark') {
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      } else {
        await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
      }
      await page.locator(`${FORM} [type="submit"]`).click();

      const probe = await page.evaluate(() => {
        const err = [...document.querySelectorAll<HTMLElement>('.payment-error')].find((el) => !el.hidden);
        const panel = document.querySelector('.payment-dialog-panel');
        if (!err || !err.textContent?.trim() || !panel) {
          return { ok: false as const, reason: 'на форме нет показанного сообщения об ошибке или панели' };
        }
        // Фон ищем у ближайшего предка с непрозрачной заливкой: у самого абзаца её нет,
        // и `transparent` как подложка дал бы бессмысленное число.
        let bg = '';
        for (let el: Element | null = err; el; el = el.parentElement) {
          const c = getComputedStyle(el).backgroundColor;
          if (c && c !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(c)) {
            bg = c;
            break;
          }
        }
        return {
          ok: true as const,
          text: err.textContent.trim(),
          color: getComputedStyle(err).color,
          background: bg,
          panelBackground: getComputedStyle(panel).backgroundColor,
        };
      });

      if (!probe.ok) {
        expect(probe.ok, `прибор не смог измерить: ${probe.reason}`).toBe(true);
        return;
      }
      expect(probe.background, 'непрозрачной подложки под сообщением не нашлось').toBeTruthy();

      const value = contrastRatio(parseRgb(probe.color), parseRgb(probe.background));
      expect(
        value,
        `«${probe.text}» ${probe.color} на ${probe.background} даёт ${value.toFixed(2)}:1 при требуемых ${MIN_RATIO}:1`,
      ).toBeGreaterThanOrEqual(MIN_RATIO);
    });
  }
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

// ─── 3a.3c axe над самим диалогом ─────────────────────────────────────────────
//
// Форму оплаты не проверял ни один a11y-гейт, и это не оговорка, а следствие устройства
// наборов: `a11y.spec.ts` идёт по боевому `dist`, то есть по артефакту роли `ci`, у
// которого формы нет вовсе (`hasForm = role !== 'ci'`). Прогнать axe по `/oplata` там
// можно, и он зеленел — но диалога в разметке нет, и проверялась страница без предмета.
// Плюс сам диалог закрыт (`hidden`), а axe скрытое поддерево не разбирает.
//
// Поэтому гейт живёт здесь, на артефакте роли `stand`, и проверяет ДВА состояния: только
// что открытое окно и окно после неудачной отправки. Второе отдельно потому, что именно
// в нём появляются `aria-invalid` и `aria-describedby` — связи, которых в первом нет, и
// сломать их можно не тронув разметку полей.
//
// Обе темы: контраст текста — правило axe, и дефект `.payment-error` жил ровно в тёмной.
test.describe('3a.3c axe над окном оплаты', () => {
  test.describe.configure({ timeout: 60_000 });

  const analyze = (page: Page) =>
    new AxeBuilder({ page })
      // Только само окно: страница под ним при открытом диалоге помечена `inert`, её
      // нарушения — предмет `a11y.spec.ts`, и смешивать два предмета в одном гейте значит
      // получить красный цвет, по которому не понять, что именно сломано.
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

  for (const theme of ['light', 'dark'] as const) {
    for (const state of ['открытое окно', 'после неудачной отправки'] as const) {
      test(`${state}, тема ${theme}: нет critical/serious нарушений`, async ({ page }) => {
        await page.addInitScript((t) => {
          try {
            localStorage.setItem('ikpk.theme', t);
          } catch {
            /* приватный режим */
          }
        }, theme);
        await openForm(page);
        if (theme === 'dark') {
          await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        }
        if (state === 'после неудачной отправки') {
          await page.locator(`${FORM} [type="submit"]`).click();
          await expect(page.locator(`${FORM} [aria-invalid="true"]`).first()).toBeVisible();
        }

        // Предмет на месте: без этой проверки axe разобрал бы пустой диалог и выдал ноль
        // нарушений — «нечего проверять» прочиталось бы как «нарушений нет». Ровно так
        // гейт axe в проекте уже проверял страницу 404 вместо шаблонов.
        const fields = await page.locator(`${FORM} input:not([tabindex="-1"])`).count();
        expect(fields, 'в окне нет полей формы — axe проверил бы пустой диалог').toBe(9);

        const results = await analyze(page);
        // Прибор действительно работал: если ни одно правило не применилось, ноль
        // нарушений ничего не значит.
        expect(
          results.passes.length + results.violations.length + results.incomplete.length,
          'axe не применил ни одного правила — измерять было нечем',
        ).toBeGreaterThan(0);

        const blocking = results.violations.filter(
          (v) => v.impact === 'critical' || v.impact === 'serious',
        );
        expect(
          blocking,
          blocking
            .map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} узлов)`)
            .join('\n'),
        ).toEqual([]);
      });
    }
  }
});

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
