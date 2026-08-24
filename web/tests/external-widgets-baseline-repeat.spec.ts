import { test, expect, type Browser } from '@playwright/test';
import { installThirdPartyGuard } from './helpers/third-party-guard';
import { SEL_AWARD_ROW } from './helpers/external-widgets';

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
 * `tests/external-widgets-build-year.spec.ts`. Один тест на сценарии двух требований
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
  readonly image: Buffer;
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
 * Поэтому: прокрутить страницу до низа (это и запускает ленивую загрузку), дождаться
 * тишины в сети, вернуться наверх, дождаться готовности шрифтов и КАЖДОЙ картинки.
 * Ожидание тишины — тот же приём, что у прогона эталонов
 * (`web/tests/visual-baseline.spec.ts:31`, `waitForLoadState('networkidle')`).
 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.scrollTo(0, 0));
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
}

async function shot(browser: Browser, path: string): Promise<Shot> {
  // Своя страница на каждый прогон: `page.clock.install` ставится на страницу один раз, и
  // два снимка одной и той же страницы совпали бы тривиально — предметом стала бы
  // способность браузера дважды отдать один кадр, а не детерминированность вывода.
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    await page.clock.install({ time: new Date(ONE_MOMENT) });
    await installThirdPartyGuard(page, { chatLoaderSrc: null });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const response = await page.goto(path);
    expect(response?.status(), `${path}: страница не отдалась — снимок был бы снимком ошибки`).toBe(200);
    await settle(page);
    const marker = page.locator(TEMPLATE_MARKER.selector).first();
    await expect(marker, `${path}: маркера шаблона нет — страница не отрендерена`).toBeVisible();
    const markerText = ((await marker.textContent()) ?? '').trim();
    const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const image = await page.screenshot({
      fullPage: true,
      animations: 'disabled',
      // Единственный датозависимый фрагмент этой возможности исключается явно и здесь
      // тоже: иначе повторяемость мерилась бы вместе с датозависимостью, а это предмет
      // другого требования.
      mask: [page.locator(`[${SEL_AWARD_ROW}]`)],
    });
    return { image, markerText, fullHeight };
  } finally {
    await context.close();
  }
}

test.describe('визуальные эталоны не зависят от ответа сторонних сервисов', () => {
  test.describe.configure({ timeout: 120_000 });

  test('два прогона при одном моменте дают одни снимки', async ({ browser }) => {
    const first = await shot(browser, TEMPLATE_MARKER.path);
    const second = await shot(browser, TEMPLATE_MARKER.path);

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
    ).toBeGreaterThan(720);
    expect(first.fullHeight, 'высота документа разошлась между прогонами').toBe(second.fullHeight);

    expect(
      second.image.equals(first.image),
      'два снимка при ОДНОМ И ТОМ ЖЕ подставленном моменте и подставных ответах сторонних ' +
        'сервисов различаются на неизменном дереве: значит облик зависит от чего-то, что ' +
        'проверка не привела к известному состоянию',
    ).toBe(true);
  });
});
