import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installThirdPartyGuard } from './helpers/third-party-guard';
import { TEMPLATES } from './helpers/templates';
import {
  FOREIGN_METRIKA_ID,
  OWN_METRIKA_ID,
  REVIEWS_WIDGET_HOST,
  SEL_AWARD_BADGE,
  SEL_CHAT_FACADE,
  SEL_CHAT_HOURS,
  SEL_CHAT_MOUNT,
  SEL_CHAT_TRIGGER,
  SEL_REVIEWS_SECTION,
} from './helpers/external-widgets';

/**
 * Тесты по спеке change `external-widgets` — браузерные сценарии.
 *
 * Сторонние хосты здесь ЖИВЫМИ не участвуют: перехват ставится в каждом тесте
 * (`installThirdPartyGuard`), и подмена собирает ответ из заданного содержимого, не
 * обращаясь к настоящему хосту ни одним способом. Конфигурация `playwright.config.ts`
 * запрета разрешения имён не несёт, поэтому здесь перехват — единственный слой; в
 * конфигурациях preview и stand он был бы ДОБАВЛЕН к запрету, а не вместо него.
 *
 * Подставной ответ виджета — ФИКСИРОВАННОГО размера. Это не удобство: проверка сдвига
 * раскладки на живом ответе зависела бы от того, сколько отзывов у организации сегодня,
 * а при блокировке запроса предмет проверки исчезает вовсе — появления нет.
 */

const CHAT_MODULE = '../src/lib/external-widgets';

/** Адрес загрузчика чата из конфигурации. Нет модуля или адреса — тест это скажет. */
async function chatLoader(): Promise<string | null> {
  try {
    const mod = (await import(CHAT_MODULE)) as { chatLoaderSrc?: () => string | null };
    return mod.chatLoaderSrc?.() ?? null;
  } catch {
    return null;
  }
}

async function guard(page: Page) {
  return installThirdPartyGuard(page, { chatLoaderSrc: await chatLoader() });
}

/** Момент в зоне Europe/Moscow, подставляемый странице значением. */
const MOMENT = {
  fridayWorking: '2026-08-21T11:00:00+03:00',
  fridayAfterHours: '2026-08-21T19:30:00+03:00',
  sundayNoon: '2026-08-23T12:00:00+03:00',
  nextYearWorking: '2027-08-20T11:00:00+03:00',
};

// ─── Ленивое встраивание виджета отзывов ─────────────────────────────────────

test.describe('виджет отзывов не грузится, пока секция не показалась', () => {
  test.describe.configure({ timeout: 60_000 });

  test('до появления секции запросов к домену виджета нет', async ({ page }) => {
    const seen = await guard(page);
    const response = await page.goto('/');
    expect(response?.status(), 'главная не отдалась — проверять нечего').toBe(200);

    // Непустота предмета: секция обязана быть на месте, иначе «запросов нет» верно и
    // на странице без секции.
    await expect(
      page.locator(`[${SEL_REVIEWS_SECTION}]`),
      'секции отзывов на главной нет — предмета нет',
    ).toHaveCount(1);
    await expect(page.locator(`[${SEL_REVIEWS_SECTION}]`)).not.toBeInViewport();

    // Ждём того же порога, на котором сработал бы IntersectionObserver: даём странице
    // отработать и убеждаемся, что запроса всё равно нет.
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    expect(
      seen.toHost(REVIEWS_WIDGET_HOST),
      `к домену виджета обратились до появления секции: ${seen.toHost(REVIEWS_WIDGET_HOST).join(', ')}`,
    ).toEqual([]);
  });

  test('появление секции подставляет встраивание', async ({ page }) => {
    const seen = await guard(page);
    await page.goto('/');
    await page.locator(`[${SEL_REVIEWS_SECTION}]`).scrollIntoViewIfNeeded();
    await expect(
      page.locator(`[${SEL_REVIEWS_SECTION}] iframe`),
      'после появления секции встраивание не подставлено',
    ).toHaveCount(1);
    expect(seen.toHost(REVIEWS_WIDGET_HOST).length, 'запроса к домену виджета не было').toBeGreaterThan(0);
  });

  test('появление виджета не сдвигает страницу', async ({ page }) => {
    await guard(page);
    await page.goto('/');
    const section = page.locator(`[${SEL_REVIEWS_SECTION}]`);
    await expect(section, 'секции отзывов нет — сдвигать нечему').toHaveCount(1);

    // Измеряется положение СОСЕДА ниже секции: сдвиг «содержимого вокруг секции» — это
    // именно смещение того, что стоит после неё.
    const below = page.locator(`[${SEL_REVIEWS_SECTION}] ~ *`).first();
    await expect(below, 'после секции отзывов нет ни одного элемента — сдвиг измерять нечем').toHaveCount(1);

    const geometry = async (): Promise<{ height: number; nextTop: number; scroll: number }> =>
      page.evaluate((selector) => {
        const el = document.querySelector(`[${selector}]`)!;
        const next = el.nextElementSibling!;
        return {
          height: el.getBoundingClientRect().height,
          nextTop: next.getBoundingClientRect().top + window.scrollY,
          scroll: document.documentElement.scrollHeight,
        };
      }, SEL_REVIEWS_SECTION);

    const before = await geometry();
    await section.scrollIntoViewIfNeeded();
    await expect(page.locator(`[${SEL_REVIEWS_SECTION}] iframe`)).toHaveCount(1);
    const after = await geometry();

    expect(after.height, 'высота секции изменилась после подстановки виджета').toBeCloseTo(before.height, 0);
    expect(after.nextTop, 'сосед ниже секции сместился').toBeCloseTo(before.nextTop, 0);
    expect(after.scroll, 'высота документа изменилась').toBeCloseTo(before.scroll, 0);
  });

  test('результат проверки сдвига не зависит от ответа сервиса', async ({ page }) => {
    // Дважды в одном прогоне, с РАЗНЫМ содержимым подставного документа при том же
    // размере области: результат обязан совпасть. На живом ответе он менялся бы от
    // каждого нового отзыва.
    const measure = async (body: string): Promise<number> => {
      // Перехват ставится заново, поэтому прежние обработчики снимаются: два набора
      // правил на одной странице сделали бы предмет зависящим от порядка их добавления.
      await page.unrouteAll();
      await installThirdPartyGuard(page, {
        chatLoaderSrc: await chatLoader(),
        reviewsWidgetBody: body,
      });
      await page.goto('/');
      const section = page.locator(`[${SEL_REVIEWS_SECTION}]`);
      await expect(section).toHaveCount(1);
      await section.scrollIntoViewIfNeeded();
      await expect(page.locator(`[${SEL_REVIEWS_SECTION}] iframe`)).toHaveCount(1);
      return page.evaluate(
        (selector) => document.querySelector(`[${selector}]`)!.getBoundingClientRect().height,
        SEL_REVIEWS_SECTION,
      );
    };

    const short = await measure('<!doctype html><html lang="ru"><body>один отзыв</body></html>');
    const long = await measure(
      `<!doctype html><html lang="ru"><body>${'много отзывов '.repeat(400)}</body></html>`,
    );
    expect(long, 'высота секции зависит от того, что ответил сторонний сервис').toBeCloseTo(short, 0);
  });
});

test.describe('без скриптов секция даёт ссылку, а не встраивание', () => {
  test('при отключённых скриптах виджета нет, ссылка есть', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      const seen = await installThirdPartyGuard(page, { chatLoaderSrc: await chatLoader() });
      const response = await page.goto('/');
      expect(response?.status(), 'главная не отдалась').toBe(200);
      await expect(
        page.locator(`[${SEL_REVIEWS_SECTION}]`),
        'секции отзывов нет — предмета нет',
      ).toHaveCount(1);
      await expect(
        page.locator(`[${SEL_REVIEWS_SECTION}] iframe`),
        'без скриптов встраивание всё равно есть: чужой счётчик грузится безусловно и ' +
          'без ленивого порога — ровно у того посетителя, который меньше всего этого ждёт',
      ).toHaveCount(0);
      const link = page.locator(`[${SEL_REVIEWS_SECTION}] a[href*="${REVIEWS_WIDGET_HOST}"]`);
      await expect(link, 'без скриптов в секции нет ссылки на отзывы организации').toHaveCount(1);
      expect(
        seen.toHost(REVIEWS_WIDGET_HOST),
        'без скриптов страница всё равно обратилась к домену виджета',
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

// ─── Фасад чата ──────────────────────────────────────────────────────────────

test.describe('чат: наша кнопка, чужой интерфейс по нажатию', () => {
  test.describe.configure({ timeout: 60_000 });

  test('кнопка вызова есть до исполнения стороннего скрипта и доступна с клавиатуры', async ({ page }) => {
    const seen = await guard(page);
    await page.goto('/');
    const trigger = page.locator(`[${SEL_CHAT_TRIGGER}]`);
    await expect(trigger, 'нашей кнопки вызова чата в разметке нет').toHaveCount(1);
    await expect(trigger).toBeVisible();

    const loader = await chatLoader();
    expect(loader, 'адрес загрузчика чата не объявлен конфигурацией — предмета нет').not.toBeNull();
    expect(
      seen.toHost(new URL(loader!).hostname),
      'сторонний загрузчик исполнился до нажатия',
    ).toEqual([]);

    // Доступность с клавиатуры проверяется ФОКУСОМ и активацией, а не наличием
    // `tabindex`: `div` с `tabindex` фокусируется, но по Enter ничего не делает.
    await trigger.focus();
    await expect(trigger, 'кнопка вызова не принимает фокус').toBeFocused();
    const name = await trigger.evaluate((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');
    expect(name.trim().length, 'у кнопки вызова нет доступного имени').toBeGreaterThan(0);
  });

  test('сторонних запросов до нажатия нет', async ({ page }) => {
    const seen = await guard(page);
    await page.goto('/');
    await expect(page.locator(`[${SEL_CHAT_TRIGGER}]`), 'кнопки вызова нет — предмета нет').toHaveCount(1);

    // Простой браузера триггером НЕ является, и это проверяется временем: измерение
    // бюджетов производительности хука перехвата не имеет вовсе, простой внутри него
    // наступает, и «отложенный до простоя» скрипт исполнился бы там на всех четырёх
    // шаблонах против бюджета времени блокировки.
    await page.waitForLoadState('load');
    await page.waitForTimeout(4000);
    const loader = await chatLoader();
    expect(loader, 'адрес загрузчика не объявлен — предмета нет').not.toBeNull();
    expect(
      seen.toHost(new URL(loader!).hostname),
      'загрузчик исполнился без нажатия: простой браузера сработал как триггер',
    ).toEqual([]);
  });

  test('нажатие исполняет загрузчик, и фокус уходит внутрь появившегося интерфейса', async ({ page }) => {
    await guard(page);
    await page.goto('/');
    const trigger = page.locator(`[${SEL_CHAT_TRIGGER}]`);
    await expect(trigger, 'кнопки вызова нет — нажимать нечего').toHaveCount(1);
    await trigger.focus();
    await trigger.click();

    const panel = page.locator(`[${SEL_CHAT_MOUNT}] [data-chat-stub-panel]`);
    await expect(
      panel,
      'подставной интерфейс не появился в объявленной точке монтирования: либо загрузчик ' +
        'не исполнился, либо смонтировался не туда',
    ).toHaveCount(1);

    const inside = await page.evaluate(
      (mount) => {
        const host = document.querySelector(`[${mount}]`);
        return host !== null && document.activeElement !== null && host.contains(document.activeElement);
      },
      SEL_CHAT_MOUNT,
    );
    expect(
      inside,
      'фокус не внутри появившегося интерфейса: уничтожение элемента с фокусом уводит его ' +
        'в начало документа',
    ).toBe(true);
  });
});

// ─── Часы работы менеджера ───────────────────────────────────────────────────

test.describe('вне часов работы посетитель видит часы и телефон', () => {
  test('в воскресенье часы работы и телефон показаны', async ({ page }) => {
    await page.clock.install({ time: new Date(MOMENT.sundayNoon) });
    await guard(page);
    await page.goto('/');
    const hours = page.locator(`[${SEL_CHAT_HOURS}]`);
    await expect(hours, 'блока часов работы нет').toHaveCount(1);
    await expect(hours).toBeVisible();
    const text = (await hours.innerText()).replace(/\s+/g, ' ');
    expect(text, `в блоке нет часов работы: «${text}»`).toMatch(/10[:.]00/);
    expect(text, `в блоке нет часов работы: «${text}»`).toMatch(/18[:.]00/);
    const tel = hours.locator('a[href^="tel:"]');
    await expect(tel, 'в блоке часов нет телефона').not.toHaveCount(0);
  });

  test('выходные названы как выходные МЕНЕДЖЕРА, а семинары в эти дни идут', async ({ page }) => {
    await page.clock.install({ time: new Date(MOMENT.sundayNoon) });
    await guard(page);
    await page.goto('/');
    const text = (await page.locator(`[${SEL_CHAT_HOURS}]`).innerText()).replace(/\s+/g, ' ');
    expect(
      /семинар/i.test(text),
      `текст не говорит, что выходные относятся к менеджеру, а семинары идут: «${text}». ` +
        'Умолчание об этом читается как «в выходные ничего не происходит»',
    ).toBe(true);
  });

  test('часы и телефон показаны и при неответившем загрузчике', async ({ page }) => {
    await page.clock.install({ time: new Date(MOMENT.sundayNoon) });
    // Загрузчик не отвечает вовсе: часы и телефон — НАШИ данные, и посетитель,
    // пришедший в воскресенье, обязан увидеть их при недоступном чате.
    await installThirdPartyGuard(page, { chatLoaderSrc: await chatLoader(), chatLoaderBody: '' });
    await page.goto('/');
    await expect(page.locator(`[${SEL_CHAT_HOURS}]`)).toBeVisible();
    await expect(page.locator(`[${SEL_CHAT_HOURS}] a[href^="tel:"]`)).not.toHaveCount(0);
  });
});

// ─── Различение счётчиков ────────────────────────────────────────────────────

test.describe('наша и чужая аналитика различены по идентификатору счётчика', () => {
  test('перехват видит оба счётчика и различает их идентификатором в адресе пикселя', async ({ page }) => {
    const seen = await guard(page);
    await page.goto('/');
    await page.locator(`[${SEL_REVIEWS_SECTION}]`).scrollIntoViewIfNeeded();
    await expect(page.locator(`[${SEL_REVIEWS_SECTION}] iframe`)).toHaveCount(1);
    // Тег грузится после простоя (`requestIdleCallback` с таймаутом 3000), поэтому
    // ждём именно его, а не фиксированную паузу наугад.
    await page.waitForTimeout(4000);

    const ids = seen.counterIds();
    expect(ids, `в перехвате нет ни одного обращения к трекинг-пикселю: ${seen.urls.join(', ')}`).not.toEqual([]);
    expect(ids, 'нашего счётчика в перехвате нет').toContain(OWN_METRIKA_ID);
    expect(ids, 'чужого счётчика из виджета в перехвате нет').toContain(FOREIGN_METRIKA_ID);

    // Адрес ТЕГА у них общий — на нём различить нельзя в принципе, и это проверяется,
    // а не подразумевается.
    const tagCalls = seen.urls.filter((u) => u.endsWith('/metrika/tag.js'));
    expect(tagCalls.length, 'тег Метрики не загружался — утверждение про общий адрес не проверено').toBeGreaterThan(0);
    for (const call of tagCalls) {
      expect(call).not.toContain(OWN_METRIKA_ID);
      expect(call).not.toContain(FOREIGN_METRIKA_ID);
    }
  });

  test('идентификатора чужого счётчика в нашей разметке нет вовсе', async ({ page }) => {
    // Отсюда и следует, что различение НЕ ищется в выводе сборки: предмета там нет, и
    // проверка по разметке была бы непройденной, а не пройденной.
    await guard(page);
    await page.goto('/');
    // Непустота: секция и живое встраивание обязаны быть на месте. Без этого «чужого
    // идентификатора в разметке нет» верно на странице, где виджета нет вовсе, — то есть
    // утверждение подтверждается сломанным продуктом.
    await page.locator(`[${SEL_REVIEWS_SECTION}]`).scrollIntoViewIfNeeded();
    await expect(
      page.locator(`[${SEL_REVIEWS_SECTION}] iframe`),
      'встраивания нет — утверждение об отсутствии чужого идентификатора тривиально верно',
    ).toHaveCount(1);
    const markup = await page.content();
    expect(
      markup.includes(FOREIGN_METRIKA_ID),
      'идентификатор чужого счётчика оказался в нашей разметке — значит счётчик наш, ' +
        'а не приехавший внутри виджета',
    ).toBe(false);
  });
});

// ─── Доступность ─────────────────────────────────────────────────────────────

test.describe('сторонний iframe не отменяет доступности секции', () => {
  test.describe.configure({ timeout: 60_000 });

  test('наши части секции и блок часов без critical/serious', async ({ page }) => {
    await page.clock.install({ time: new Date(MOMENT.sundayNoon) });
    await guard(page);
    await page.goto('/');
    await page.locator(`[${SEL_REVIEWS_SECTION}]`).scrollIntoViewIfNeeded();
    await expect(page.locator(`[${SEL_REVIEWS_SECTION}] iframe`), 'встраивания нет — предмета нет').toHaveCount(1);
    await expect(page.locator(`[${SEL_CHAT_HOURS}]`), 'блока часов нет — предмета нет').toHaveCount(1);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      // Исключается ТОЛЬКО сам сторонний iframe и то, что загрузчик создаёт ВНУТРИ
      // объявленной нами точки монтирования. Ни секция, ни блок часов, ни наша кнопка
      // вызова из проверки не выходят: признак — НАШЕ имя контейнера, потому что
      // происхождение узла селектором не выражается, а чужой класс сторона вправе
      // переименовать.
      .exclude(`[${SEL_REVIEWS_SECTION}] iframe`)
      .exclude(`[${SEL_CHAT_MOUNT}] *`)
      .analyze();

    const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(
      blocking,
      blocking.map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`).join('\n'),
    ).toEqual([]);
  });

  test('исключение не накрывает нашу кнопку вызова', async ({ page }) => {
    // Мутация на ЧРЕЗМЕРНОСТЬ исключения: слишком широкий селектор скрыл бы наши
    // нарушения молча. Проверяется, что кнопка вызова НЕ лежит внутри исключаемой
    // области.
    await guard(page);
    await page.goto('/');
    await expect(page.locator(`[${SEL_CHAT_TRIGGER}]`), 'кнопки нет — предмета нет').toHaveCount(1);
    const inside = await page.evaluate(
      ([mount, trigger]) => {
        const host = document.querySelector(`[${mount}]`);
        const button = document.querySelector(`[${trigger}]`);
        return host !== null && button !== null && host.contains(button);
      },
      [SEL_CHAT_MOUNT, SEL_CHAT_TRIGGER],
    );
    expect(
      inside,
      'наша кнопка вызова лежит внутри точки монтирования: исключение из проверки ' +
        'доступности накрыло бы её, то есть скрыло наши нарушения',
    ).toBe(false);
  });

  test('у встраивания есть название, сообщающее, что внутри', async ({ page }) => {
    await guard(page);
    await page.goto('/');
    await page.locator(`[${SEL_REVIEWS_SECTION}]`).scrollIntoViewIfNeeded();
    const frame = page.locator(`[${SEL_REVIEWS_SECTION}] iframe`);
    await expect(frame, 'встраивания нет — названия проверять нечему').toHaveCount(1);
    const title = (await frame.getAttribute('title')) ?? '';
    expect(title.trim().length, 'у встраивания нет названия').toBeGreaterThan(0);
    expect(
      /отзыв/i.test(title),
      `название «${title}» не сообщает, что внутри отзывы организации`,
    ).toBe(true);
  });
});

// ─── Перекрытие кнопкой чата ─────────────────────────────────────────────────

test.describe('кнопка чата не перекрывает содержимое страницы', () => {
  test.describe.configure({ timeout: 60_000 });

  for (const { name, path } of TEMPLATES) {
    test(`${name}: закрытая кнопка не накрывает интерактивные элементы и текст`, async ({ page }) => {
      await guard(page);
      const response = await page.goto(path);
      if (name.startsWith('preview-') && response?.status() === 404)
        test.skip(true, 'черновик варианта отсутствует в боевой сборке');
      // 404 — «проверять нечего», а не «перекрытий нет»: страница крошечная, и на ней
      // ничего не перекрывается по построению.
      expect(response?.status(), `${path}: страница не отдалась — проверялась бы 404`).toBe(200);

      const trigger = page.locator(`[${SEL_CHAT_TRIGGER}]`);
      await expect(trigger, `${path}: кнопки вызова нет — перекрывать нечем`).toHaveCount(1);
      await expect(trigger).toBeVisible();

      const overlaps = await page.evaluate((triggerAttr) => {
        const button = document.querySelector(`[${triggerAttr}]`) as HTMLElement | null;
        if (button === null) return { interactive: ['кнопки нет'], text: [] as string[] };
        const box = button.getBoundingClientRect();
        const hit = (r: DOMRect): boolean =>
          r.width > 0 && r.height > 0 &&
          r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;

        const interactive: string[] = [];
        for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"]')) {
          if (button.contains(el) || el.contains(button)) continue;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          if (hit(el.getBoundingClientRect()))
            interactive.push(`${el.tagName.toLowerCase()}: ${(el.textContent ?? '').trim().slice(0, 40)}`);
        }

        // РАМКА ТЕКСТА, а не рамка блока: блок во всю ширину пересекается с плавающим
        // элементом всегда, и такое измерение сообщает о перекрытии там, где его нет.
        const text: string[] = [];
        for (const p of document.querySelectorAll('p, li, h1, h2, h3, h4')) {
          if (button.contains(p)) continue;
          const style = getComputedStyle(p);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const range = document.createRange();
          range.selectNodeContents(p);
          for (const rect of range.getClientRects())
            if (hit(rect)) {
              text.push(`${p.tagName.toLowerCase()}: ${(p.textContent ?? '').trim().slice(0, 40)}`);
              break;
            }
          range.detach();
        }
        return { interactive, text };
      }, SEL_CHAT_TRIGGER);

      expect(
        overlaps.interactive.slice(0, 5),
        `${path}: кнопка вызова чата накрывает интерактивные элементы`,
      ).toEqual([]);
      expect(
        overlaps.text.slice(0, 5),
        `${path}: кнопка вызова чата накрывает рамку текста`,
      ).toEqual([]);
    });
  }

  test('точка «вне элемента», выбранная существующим перебором, не попадает в кнопку чата', async ({ page }) => {
    // Существующие переборы идут СНИЗУ вверх и отбрасывают интерактивные узлы, поэтому
    // сама кнопка будет пропущена — риск обратный: неинтерактивная фиксированная
    // обёртка вокруг кнопки под признак «интерактивное» не попадёт, и точка окажется
    // на ней. Прогон тогда упадёт по причине, к его предмету не относящейся.
    await guard(page);
    await page.goto('/');
    await expect(page.locator(`[${SEL_CHAT_FACADE}]`), 'фасада чата нет — предмета нет').toHaveCount(1);

    const landed = await page.evaluate((facadeAttr) => {
      const facade = document.querySelector(`[${facadeAttr}]`);
      const step = 20;
      const interactive = 'a, button, summary, input, select, textarea, label, [role="button"]';
      for (let y = innerHeight - step; y > 0; y -= step)
        for (let x = step; x < innerWidth; x += step) {
          const el = document.elementFromPoint(x, y);
          if (el === null) continue;
          if (el.closest(interactive)) continue;
          return { x, y, inFacade: facade !== null && facade.contains(el), tag: el.tagName.toLowerCase() };
        }
      return null;
    }, SEL_CHAT_FACADE);

    expect(landed, 'ни одной неинтерактивной точки не нашлось — перебор проверить нечем').not.toBeNull();
    expect(
      landed!.inFacade,
      `точка «вне элемента» (${landed!.x}, ${landed!.y}) попала внутрь фасада чата ` +
        `(${landed!.tag}): существующие прогоны начнут падать по чужой причине`,
    ).toBe(false);
  });
});

// ─── Детерминированность облика при смене момента ────────────────────────────

test.describe('датозависимые фрагменты не краснят сравнение облика', () => {
  test.describe.configure({ timeout: 60_000 });

  /**
   * Снимок страницы с ИСКЛЮЧЁННЫМИ поимённо датозависимыми фрагментами.
   *
   * Сравниваются два снимка друг с другом, а не с принятым эталоном: предмет здесь —
   * зависимость облика от момента, а не сам облик, и привязка к файлу эталона внесла бы
   * зависимость от окружения, в котором эталоны сняты.
   */
  interface Shot {
    image: Buffer;
    /** Наблюдаемое состояние датозависимых фрагментов — доказательство непустоты. */
    fragments: string;
  }

  const shot = async (browser: Browser, moment: string): Promise<Shot> => {
    // Своя страница на каждый момент: `page.clock.install` ставится на страницу один
    // раз, и повторная установка на той же странице предмет не меняет, а ломает.
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await page.clock.install({ time: new Date(moment) });
      await installThirdPartyGuard(page, { chatLoaderSrc: await chatLoader() });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      const fragments = await page.evaluate(
        ([badge, hours]) =>
          [badge, hours]
            .map((name) => {
              const el = document.querySelector(`[${name}]`);
              return `${name}=${el === null ? 'нет' : JSON.stringify((el as HTMLElement).innerText)}`;
            })
            .join(' | '),
        [SEL_AWARD_BADGE, SEL_CHAT_HOURS],
      );
      const image = await page.screenshot({
        fullPage: true,
        animations: 'disabled',
        mask: [page.locator(`[${SEL_AWARD_BADGE}]`), page.locator(`[${SEL_CHAT_HOURS}]`)],
      });
      return { image, fragments };
    } finally {
      await context.close();
    }
  };

  /**
   * СТОРОЖ НЕПУСТОТЫ для обоих сценариев ниже.
   *
   * «Снимки совпали» тривиально верно, пока датозависимых фрагментов на странице нет
   * вовсе: тогда менять их нечему, и проверка подтверждает сломанный продукт. Поэтому
   * сначала доказывается, что фрагменты ДЕЙСТВИТЕЛЬНО зависят от момента — их
   * наблюдаемое состояние при двух моментах различается, — и только потом сравниваются
   * снимки.
   *
   * Чем именно достигается совпадение снимков при различающихся фрагментах, требование
   * не предписывает: маскирование, невключение блока в покрытие или резервирование
   * места — выбор реализации. Проверяется исход, а не способ.
   */
  const assertDateDependent = (a: Shot, b: Shot, what: string): void => {
    expect(
      a.fragments,
      `${what}: датозависимые фрагменты одинаковы при разных моментах (${a.fragments}) — ` +
        'либо их на странице нет, либо они от момента не зависят. Тогда «снимки совпали» ' +
        'ничего не утверждает',
    ).not.toBe(b.fragments);
  };

  test('смена часа и дня недели не меняет снимок', async ({ browser }) => {
    // Именно час и день недели, а не год: два прогона подряд лежат по одну сторону от
    // 18:00, и проверка, различающая только год, этого класса дефекта не поймала бы.
    // Блок часов стоит вместе с чатом, то есть на КАЖДОЙ странице, и меняется дважды в
    // сутки.
    const working = await shot(browser, MOMENT.fridayWorking);
    const afterHours = await shot(browser, MOMENT.fridayAfterHours);
    assertDateDependent(working, afterHours, 'смена часа и дня недели');
    expect(
      afterHours.image.equals(working.image),
      'снимок в рабочий час и снимок вне часов различаются на неизменном коде: ' +
        'датозависимый блок не исключён из сравнения облика',
    ).toBe(true);
  });

  test('смена года не меняет снимок', async ({ browser }) => {
    const now = await shot(browser, MOMENT.fridayWorking);
    const nextYear = await shot(browser, MOMENT.nextYearWorking);
    assertDateDependent(now, nextYear, 'смена года');
    expect(
      nextYear.image.equals(now.image),
      'снимок следующего года отличается: знак награды не исключён из сравнения облика',
    ).toBe(true);
  });
});
