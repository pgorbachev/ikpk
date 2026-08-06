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
  // варианты редизайна (верхнее меню) — новый layout + hero-компоненты под гейтом
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
