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
  // вариант редизайна B (верхнее меню) — новый layout под гейтом
  { name: 'preview-b', path: '/preview/b/' },
];

test.describe('Accessibility', () => {
  for (const { name, path } of TEMPLATES) {
    test(`${name} template has no critical/serious axe violations`, async ({ page }) => {
      await page.goto(path);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
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
});
