import { test, expect, type Browser } from '@playwright/test';
import { installThirdPartyGuard } from './helpers/third-party-guard';
import { serveStatic, type StaticSite } from './helpers/static-serve';
import { PROBE_CHAT_LOADER_SRC, buildProbe } from './helpers/widget-probe-build';
import {
  BUILD_YEAR_KEY,
  CHAT_LOADER_KEY,
  SEL_AWARD_BADGE,
  SEL_AWARD_ROW,
  SEL_REVIEWS_SECTION,
} from './helpers/external-widgets';

/**
 * Тесты по спеке change `external-widgets` — ДАТОЗАВИСИМЫЙ ФРАГМЕНТ: строка знаков наград.
 *
 * ── ПОЧЕМУ ДВЕ СБОРКИ, А НЕ ДВА МОМЕНТА ─────────────────────────────────────
 * Требование это называет прямо: «проверка идёт на ДВУХ СБОРКАХ, различающихся
 * `BUILD_YEAR`: год знака берётся из конфигурации сборки, потому что механизма подмены
 * системных часов сборки в репозитории нет». Состав знаков вычисляется НА СБОРКЕ и от часа
 * показа не зависит вовсе — значит подстановка момента в браузер его не меняет, и прежняя
 * редакция этих тестов, менявшая час и год у `page.clock`, проверяла несуществующую
 * зависимость.
 *
 * Обязательный положительный контроль — «состав знаков в этих сборках РАЗЛИЧАЕТСЯ». Без
 * него исключение фрагмента и совпадение рамок проверены на предмете, где различия и не
 * было, то есть проверка зелена на любом коде.
 *
 * ── ЧТО ИМЕННО ИЗМЕРЯЕТСЯ, И ПОЧЕМУ ДВУХ ИЗМЕРЕНИЙ МАЛО ПО ОТДЕЛЬНОСТИ ──────
 * Способ у требования ДВОЙНОЙ: явное исключение фрагмента из сравнения облика ПЛЮС
 * независимая от состава знаков рамка. Одного исключения недостаточно, и причина измерима:
 * строка знаков при нуле знаков не рендерится вовсе, значит между сборкой со знаком и
 * сборкой без него меняется высота секции, а содержимое ниже сдвигается — ВНЕ
 * замаскированной области, и маска этого не скрывает по своему определению. Поэтому
 * измеряется рамка строки И рамка следующего за ней элемента.
 *
 * Цена: две пробные сборки по 6,3 с. Устройство — в шапке
 * `tests/helpers/widget-probe-build.ts`.
 */

interface Measured {
  readonly image: Buffer;
  readonly badges: number;
  readonly badgePresentations: readonly BadgePresentation[];
  readonly rowRect: Rect | null;
  readonly nextRect: Rect | null;
}

interface BadgePresentation {
  readonly provider: string | null;
  readonly iconCount: number;
  readonly iconRect: Rect | null;
  readonly iconSvgRect: Rect | null;
  readonly iconBackground: string | null;
  readonly badgeBackground: string | null;
  readonly badgeBoxShadow: string | null;
  readonly title: string | null;
  readonly titleRect: Rect | null;
  readonly source: string | null;
  readonly sourceRect: Rect | null;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Путь модуля данных лежит в ПЕРЕМЕННОЙ, а не в литерале импорта: у литерала `astro check`
 * требует существования модуля, и отсутствие реализации давало бы красный гейт типов
 * вместо красного теста.
 */
const BADGES_MODULE = '../src/lib/award-badges';

/** Год действия знаков, объявленный в данных. Нет данных — предмета нет. */
async function declaredBadgeYear(): Promise<number> {
  let mod: { DECLARED_AWARD_BADGES?: { year?: unknown }[] };
  try {
    mod = (await import(BADGES_MODULE)) as typeof mod;
  } catch (error) {
    throw new Error(
      `модуля данных знаков нет либо он не загружается: ${(error as Error).message}. Год ` +
        'знака берётся из объявления, а не выдумывается проверкой: иначе положительный ' +
        'контроль «состав знаков различается» недостижим',
      { cause: error },
    );
  }
  const years = (mod.DECLARED_AWARD_BADGES ?? [])
    .map((b) => b.year)
    .filter((y): y is number => typeof y === 'number');
  if (years.length === 0)
    throw new Error(
      'в данных не объявлено ни одного знака с годом действия: состав знаков не изменится ни ' +
        'от какого `BUILD_YEAR`, и положительный контроль построить нечем. Это «измерить не ' +
        'удалось», а не «различий нет»',
    );
  return Math.min(...years);
}

async function measure(browser: Browser, site: StaticSite): Promise<Measured> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  // Утверждённый референс `home-1280d-02-reviews-block.png` снят в тёмной теме.
  // Значение ставится до первого скрипта страницы, чтобы HeadMeta применил тему без
  // промежуточного светлого кадра.
  await context.addInitScript(() => localStorage.setItem('ikpk.theme', 'dark'));
  const page = await context.newPage();
  try {
    await installThirdPartyGuard(page, { chatLoaderSrc: PROBE_CHAT_LOADER_SRC });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const response = await page.goto(`${site.origin}/`);
    expect(response?.status(), 'главная пробной сборки не отдалась — измерять нечего').toBe(200);
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.locator(`[${SEL_REVIEWS_SECTION}]`),
      'секции отзывов в пробной сборке нет — предмета нет',
    ).toHaveCount(1);

    const badges = await page.locator(`[${SEL_AWARD_BADGE}]`).count();
    const rects = await page.evaluate(
      ({ rowAttr, badgeAttr }) => {
        const round = (r: DOMRect) => ({
          x: Math.round(r.x),
          y: Math.round(r.y + window.scrollY),
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
        const row = document.querySelector(`[${rowAttr}]`);
        const badgePresentations = Array.from(document.querySelectorAll(`[${badgeAttr}]`)).map(
          (badge) => {
            const icons = badge.querySelectorAll('[data-award-icon]');
            const iconSvg = icons[0]?.querySelector('svg');
            const title = badge.querySelector('[data-award-title]');
            const source = badge.querySelector('[data-award-source]');
            const iconStyle = icons[0] instanceof Element ? getComputedStyle(icons[0]) : null;
            const badgeStyle = getComputedStyle(badge);
            return {
              provider: badge.getAttribute('data-award-provider'),
              iconCount: icons.length,
              iconRect: icons[0] instanceof Element ? round(icons[0].getBoundingClientRect()) : null,
              iconSvgRect: iconSvg instanceof Element ? round(iconSvg.getBoundingClientRect()) : null,
              iconBackground: iconStyle?.backgroundColor ?? null,
              badgeBackground: badgeStyle.backgroundColor,
              badgeBoxShadow: badgeStyle.boxShadow,
              title: title?.textContent?.trim() ?? null,
              titleRect: title instanceof Element ? round(title.getBoundingClientRect()) : null,
              source: source?.textContent?.trim() ?? null,
              sourceRect: source instanceof Element ? round(source.getBoundingClientRect()) : null,
            };
          },
        );
        if (row === null) return { row: null, next: null, badgePresentations };
        const next = row.nextElementSibling;
        return {
          row: round(row.getBoundingClientRect()),
          next: next === null ? null : round(next.getBoundingClientRect()),
          badgePresentations,
        };
      },
      { rowAttr: SEL_AWARD_ROW, badgeAttr: SEL_AWARD_BADGE },
    );

    const image = await page.screenshot({
      fullPage: true,
      animations: 'disabled',
      // ЯВНОЕ исключение фрагмента — вторая ветвь «либо» у `visual-regression-gate`.
      // Первая ветвь (не включать блок в манифест) непригодна: она вычеркнула бы из
      // покрытия секцию отзывов целиком.
      mask: [page.locator(`[${SEL_AWARD_ROW}]`)],
    });
    return {
      image,
      badges,
      badgePresentations: rects.badgePresentations,
      rowRect: rects.row,
      nextRect: rects.next,
    };
  } finally {
    await context.close();
  }
}

test.describe('датозависимый фрагмент — строка знаков наград', () => {
  // Прогон идёт на ОДНОМ разрешении, и отбор сделан НЕ здесь, а в скрипте пакета
  // (`test:e2e:widgets` вызывает этот файл только с `--project=desktop`). Предмет —
  // зависимость облика от года сборки, а не адаптивность; второе разрешение удвоило бы две
  // пробные сборки, ничего не добавив.
  test.describe.configure({ timeout: 15 * 60 * 1000, mode: 'serial' });

  let current: Measured;
  let next: Measured;

  test.beforeAll(async ({ browser }, testInfo) => {
    // `describe.configure({ timeout })` выше governит таймаут ТЕСТОВ, а не `beforeAll`:
    // хук держит собственный таймаут (умолчание конфига — 10с, `playwright.config.ts:16`),
    // и до снятия `.skip` с этого файла (TD-53) обе пробные сборки внутри него ни разу не
    // запускались — несовпадение обнаружилось только сейчас, при первом реальном прогоне.
    testInfo.setTimeout(15 * 60 * 1000);
    const year = await declaredBadgeYear();
    // `keepOnDisk`: оба дерева надо раздавать браузеру. Убираются здесь же, в `finally`:
    // одна пробная сборка занимает 91 МБ, и забытые каталоги за сессию съели 5,4 ГБ,
    // прежде чем это было замечено — диск кончился посреди прогона.
    const built = [
      buildProbe(
        `${BUILD_YEAR_KEY}=${year}`,
        { [BUILD_YEAR_KEY]: String(year), [CHAT_LOADER_KEY]: PROBE_CHAT_LOADER_SRC },
        { keepOnDisk: true },
      ),
      buildProbe(
        `${BUILD_YEAR_KEY}=${year + 1}`,
        { [BUILD_YEAR_KEY]: String(year + 1), [CHAT_LOADER_KEY]: PROBE_CHAT_LOADER_SRC },
        { keepOnDisk: true },
      ),
    ];
    try {
      const sites = await Promise.all(built.map((b) => serveStatic(b.root!)));
      try {
        current = await measure(browser, sites[0]);
        next = await measure(browser, sites[1]);
      } finally {
        await Promise.all(sites.map((s) => s.close()));
      }
    } finally {
      built.forEach((b) => b.dispose());
    }
  });

  test('состав знаков в двух сборках РАЗЛИЧАЕТСЯ', async () => {
    // Положительный контроль обоих сценариев ниже, и он идёт первым намеренно: если
    // `BUILD_YEAR` до сборки не доезжает, состав одинаков, и оба сценария зелены на
    // предмете, где различия нет.
    expect(
      current.badges,
      `при годе сборки, равном году знаков, знаков показано ${current.badges}: строка знаков ` +
        'не отрендерена вовсе, и различать нечего',
    ).toBeGreaterThan(0);
    expect(
      next.badges,
      `при следующем годе сборки показано ${next.badges} знаков: знак не протухает, и ` +
        'зависимость от года не наблюдаема`',
    ).toBe(0);
  });

  test('знак соответствует утверждённому мокапу: сервисная иконка и две строки текста', async () => {
    expect(current.badges, 'в сборке нет показанного знака — проверка облика вакуумна').toBeGreaterThan(0);
    expect(current.badgePresentations).toHaveLength(current.badges);

    const badge = current.badgePresentations[0];
    expect(badge.provider).toBe('yandex-maps');
    expect(badge.iconCount, 'у знака нет ровно одной сервисной иконки').toBe(1);
    expect(badge.title, 'название знака не выделено в отдельную строку').toBe('Хорошее место 2026');
    expect(badge.source, 'источник знака не выведен отдельной строкой').toBe('Яндекс Карты');
    expect(badge.iconRect, 'рамка сервисной иконки не измерена').not.toBeNull();
    expect(badge.titleRect, 'рамка названия знака не измерена').not.toBeNull();
    expect(badge.sourceRect, 'рамка подписи источника не измерена').not.toBeNull();
    expect(badge.iconSvgRect, 'рамка SVG внутри подложки не измерена').not.toBeNull();

    expect(badge.iconRect, 'подложка иконки не 26×26 px, как в утверждённом мокапе').toMatchObject({
      width: 26,
      height: 26,
    });
    expect(badge.iconSvgRect, 'сама иконка не 18×18 px, как в утверждённом мокапе').toMatchObject({
      width: 18,
      height: 18,
    });
    expect(badge.iconBackground, 'у иконки нет серой подложки variant E').toBe('rgb(245, 246, 247)');
    expect(badge.badgeBackground, 'чип не остаётся белым в тёмной теме').toBe('rgb(255, 255, 255)');
    expect(badge.badgeBoxShadow, 'у чипа пропала лёгкая тень variant E').toContain(
      'rgba(0, 0, 0, 0.04)',
    );

    expect(badge.iconRect!.x + badge.iconRect!.width, 'иконка не стоит слева от текста').toBeLessThanOrEqual(
      badge.titleRect!.x,
    );
    expect(badge.sourceRect!.y, 'подпись источника не находится ниже названия').toBeGreaterThanOrEqual(
      badge.titleRect!.y + badge.titleRect!.height,
    );
  });

  test('смена года сборки не краснит сравнение облика', async () => {
    expect(current.badges).not.toBe(next.badges);
    expect(
      next.image.equals(current.image),
      'снимки двух сборок, различающихся годом сборки, не совпали при явно исключённой ' +
        'строке знаков: значит зависимость НЕ ограничена фрагментом — при нуле знаков строка ' +
        'не рендерится, высота секции меняется, и сдвиг соседей уходит за пределы маски',
    ).toBe(true);
  });

  test('рамка строки знаков и рамка следующего за ней элемента не зависят от состава', async () => {
    // Центральный SHALL требования: строка знаков SHALL иметь рамку, не зависящую от
    // состава знаков внутри неё. Предмет измерения — рамка строки И рамка следующего за
    // ней элемента: строка стоит в обычном потоке секции, поэтому сдвиг соседа и есть то,
    // что рамка обязана предотвратить.
    expect(current.badges).not.toBe(next.badges);
    expect(
      current.rowRect,
      `строки знаков '${SEL_AWARD_ROW}' нет в сборке с показанными знаками — измерять нечего`,
    ).not.toBeNull();
    expect(
      next.rowRect,
      `строки знаков '${SEL_AWARD_ROW}' нет в сборке БЕЗ знаков: именно это и означает ` +
        '«рамка зависит от состава» — при нуле знаков строка не отрендерилась, высота секции ' +
        'изменилась, и сдвиг ушёл вне маски',
    ).not.toBeNull();
    expect(next.rowRect, 'рамка строки знаков разошлась между сборками').toEqual(current.rowRect);

    expect(
      current.nextRect,
      'после строки знаков нет ни одного элемента — сдвиг соседа измерять нечем, а именно им ' +
        'доказывается, что зависимость ограничена фрагментом',
    ).not.toBeNull();
    expect(next.nextRect, 'сосед ниже строки знаков сместился').toEqual(current.nextRect);
  });
});
