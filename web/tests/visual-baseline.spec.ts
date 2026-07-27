import { test, expect } from '@playwright/test';

// ─── Доказательство «вид не изменился» ──────────────────────────────────────
//
// Фундамент токенов — это вынос существующих значений в именованные роли, а не
// смена облика. Утверждение проверяемое: эталоны снимаются ДО правок, после
// правок снимки должны совпасть попиксельно.
//
// Сюда же опирается следующий шаг — раскатка выбранного варианта: тогда эталоны
// осознанно обновляются, и diff показывает ровно то, что менялось.
//
// Анимации выключены: иначе снимок ловит случайную фазу перехода.
const PAGES = [
  { name: 'home', path: '/' },
  { name: 'oplata', path: '/oplata' },
  { name: 'schedule', path: '/raspisanie-i-tseny' },
  { name: 'seminar', path: '/institut-apledzhera/kraniosakralnaya-terapiya/kraniosakralnaya-terapiya-1' },
  { name: 'institute', path: '/institut-apledzhera' },
  { name: 'articles', path: '/statyi' },
];

test.describe('Визуальные эталоны', () => {
  test.describe.configure({ timeout: 60_000 });

  for (const { name, path } of PAGES) {
    test(`${name}: облик не изменился`, async ({ page }, testInfo) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(path);
      // шрифты и ленивые картинки успевают приехать до снимка
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');

      await expect(page).toHaveScreenshot(`${name}-${testInfo.project.name}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.001,
        animations: 'disabled',
      });
    });
  }
});
