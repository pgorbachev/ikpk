import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  FIXED_SIZE_WIDGET_BODY,
  WIDGET_BODY_WITH_FOREIGN_PIXEL,
  installThirdPartyGuard,
} from './helpers/third-party-guard';
import { serveStatic, type StaticSite } from './helpers/static-serve';
import { PROBE_CHAT_LOADER_SRC, buildProbe, type ProbeBuild } from './helpers/widget-probe-build';
import { TEMPLATES } from './helpers/templates';
import {
  CHAT_LOADER_KEY,
  FOREIGN_METRIKA_ID,
  MANAGER_HOURS_ATTR,
  MANAGER_HOURS_VALUE,
  OWN_METRIKA_ID,
  REVIEWS_WIDGET_HOST,
  SEL_CHAT_FACADE,
  SEL_CHAT_MOUNT,
  SEL_CHAT_TRIGGER,
  SEL_REVIEWS_SECTION,
} from './helpers/external-widgets';

/**
 * Тесты по спеке change `external-widgets` — браузерные сценарии.
 *
 * ── ЧТО РАЗДАЁТСЯ И ПОЧЕМУ НЕ `dist` ────────────────────────────────────────
 * Набор идёт по ПРОБНОЙ СБОРКЕ, собранной с заданным адресом загрузчика чата
 * (`CHAT_LOADER_SRC=<адрес>`), а не по боевому `dist`, который раздаёт `webServer`
 * конфигурации.
 *
 * Причина не в удобстве. У боевой сборки одно состояние конфигурации, и спека объявляет
 * публикуемыми ДВА состояния с разным обликом страницы: в состоянии «отсутствие объявлено
 * явно» фасада чата нет целиком. Значит набор, идущий по `dist`, терял бы предмет почти
 * весь — кнопка вызова, фокус, перекрытие, доступность нашей кнопки — ровно в том
 * состоянии, которое спека называет законным. Это тот же шаблон «законное состояние и
 * зелёный гейт недостижимы одновременно», от которого требования этой возможности и
 * переписывались. Пробная сборка снимает зависимость от того, что кто-то объявил в дереве.
 *
 * Цена измерена и невелика: `astro build --outDir <вне репозитория>` — 6,3 с на этом
 * дереве. Устройство — в шапке `tests/helpers/widget-probe-build.ts`.
 *
 * ── СТОРОННИЕ ХОСТЫ ─────────────────────────────────────────────────────────
 * Живыми они здесь не участвуют: перехват ставится в каждом тесте
 * (`installThirdPartyGuard`), и подмена собирает ответ из заданного содержимого, не
 * обращаясь к настоящему хосту ни одним способом. Конфигурация `playwright.config.ts`
 * запрета разрешения имён не несёт, поэтому здесь перехват — единственный слой; в
 * конфигурациях preview и stand он был бы ДОБАВЛЕН к запрету, а не вместо него.
 *
 * Подставных ответов виджета два, и выбор между ними — предмет проверки, а не деталь:
 * ответ ФИКСИРОВАННОГО размера идёт проверке сдвига раскладки, ответ с ПИКСЕЛЕМ чужого
 * счётчика — проверке различения счётчиков.
 */

let probe: ProbeBuild;
let site: StaticSite;

test.beforeAll(async () => {
  test.setTimeout(10 * 60 * 1000);
  // `keepOnDisk`: этому набору дерево надо РАЗДАВАТЬ, поэтому 91 МБ остаются до конца
  // прогона и убираются в `afterAll`. Всем остальным потребителям хватает разметки в
  // памяти, и там каталог удаляется сразу — иначе за сессию накапливаются гигабайты.
  probe = buildProbe(`${CHAT_LOADER_KEY}=<адрес>`, { [CHAT_LOADER_KEY]: PROBE_CHAT_LOADER_SRC }, { keepOnDisk: true });
  site = await serveStatic(probe.root!);
});

test.afterAll(async () => {
  await site?.close();
  probe?.dispose();
});

const url = (path: string): string => `${site.origin}${path}`;

async function guard(page: Page, options: Parameters<typeof installThirdPartyGuard>[1] = {}) {
  return installThirdPartyGuard(page, { chatLoaderSrc: PROBE_CHAT_LOADER_SRC, ...options });
}

const LOADER_HOST = new URL(PROBE_CHAT_LOADER_SRC).hostname;

/**
 * `seen.toHost()` ловит и субдомены (`.endsWith('.'+host)`) — годится для LOADER_HOST,
 * но не для REVIEWS_WIDGET_HOST: реальный адрес виджета — голый `yandex.ru`
 * (proposal.md, замер), а собственная Яндекс.Метрика сайта (39506315) висит на
 * `mc.yandex.ru`, тоже субдомене `yandex.ru`, и грузится на каждой странице
 * независимо от секции отзывов. Признак по субдомену конфликтует с ЧУЖИМ, но
 * предсуществующим механизмом — нужен точный хост, а не суффикс.
 */
function toExactHost(urls: readonly string[], host: string): string[] {
  return urls.filter((u) => {
    try {
      return new URL(u).hostname.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  });
}

// ─── Ленивое встраивание виджета отзывов ─────────────────────────────────────

test.describe('виджет отзывов не грузится, пока секция не показалась', () => {
  test.describe.configure({ timeout: 60_000 });

  test('до появления секции запросов к домену виджета нет', async ({ page }) => {
    const seen = await guard(page);
    const response = await page.goto(url('/'));
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
      toExactHost(seen.urls, REVIEWS_WIDGET_HOST),
      `к домену виджета обратились до появления секции: ${toExactHost(seen.urls, REVIEWS_WIDGET_HOST).join(', ')}`,
    ).toEqual([]);
  });

  test('появление секции подставляет встраивание', async ({ page }) => {
    const seen = await guard(page);
    await page.goto(url('/'));
    await page.locator(`[${SEL_REVIEWS_SECTION}]`).scrollIntoViewIfNeeded();
    await expect(
      page.locator(`[${SEL_REVIEWS_SECTION}] iframe`),
      'после появления секции встраивание не подставлено',
    ).toHaveCount(1);
    // `toHaveCount` резолвится, как только узел `<iframe>` появился в DOM — это происходит
    // синхронно внутри `load()`. Присвоение `iframe.src` порождает СЕТЕВОЙ запрос не
    // синхронно с этим: браузер планирует его отдельной задачей, и `seen.urls` заполняет
    // именно этот запрос через перехват Playwright. После снятия `rootMargin: 200px`
    // (наблюдатель срабатывает точно по факту видимости, а не заранее) окно между «узел
    // есть» и «запрос замечен перехватом» стало короче — измерено: обычный `expect`
    // сразу после `toHaveCount` терял гонку на CI (mobile, один прогон из нескольких).
    // `expect.poll` — не смягчение предмета проверки, а терпимость к этой реальной,
    // конечной по времени задержке; при нуле запросов по истечении таймаута тест всё
    // равно падает.
    await expect
      .poll(() => toExactHost(seen.urls, REVIEWS_WIDGET_HOST).length, {
        message: 'запроса к домену виджета не было',
      })
      .toBeGreaterThan(0);
  });

  test('появление виджета не сдвигает страницу', async ({ page }) => {
    // Ответ ФИКСИРОВАННОГО размера — первый из двух названных подставных ответов. На
    // живом ответе проверка зависела бы от того, сколько отзывов у организации сегодня, а
    // при блокировке запроса предмет исчезает вовсе: появления нет.
    await guard(page, { reviewsWidgetBody: FIXED_SIZE_WIDGET_BODY });
    await page.goto(url('/'));
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
      await guard(page, { reviewsWidgetBody: body });
      await page.goto(url('/'));
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

/**
 * Высота содержимого виджета, измеренная двоичным поиском по живому ответу сервиса
 * 2026-09-05: 1304 px при ширине 760, 1306 при 736, 1359 при 343. Здесь худшая из трёх —
 * ровно то число, которое стоит в `Reviews.astro`. Оно продублировано намеренно: гейт,
 * читающий число из проверяемого файла, зелен при любом его значении.
 */
const WIDGET_CONTENT_HEIGHT = 1359;

test.describe('встраивание занимает отведённое ему место', () => {
  test.describe.configure({ timeout: 60_000 });

  /**
   * Гейт РАСКЛАДКИ, и он обязан быть браузерным: сборка зелена и на сломанной вёрстке.
   * Предмет — НАША геометрия, а не содержимое виджета: `guard` не пускает запрос к
   * Яндексу, узел `<iframe>` при этом создаётся, и его коробку считает наш же CSS.
   * Третья сторона в прогон не попадает.
   *
   * Дефект, ради которого гейт написан: Astro метит разметку `data-astro-cid-…` и
   * переписывает под неё селекторы, а узел, созданный `document.createElement`, метки не
   * получает — `.reviews-embed iframe` до него не доходил. Измерено на стенде: 304×154
   * (браузерное умолчание, `display: inline`) внутри контейнера 1168×384. Ни один
   * существовавший гейт этого не видел, дефект нашёлся глазами по скриншоту.
   */
  for (const width of [1280, 375]) {
    test(`iframe заполняет свой контейнер на ${width}px`, async ({ page }) => {
      await guard(page);
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(url('/'));
      expect(response?.status(), 'главная не отдалась — проверять нечего').toBe(200);

      const box = page.locator('[data-reviews-embed]');
      await expect(box, 'контейнера встраивания нет — предмета нет').toHaveCount(1);
      await box.scrollIntoViewIfNeeded();

      const frame = box.locator('iframe');
      await expect(frame, 'после появления секции встраивание не подставлено').toHaveCount(1);

      const outer = await box.boundingBox();
      const inner = await frame.boundingBox();
      expect(outer, 'коробка контейнера не измерена').not.toBeNull();
      expect(inner, 'коробка встраивания не измерена').not.toBeNull();

      // Ширина — по контейнеру. Допуск 1px на субпиксельное округление, не больше:
      // дефект давал расхождение в 864px, и широкий допуск скрыл бы его.
      expect(
        Math.abs(inner!.width - outer!.width),
        `встраивание шириной ${inner!.width} в контейнере ${outer!.width}: стиль до него не дошёл`,
      ).toBeLessThanOrEqual(1);

      // Высота — не меньше контейнера: пустая серая полоса под встраиванием читается
      // как дефект, ради этого у контейнера и стоит min-height.
      expect(
        inner!.height,
        `встраивание высотой ${inner!.height} в контейнере ${outer!.height}`,
      ).toBeGreaterThanOrEqual(outer!.height - 1);

      // Блочность: `display: inline` — то самое умолчание, с которого дефект начался.
      const display = await frame.evaluate((el) => getComputedStyle(el).display);
      expect(display, 'встраивание осталось инлайновым').not.toBe('inline');

      // Высота — не меньше измеренной высоты содержимого виджета: при меньшей внутри
      // встраивания появляется собственная прокрутка сервиса, и из пяти отзывов виден один.
      // Так и было на стенде до 2026-09-05: контейнер 384 px против содержимого 1359.
      expect(
        inner!.height,
        `встраивание высотой ${inner!.height}: отзывы не помещаются, вернётся внутренняя прокрутка`,
      ).toBeGreaterThanOrEqual(WIDGET_CONTENT_HEIGHT);

      // Знак — СБОКУ от встраивания там, где колонки помещаются рядом, и НИЖЕ него, где не
      // помещаются. Прежняя редакция требовала общего левого края: знак стоял над виджетом и
      // читался как часть его содержимого. Утверждённый вариант C (владелец, 2026-09-05)
      // ставит его в правую колонку.
      const badge = page.locator('[data-award-row]');
      await expect(badge, 'строки знаков нет — сравнивать не с чем').toHaveCount(1);
      const badgeBox = await badge.boundingBox();
      expect(badgeBox, 'коробка строки знаков не измерена').not.toBeNull();
      if (width >= 1280) {
        expect(
          badgeBox!.x,
          `знак начинается на ${badgeBox!.x}, встраивание кончается на ${outer!.x + outer!.width}: ` +
            'колонки не разошлись по горизонтали',
        ).toBeGreaterThanOrEqual(outer!.x + outer!.width);
      } else {
        expect(
          badgeBox!.y,
          `знак на ${badgeBox!.y}, встраивание кончается на ${outer!.y + outer!.height}: ` +
            'на узкой ширине колонки не сложились в одну',
        ).toBeGreaterThanOrEqual(outer!.y + outer!.height);
      }
    });
  }
});

test.describe('без скриптов секция даёт ссылку, а не встраивание', () => {
  test('при отключённых скриптах виджета нет, ссылка есть', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      const seen = await installThirdPartyGuard(page, { chatLoaderSrc: PROBE_CHAT_LOADER_SRC });
      const response = await page.goto(url('/'));
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
      // Скоуп сужен до `.reviews-cta`: с объявленным знаком награды (TD-53) в секции
      // теперь ДВЕ законные ссылки на `yandex.ru` — noscript-ссылка на отзывы и
      // ссылка знака на карточку организации (`award-badge`). Предмет проверки — что
      // фолбэк без скриптов НА МЕСТЕ, а не что ссылка на этот хост ровно одна.
      const link = page.locator(`[${SEL_REVIEWS_SECTION}] a.reviews-cta[href*="${REVIEWS_WIDGET_HOST}"]`);
      await expect(link, 'без скриптов в секции нет ссылки на отзывы организации').toHaveCount(1);
      expect(
        toExactHost(seen.urls, REVIEWS_WIDGET_HOST),
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
    await page.goto(url('/'));
    const trigger = page.locator(`[${SEL_CHAT_TRIGGER}]`);
    await expect(trigger, 'нашей кнопки вызова чата в разметке нет').toHaveCount(1);
    await expect(trigger).toBeVisible();

    expect(seen.toHost(LOADER_HOST), 'сторонний загрузчик исполнился до нажатия').toEqual([]);

    // Доступность с клавиатуры проверяется ФОКУСОМ и доступным именем, а не наличием
    // `tabindex`: `div` с `tabindex` фокусируется, но по Enter ничего не делает.
    await trigger.focus();
    await expect(trigger, 'кнопка вызова не принимает фокус').toBeFocused();
    const name = await trigger.evaluate((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');
    expect(name.trim().length, 'у кнопки вызова нет доступного имени').toBeGreaterThan(0);
  });

  test('сторонних запросов до нажатия нет, и простой браузера триггером не является', async ({ page }) => {
    const seen = await guard(page);
    await page.goto(url('/'));
    await expect(page.locator(`[${SEL_CHAT_TRIGGER}]`), 'кнопки вызова нет — предмета нет').toHaveCount(1);

    // Простой браузера триггером НЕ является, и это проверяется временем: измерение
    // бюджетов производительности хука перехвата не имеет вовсе, простой внутри него
    // наступает, и «отложенный до простоя» скрипт исполнился бы там на всех четырёх
    // шаблонах против бюджета времени блокировки.
    await page.waitForLoadState('load');
    await page.waitForTimeout(4000);
    expect(
      seen.toHost(LOADER_HOST),
      'загрузчик исполнился без нажатия: простой браузера сработал как триггер',
    ).toEqual([]);
  });

  test('нажатие исполняет загрузчик, и фокус уходит внутрь появившегося интерфейса', async ({ page }) => {
    await guard(page);
    await page.goto(url('/'));
    const trigger = page.locator(`[${SEL_CHAT_TRIGGER}]`);
    await expect(trigger, 'кнопки вызова нет — нажимать нечего').toHaveCount(1);
    await trigger.focus();
    await trigger.click();

    // Место появления интерфейса портала НЕ документировано (справка Bitrix24 не
    // называет ни контейнер, ни метод узнать DOM-узел виджета), поэтому предметом
    // служит сам подставной интерфейс где угодно в документе, а не его положение
    // внутри `[data-chat-mount]` — этот контейнер несёт только нашу разметку.
    const panel = page.locator('[data-chat-stub-panel]');
    await expect(
      panel,
      'подставной интерфейс не появился: либо загрузчик не исполнился, либо наш код не ' +
        'вызвал widget.open() по документированному контракту (onBitrixLiveChat → ' +
        'subscribe(configLoaded) → open())',
    ).toHaveCount(1);

    const inside = await page.evaluate(() => {
      const panel = document.querySelector('[data-chat-stub-panel]');
      return panel !== null && document.activeElement !== null && panel.contains(document.activeElement);
    });
    expect(
      inside,
      'фокус не внутри появившегося интерфейса: уничтожение элемента с фокусом уводит его ' +
        'в начало документа',
    ).toBe(true);
  });

  test('загрузчик не ответил — панель не появляется, а телефоны в подвале видны', async ({ page }) => {
    // Наша гарантия при неответившем стороннем загрузчике — подвал, и только он. Прежняя
    // редакция спеки обещала здесь ещё и часы работы; сужение названо ею прямо.
    await guard(page, { chatLoaderBody: '' });
    await page.goto(url('/'));
    const trigger = page.locator(`[${SEL_CHAT_TRIGGER}]`);
    await expect(trigger, 'кнопки вызова нет — предмета нет').toHaveCount(1);
    await trigger.click();
    await page.waitForTimeout(1000);
    await expect(
      page.locator('[data-chat-stub-panel]'),
      'панель появилась при пустом ответе загрузчика — значит рисуем её мы, а не сторона',
    ).toHaveCount(0);
    await expect(
      page.locator('footer a[href^="tel:"]').first(),
      'телефона в подвале нет: единственная гарантия при неответившем загрузчике потеряна',
    ).toBeVisible();
  });

  test('часы работы на обычной странице узнать нельзя, и это известное отклонение', async ({ page }) => {
    // Наблюдаемая часть сценария: вне страниц контактов и оплаты блока часов нет, а
    // панель без ответа загрузчика не появляется — значит часы узнать нечем. Запись
    // известного отклонения проверяется отдельно, по `docs/tech-debt.md`
    // (`tests/external-widgets-guard.test.ts`): наблюдение без записи читалось бы как
    // выполненное требование.
    await guard(page, { chatLoaderBody: '' });
    await page.goto(url('/'));
    await expect(
      page.locator(`[${MANAGER_HOURS_ATTR}="${MANAGER_HOURS_VALUE}"]`),
      'на главной появился блок часов работы менеджера: спека такой блок запрещает — он не ' +
        'нарисован ни в одном утверждённом варианте',
    ).toHaveCount(0);
    await expect(page.locator(`[${SEL_CHAT_FACADE}]`), 'фасада чата нет — предмета нет').toHaveCount(1);
  });
});

// ─── Различение счётчиков ────────────────────────────────────────────────────

test.describe('наша и чужая аналитика различены по идентификатору счётчика', () => {
  test('перехват видит оба счётчика и различает их идентификатором в адресе пикселя', async ({ page }) => {
    // Подставной ответ ЗДЕСЬ — второй из двух названных: тот, что несёт пиксель чужого
    // счётчика. Живого ответа в прогонах нет по требованию о перехвате, значит пиксель
    // обязан прийти из подставного ответа, и какой именно ответ его несёт — часть
    // контракта, а не деталь.
    const seen = await guard(page, { reviewsWidgetBody: WIDGET_BODY_WITH_FOREIGN_PIXEL });
    await page.goto(url('/'));
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

  test('первый подставной ответ чужого счётчика НЕ несёт, и признак это видит', async ({ page }) => {
    // Обратная сторона: два подставных ответа обязаны различаться наблюдаемо, иначе
    // «используется один из двух названных» ничего не значит. Ответ фиксированного
    // размера пикселя не несёт — значит чужого идентификатора в перехвате нет.
    const seen = await guard(page, { reviewsWidgetBody: FIXED_SIZE_WIDGET_BODY });
    await page.goto(url('/'));
    await page.locator(`[${SEL_REVIEWS_SECTION}]`).scrollIntoViewIfNeeded();
    await expect(page.locator(`[${SEL_REVIEWS_SECTION}] iframe`)).toHaveCount(1);
    await page.waitForTimeout(4000);
    expect(
      seen.counterIds(),
      'чужой счётчик пришёл из ответа, который его не несёт — значит признак смотрит не на ' +
        'пиксель подставного ответа',
    ).not.toContain(FOREIGN_METRIKA_ID);
  });

  test('идентификатора чужого счётчика в нашей разметке нет вовсе', async ({ page }) => {
    // Отсюда и следует, что различение НЕ ищется в выводе сборки: предмета там нет, и
    // проверка по разметке была бы непройденной, а не пройденной.
    await guard(page, { reviewsWidgetBody: WIDGET_BODY_WITH_FOREIGN_PIXEL });
    await page.goto(url('/'));
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

  test('наши части секции и наша кнопка вызова без critical/serious', async ({ page }) => {
    // Предмет — НАШИ части: заголовок, ссылка, знаки наград, подпись и кнопка вызова
    // чата. Предыдущая редакция этой проверки требовала внутри себя блок часов работы как
    // доказательство непустоты, и с его снятием стала НЕИСПОЛНИМОЙ при живом требовании.
    // Непустота теперь доказывается тем, что предмет и есть: встраивание на месте и наша
    // кнопка на месте.
    await guard(page);
    await page.goto(url('/'));
    await page.locator(`[${SEL_REVIEWS_SECTION}]`).scrollIntoViewIfNeeded();
    await expect(page.locator(`[${SEL_REVIEWS_SECTION}] iframe`), 'встраивания нет — предмета нет').toHaveCount(1);
    await expect(page.locator(`[${SEL_CHAT_TRIGGER}]`), 'нашей кнопки вызова нет — предмета нет').toHaveCount(1);

    // ── ПРЕДМЕТ СУЖЕН ДО НАШИХ ЧАСТЕЙ, И ЭТО ПО ТРЕБОВАНИЮ, А НЕ ДЛЯ СКОРОСТИ ──
    // Требование говорит: «НАШИ части секции отзывов — заголовок, ссылка, знаки наград,
    // подпись — и НАША кнопка вызова чата SHALL не иметь нарушений». Значит предмет —
    // именно эти два поддерева, а не страница целиком: доступность страницы стережёт
    // существующий гейт `a11y.spec.ts`, и второй проход по тому же предмету дал бы две
    // проверки над одним предметом.
    //
    // Цена этого выбора измерена, и она не косметическая: проход axe по ВСЕЙ странице
    // (6063 px) на этом наборе шёл **16,4 минуты** при объявленном таймауте 60 с — то есть
    // таймаут его не прерывал, и в обязательном прогоне такой шаг встал бы поперёк всего
    // джоба. Сужение до наших поддеревьев возвращает проход в секунды.
    //
    // Исключается ТОЛЬКО сам сторонний iframe и то, что загрузчик создаёт ВНУТРИ
    // объявленной нами точки монтирования. Ни секция, ни наша кнопка вызова из проверки
    // не выходят: признак — НАШЕ имя контейнера, потому что происхождение узла селектором
    // не выражается, а чужой класс сторона вправе переименовать.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .include(`[${SEL_REVIEWS_SECTION}]`)
      .include(`[${SEL_CHAT_TRIGGER}]`)
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
    await page.goto(url('/'));
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
    await page.goto(url('/'));
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

  // TD-52 (docs/tech-debt.md): на ширине 375px кнопка реально перекрывает нижний контент
  // этих шаблонов (карточка семинара, ссылка tel:, карточки статей, `<select>` города,
  // карточка модуля программы) — не тестовый дефект и не сторонний баг, замерено
  // `getBoundingClientRect`. Признано известным отклонением владельцем: точечного фикса
  // нет (сдвиг кнопки требует поведения на скролле, которого нет в спеке; правка чужой
  // вёрстки — редизайн, а не фикс кнопки). Список — по факту двух прогонов CI, а не по
  // старой таблице в docs/handoff (та писалась до расширения TEMPLATES и называла 5 из
  // прежних 11, не семь из текущих). Desktop эта проверка по-прежнему покрывает —
  // пропускается только mobile-проект и только эти шаблоны.
  const KNOWN_MOBILE_OVERLAP = new Set([
    'home',
    'course',
    'seminar',
    'seminar-dated',
    'kontakty',
    'statyi',
    'raspisanie',
  ]);

  for (const { name, path } of TEMPLATES) {
    test(`${name}: закрытая кнопка не накрывает интерактивные элементы и текст`, async ({ page }, testInfo) => {
      if (testInfo.project.name === 'mobile' && KNOWN_MOBILE_OVERLAP.has(name))
        test.skip(true, `TD-52: известное отклонение — кнопка чата перекрывает контент шаблона '${name}' на 375px`);

      await guard(page);
      const response = await page.goto(url(path));
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

        // Закрытый `<details>` не прячет содержимое через display/visibility САМОГО
        // потомка — это признак ПРЕДКА. У `.topnav-drawer` (мобильное меню, TopNav.astro,
        // не тронут этим change) `position: absolute` выводит его геометрию из-под
        // схлопывания, которым браузер прячет закрытый details: getBoundingClientRect
        // потомков остаётся настоящим и ненулевым, хотя пользователь их не видит и не
        // может нажать. Без этой проверки хит-тест ловит фантомное перекрытие с любым
        // новым фиксированным элементом на мобильном — независимо от того, что нового
        // элемента касается.
        const insideClosedDetails = (el: Element): boolean => {
          let node: Element | null = el;
          while (node !== null) {
            if (node.tagName === 'DETAILS' && !(node as HTMLDetailsElement).open) return true;
            node = node.parentElement;
          }
          return false;
        };

        const interactive: string[] = [];
        for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"]')) {
          if (button.contains(el) || el.contains(button)) continue;
          if (insideClosedDetails(el)) continue;
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
          if (insideClosedDetails(p)) continue;
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
    await page.goto(url('/'));
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
