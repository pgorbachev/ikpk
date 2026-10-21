import { test, expect, type Browser, type ViewportSize } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { installThirdPartyGuard } from './helpers/third-party-guard';
import { SEL_AWARD_ROW } from './helpers/external-widgets';
import { buildProbe, PROBE_CHAT_LOADER_SRC } from './helpers/widget-probe-build';
import { serveStatic } from './helpers/static-serve';

/**
 * Тесты по спеке change `external-widgets` — ПОВТОРЯЕМОСТЬ снимков при одном моменте.
 *
 * ── ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ВНУТРИ `visual-baseline.spec.ts` ────────────
 * Спека называет место прямо: сценарий «два снимка при одном моменте плюс контроль
 * отрендеренности» SHALL быть реализован **отдельным прогоном, стоящим в гейтующем
 * workflow**, а не внутри прогона эталонов. Тот числится в списке признанного долга
 * браузерных проверок (`web/tests/browser-test-gating.test.ts:56`,
 * `'visual-baseline.spec.ts',`), и принятое правило запрещает файлу быть одновременно в
 * гейте и в долге — то есть проверка, положенная туда, была бы зелена ровно потому, что
 * её никто не выполняет.
 *
 * ── ЧТО ИМЕННО СРАВНИВАЕТСЯ ─────────────────────────────────────────────────
 * Два снимка ДРУГ С ДРУГОМ, а не с принятым эталоном. Причина названа спекой: эталоны на
 * этом проекте снимаются только в CI, локально их не снять, а прогон эталонов не исполняет
 * ни один гейтующий workflow — сравнение с эталоном мерило бы совпадение с чужим
 * окружением, а не детерминированность нашего вывода.
 *
 * Датозависимость здесь НЕ предмет: моменты, различающиеся часом и годом, разбирает
 * требование о датозависимом фрагменте, и его проверка живёт в
 * `tests/external-widgets-config-probe.test.ts`. Один тест на сценарии двух требований
 * сделал бы расхождение между ними невидимым для обоих.
 *
 * Перехват сторонних хостов ставится ЗДЕСЬ, в своём файле: гранулярность по прогону, а не
 * по конфигурации. Конфигураций «с перехватом» не существует — запрет разрешения имён,
 * стоящий в двух конфигурациях, это другой механизм, и спека их различает.
 */

/** Момент подставляется ОДИН И ТОТ ЖЕ обоим прогонам: предмет — повторяемость, не дата. */
const ONE_MOMENT = '2026-08-21T11:00:00+03:00';

/**
 * Известный маркер шаблона — контроль ОТРЕНДЕРЕННОСТИ.
 *
 * Без него совпадают два снимка пустой или ошибочной страницы, и проверка зелена в том
 * самом случае, ради которого написана. Маркер именно ШАБЛОНА, а не строки текста
 * вообще: страница 404 тоже несёт текст.
 */
const TEMPLATE_MARKER = { path: '/', selector: 'h1' };

interface Shot {
  readonly firstViewport: Buffer;
  readonly reviewsViewport: Buffer;
  readonly markerText: string;
  readonly fullHeight: number;
}

/**
 * Привести страницу к УСТОЯВШЕМУСЯ состоянию до снимка.
 *
 * Без этого шага проверка флакует, и это ИЗМЕРЕНО, а не предположено. Первая редакция
 * снимала кадр сразу после `document.fonts.ready`, и в полном прогоне (три воркера на один
 * `astro preview`) два снимка расходились; вне нагрузки — 12 пар из 12 совпали побайтово.
 * То есть расходился не сайт, а моя проверка: страница 6063 px несёт картинки с
 * `loading="lazy"`, полностраничный снимок сам их и подгружает, а успеют ли они
 * декодироваться до захвата, зависит от того, насколько занят сервер.
 *
 * Гейт, флакующий на неизменном дереве, хуже отсутствующего: он приучает перезапускать.
 * Поэтому: пройти страницу шагами по viewport (одного прыжка вниз недостаточно для всех
 * `loading="lazy"` картинок), дождаться тишины в сети, вернуться наверх, дождаться
 * готовности шрифтов и КАЖДОЙ картинки.
 * Ожидание тишины — тот же приём, что у прогона эталонов
 * (`web/tests/visual-baseline.spec.ts:31`, `waitForLoadState('networkidle')`).
 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  const step = await page.evaluate(() => {
    const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
    return Math.max(1, Math.floor((port?.clientHeight ?? window.innerHeight) * 0.75));
  });
  while (true) {
    const { height, viewportHeight, currentTop } = await page.evaluate(() => ({
      height: document.querySelector<HTMLElement>('[data-page-scrollport]')?.scrollHeight ?? document.documentElement.scrollHeight,
      viewportHeight: document.querySelector<HTMLElement>('[data-page-scrollport]')?.clientHeight ?? window.innerHeight,
      currentTop: document.querySelector<HTMLElement>('[data-page-scrollport]')?.scrollTop ?? window.scrollY,
    }));
    const bottom = Math.max(0, height - viewportHeight);
    if (currentTop >= bottom) break;

    const nextTop = Math.min(currentTop + step, bottom);
    await page.evaluate((scrollTop) => {
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
      if (port) port.scrollTo({ top: scrollTop, behavior: 'instant' });
      else window.scrollTo({ top: scrollTop, behavior: 'instant' });
    }, nextTop);
    if ((await page.evaluate(() => document.querySelector<HTMLElement>('[data-page-scrollport]')?.scrollTop ?? window.scrollY)) <= currentTop) break;
  }
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
    if (port) port.scrollTo({ top: 0, behavior: 'instant' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      Promise.all(
        [...document.images]
          .filter((img) => !img.complete)
          .map((img) => new Promise((done) => {
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          })),
      ),
  );
  await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))));
}

async function shot(browser: Browser, path: string, viewport: ViewportSize, chatEnabled = false): Promise<Shot> {
  // Своя страница на каждый прогон: `page.clock.install` ставится на страницу один раз, и
  // два снимка одной и той же страницы совпали бы тривиально — предметом стала бы
  // способность браузера дважды отдать один кадр, а не детерминированность вывода.
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  try {
    await page.clock.install({ time: new Date(ONE_MOMENT) });
    await installThirdPartyGuard(page, { chatLoaderSrc: null });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const response = await page.goto(path);
    expect(response?.status(), `${path}: страница не отдалась — снимок был бы снимком ошибки`).toBe(200);
    if (chatEnabled) {
      await expect(page.locator('body[data-chat-page]'), `${path}: chat layout is active`).toHaveCount(1);
      await expect(page.locator('[data-page-scrollport]'), `${path}: chat fixture has the shared scrollport`).toHaveCount(1);
      await expect(page.locator('[data-chat-trigger]'), `${path}: chat entry is rendered in the repeated view`).toBeVisible();
    }
    await settle(page);
    const marker = page.locator(TEMPLATE_MARKER.selector).first();
    await expect(marker, `${path}: маркера шаблона нет — страница не отрендерена`).toBeVisible();
    const markerText = ((await marker.textContent()) ?? '').trim();
    const fullHeight = await page.evaluate(() => document.querySelector<HTMLElement>('[data-page-scrollport]')?.scrollHeight ?? document.documentElement.scrollHeight);
    const mask = [page.locator(`[${SEL_AWARD_ROW}]`)];
    const firstViewport = await page.screenshot({
      fullPage: false,
      animations: 'disabled',
      // Единственный датозависимый фрагмент этой возможности исключается явно и здесь
      // тоже: иначе повторяемость мерилась бы вместе с датозависимостью, а это предмет
      // другого требования.
      mask,
    });
    const reviews = page.locator('[data-reviews-embed]');
    await expect(reviews, `${path}: reviews embed is part of the rendered home template`).toBeAttached();
    await page.evaluate(() => {
      const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
      const embed = document.querySelector<HTMLElement>('[data-reviews-embed]');
      if (port && embed) port.scrollTo({ top: Math.max(0, embed.offsetTop - port.offsetTop), behavior: 'instant' });
      else if (embed) window.scrollTo({ top: embed.getBoundingClientRect().top + window.scrollY, behavior: 'instant' });
    });
    await expect(reviews, `${path}: reviews iframe region is visible in the repeated viewport`).toBeInViewport();
    await expect(reviews.locator('iframe'), `${path}: reviews content is rendered in its iframe`).toHaveCount(1);
    await expect(reviews.frameLocator('iframe').locator('#stub'), `${path}: the substituted Reviews document is loaded before capture`)
      .toHaveText('подставной документ виджета отзывов');
    await page.waitForLoadState('networkidle');
    const reviewsViewport = await page.screenshot({ fullPage: false, animations: 'disabled', mask });
    return { firstViewport, reviewsViewport, markerText, fullHeight };
  } finally {
    await context.close();
  }
}

test.describe('визуальные эталоны не зависят от ответа сторонних сервисов', () => {
  test.describe.configure({ timeout: 120_000 });

  test('два прогона при одном моменте дают одни снимки', async ({ browser }, testInfo) => {
    const viewport = testInfo.project.use.viewport as ViewportSize;
    const first = await shot(browser, TEMPLATE_MARKER.path, viewport);
    const second = await shot(browser, TEMPLATE_MARKER.path, viewport);

    // Контроль отрендеренности — ДО сравнения: он и есть доказательство непустоты
    // предмета. Пустая страница дала бы два одинаковых снимка и зелёный вердикт.
    expect(
      first.markerText.length,
      'маркер шаблона пуст: сравнивались бы два снимка пустой страницы',
    ).toBeGreaterThan(0);
    expect(first.markerText, 'маркер шаблона разошёлся между прогонами').toBe(second.markerText);
    expect(
      first.fullHeight,
      'высота документа меньше высоты окна: похоже на страницу ошибки, а не на шаблон',
    ).toBeGreaterThan(viewport.height);
    expect(first.fullHeight, 'высота документа разошлась между прогонами').toBe(second.fullHeight);

    const firstSame = second.firstViewport.equals(first.firstViewport);
    const reviewsSame = second.reviewsViewport.equals(first.reviewsViewport);
    const same = firstSame && reviewsSame;
    if (!same) {
      await Promise.all([
        writeFile(testInfo.outputPath('first-run-viewport.png'), first.firstViewport),
        writeFile(testInfo.outputPath('second-run-viewport.png'), second.firstViewport),
        writeFile(testInfo.outputPath('first-run-reviews.png'), first.reviewsViewport),
        writeFile(testInfo.outputPath('second-run-reviews.png'), second.reviewsViewport),
      ]);
    }

    expect(
      same,
      'два снимка при ОДНОМ И ТОМ ЖЕ подставленном моменте и подставных ответах сторонних ' +
        'сервисов различаются на неизменном дереве: значит облик зависит от чего-то, что ' +
        'проверка не привела к известному состоянию; отдельно сверяются первый экран и видимая область Reviews iframe',
    ).toBe(true);
  });

  test('chat-enabled scrollport and the visible Reviews frame repeat deterministically', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'one mobile viewport proves the layout-specific scrollport and lower chat row');
    const viewport = { width: 375, height: 812 };
    const build = buildProbe('non-demo preview payment plus chat baseline repeat', {
      CHAT_LOADER_SRC: PROBE_CHAT_LOADER_SRC,
      PAYMENT_ROLE: 'preview',
      DEMO_FORMS: 'stub',
      DEMO_OUTPUT: undefined,
    }, { keepOnDisk: true });
    let site: Awaited<ReturnType<typeof serveStatic>> | undefined;
    try {
      if (!build.root) throw new Error('chat-enabled repeat probe has no retained output for Pagefind');
      execFileSync(join(process.cwd(), 'node_modules/.bin/pagefind'), ['--site', build.root], {
        cwd: process.cwd(),
        stdio: 'pipe',
        encoding: 'utf8',
      });
      site = await serveStatic(build.root);
      const first = await shot(browser, `${site.origin}/`, viewport, true);
      const second = await shot(browser, `${site.origin}/`, viewport, true);
      expect(first.markerText.length, 'chat-enabled page has the home template marker').toBeGreaterThan(0);
      expect(first.markerText).toBe(second.markerText);
      expect(first.fullHeight).toBeGreaterThan(viewport.height);
      expect(first.fullHeight).toBe(second.fullHeight);
      const same = first.firstViewport.equals(second.firstViewport)
        && first.reviewsViewport.equals(second.reviewsViewport);
      if (!same) {
        await Promise.all([
          writeFile(testInfo.outputPath('chat-first-run-viewport.png'), first.firstViewport),
          writeFile(testInfo.outputPath('chat-second-run-viewport.png'), second.firstViewport),
          writeFile(testInfo.outputPath('chat-first-run-reviews.png'), first.reviewsViewport),
          writeFile(testInfo.outputPath('chat-second-run-reviews.png'), second.reviewsViewport),
        ]);
      }
      expect(same, 'chat-enabled page first viewport and the actually loaded Reviews frame are repeatable').toBe(true);
    } finally {
      await site?.close();
      build.dispose();
    }
  });
});
