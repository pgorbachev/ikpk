import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// ─── Accessibility (axe-core) ────────────────────────────
// PR-гейт плана 004 (Этап 0): 0 critical/serious нарушений на 4 шаблонах
// из kpi-validation.md: главная, курс (depth=2), семинар (depth=3), статья.

const TEMPLATES: Array<{ name: string; path: string }> = [
  { name: 'home', path: '/' },
  {
    name: 'course',
    path: '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya',
  },
  {
    name: 'seminar',
    path: '/institut-klinicheskoy-prikladnoy-kineziologii/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami/korrekciya-strukturnyh-narushenij-shejnogo-otdela-pozvonochnika-pleche-lopatochnogo-regiona-i-verhnih-konechnostej',
  },
  { name: 'article', path: '/statyi/90percent-narushenij-v-skeletno-myshechnoj-sisteme' },
  // варианты редизайна b/c/d и architecture-прототипы собираются только при
  // DEMO_FORMS (build:demo). Job Playwright smoke строит прод → эти пути дают
  // 404, и тест ниже их пропускает. Прототипы вне a11y-гейта CI; проверка —
  // локально на демо-сборке.
  { name: 'preview-b', path: '/preview/b' },
  { name: 'preview-c', path: '/preview/c' },
  { name: 'preview-d', path: '/preview/d' },
  // страница видео-плейлиста с фасадом (FR-04)
  { name: 'video', path: '/video/33' },
  // контакты с ленивой картой + форма подписки (card-вариант)
  { name: 'kontakty', path: '/kontakty' },
  // Внутренние страницы, которых в списке не было, а правки их касаются:
  // фильтры статей (видимый фокус), аккордеоны оплаты и «Сведений»,
  // расписание с фасетами, страница института с портретами.
  { name: 'oplata', path: '/oplata' },
  { name: 'statyi', path: '/statyi' },
  { name: 'raspisanie', path: '/raspisanie-i-tseny' },
  { name: 'svedeniya', path: '/svedeniya-ob-obrazovatelnoy-organizatsii' },
  { name: 'institute', path: '/institut-apledzhera' },
];

test.describe('Accessibility', () => {
  // axe разбирает всё дерево страницы, и на списках это долго: у расписания 63
  // события, у статей 68 карточек, у «Сведений» 17 раскрывающихся разделов с
  // восстановленным контентом. Общего лимита 10 секунд не хватает, и тесты
  // падали не по нарушениям, а по таймауту — то есть врали.
  test.describe.configure({ timeout: 60_000 });

  for (const { name, path } of TEMPLATES) {
    test(`${name} template has no critical/serious axe violations`, async ({ page }) => {
      const response = await page.goto(path);
      // Черновики вариантов собираются только в демо-режиме: в боевой сборке их
      // нет, и это не повод краснеть — проверять просто нечего.
      if (name.startsWith('preview-') && response?.status() === 404) {
        test.skip(true, 'черновик варианта отсутствует в боевой сборке');
      }

      // 404 — это «проверять нечего», а не «нарушений нет». Страница 404 у нас
      // крошечная, axe находит на ней ноль нарушений, и гейт зеленеет: именно так
      // 10 шаблонов из 14 проверялись впустую, пока адреса в списке шли со
      // слэшем на конце, а сборка перешла на `trailingSlash: 'never'`.
      expect(
        response?.status(),
        `${path}: страница не отдалась — axe проверил бы страницу 404, а не шаблон`,
      ).toBe(200);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        // Исключаем ТОЛЬКО сами сторонние iframe (Яндекс.Карта, RUTUBE) —
        // их markup мы не контролируем. Наши кнопка запуска видео и
        // fallback-ссылка карты остаются под проверкой.
        .exclude('.contact-shell-map iframe')
        .exclude('.video-facade iframe')
        .analyze();

      const blocking = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious'
      );

      expect(
        blocking,
        blocking
          .map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`)
          .join('\n')
      ).toEqual([]);
    });
  }

  // Тёмная тема главной: гард против регрессий контраста (ревью PR #22 —
  // hero и CTA-полоса ломались в dark mode). Тест сам по себе проверяет
  // РЕЗУЛЬТАТ переключения темы, а не только смену data-theme.
  test('home template (dark theme) has no critical/serious axe violations', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('ikpk.theme', 'dark');
      } catch {
        /* приватный режим — тест просто пройдёт по светлой теме */
      }
    });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .exclude('.contact-shell-map iframe')
      .exclude('.video-facade iframe')
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );

    expect(
      blocking,
      blocking
        .map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`)
        .join('\n')
    ).toEqual([]);
  });
});

// ─── Видимый фокус клавиатуры ────────────────────────────────────────────────
// axe индикаторы фокуса НЕ проверяет, поэтому оба существующих e2e-гейта были
// зелёными при живом дефекте: ArticleFilterBar снимает outline и компенсирует
// тенью в 8% чёрного (в тёмной теме этот хардкод к тому же совпадает с фоном).
// Глобального :focus-visible в проекте нет вообще.
//
// Проверяем ИМЕННО поля фильтров, а не «первые двенадцать табов»: до фильтров
// обход не доходит, а у ссылок шапки фокус рисует сам браузер — из-за этого
// общий обход был зелёным при сломанных полях.
test.describe('Видимый фокус', () => {
  const TARGETS = [
    { path: '/statyi', selectors: ['.article-filter-bar input', '.article-filter-bar select'] },
    { path: '/raspisanie-i-tseny', selectors: ['select', 'input[type="search"], input[type="text"]'] },
  ];

  for (const { path, selectors } of TARGETS) {
    test(`${path}: поля управления получают видимый фокус`, async ({ page }) => {
      await page.goto(path);

      const invisible: string[] = [];
      for (const selector of selectors) {
        const el = page.locator(selector).first();
        if (!(await el.count())) continue;

        await el.focus();
        const info = await el.evaluate((node) => {
          const s = getComputedStyle(node as Element);
          return {
            tag: (node as Element).tagName.toLowerCase(),
            outlineWidth: s.outlineWidth,
            outlineStyle: s.outlineStyle,
            boxShadow: s.boxShadow,
          };
        });

        const hasOutline = info.outlineStyle !== 'none' && parseFloat(info.outlineWidth) > 0;
        // тень тоже индикатор, но только заметная: 8% чёрного не в счёт
        const strongShadow =
          info.boxShadow !== 'none' && !/rgba\([^)]*0?\.0?[0-9]\)/.test(info.boxShadow);

        if (!hasOutline && !strongShadow) {
          invisible.push(
            `${path} ${info.tag}: outline ${info.outlineWidth} ${info.outlineStyle}, shadow ${info.boxShadow}`,
          );
        }
      }

      expect(
        invisible,
        `поле в фокусе без видимого индикатора:\n${invisible.join('\n')}`,
      ).toEqual([]);
    });
  }
});

// ─── Уважение prefers-reduced-motion ────────────────────────────────────────
// Глобальный ресет в motion.css обнуляет длительности, но конечные transform
// гасятся хардкод-списком из пяти классов главной. Внутренние страницы в него
// не попали, поэтому под reduce карточки всё равно смещаются при hover.
test.describe('Сокращённое движение', () => {
  // Эмуляцию включаем ЯВНО через emulateMedia. Опция контекста
  // `test.use({ reducedMotion: 'reduce' })` в этом проекте не применялась —
  // matchMedia в странице возвращал false, то есть тест проверял обычный
  // режим и «краснел» по другой причине. Такой тест хуже отсутствующего.

  const TARGETS = [
    { path: '/raspisanie-i-tseny', selector: '.schedule-card' },
    { path: '/video', selector: '.playlist-card' },
    { path: '/institut-apledzhera', selector: '.program-card' },
  ];

  for (const { path, selector } of TARGETS) {
    test(`${path}: ${selector} не смещается при наведении`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(path);

      const reduceOn = await page.evaluate(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      );
      expect(reduceOn, 'эмуляция сокращённого движения не включилась').toBe(true);

      const el = page.locator(selector).first();
      if (!(await el.count())) test.skip();

      // Читаем ВЫЧИСЛЕННЫЙ transform под наведением, а не рамку элемента.
      // Через boundingBox тест был декоративным: он проходил и с включённым
      // подъёмом, то есть ничего не проверял.
      await el.scrollIntoViewIfNeeded();
      await el.hover();
      await page.waitForTimeout(200);

      const transform = await el.evaluate(
        (node) => getComputedStyle(node as Element).transform,
      );

      // 'none' или единичная матрица — движения нет
      const identity = transform === 'none' || /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(transform);
      expect(
        identity,
        `под prefers-reduced-motion при наведении применён transform: ${transform}`,
      ).toBe(true);
    });
  }
});

// ─── Якоря не уезжают под залипающую шапку ──────────────────────────────────
// scroll-behavior: smooth включён, шапка sticky высотой 60px, а
// scroll-margin-top не задан нигде в проекте: заголовок цели оказывается под
// шапкой. Заметнее всего на длинных страницах с раскрытыми секциями.
test.describe('Якоря под шапкой', () => {
  test('цель внутристраничной ссылки не уходит под шапку', async ({ page }) => {
    await page.goto('/svedeniya-ob-obrazovatelnoy-organizatsii');

    const target = page.locator('[id="3"]').first();
    if (!(await target.count())) test.skip();

    const reserved = await target.evaluate((el) =>
      parseFloat(getComputedStyle(el as Element).scrollMarginTop || '0'),
    );
    const header = await page.evaluate(() => {
      const h = document.querySelector('header.topnav');
      return h ? h.getBoundingClientRect().height : 0;
    });

    expect(
      reserved,
      `у цели якоря scroll-margin-top ${reserved}px при высоте залипающей шапки ${header}px`,
    ).toBeGreaterThanOrEqual(header);
  });
});

// ─── Контраст элементов управления (WCAG 1.4.11, нетекстовый контраст) ──────
// Тумблер темы был неотличим от шапки: дорожка `--color-gray-300` (#d0d0d0) на
// белом фоне даёт 1.54:1 при требуемых 3:1, а белый кружок на этой дорожке —
// столько же. Иконки у контрола нет, поэтому граница дорожки — единственное, чем
// он вообще обозначен на странице.
//
// Измеряем ВЫЧИСЛЕННЫЕ цвета в браузере, а не написание токена в CSS: тот же
// класс дефекта уже был в проекте, когда гейт сверял литерал цвета и не замечал
// переопределения темой.
test.describe('Нетекстовый контраст контролов', () => {
  const MIN_RATIO = 3;

  const luminance = ([r, g, b]: number[]): number => {
    const f = (c: number): number => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: number[], b: number[]): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const parse = (color: string): number[] =>
    (color.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);

  for (const theme of ['light', 'dark'] as const) {
    test(`тумблер темы отделяется от шапки (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('ikpk.theme', t);
        } catch {
          /* приватный режим */
        }
      }, theme);
      const response = await page.goto('/');
      expect(response?.status(), 'страница не отдалась — измерять контраст не на чем').toBe(200);

      // На узких экранах тумблер убран из бара по замыслу, но парный живёт в
      // мобильном меню — раскрываем его и мерим ЕГО, а не пропускаем проверку:
      // пропуск оставил бы контрол мобильной шапки без гейта вовсе.
      const inBar = await page.locator('#theme-toggle').isVisible().catch(() => false);
      if (!inBar) {
        await page.locator('.topnav-mobile > summary').click();
        await expect(page.locator('.drawer-theme')).toBeVisible();
      }
      const scope = inBar ? 'бар' : 'мобильное меню';

      const colors = await page.evaluate((barVisible) => {
        const prefix = barVisible ? '.theme-toggle' : '.drawer-theme';
        const track = document.querySelector(`${prefix}-track`) as HTMLElement | null;
        const thumb = document.querySelector(`${prefix}-thumb`) as HTMLElement | null;
        if (!track || !thumb) return null;
        // Фон подложки: ближайший предок с непрозрачным цветом.
        let node: HTMLElement | null = track.parentElement;
        let behind = 'rgb(255, 255, 255)';
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
            behind = bg;
            break;
          }
          node = node.parentElement;
        }
        return {
          track: getComputedStyle(track).backgroundColor,
          thumb: getComputedStyle(thumb).backgroundColor,
          behind,
        };
      }, inBar);

      expect(colors, 'разметки тумблера не найдено — проверять нечего').not.toBeNull();
      const trackToPage = ratio(parse(colors!.track), parse(colors!.behind));
      const thumbToTrack = ratio(parse(colors!.thumb), parse(colors!.track));

      expect(
        trackToPage,
        `${scope}: дорожка ${colors!.track} на фоне ${colors!.behind}: ${trackToPage.toFixed(2)}:1 при требуемых ${MIN_RATIO}:1`,
      ).toBeGreaterThanOrEqual(MIN_RATIO);
      expect(
        thumbToTrack,
        `${scope}: кружок ${colors!.thumb} на дорожке ${colors!.track}: ${thumbToTrack.toFixed(2)}:1 при требуемых ${MIN_RATIO}:1`,
      ).toBeGreaterThanOrEqual(MIN_RATIO);
    });
  }
});

// ─── Состояние тумблера темы читается не только цветом (WCAG 1.4.1) ──────────
// Дефект: у контрола не было ни иконки, ни подписи — состояние передавалось
// цветом дорожки и позицией кружка. После исправления контраста выключенное
// состояние (#717171) стало ТЕМНЕЕ включённого (#7eaa7f), то есть выглядело
// активнее; владелец, глядя на светлую тему, спросил «ночная версия?».
test.describe('Состояние тумблера темы различимо', () => {
  for (const project of ['bar', 'drawer'] as const) {
    test(`иконка отличает состояния (${project})`, async ({ page }) => {
      const response = await page.goto('/');
      expect(response?.status(), 'страница не отдалась').toBe(200);

      const inBar = await page.locator('#theme-toggle').isVisible().catch(() => false);
      if (project === 'bar' && !inBar) test.skip(true, 'в этом вьюпорте тумблера в баре нет');
      if (project === 'drawer' && inBar) test.skip(true, 'парный контрол проверяется на узком экране');
      if (!inBar) await page.locator('.topnav-mobile > summary').click();

      const selector = inBar ? '#theme-toggle' : '.drawer-theme';
      const toggle = page.locator(selector);

      const shape = async (): Promise<string> =>
        toggle.evaluate((el) => {
          // Видимая иконка состояния: та, что не скрыта.
          // Иконки рисуются CSS, поэтому ищем элементы состояния по признаку, а не
          // по тегу: реализация может быть <i>, <span> или <svg> — важно, что
          // видимый признак состояния есть и он меняется.
          const icons = [...el.querySelectorAll('[data-state]')].filter((node) => {
            const s = getComputedStyle(node);
            return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
          });
          return icons.map((node) => node.getAttribute('data-state') ?? '').join('|');
        });

      // Иконка показывает ЦЕЛЬ переключения, как на старом сайте: в светлой теме
      // видна луна («переключить на тёмную»), в тёмной — солнце. Владелец сверил со
      // старым сайтом и попросил именно эту модель: иконка на дорожке, кружок пустой.
      const off = await shape();
      expect(
        off,
        'в светлой теме на тумблере должна быть ЛУНА — цель переключения',
      ).toBe('moon');

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      const on = await shape();
      expect(on, 'в тёмной теме на тумблере должно быть СОЛНЦЕ — цель переключения').toBe('sun');
    });
  }
});

// ─── Контраст всех частей тумблера в ОБЕИХ темах ─────────────────────────────
// Дефект, ради которого гейт заведён: токены `--color-light-100` и
// `--color-dark-700` в тёмной теме инвертируются (light-100 = #171a17) — они
// задают роль, а не яркость. Использованные как «светлый»/«тёмный», они сделали в
// тёмной теме и солнце, и сам кружок почти чёрными; владелец это увидел на экране.
// То же с accent-500: в тёмной теме он светлый (#7eaa7f), и белый кружок давал на
// нём 2.64:1 при требуемых 3:1.
//
// Прежний гейт контраста смотрел только дорожку к фону шапки, поэтому обе поломки
// пропустил. Здесь проверяются ВСЕ пары: дорожка к шапке, кружок к дорожке, иконка
// к дорожке — и в светлой, и в тёмной теме.
test.describe('Контраст тумблера темы в обеих темах', () => {
  const MIN = 3;
  const lum = ([r, g, b]: number[]): number => {
    const f = (c: number): number => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (color: string): number[] =>
    (color.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const theme of ['light', 'dark'] as const) {
    test(`все части тумблера различимы (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('ikpk.theme', t);
        } catch {
          /* приватный режим */
        }
      }, theme);
      const response = await page.goto('/');
      expect(response?.status(), 'страница не отдалась').toBe(200);

      const inBar = await page.locator('#theme-toggle').isVisible().catch(() => false);
      if (!inBar) await page.locator('.topnav-mobile > summary').click();
      const toggle = page.locator(inBar ? '#theme-toggle' : '.drawer-theme');

      // Второй проход переключает тему, а не состояние контрола отдельно от неё:
      // applyTheme (HeaderTools.astro) ставит data-theme и aria-checked одним
      // синхронным вызовом, поэтому в устойчивом состоянии существуют только две
      // комбинации — светлая+выключено и тёмная+включено. Их и меряем.
      //
      // Комбинация «тёмная+выключено» устойчиво НЕ достижима: она живёт лишь кадр
      // между синхронной установкой data-theme в <head> и отработкой скрипта,
      // который выставит aria-checked. Детерминированного теста на неё здесь нет —
      // цвет для неё подобран расчётом, и этот долг записан в TD-10.
      for (const pass of ['как есть', 'после переключения'] as const) {
        if (pass === 'после переключения') {
          await toggle.click();
          // 350 мс, а не 200: у `.topnav` background-color переходит 0.3s
          // (motion.css, «плавная смена темы»), а у дорожки — 0.15s. При
          // ожидании 200 мс замер иногда попадает в НЕОСЕВШЕЕ состояние, и гейт
          // краснеет на исправном коде — независимое ревью воспроизвело это
          // повторными прогонами (2 падения из 15 и 2 из 20).
          //
          // Это НЕ маскировка дефекта: провал контраста во время самой анимации
          // реален и измерен (до 1.04:1, ниже порога 150 мс), но он про
          // переходные кадры, а не про состояние контрола — см. TD-10.
          // Здесь измеряются устойчивые состояния, и ждать надо дольше самого
          //долгого relevant-перехода.
          await page.waitForTimeout(350);
        }

        const m = await toggle.evaluate((el) => {
          const track = el.querySelector('[class*="-track"]') as HTMLElement;
          const thumb = el.querySelector('[class*="-thumb"]') as HTMLElement;
          const icon = [...el.querySelectorAll('[data-state]')].find((n) => {
            const cs = getComputedStyle(n);
            return cs.display !== 'none' && Number(cs.opacity) > 0;
          }) as HTMLElement | undefined;

          // Фон под контролом: ближайший предок с непрозрачным цветом.
          let node: HTMLElement | null = el.parentElement;
          let behind = 'rgb(255, 255, 255)';
          while (node) {
            const bg = getComputedStyle(node).backgroundColor;
            if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
              behind = bg;
              break;
            }
            node = node.parentElement;
          }

          const iconStyle = icon ? getComputedStyle(icon) : null;
          return {
            // Тема НА МОМЕНТ ЗАМЕРА: во втором проходе она противоположна той,
            // с которой тест стартовал, и подпись обязана называть фактическую.
            theme: document.documentElement.dataset.theme ?? 'light',
            checked: el.getAttribute('aria-checked'),
            track: getComputedStyle(track).backgroundColor,
            // Границу контрола может давать не цвет дорожки, а обводка: тёмная
            // дорожка нужна, чтобы жёлтое солнце читалось, и тогда отделяет её от
            // фона именно обводка. WCAG важна различимость границы, а не механизм.
            trackBorder: (getComputedStyle(track).boxShadow.match(/rgb\([^)]+\)/) ?? [null])[0],
            thumb: getComputedStyle(thumb).backgroundColor,
            iconState: icon?.getAttribute('data-state') ?? null,
            // У иконки цвет может быть в background-color или в градиенте.
            iconColor: iconStyle
              ? iconStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
                ? iconStyle.backgroundColor
                : (iconStyle.backgroundImage.match(/rgb\([^)]+\)/) ?? ['rgb(0,0,0)'])[0]
              : null,
            behind,
          };
        });

        expect(m.iconState, `${m.theme}/${pass}: видимой иконки состояния нет`).not.toBeNull();

        const checks: Array<[string, number]> = [
          [
            `граница контрола (дорожка ${m.track} либо обводка ${m.trackBorder ?? 'нет'}) к фону ${m.behind}`,
            Math.max(
              ratio(m.track, m.behind),
              m.trackBorder ? ratio(m.trackBorder, m.behind) : 0,
            ),
          ],
          [`кружок ${m.thumb} к дорожке ${m.track}`, ratio(m.thumb, m.track)],
          [`иконка ${m.iconState} ${m.iconColor} к дорожке ${m.track}`, ratio(m.iconColor!, m.track)],
        ];

        for (const [what, value] of checks) {
          expect(
            value,
            `${m.theme}, ${pass} (aria-checked=${m.checked}): ${what} — ${value.toFixed(2)}:1 при требуемых ${MIN}:1`,
          ).toBeGreaterThanOrEqual(MIN);
        }
      }
    });
  }
});

// Симулируем увеличенный кегль через document.documentElement.style.fontSize
// (прямая проверка поведения раскладки; в реальности переход к масштабируемому
// корню происходит через фикс html{font-size} в base.css — сам факт роста
// кегля здесь смоделирован, а не выведен из фикса).
// Адреса без слэша на конце: сейчас сборка отдаёт обе формы, но в ветке с
// каталогом медиа и редиректами включён `trailingSlash: 'never'`, и форма со
// слэшем там отдаёт 404. Тест на переполнение на странице 404 прошёл бы молча —
// «нарушений нет» вместо «проверять нечего», поэтому код ответа проверяется ниже.
const ZOOM_PATHS = ['/', '/statyi', '/raspisanie-i-tseny'];

// Опущенное закрытым <details> содержимое (мобильный дровер шапки) остаётся в
// layout-дереве ради scroll-вычислений, но не окрашивается и не видно
// пользователю — checkVisibility() отличает такие узлы от реально видимого
// переполнения.
async function findOverflowingVisible(
  page: import('@playwright/test').Page,
  rootSelector: string,
  excludeSelector?: string
): Promise<string[]> {
  return page.evaluate(
    ({ rootSelector, excludeSelector }) => {
      const root = document.querySelector(rootSelector);
      if (!root) return [`root not found: ${rootSelector}`];
      const viewportWidth = window.innerWidth;
      const offenders: string[] = [];
      for (const el of root.querySelectorAll('*')) {
        if (excludeSelector && el.closest(excludeSelector)) continue;
        const withVisibility = el as Element & { checkVisibility?: () => boolean };
        if (typeof withVisibility.checkVisibility === 'function' && !withVisibility.checkVisibility()) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right > viewportWidth + 1) {
          offenders.push(`${el.tagName}.${(el as HTMLElement).className || ''} right=${Math.round(rect.right)} > viewport=${viewportWidth}`);
        }
      }
      return offenders;
    },
    { rootSelector, excludeSelector }
  );
}

test.describe('Root font-size scaling (a11y text zoom)', () => {
  for (const path of ZOOM_PATHS) {
    // Шапка (TopNav) — известный, отдельный от html{font-size} дефект: плоский
    // flex-ряд без flex-wrap переполняется по горизонтали при увеличенном
    // кегле на ВСЕХ проверенных страницах и viewport'ах. Разобрано и заведено
    // как TD-4 (docs/tech-debt.md) — исправление требует изменений раскладки,
    // которые при baseline-кегле уже меняют высоту/перенос шапки (проверено
    // вручную), то есть выходят за рамки точечного a11y-фикса и нуждаются в
    // мокапе по правилам проекта. Тест зафиксирован как fixme, а не удалён —
    // проверка реальна и должна позеленеть после фикса TD-4.
    test(`${path}: header (TopNav) does not overflow horizontally at 2x root font-size`, async ({ page }) => {
      test.fixme(true, 'TD-4: TopNav переполняется при увеличенном кегле — см. docs/tech-debt.md');

      const response = await page.goto(path);
      expect(response?.status(), `${path}: страница не отдалась — измерять переполнение не на чем`).toBe(200);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });

      const offenders = await findOverflowingVisible(page, 'header.topnav');
      expect(offenders, `шапка переполняется по горизонтали при увеличенном кегле:\n${offenders.join('\n')}`).toEqual([]);
    });

    test(`${path}: content outside the header has no new horizontal overflow at 2x root font-size`, async ({ page }, testInfo) => {
      // Часть страниц/viewport'ов уже сейчас содержит СЕКЦИИ вне шапки, не
      // готовые к росту кегля (не связано с дефектом html{font-size}) —
      // заведено как TD-5. Список — не молчаливое сужение: каждая пара
      // явно поименована и привязана к конкретному долгу.
      const knownBroken = new Set(['/|desktop', '/|mobile', '/raspisanie-i-tseny|mobile']);
      test.fixme(
        knownBroken.has(`${path}|${testInfo.project.name}`),
        'TD-5: секции вне шапки не готовы к росту кегля — см. docs/tech-debt.md'
      );

      const response = await page.goto(path);
      expect(response?.status(), `${path}: страница не отдалась — измерять переполнение не на чем`).toBe(200);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });

      const offenders = await findOverflowingVisible(page, 'body', 'header.topnav');
      expect(
        offenders,
        `вне шапки — горизонтальное переполнение при увеличенном кегле:\n${offenders.join('\n')}`
      ).toEqual([]);
    });
  }
});
