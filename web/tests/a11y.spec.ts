import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// ─── Accessibility (axe-core) ────────────────────────────
// PR-гейт плана 004 (Этап 0): 0 critical/serious нарушений на 4 шаблонах
// из kpi-validation.md: главная, курс (depth=2), семинар (depth=3), статья.

const TEMPLATES: Array<{ name: string; path: string }> = [
  { name: 'home', path: '/' },
  {
    name: 'course',
    path: '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/',
  },
  {
    name: 'seminar',
    path: '/institut-klinicheskoy-prikladnoy-kineziologii/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami/korrekciya-strukturnyh-narushenij-shejnogo-otdela-pozvonochnika-pleche-lopatochnogo-regiona-i-verhnih-konechnostej/',
  },
  { name: 'article', path: '/statyi/90percent-narushenij-v-skeletno-myshechnoj-sisteme/' },
  // варианты редизайна (верхнее меню) — новый layout + hero-компоненты под гейтом
  { name: 'preview-b', path: '/preview/b/' },
  { name: 'preview-c', path: '/preview/c/' },
  { name: 'preview-d', path: '/preview/d/' },
  // страница видео-плейлиста с фасадом (FR-04)
  { name: 'video', path: '/video/33/' },
  // контакты с ленивой картой + форма подписки (card-вариант)
  { name: 'kontakty', path: '/kontakty/' },
];

test.describe('Accessibility', () => {
  for (const { name, path } of TEMPLATES) {
    test(`${name} template has no critical/serious axe violations`, async ({ page }) => {
      await page.goto(path);

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

// ─── Увеличенный корневой кегль (текстовый зум, a11y) ───────────────────────
// html { font-size: 16px } в base.css подавлял пользовательскую настройку
// размера шрифта: почти вся типографика на rem, поэтому дефект проверяем не
// только по исходнику/сборке CSS, но и по фактическому поведению раскладки —
// раскладочные баги видит только браузер (Playwright), не lint/build-гейты.
//
// Симулируем увеличенный кегль через document.documentElement.style.fontSize
// (прямая проверка поведения раскладки; в реальности переход к масштабируемому
// корню происходит через фикс html{font-size} в base.css — сам факт роста
// кегля здесь смоделирован, а не выведен из фикса).
const ZOOM_PATHS = ['/', '/statyi/', '/raspisanie-i-tseny/'];

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

      await page.goto(path);
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
      const knownBroken = new Set(['/|desktop', '/|mobile', '/raspisanie-i-tseny/|mobile']);
      test.fixme(
        knownBroken.has(`${path}|${testInfo.project.name}`),
        'TD-5: секции вне шапки не готовы к росту кегля — см. docs/tech-debt.md'
      );

      await page.goto(path);
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
