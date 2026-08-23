import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calendarToday, isCurrentOrFuture } from '../src/lib/schedule-window';

// ─── Расписание на странице семинара: перенос вверх (D3, вариант C) ──────────
// Предмет: `docs/demo-2026-08-23-mockup-choice.md`, «Страница семинара — вариант C
// — расписание карточками в липкой боковой колонке». Спеки у этой работы нет:
// облик утверждён владельцем по мокапам, дальше обычный red/green.
//
// Файл КРАСНЫЙ по замыслу: сегодня расписание лежит одной таблицей ПОСЛЕ описания,
// боковой колонки нет вовсе.
//
// Почему браузерные проверки, а не сборочные: предмет — раскладка (кто где стоит,
// что липнет, что прокручивается). `lint`, `typecheck` и проверки по `dist` зелёные
// и на сломанной вёрстке (AGENTS.md, «Дефекты: red/green»).
//
// Файл исполняется workflow `Tests` — через `npm run test:e2e:seminar`, вписанный в
// job `e2e-smoke` рядом с `test:e2e:catalog`. Положить проверки в
// `seminar-parity.spec.ts` нельзя: его не запускает ни один гейтующий workflow, и
// зелёными они были бы ровно потому, что их никто не выполняет
// (`browser-test-gating.test.ts`, признанный долг).
//
// Ни одна страница здесь не захардкожена. Число дат у семинара меняется само от
// хода времени: `isCurrentOrFuture` отбрасывает прошедшие. Поэтому страницы
// ВЫБИРАЮТСЯ по данным, а перегруз колонки, которого в данных может не оказаться,
// создаётся мутацией DOM, а не ожиданием подходящего семинара.
//
// Сущности читаются прямо из `discovery/entities/`, а не через `src/lib/data`:
// `data.ts` тянет `media-manifest.json`, а трансформер Playwright импорт JSON без
// атрибута типа не берёт — прогон падал на сборе, не запустив ни одного теста.
// Отбор дат при этом идёт той же функцией `isCurrentOrFuture`, что и у страницы.

const SCHEDULE = '[data-testid="seminar-schedule"]';
/** Липкая обёртка — она же область прокрутки на десктопе. */
const PANEL = '[data-seminar-schedule-panel]';
const ITEM = '[data-seminar-schedule-card]';
const DESCRIPTION = '.seminar-content';
const REGISTER = '.seminar-register-link';

/** Цена варианта C на узких ширинах, зафиксированная при выборе (finding 15). */
const NAMED_COST = { 768: 1447, 375: 1608 };

interface SeminarPage {
  path: string;
  /** Актуальных дат на сегодня — столько записей и должно быть в колонке. */
  dates: number;
}

const ENTITIES = join(import.meta.dirname, '..', '..', 'discovery', 'entities');

function entities<T>(file: string): T[] {
  const raw = JSON.parse(readFileSync(join(ENTITIES, file), 'utf-8'));
  const rows = Array.isArray(raw) ? raw : Object.values(raw)[0];
  expect(Array.isArray(rows), `${file}: ожидался массив сущностей`).toBe(true);
  return rows as T[];
}

/**
 * Страницы семинаров с числом актуальных дат. Путь собирается так же, как его
 * собирает `getStaticPaths` страницы: институт → группа курсов → семинар.
 */
function seminarPages(): SeminarPage[] {
  const institutes = entities<{ slug: string }>('institutes.json');
  const groups = entities<{ slug: string; legacy_id: string; institute_legacy_id: string }>('course_groups.json');
  const seminars = entities<{ slug: string; course_group_legacy_id: string }>('seminars.json');
  const schedule = entities<{
    status: string;
    seminar?: { slug: string };
    startAt: string;
    endAt: string;
  }>('schedule_entries.json');
  const today = calendarToday();

  const perSlug = new Map<string, number>();
  for (const entry of schedule) {
    const slug = entry.seminar?.slug;
    if (!slug || entry.status !== 'active' || !isCurrentOrFuture(entry, today)) continue;
    perSlug.set(slug, (perSlug.get(slug) ?? 0) + 1);
  }

  const pages: SeminarPage[] = [];
  for (const seminar of seminars) {
    const group = groups.find((candidate) => candidate.legacy_id === seminar.course_group_legacy_id);
    if (!group) continue;
    const institute = institutes.find((candidate) => candidate.slug === group.institute_legacy_id);
    if (!institute) continue;
    pages.push({
      path: `/${institute.slug}/${group.slug}/${seminar.slug}`,
      dates: perSlug.get(seminar.slug) ?? 0,
    });
  }

  expect(pages.length, 'в данных нет ни одной страницы семинара — проверять было нечего')
    .toBeGreaterThan(0);
  return pages;
}

const PAGES = seminarPages();

/** Страница с наибольшим числом дат: на ней колонка выше всего. */
const MOST_DATES = PAGES.reduce((best, page) => (page.dates > best.dates ? page : best), PAGES[0]);
/** Страница ровно с одной датой: короткий список, прокрутки внутри быть не должно. */
const ONE_DATE = PAGES.find((page) => page.dates === 1);
/** Страница без дат — их большинство каталога. */
const NO_DATES = PAGES.find((page) => page.dates === 0);

/**
 * Открыть страницу семинара и убедиться, что разбирать есть что.
 *
 * Код ответа утверждается явно: разбор страницы 404 проходит всегда — на ней нет ни
 * расписания, ни описания, поэтому любая проверка «блок стоит там-то» на ней
 * вырождается в «блока нет», а это не успех.
 */
async function openSeminar(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), `${path}: страница не отдалась — проверять было нечего`).toBe(200);
  await expect(page.locator(SCHEDULE), `${path}: блока расписания нет`).toBeVisible();
}

async function box(locator: Locator, what: string) {
  const rect = await locator.boundingBox();
  expect(rect, `${what}: рамку измерить не удалось`).not.toBeNull();
  return rect!;
}

/**
 * Прокрутить страницу и вернуть фактическое смещение.
 *
 * `behavior: 'instant'` обязателен: в базовых стилях включён `scroll-behavior: smooth`,
 * поэтому обычный `window.scrollTo(0, y)` только ЗАПУСКАЕТ анимацию, и прочитанный тут же
 * `scrollY` равен нулю. Первая редакция этой проверки падала именно так — на исправном
 * коде, с сообщением «проверять было нечем». Кадр ожидания нужен, чтобы браузер пересчитал
 * положение липкого элемента до измерения рамки.
 */
async function scrollPageTo(page: Page, top: number): Promise<{ y: number; height: number }> {
  const result = await page.evaluate((target) => {
    window.scrollTo({ top: target, behavior: 'instant' });
    return { y: window.scrollY, height: document.documentElement.scrollHeight };
  }, top);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  return result;
}

/** Метрики области прокрутки панели — снимаются у самого элемента, не по стилям. */
function panelMetrics(page: Page) {
  return page.locator(PANEL).evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      position: style.position,
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
      viewport: window.innerHeight,
    };
  });
}

// ─── Десктоп 1280: две колонки, липкость, прокрутка внутри ────────────────────

test.describe('Расписание семинара на десктопе', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('расписание стоит сбоку от описания, а не под ним @d3-side-column', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);

    const schedule = await box(page.locator(SCHEDULE), 'расписание');
    const description = await box(page.locator(DESCRIPTION), 'описание');

    expect(
      schedule.x,
      `расписание не справа от описания: описание кончается на ${Math.round(description.x + description.width)}, расписание начинается на ${Math.round(schedule.x)}`,
    ).toBeGreaterThanOrEqual(description.x + description.width - 1);
    expect(
      schedule.y,
      `верх расписания (${Math.round(schedule.y)}) ниже верха описания (${Math.round(description.y)}) — колонка не поднята`,
    ).toBeLessThanOrEqual(description.y + 8);
  });

  test('описание не опускается от числа дат @d3-description-not-pushed', async ({ page }) => {
    expect(NO_DATES, 'в данных нет семинара без дат — сравнивать было не с чем').toBeDefined();

    const offsets: Record<string, number> = {};
    for (const target of [MOST_DATES, NO_DATES!]) {
      await openSeminar(page, target.path);
      const heading = await box(page.locator('h1'), 'заголовок');
      const description = await box(page.locator(DESCRIPTION), 'описание');
      offsets[target.path] = description.y - (heading.y + heading.height);

      expect(
        description.y,
        `${target.path}: описание начинается на ${Math.round(description.y)} — ниже первого экрана`,
      ).toBeLessThan(720);
      expect(
        description.y,
        `${target.path}: между заголовком и описанием ${Math.round(offsets[target.path])} px — расписание вклинилось`,
      ).toBeLessThanOrEqual(heading.y + heading.height + 48);
    }

    const withDates = offsets[MOST_DATES.path];
    const without = offsets[NO_DATES!.path];
    expect(
      Math.abs(withDates - without),
      `отступ описания зависит от числа дат: ${Math.round(withDates)} против ${Math.round(without)}`,
    ).toBeLessThanOrEqual(4);
  });

  test('запись видна на первом экране @d3-cta-first-screen', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);

    const cta = page.locator(REGISTER).first();
    await expect(cta, 'ссылки записи на странице нет').toBeVisible();
    const rect = await box(cta, 'кнопка записи');
    expect(
      rect.y + rect.height,
      `кнопка записи кончается на ${Math.round(rect.y + rect.height)} — за первым экраном (720)`,
    ).toBeLessThanOrEqual(720);
  });

  test('колонка остаётся на экране при прокрутке @d3-sticky', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);

    const scrolled = await scrollPageTo(page, 1800);
    expect(
      scrolled.y,
      `страница не прокрутилась на 1800 (высота ${scrolled.height}, прокрутка ${scrolled.y}) — липкость проверять было нечем`,
    ).toBeGreaterThan(1000);

    const panel = await box(page.locator(PANEL), 'панель расписания');
    expect(panel.y, `панель уехала выше экрана: верх на ${Math.round(panel.y)}`).toBeGreaterThanOrEqual(0);
    expect(panel.y, `панель не липнет: верх на ${Math.round(panel.y)} после прокрутки`).toBeLessThan(200);
    await expect(
      page.locator(PANEL).getByRole('heading', { name: 'Расписание' }),
      'заголовок расписания не виден после прокрутки',
    ).toBeInViewport();
  });

  test('таблица на шесть колонок заменена карточками @d3-card-list-instead-of-table', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);

    expect(
      await page.locator('.seminar-schedule-columns').count(),
      'на странице остался заголовок таблицы на шесть колонок',
    ).toBe(0);
    expect(await page.locator(ITEM).count(), 'карточек в колонке не столько, сколько актуальных дат')
      .toBe(MOST_DATES.dates);
  });

  test('короткий список не заводит прокрутку внутри колонки @d3-short-list-no-inner-scroll', async ({ page }) => {
    expect(ONE_DATE, 'в данных нет семинара ровно с одной датой — проверять было нечего').toBeDefined();
    await openSeminar(page, ONE_DATE!.path);

    const metrics = await panelMetrics(page);
    expect(
      metrics.scrollHeight,
      `у панели с одной карточкой прокрутка внутри: содержимое ${metrics.scrollHeight}, окно ${metrics.clientHeight}`,
    ).toBeLessThanOrEqual(metrics.clientHeight + 1);
  });

  // Решение: длинный список прокручивается ВНУТРИ липкой колонки (как в утверждённом
  // мокапе), а не отпускает колонку. Довод — измерение: из 126 страниц семинара даты
  // есть у 45, и колонку переполняют только 2 (распределение актуальных дат:
  // 1 → 38 страниц, 2 → 4, 3 → 1, 5 → 1, 7 → 1). Отпустить колонку значило бы
  // потерять кнопку записи ровно на тех двух страницах, где дат больше всего.
  //
  // Перегруз создаётся мутацией DOM, а не поиском подходящего семинара: число дат
  // меняется от хода времени, и проверка, ждущая семь дат в данных, стала бы ложно
  // красной при первом же обновлении расписания.
  test('переполненный список прокручивается внутри колонки, колонка остаётся липкой @d3-long-list-inner-scroll', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);

    const before = await panelMetrics(page);
    const itemCount = await page.locator(ITEM).count();
    expect(itemCount, 'в колонке нет ни одной карточки — размножать было нечего').toBeGreaterThan(0);

    const grown = await page.locator(PANEL).evaluate((node) => {
      const sample = node.querySelector('[data-seminar-schedule-card]');
      const list = sample?.parentElement;
      if (!sample || !list) throw new Error('список записей не найден');
      for (let i = 0; i < 12; i += 1) list.append(sample.cloneNode(true));
      return list.querySelectorAll('[data-seminar-schedule-card]').length;
    });
    expect(grown, 'мутация не добавила записей').toBeGreaterThan(itemCount);

    const after = await panelMetrics(page);
    expect(
      after.clientHeight,
      `панель выше экрана: окно ${after.clientHeight} при высоте экрана ${after.viewport}`,
    ).toBeLessThanOrEqual(after.viewport);
    expect(
      after.scrollHeight,
      `переполненная панель не прокручивается внутри: содержимое ${after.scrollHeight}, окно ${after.clientHeight}`,
    ).toBeGreaterThan(after.clientHeight);
    expect(after.overflowY, 'у панели нет своей области прокрутки').toBe('auto');
    expect(before.maxHeight, 'высота панели не ограничена — липкость на длинном списке потеряется').not.toBe('none');

    const moved = await page.locator(PANEL).evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    });
    expect(moved, 'панель не прокрутилась внутри себя').toBeGreaterThan(0);

    const scrolled = await scrollPageTo(page, 1800);
    expect(
      scrolled.y,
      `страница не прокрутилась (высота ${scrolled.height}) — липкость проверять было нечем`,
    ).toBeGreaterThan(1000);
    const panel = await box(page.locator(PANEL), 'панель расписания');
    expect(
      panel.y,
      `переполненная панель перестала липнуть: верх на ${Math.round(panel.y)} после прокрутки`,
    ).toBeLessThan(200);
  });

  // Дата не должна рваться посреди себя. В колонке 21 rem диапазон занимает две
  // строки — это нормально, а «г.» на строке один нет. Признак объективный: каждая
  // часть даты обязана укладываться в ОДИН прямоугольник переноса.
  test('дата не переносится посреди себя @d3-date-not-broken', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);

    const broken = await page.locator('[data-seminar-schedule-date-part]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: (node.textContent ?? '').trim(),
        lines: node.getClientRects().length,
      })),
    );
    expect(broken.length, 'частей даты на странице не нашлось — проверять было нечего')
      .toBeGreaterThan(0);
    const split = broken.filter((part) => part.lines !== 1);
    expect(
      split,
      `часть даты разорвана переносом: ${split.map((p) => `«${p.text}» на ${p.lines} строк`).join('; ')}`,
    ).toEqual([]);
  });

  // В печати колонка обязана отпускаться: `max-height` в единицах экрана с
  // `overflow: auto` обрезал бы список, и лишние даты исчезли бы с бумаги совсем —
  // прокрутить её нечем. До переноса расписание печаталось целиком, так что это
  // регресс, который вводит сама раскладка, а не давнее отсутствие печатных стилей.
  test('в печати колонка отпускается и список не обрезается @d3-print-released', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);
    await page.emulateMedia({ media: 'print' });

    const metrics = await panelMetrics(page);
    expect(metrics.position, 'панель осталась липкой в печати').toBe('static');
    expect(metrics.maxHeight, 'у панели остался предел высоты в печати').toBe('none');
    expect(
      metrics.scrollHeight,
      `список обрезан в печати: содержимое ${metrics.scrollHeight}, окно ${metrics.clientHeight}`,
    ).toBeLessThanOrEqual(metrics.clientHeight + 1);
  });
});

// ─── Узкие ширины: колонка отпускается, цена выбора названа заранее ───────────

for (const width of [768, 375] as const) {
  const height = width === 768 ? 1024 : 812;

  test.describe(`Расписание семинара на ${width}`, () => {
    test.use({ viewport: { width, height } });

    test(`расписание стоит над описанием во всю ширину @d3-narrow-stacked-${width}`, async ({ page }) => {
      await openSeminar(page, MOST_DATES.path);

      const schedule = await box(page.locator(SCHEDULE), 'расписание');
      const description = await box(page.locator(DESCRIPTION), 'описание');
      expect(
        schedule.y + schedule.height,
        `расписание (низ ${Math.round(schedule.y + schedule.height)}) не выше описания (верх ${Math.round(description.y)})`,
      ).toBeLessThanOrEqual(description.y + 1);
      expect(
        schedule.width,
        `расписание ${Math.round(schedule.width)} px при описании ${Math.round(description.width)} — колонка не разошлась во всю ширину`,
      ).toBeGreaterThanOrEqual(description.width * 0.9);
    });

    test(`колонка не липкая и без своей прокрутки @d3-narrow-released-${width}`, async ({ page }) => {
      await openSeminar(page, MOST_DATES.path);

      const metrics = await panelMetrics(page);
      expect(metrics.position, 'панель осталась липкой на узкой ширине').toBe('static');
      expect(metrics.maxHeight, 'у панели осталось ограничение высоты на узкой ширине').toBe('none');
      expect(
        metrics.scrollHeight,
        `прокрутка внутри блока во всю ширину: содержимое ${metrics.scrollHeight}, окно ${metrics.clientHeight}`,
      ).toBeLessThanOrEqual(metrics.clientHeight + 1);
    });

    test(`запись видна на первом экране @d3-narrow-cta-${width}`, async ({ page }) => {
      await openSeminar(page, MOST_DATES.path);

      const rect = await box(page.locator(REGISTER).first(), 'кнопка записи');
      expect(
        rect.y + rect.height,
        `кнопка записи кончается на ${Math.round(rect.y + rect.height)} — за первым экраном (${height})`,
      ).toBeLessThanOrEqual(height);
    });

    // Цена варианта C на узких ширинах принята владельцем при выборе, но проверить,
    // что она не стала ХУЖЕ названной, всё равно надо: карточки у нас несут больше
    // данных, чем в мокапе (продолжительность), и лишняя строка сдвинула бы описание
    // ниже обещанного.
    test(`описание не уезжает ниже названной цены @d3-narrow-named-cost-${width}`, async ({ page }) => {
      await openSeminar(page, MOST_DATES.path);

      const description = await box(page.locator(DESCRIPTION), 'описание');
      expect(
        Math.round(description.y),
        `описание на ${Math.round(description.y)} px при названной цене ${NAMED_COST[width]} (страница ${MOST_DATES.path}, дат ${MOST_DATES.dates})`,
      ).toBeLessThanOrEqual(NAMED_COST[width]);
    });
  });
}
