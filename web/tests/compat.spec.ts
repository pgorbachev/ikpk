import { test, expect } from '@playwright/test';
import { installThirdPartyGuard } from './helpers/third-party-guard';

test.beforeEach(async ({ page }) => {
  await installThirdPartyGuard(page);
});

const PAGES: Array<{ path: string; check: string }> = [
  { path: '/', check: 'Институт клинической прикладной кинезиологии' },
  { path: '/raspisanie-i-tseny', check: 'Расписание' },
  { path: '/statyi', check: 'Статьи' },
  { path: '/kontakty', check: 'Контакты' },
];

test.describe('Compatibility smoke', () => {
  for (const pageDef of PAGES) {
    test(`${pageDef.path} loads with core content`, async ({ page }) => {
      const jsErrors: string[] = [];
      page.on('pageerror', (error) => jsErrors.push(error.message));

      const response = await page.goto(pageDef.path, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), `${pageDef.path} should return HTTP 200`).toBe(200);

      const body = page.locator('body');
      await expect(body).toContainText(pageDef.check);
      await expect(page.locator('h1').first()).toBeVisible();
      expect(jsErrors, `${pageDef.path} should not raise runtime JS errors`).toHaveLength(0);
    });
  }

  test('homepage keeps SEO and analytics base markers', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /ikpk\.su/);

    const html = await page.content();
    expect(html).toContain('39506315');
    expect(html).toContain('mc.yandex.ru/metrika');
  });

  test('content pages render <details> blocks', async ({ page }) => {
    await page.goto('/svedeniya-ob-obrazovatelnoy-organizatsii');
    const details = page.locator('details');
    expect(await details.count()).toBeGreaterThan(0);
  });

  // Ожидание выводится из ШИРИНЫ вьюпорта против порога шапки, а не из имён
  // профилей. Поимённый список описывал только то, что есть сегодня: планшетный
  // профиль шире 900 (iPad landscape, iPad Pro 12.9″ портрет) в него не попал бы,
  // и тест упал бы с сообщением «навигации в шапке нет», для такого профиля
  // ложным. Ширина вьюпорта приходит из конфигурации проекта, а не из рендера, —
  // значит признак по-прежнему не читает предмет, ради чего правка и делалась.
  const BURGER_MAX_WIDTH = 900;

  // Дефект пришёл с iPhone 14 Pro: меню открывается, щелчок рядом его не
  // закрывает. Причина не в устройстве — drawer это нативный <details>, а он по
  // внешнему щелчку не закрывается ни в одном браузере. Проверка здесь нужна
  // именно потому, что здесь настоящие профили iOS и Android, а не эмуляция
  // размера окна.
  test('мобильное меню закрывается щелчком вне себя', async ({ page }, testInfo) => {
    const response = await page.goto('/');
    expect(response?.status(), 'страница не отдалась').toBe(200);

    const drawer = page.locator('details.topnav-mobile');
    const summary = drawer.locator('> summary');
    const burgerVisible = await summary.isVisible().catch(() => false);

    // Условие пропуска раньше читало САМ ПРЕДМЕТ: «бургер не виден — значит в этом
    // профиле меню нет по замыслу». Такой признак исчезает вместе с предметом, и
    // регресс, спрятавший бургер, тихо превращался в пропуск вместо падения —
    // ровно это и случилось на `compat-ios-ipad` (810×1080), когда правила
    // мобильного меню уехали в медиазапрос ≤430 (ревью PR #153).
    const viewportWidth = page.viewportSize()?.width ?? 0;
    expect(viewportWidth, 'у профиля нет ширины вьюпорта — сравнивать не с чем').toBeGreaterThan(0);
    const where = `${testInfo.project.name} (${viewportWidth}px)`;

    if (viewportWidth > BURGER_MAX_WIDTH) {
      expect(burgerVisible, `${where}: шире ${BURGER_MAX_WIDTH}px бургера быть не должно`).toBe(false);
      await expect(
        page.locator('.topnav-menu a').first(),
        `${where}: бургера нет по замыслу, но и пунктов горизонтального меню не видно`,
      ).toBeVisible();
      test.skip(true, `${where}: навигация горизонтальным меню, мобильного нет по замыслу`);
    }

    expect(
      burgerVisible,
      `${where}: бургер не виден, а горизонтальное меню в этой ширине скрыто — ` +
        'навигации в шапке нет вовсе',
    ).toBe(true);

    await summary.click();
    await expect(drawer, 'меню не открылось').toHaveAttribute('open', '');
    // Атрибута `open` мало: он выставляется и при скрытой панели. Без этого
    // утверждения правило `.topnav-drawer { display: none }` оставило бы
    // проверку зелёной при недостижимой навигации.
    await expect(
      page.locator('.topnav-drawer .drawer-link').first(),
      `${where}: меню открылось, но ни одной ссылки в панели не видно`,
    ).toBeVisible();

    const outside = await page.evaluate(() => {
      const d = document.querySelector('details.topnav-mobile');
      if (!d) return null;
      const step = 20;
      // Точка обязана быть НЕинтерактивной. Иначе щелчок уводит на другую
      // страницу, там <details> закрыт по умолчанию, и тест зеленеет не по той
      // причине: без исправления он проходил именно так — проверено негативно.
      const interactive = 'a, button, summary, input, select, textarea, label, [role="button"]';
      for (let y = innerHeight - step; y > 0; y -= step) {
        for (let x = step; x < innerWidth; x += step) {
          const el = document.elementFromPoint(x, y);
          if (!el || d.contains(el)) continue;
          if (el.closest(interactive)) continue;
          return { x, y };
        }
      }
      return null;
    });
    expect(outside, 'не нашлось точки вне открытого меню — щёлкнуть вне него невозможно').not.toBeNull();
    const urlBefore = page.url();
    await page.mouse.click(outside!.x, outside!.y);
    expect(page.url(), 'щелчок увёл на другую страницу — меню закрылось бы и без исправления').toBe(
      urlBefore,
    );
    await expect(drawer, 'меню осталось открытым после щелчка вне него').not.toHaveAttribute(
      'open',
      '',
    );
  });
});
