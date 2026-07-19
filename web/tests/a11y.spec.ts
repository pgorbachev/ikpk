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
