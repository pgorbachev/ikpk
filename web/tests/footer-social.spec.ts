/**
 * Подача внешних аккаунтов в подвале — БРАУЗЕРНЫЕ проверки.
 *
 * Источник требований — change `social-accounts`, `specs/social-accounts/spec.md`:
 *  - «Аккаунт обозначается официальной маркой в фирменных цветах», сценарий «марка сети
 *    показана» — в части, наблюдаемой по выводу. Две части того же требования по выводу НЕ
 *    наблюдаются и проверяются сверкой файла марки с зафиксированным хешем (Requirement
 *    «Решение о применимости марки зафиксировано в машиночитаемом реестре», `design.md`,
 *    Решения 17 и 18): происхождение марки и оправа, встроенная в саму разметку марки.
 *    Сверка появится вместе с файлами марок и реестром, то есть при реализации;
 *  - «Доступное имя ссылки равно названию сети», оба сценария;
 *  - «Ссылка-иконка достижима указателем и клавиатурой», оба сценария;
 *  - «Марка различима на фоне подвала в каждой теме», сценарий «контраст в каждой теме»;
 *  - «Youtube и Rutube отличимы друг от друга», сценарий «цвета двух марок различаются»;
 *  - «Подвал сохраняет раскладку», сценарий «число дорожек на каждой полосе».
 *
 * ПОЧЕМУ ЭТИ ПРОВЕРКИ КРАСНЫЕ СЕЙЧАС: подвал отдаёт соцсети текстовыми ссылками
 * (`web/src/components/Footer.astro:49`, `<ul class="footer-links footer-social">`), марок
 * в нём нет ни одной, поэтому нет ни `<svg>`, ни доминирующей заливки, ни контраста
 * графики. Раскладка при этом уже соответствует требованию — эта проверка зелёная по
 * замыслу и охраняет её от бесшумной перестройки.
 *
 * АДРЕСА — КАНОНИЧЕСКИЕ, без слэша на конце: `tests/e2e-addresses.test.ts` ловит любой
 * литерал-адрес, являющийся источником редиректа, и покраснел бы раньше предмета.
 *
 * ПРОВЕРКИ ПОДТВЕРЖДАЮТ, ЧТО СТРАНИЦА ОТДАЛАСЬ. Этот класс ошибки в проекте уже был:
 * гейт axe разбирал страницу 404 на 10 шаблонах из 14 и был зелёным, потому что на
 * маленькой странице ошибки нарушений нет.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contrastRatio,
  parseRgb,
  deltaE76,
  dominantOpaqueRgb,
  COLOR_DISTANCE_THRESHOLD,
} from './helpers/contrast';
import { ACCEPTED_ACCOUNTS, SOCIAL_COLUMN_HEADING, networksRequiringMark } from './helpers/social-accounts-contract';
import { SOCIAL_MARKS_REGISTRY, hasContrastWaiver } from '../src/lib/social-marks-registry';

const MARK_ACCOUNTS = ACCEPTED_ACCOUNTS.filter((account) =>
  networksRequiringMark(
    SOCIAL_MARKS_REGISTRY,
    ACCEPTED_ACCOUNTS.map((a) => a.name),
  ).includes(account.name),
);

const PAGE = '/';

/**
 * Поддерживаемые темы выводятся ИЗ ТОКЕНОВ, а не перечисляются здесь константой.
 *
 * Это НОРМАТИВНОЕ правило, а не признак, выбранный тестом. Спека, Requirement «Марка
 * различима на фоне подвала в каждой теме»: «тема по умолчанию плюс каждое значение
 * атрибута темы, для которого в общем файле токенов переопределены цветовые токены»
 * (`design.md`, Решение 20). Прежняя редакция правила не называла — это был ДЕФЕКТ-7
 * разбора, — и тогда признак был решением исполнителя; сейчас он совпадает с требованием.
 *
 * Появление третьей темы расширит проверку само; пустой перечень невозможен, потому что
 * тема по умолчанию есть всегда, а отсутствие файла токенов роняет чтение.
 *
 * Граница признака названа: селектор `:root[data-theme='…']` отбирается независимо от того,
 * какие именно токены он переопределяет. Сегодня разницы нет — единственный такой блок
 * переопределяет цветовые токены, — но тема, переопределяющая, скажем, только размеры,
 * попала бы в перечень зря. Это осознанный размен: лишняя тема даёт лишнюю проверку, а
 * пропущенная — необнаруженный дефект контраста.
 */
function supportedThemes(): Array<string | null> {
  const tokens = readFileSync(join(import.meta.dirname, '..', 'src', 'styles', 'tokens.css'), 'utf-8');
  const named = [...new Set([...tokens.matchAll(/:root\[data-theme=['"]([^'"]+)['"]\]/g)].map((m) => m[1]!))];
  expect(named.length, 'в токенах не найдено ни одной именованной темы — перечень тем пуст').toBeGreaterThan(0);
  return [null, ...named];
}

async function openFooter(page: Page): Promise<{ footer: Locator; column: Locator }> {
  const response = await page.goto(PAGE);
  expect(
    response?.status(),
    `${PAGE}: страница не отдалась — проверялась бы страница ошибки, а не подвал`,
  ).toBe(200);

  const footer = page.getByRole('contentinfo');
  await expect(footer, 'на странице нет элемента роли contentinfo — подвала нет').toHaveCount(1);
  // Без прокрутки elementFromPoint по центру цели даёт null — подвал ниже первого экрана.
  await footer.scrollIntoViewIfNeeded();

  // Колонка отбирается по ЗАГОЛОВКУ, а не по имени CSS-класса: колонка названа самим
  // требованием о раскладке, класс — деталь реализации, которую эта работа и меняет.
  const heading = footer.getByRole('heading', { name: SOCIAL_COLUMN_HEADING, exact: true });
  await expect(heading, `в подвале нет заголовка «${SOCIAL_COLUMN_HEADING}»`).toHaveCount(1);
  return { footer, column: heading.locator('xpath=..') };
}

async function setTheme(page: Page, theme: string | null): Promise<void> {
  await page.evaluate((value) => {
    if (value === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  }, theme);
}

test.describe('подвал: состав и подача внешних аккаунтов', () => {
  test('в колонке аккаунтов ровно принятый состав', async ({ page }) => {
    const { column } = await openFooter(page);
    const hrefs = await column.getByRole('link').evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).getAttribute('href') ?? ''),
    );
    expect(hrefs, 'в колонке аккаунтов не принятый состав').toEqual(
      ACCEPTED_ACCOUNTS.map((a) => a.href),
    );
  });

  /**
   * Сценарий «марка сети показана» после его сужения спекой: маркой обязан быть обозначен
   * каждый аккаунт, для которого реестр применимости НЕ называет исход «текстовая ссылка».
   *
   * ПОЧЕМУ ЗДЕСЬ ПО-ПРЕЖНЕМУ ВСЕ ЧЕТЫРЕ, И ЭТО НЕ ОБХОД ТРЕБОВАНИЯ. Реестр применимости —
   * продуктовый файл `web/src/lib/social-marks-registry.ts`, который создаёт реализация
   * (`design.md`, Решение 18); на этой голове его нет, а `web/src/**` сессия тестов не
   * трогает. Пустой реестр ни для одной сети исход «текстовая ссылка» не называет — значит
   * требование о марке действует для всех четырёх, и «все четыре» есть в точности то же
   * требование, вычисленное на текущем состоянии реестра, а не ослабленное.
   *
   * Читать реестр отсюда уже сейчас нельзя, и это ИЗМЕРЕНО, а не предположено: литеральный
   * `await import('../src/lib/social-marks-registry.js')` роняет обязательный гейт
   * `npm run typecheck` — `ts(2307)`, 1 error из 289 файлов, — а импорт по вычисленному
   * спецификатору гейт проходит (0 errors), но заводит ветвь, которую сегодня нечем пройти:
   * загружать нечего, и под загрузчиком Playwright она не проверена вовсе. Непройденная
   * ветвь — такое же обещание, как непроверенный гейт.
   *
   * ЧТО ЗАСТАВИТ УЖЕСТОЧИТЬ ПРОВЕРКУ — не этот комментарий, а мета-гейт «как только реестр
   * появится, браузерная проверка обязана его читать» в `tests/social-accounts.test.ts`. Он
   * покраснеет в тот момент, когда модуль реестра появится, а этот файл его всё ещё не
   * читает: тогда перечень сетей берётся из `networksRequiringMark(...)`.
   */
  test('каждый аккаунт обозначен маркой, а не текстом', async ({ page }) => {
    const { column } = await openFooter(page);
    const withoutMark: string[] = [];
    for (const account of MARK_ACCOUNTS) {
      const link = column.locator(`a[href="${account.href}"]`);
      if ((await link.count()) === 0) {
        withoutMark.push(`${account.name}: ссылки нет вовсе`);
        continue;
      }
      const marks = await link.locator('svg').count();
      if (marks === 0) withoutMark.push(`${account.name}: внутри ссылки нет марки (svg)`);
    }
    expect(
      withoutMark,
      `подача аккаунта не марочная:\n${withoutMark.join('\n')}\n` +
        'Исключения — сети, для которых реестр применимости называет исход «текстовая ссылка» ' +
        '(web/src/lib/social-marks-registry.ts); перечень берётся из networksRequiringMark(...).',
    ).toEqual([]);
  });

  /**
   * Запрет ЕДИНОЙ посторонней оправы. Требование теперь само делит запрет на два признака с
   * разными способами проверки, и делит потому, что у второго объективного признака по
   * выводу нет:
   *
   *  - CSS-декорация вокруг марки — добавленное стилями украшение (фон, рамка, скругление)
   *    на элементах между `<a>` и `<svg>`, одинаковое у всех четырёх. ЭТО проверяет данный
   *    тест: признак наблюдаем в выводе;
   *  - оправа, ВСТРОЕННАЯ В САМУ РАЗМЕТКУ марки, «объективного признака по выводу не имеет
   *    — это проверяется тем же способом, что происхождение марки», то есть сверкой файла
   *    марки с зафиксированным в реестре хешем, а не отдельной проверкой (Решения 17, 18).
   *    Здесь она не проверяется и проверяться не может: оправа, нарисованная одинаково
   *    внутри четырёх SVG, от собственной плашки правообладателя по выводу неотличима.
   *
   * Прежде это расхождение теста с прозой требования было ДЕФЕКТ-5 разбора — требование
   * запрещало больше, чем поддавалось проверке. Спека выбрала первый из двух предложенных
   * разбором исходов: признала границу вслух и назвала способ для второй части. То есть
   * дефект закрыт признанием, а не новым измерением, и предмет теста от этого не изменился —
   * изменилось то, что он больше не выглядит неполной проверкой всего запрета.
   */
  test('вокруг марок нет единой посторонней оправы', async ({ page }) => {
    const { column } = await openFooter(page);
    const signatures: string[] = [];
    for (const account of MARK_ACCOUNTS) {
      const link = column.locator(`a[href="${account.href}"]`);
      if ((await link.count()) === 0) continue;
      signatures.push(
        await link.evaluate((node) => {
          const parts: string[] = [];
          const walk = (el: Element): void => {
            if (el.tagName.toLowerCase() === 'svg') return;
            const s = getComputedStyle(el);
            const decorated =
              (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') ||
              parseFloat(s.borderTopWidth) > 0 ||
              s.borderTopLeftRadius !== '0px';
            if (decorated) {
              parts.push(`${s.backgroundColor}|${s.borderTopWidth} ${s.borderTopStyle}|${s.borderTopLeftRadius}`);
            }
            for (const child of Array.from(el.children)) walk(child);
          };
          walk(node);
          return parts.join(';');
        }),
      );
    }
    expect(signatures.length, 'ни одной ссылки на аккаунт не найдено — проверять было нечего').toBe(
      MARK_ACCOUNTS.length,
    );
    const decorated = signatures.filter((s) => s !== '');
    const identical = decorated.length === MARK_ACCOUNTS.length && new Set(decorated).size === 1;
    expect(
      identical,
      `вокруг всех четырёх марок одинаковое добавленное украшение — это единая оправа: ${signatures[0]}`,
    ).toBe(false);
  });

  test('доступное имя ссылки точно равно названию сети', async ({ page }) => {
    const { column } = await openFooter(page);
    for (const account of ACCEPTED_ACCOUNTS) {
      const link = column.locator(`a[href="${account.href}"]`);
      await expect(link, `нет ссылки на ${account.name}`).toHaveCount(1);
      await expect(link, `доступное имя ссылки на ${account.name} не равно названию сети`).toHaveAccessibleName(
        account.name,
      );
    }
  });

  test('автоматическая проверка доступности не находит нарушений имени ссылки в подвале', async ({ page }) => {
    await openFooter(page);
    const results = await new AxeBuilder({ page })
      .include('footer')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    // Перечисляем ВСЕ нарушения подвала, но требование — про имя ссылки, поэтому имя
    // правила названо: иначе проверка молча расширилась бы на чужой предмет.
    const linkName = results.violations.filter((v) => v.id === 'link-name');
    expect(
      linkName.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      'axe нашёл нарушения правила о имени ссылки в подвале',
    ).toEqual([]);
  });

  test('область нажатия каждой ссылки не меньше 24×24', async ({ page }) => {
    const { column } = await openFooter(page);
    const small: string[] = [];
    for (const account of ACCEPTED_ACCOUNTS) {
      const link = column.locator(`a[href="${account.href}"]`);
      if ((await link.count()) === 0) {
        small.push(`${account.name}: ссылки нет вовсе`);
        continue;
      }
      const box = await link.boundingBox();
      if (box === null) {
        small.push(`${account.name}: ссылка не отрисована — измерить нечего`);
        continue;
      }
      if (box.width < 24 || box.height < 24) {
        small.push(`${account.name}: ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
      // Геометрии мало: цель, накрытую чужим слоем, посетитель не нажмёт. Проверяем
      // попадание в центр — этот класс дефекта в проекте уже был (`inert` ломал hit-testing).
      const hit = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x!, y!);
          return el?.closest('a')?.getAttribute('href') ?? null;
        },
        [box.x + box.width / 2, box.y + box.height / 2],
      );
      if (hit !== account.href) {
        small.push(`${account.name}: центр цели накрыт чужим элементом (попадание в ${hit ?? 'ничто'})`);
      }
    }
    expect(small, `область нажатия меньше 24×24 CSS-пикселей либо недоступна:\n${small.join('\n')}`).toEqual(
      [],
    );
  });

  test('каждая ссылка получает фокус табуляцией и показывает видимый индикатор', async ({ page }) => {
    const { column } = await openFooter(page);
    const first = column.locator(`a[href="${ACCEPTED_ACCOUNTS[0]!.href}"]`);
    await expect(first, 'первой ссылки колонки нет — обходить нечего').toHaveCount(1);
    await first.focus();

    const visited: string[] = [];
    const invisible: string[] = [];
    for (let i = 0; i < ACCEPTED_ACCOUNTS.length; i += 1) {
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el === null) return null;
        const s = getComputedStyle(el);
        return {
          href: el.getAttribute('href'),
          outlineWidth: s.outlineWidth,
          outlineStyle: s.outlineStyle,
          boxShadow: s.boxShadow,
        };
      });
      if (info === null) break;
      visited.push(info.href ?? '(не ссылка)');

      // Мера видимости — уже принятая в проекте (`tests/a11y.spec.ts`): контур ненулевой
      // ширины и стиля, отличного от «нет», либо тень, не являющаяся почти прозрачной.
      // Живой дефект этого класса — снятый outline, компенсированный тенью в 8 % чёрного —
      // уже проходил мимо двух зелёных гейтов.
      const hasOutline = info.outlineStyle !== 'none' && parseFloat(info.outlineWidth) > 0;
      const strongShadow = info.boxShadow !== 'none' && !/rgba\([^)]*0?\.0?[0-9]\)/.test(info.boxShadow);
      if (!hasOutline && !strongShadow) {
        invisible.push(
          `${info.href}: outline ${info.outlineWidth} ${info.outlineStyle}, shadow ${info.boxShadow}`,
        );
      }
      await page.keyboard.press('Tab');
    }

    expect(visited, 'табуляция по подвалу не обошла все четыре ссылки на аккаунты по порядку').toEqual(
      ACCEPTED_ACCOUNTS.map((a) => a.href),
    );
    expect(invisible, `ссылка в фокусе без видимого индикатора:\n${invisible.join('\n')}`).toEqual([]);
  });
});

test.describe('подвал: цвет марок', () => {
  /**
   * Доминирующая заливка марки в ЦЕЛЕВОМ РАЗМЕРЕ, и целевой размер теперь НОРМАТИВЕН:
   * «фактическим размером отрисовки марки в подвале… при масштабе устройства (device pixel
   * ratio) 1» (Requirement «Марка различима на фоне подвала в каждой теме», `design.md`,
   * Решение 20). Прежняя редакция размера не называла — ДЕФЕКТ-6 разбора, — и тогда
   * `getBoundingClientRect` был решением исполнителя; сейчас он и есть названный критерий.
   *
   * Масштаб устройства не ПРЕДПОЛАГАЕТСЯ равным 1, а утверждается измерением ниже. Проекты
   * прогона дескриптора устройства не задают (`web/playwright.config.ts:27`,
   * `use: { viewport: { width: 1280, height: 720 } },`), поэтому по умолчанию он равен 1 —
   * но «по умолчанию» меняется молча и правкой конфигурации, и версией Playwright, а число
   * смешанных пикселей на границах зависит от него напрямую: измерение поехало бы, не
   * покраснев.
   *
   * Растеризация идёт через `data:`-URL с разметкой самой марки: снимок элемента не годится,
   * потому что в нём прозрачность уже смешана с фоном и «непрозрачные пиксели марки»
   * неотличимы от фона рамки. Ноль непрозрачных пикселей — «измерить не удалось», и
   * проверка обязана падать, а не проходить.
   */
  async function dominantFills(
    column: Locator,
    background: number[],
  ): Promise<Map<string, { rgb: number[]; share: number } | string>> {
    const out = new Map<string, { rgb: number[]; share: number } | string>();
    for (const account of MARK_ACCOUNTS) {
      const svg = column.locator(`a[href="${account.href}"] svg`).filter({ visible: true });
      if ((await svg.count()) === 0) {
        out.set(account.name, 'марки (svg) внутри ссылки нет — измерить нечего');
        continue;
      }
      const raster = await svg.evaluate(async (node) => {
        const el = node as SVGSVGElement;
        const rect = el.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(el.outerHTML)}`;
        const img = new Image(w, h);
        img.src = url;
        try {
          await img.decode();
        } catch {
          return { error: 'разметка марки не растеризуется как самостоятельный svg' };
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return { error: 'canvas недоступен — измерить нечем' };
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        return { pixels: Array.from(ctx.getImageData(0, 0, w, h).data), width: w, height: h };
      });
      if ('error' in raster) {
        out.set(account.name, raster.error!);
        continue;
      }
      const dominant = dominantOpaqueRgb(raster.pixels!, background);
      if (dominant === null) {
        out.set(account.name, `в марке ${raster.width}×${raster.height} нет непрозрачных пикселей`);
        continue;
      }
      out.set(account.name, { rgb: dominant.rgb, share: dominant.share });
    }
    return out;
  }

  test('контраст доминирующей заливки к фону подвала не ниже 3:1 в каждой теме', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'предмет не зависит от ширины экрана');
    const { footer, column } = await openFooter(page);

    // Целевой размер требование определяет ПРИ МАСШТАБЕ УСТРОЙСТВА 1. Условие проверяется, а
    // не предполагается: при другом масштабе доля смешанных пикселей на границах иная, и
    // «доминирующая заливка» может смениться — то есть измерялось бы не то, что требуется.
    expect(
      await page.evaluate(() => window.devicePixelRatio),
      'масштаб устройства не равен 1 — целевой размер требования измерен не в тех условиях',
    ).toBe(1);

    const themes = supportedThemes();
    const offenders: string[] = [];

    for (const theme of themes) {
      await setTheme(page, theme);
      const background = parseRgb(
        await footer.evaluate((node) => getComputedStyle(node as Element).backgroundColor),
      );
      const fills = await dominantFills(column, background);
      for (const [name, value] of fills) {
        if (typeof value === 'string') {
          offenders.push(`тема ${theme ?? 'по умолчанию'}, ${name}: ${value}`);
          continue;
        }
        const ratio = contrastRatio(value.rgb, background);
        if (ratio < 3) {
          if (hasContrastWaiver(name, theme)) continue;
          offenders.push(
            `тема ${theme ?? 'по умолчанию'}, ${name}: ${ratio.toFixed(2)}:1 ` +
              `(заливка rgb(${value.rgb.join(', ')}), доля ${(value.share * 100).toFixed(0)} %, ` +
              `фон rgb(${background.join(', ')}))`,
          );
        }
      }
    }

    expect(
      offenders,
      'контраст марки к фону подвала ниже 3:1 либо не измерен. Исключение — themeAssets, ' +
        `contrastWaiverThemes или исход text-link:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  test('доминирующие заливки Youtube и Rutube различаются не менее чем на объявленный порог', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'предмет не зависит от ширины экрана');
    const { footer, column } = await openFooter(page);
    const background = parseRgb(
      await footer.evaluate((node) => getComputedStyle(node as Element).backgroundColor),
    );
    const fills = await dominantFills(column, background);
    const youtube = fills.get('Youtube');
    const rutube = fills.get('Rutube');

    expect(
      typeof youtube === 'string' ? youtube : null,
      'заливку марки Youtube измерить не удалось',
    ).toBeNull();
    expect(typeof rutube === 'string' ? rutube : null, 'заливку марки Rutube измерить не удалось').toBeNull();

    const distance = deltaE76(
      (youtube as { rgb: number[] }).rgb,
      (rutube as { rgb: number[] }).rgb,
    );
    expect(
      distance,
      `цветовое расстояние ΔE76 между марками ${distance.toFixed(1)} ниже объявленного порога ` +
        `${COLOR_DISTANCE_THRESHOLD}. Метрика (ΔE76 в CIE Lab, D65) и правило контрольной пары ` +
        '(фиксированный якорь #ff0000 и он же с каналами ×0,8) закреплены требованием; решением ' +
        'реализации остаётся только число порога — его и переизмеряет задача 3.10 на официальных марках',
    ).toBeGreaterThanOrEqual(COLOR_DISTANCE_THRESHOLD);
  });
});

test.describe('подвал: раскладка', () => {
  /**
   * Число ДОРОЖЕК в вычисленном `grid-template-columns`, а не число блоков: блоков четыре
   * на любой ширине, а дорожек может быть одна.
   *
   * Полосы таблицы требования покрыты тремя проектами прогона: 1280 (шире 768), 600
   * (481–768 включительно) и 375 (480 и уже). Третий проект добавлен этой работой: до неё
   * вьюпортов было два, и полоса 481–768 не была покрыта ни одним.
   */
  const EXPECTED_TRACKS: Record<string, number> = {
    desktop: 4,
    'footer-tablet': 2,
    mobile: 1,
  };

  test('число дорожек сетки подвала соответствует полосе ширины', async ({ page }, testInfo) => {
    const expected = EXPECTED_TRACKS[testInfo.project.name];
    expect(
      expected,
      `для проекта ${testInfo.project.name} ожидаемое число дорожек не объявлено — ` +
        'полоса без проверки должна быть названа, а не умолчана',
    ).toBeDefined();

    const { column } = await openFooter(page);
    const tracks = await column.evaluate((node) => {
      let el: Element | null = node as Element;
      while (el !== null) {
        const display = getComputedStyle(el).display;
        if (display === 'grid' || display === 'inline-grid') {
          return getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length;
        }
        el = el.parentElement;
      }
      return -1;
    });

    expect(tracks, 'сетка подвала не найдена — измерять дорожки нечем').toBeGreaterThan(0);
    const width = page.viewportSize()?.width;
    expect(tracks, `на ширине ${width} px у сетки подвала ${tracks} дорожек, а не ${expected}`).toBe(
      expected,
    );
  });
});
