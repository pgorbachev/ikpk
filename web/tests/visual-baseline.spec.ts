import { test, expect } from '@playwright/test';
import { installThirdPartyGuard } from './helpers/third-party-guard';
import { SEL_AWARD_ROW } from './helpers/external-widgets';

test.beforeEach(async ({ page }) => {
  await installThirdPartyGuard(page);
});

// ─── Доказательство «вид не изменился» ──────────────────────────────────────
//
// Фундамент токенов — это вынос существующих значений в именованные роли, а не
// смена облика. Утверждение проверяемое: эталоны снимаются ДО правок, после
// правок снимки должны совпасть попиксельно.
//
// Сюда же опирается следующий шаг — раскатка выбранного варианта: тогда эталоны
// осознанно обновляются, и diff показывает ровно то, что менялось.
//
// Страницы собраны из закреплённого снимка-фикстуры (cms-content-publication, D7).
// Анимации выключены: иначе снимок ловит случайную фазу перехода.
//
// ── Датозависимый фрагмент и состав покрытия (change external-widgets) ───────
// Датозависимый фрагмент здесь ОДИН: строка знаков наград (`SEL_AWARD_ROW`,
// `[data-award-row]`) — её содержимое зависит от текущего срока, поэтому она
// маскируется при попиксельном сравнении, а не участвует в нём.
//
// Состав покрытия обновлён вместе с появлением встраиваний: секция отзывов
// (`SEL_REVIEWS_SECTION`, `[data-reviews-section]`, видна на главной) и НАША
// кнопка вызова чата (`SEL_CHAT_TRIGGER`, `[data-chat-trigger]`, видна на любой
// странице) попадают в снимок как обычная разметка — перехват сторонних
// запросов гасит только их сторонние ответы, а не саму кнопку/секцию. Точка
// монтирования чужого интерфейса чата в покрытие не входит: при погашенных
// сторонних запросах внутри неё ничего не рендерится.
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
        // Единственный датозависимый фрагмент — строка знаков наград, см. пояснение выше.
        mask: [page.locator(`[${SEL_AWARD_ROW}]`)],
      });
    });
  }
});
