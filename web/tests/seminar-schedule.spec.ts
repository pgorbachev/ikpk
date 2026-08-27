import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calendarToday, isCurrentOrFuture } from '../src/lib/schedule-window';
import { installThirdPartyGuard } from './helpers/third-party-guard';

test.beforeEach(async ({ page }) => {
  await installThirdPartyGuard(page);
});

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

/**
 * Цена варианта C на узких ширинах, зафиксированная при выборе (finding 15 мокапов).
 *
 * Число названо для СЕМИ дат, и это часть самого числа: измерено, что каждая
 * дополнительная дата стоит 142 px на 768 и 163 px на 375, тогда как запас до потолка
 * — 88 и 104 px. То есть одна новая запись в расписании покраснила бы проверку без
 * всякой правки кода, а истечение дат сделало бы потолок вакуумным. Поэтому число
 * дат утверждается рядом с потолком: если данные разошлись, проверка обязана сказать
 * «цену надо переснять», а не тихо пройти и не упасть на раскладку.
 */
const NAMED_COST = { 768: 1447, 375: 1608 };
const NAMED_COST_DATES = 7;

interface SeminarPage {
  path: string;
  /** Актуальных дат на сегодня — столько записей и должно быть в колонке. */
  dates: number;
  /**
   * Есть ли у семинара описание. Берётся из данных, а не выясняется на странице:
   * у пяти семинаров из 126 описания нет в природе, и страница, выбранная без этого
   * признака, роняла бы измерение рамки описания вместо проверки раскладки.
   */
  described: boolean;
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
  const seminars = entities<{
    slug: string;
    course_group_legacy_id: string;
    description_html?: string | null;
    description_text?: string | null;
  }>('seminars.json');
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
      described: Boolean(
        (seminar.description_html ?? '').trim() || (seminar.description_text ?? '').trim(),
      ),
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
/** Страница без дат и С ОПИСАНИЕМ — их большинство каталога. */
const NO_DATES = PAGES.find((page) => page.dates === 0 && page.described);

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

  // Требование: расписание НЕ опускает описание — обе колонки начинаются на одной
  // высоте. Признак сравнивает два блока НА ОДНОЙ странице, а не две разные страницы
  // между собой. Прежняя редакция сравнивала отступ «заголовок → описание» на
  // датированной и недатированной странице и была зелена по совпадению: измерено по
  // всем 126 страницам, этот отступ равен 28 px на 113 из них, 52 px на восьми, а у
  // пяти описания нет вовсе. Попадись в выборку любая из тринадцати — тест обвинил бы
  // раскладку в разнице СОДЕРЖИМОГО либо упал на измерении рамки.
  test('расписание не опускает описание @d3-description-not-pushed', async ({ page }) => {
    expect(NO_DATES, 'в данных нет семинара без дат и с описанием — сравнивать было не с чем')
      .toBeDefined();

    for (const target of [MOST_DATES, NO_DATES!]) {
      await openSeminar(page, target.path);
      const schedule = await box(page.locator(SCHEDULE), 'расписание');
      const description = await box(page.locator(DESCRIPTION), 'описание');

      expect(
        Math.abs(description.y - schedule.y),
        `${target.path} (дат ${target.dates}): описание на ${Math.round(description.y)}, расписание на ${Math.round(schedule.y)} — колонки начинаются не на одной высоте`,
      ).toBeLessThanOrEqual(2);
      expect(
        description.y,
        `${target.path}: описание начинается на ${Math.round(description.y)} — ниже первого экрана`,
      ).toBeLessThan(720);
    }
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

  // Признак — форма разметки, а не имя удалённого класса. Прежняя редакция проверяла
  // `.seminar-schedule-columns` (заголовок таблицы на шесть колонок), а этой строки
  // после удаления старого компонента нет в дереве нигде: утверждение не могло упасть
  // иначе как от возврата ровно того же имени класса. Это то самое «совпадение по
  // имени CSS-класса», которое эта же работа вычистила из двух гейтов паритета.
  //
  // Что проверяется теперь: записей столько же, сколько актуальных дат (и их больше
  // нуля — иначе признак вырождается в `0 === 0`), а сама колонка выложена списком, а
  // не шестиколоночной сеткой.
  test('расписание выложено списком записей по числу дат @d3-card-list-instead-of-table', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);

    expect(MOST_DATES.dates, 'у самой заполненной страницы нет дат — проверять было нечего')
      .toBeGreaterThan(0);
    expect(await page.locator(ITEM).count(), 'записей в колонке не столько, сколько актуальных дат')
      .toBe(MOST_DATES.dates);

    const columns = await page.locator(PANEL).evaluate((node) =>
      [...node.querySelectorAll('*')]
        .map((child) => getComputedStyle(child).gridTemplateColumns)
        .filter((value) => value && value !== 'none')
        .map((value) => value.split(/\s+/).length),
    );
    expect(
      columns.filter((count) => count > 2),
      `внутри колонки осталась сетка на ${columns.filter((c) => c > 2).join(', ')} дорожек — это таблица, а не список`,
    ).toEqual([]);
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
    // Граница ДВУСТОРОННЯЯ, и это не педантизм: одно `toBeLessThan(200)` устраивает
    // панель, уехавшую ВЫШЕ экрана (измерено: при снятой липкости `panel.y = −1572`,
    // и весь тест оставался зелёным). Соседний `@d3-sticky` пару границ имеет, здесь
    // она была потеряна — нашло независимое ревью, а не мутация: M1 давала «14 зелёных
    // из 15», то есть по цвету прогона дыра не видна.
    expect(
      panel.y,
      `переполненная панель уехала выше экрана: верх на ${Math.round(panel.y)}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      panel.y,
      `переполненная панель перестала липнуть: верх на ${Math.round(panel.y)} после прокрутки`,
    ).toBeLessThan(200);
  });

  // Требование к дате: год и «г.» никогда не расходятся по строкам. Именно этот
  // разрыв и был дефектом — неразрывным был только конец диапазона, поэтому перенос
  // выпадал на пробел перед «г.» начальной даты и строка получалась из одного «г.».
  //
  // Проверять это надо там, где перенос ВЫНУЖДЕН, иначе предмета нет: в колонке
  // 21 rem дата целиком укладывается в строку сама, и любой признак пройдёт. Поэтому
  // кегль поднимается вдвое — то же состояние, что проверяет гейт роста кегля, — и
  // отдельно утверждается, что перенос действительно случился.
  test('год и «г.» не расходятся по строкам при вынужденном переносе @d3-date-not-broken', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);

    const measured = await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
      const parts = [...document.querySelectorAll('[data-seminar-schedule-date-part]')];
      const era = /(\d{4})\u00A0(г\.)/u;
      const out: { text: string; partLines: number; eraLines: number }[] = [];
      for (const part of parts) {
        const node = [...part.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined;
        if (!node) continue;
        const match = era.exec(node.data);
        if (!match) continue;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        out.push({
          text: node.data,
          partLines: part.getClientRects().length,
          eraLines: range.getClientRects().length,
        });
      }
      return out;
    });

    expect(measured.length, 'ни в одной дате не нашлось группы «год + г.» — проверять было нечего')
      .toBeGreaterThan(0);
    expect(
      measured.some((m) => m.partLines > 1),
      `при двойном кегле ни одна дата не перенеслась — предмета у проверки нет: ${JSON.stringify(measured.slice(0, 2))}`,
    ).toBe(true);
    const split = measured.filter((m) => m.eraLines !== 1);
    expect(
      split,
      `год и «г.» разошлись по строкам: ${split.map((m) => `«${m.text}»`).join('; ')}`,
    ).toEqual([]);
  });

  // Дата и цена — самые важные данные карточки, и они обязаны нести акцентные
  // чернила, а не краску обычного абзаца. Признак сравнительный, а не «конкретный
  // hex»: значения ролевых токенов разные в светлой и тёмной теме, а требование одно
  // — `--text-primary` у даты и цены против `--text-body` у пояснений. Проверка
  // появилась после того, как переезд из таблицы в карточку тихо уравнял их с прозой
  // (было `rgb(26,26,26)`, стало `rgb(112,112,112)`) при проходящем контрасте AA:
  // пропала не читаемость, а иерархия, и не краснел ни один гейт.
  test('дата и цена несут акцентные чернила, а не краску прозы @d3-primary-data-ink', async ({ page }) => {
    await openSeminar(page, MOST_DATES.path);

    const ink = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const resolve = (name: string) => {
        const probe = document.createElement('span');
        probe.style.color = root.getPropertyValue(name).trim();
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      const colorOf = (selector: string) => {
        const node = document.querySelector(selector);
        return node ? getComputedStyle(node).color : null;
      };
      return {
        primary: resolve('--text-primary'),
        body: resolve('--text-body'),
        date: colorOf('.schedule-date'),
        price: colorOf('.schedule-price'),
        meta: colorOf('.schedule-meta'),
      };
    });

    expect(ink.primary, 'токен --text-primary не разрешился — сравнивать было нечем').toBeTruthy();
    expect(ink.primary, 'акцентные чернила совпали с краской прозы — признак вырожден')
      .not.toBe(ink.body);
    expect(ink.date, 'у даты краска прозы, а не акцентные чернила').toBe(ink.primary);
    expect(ink.price, 'у цены краска прозы, а не акцентные чернила').toBe(ink.primary);
    expect(ink.meta, 'пояснительная строка должна остаться краской прозы').toBe(ink.body);
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

    // Колонку не должно распирать содержимым. Признак — мутация DOM, а не надежда на
    // данные: в панель вставляется неразрывная строка длиннее контейнера, и колонка
    // обязана остаться в его пределах, а страница — не поехать по горизонтали.
    //
    // Гарантия названа узко и честно: `min-width: 0` держит в пределах контейнера саму
    // КОЛОНКУ, но не обещает, что неразрывный текст не вылезет из панели наружу — на
    // отпущенной панели он вылезет, и горизонтальная прокрутка страницы появится. В наших
    // данных таких токенов нет (год и «г.» склеены одним пробелом, остальное переносится),
    // и это утверждение про данные, а не про раскладку.
    //
    // Проверка живёт на УЗКИХ ширинах, и это не произвол. На десктопе панель — контейнер
    // прокрутки (`overflow: auto`), а он по построению не отдаёт наружу внутреннюю ширину
    // содержимого: там свойство инертно, и первая редакция этой проверки честно упала со
    // словами «распирать было нечем» — проба вышла 297 px против дорожки 336. Ниже 1024
    // панель отпущена (`overflow: visible`), и автоминимум грид-элемента снова считается
    // по содержимому — именно там `min-width: 0` и работает.
    test(`колонку не распирает неразрывное содержимое @d3-column-not-distended-${width}`, async ({ page }) => {
      await openSeminar(page, MOST_DATES.path);

      const measured = await page.evaluate(() => {
        const aside = document.querySelector('[data-testid="seminar-schedule"]') as HTMLElement;
        const probe = document.createElement('div');
        probe.textContent = 'Ж'.repeat(200);
        probe.style.whiteSpace = 'nowrap';
        aside.querySelector('[data-seminar-schedule-panel]')!.append(probe);
        const cols = aside.parentElement as HTMLElement;
        return {
          aside: Math.round(aside.getBoundingClientRect().width),
          container: Math.round(cols.getBoundingClientRect().width),
          // Внутренняя ширина, а не рамка: у блочного элемента рамка равна контейнеру, а
          // наружу лезет ТЕКСТ. Первая редакция мерила рамку и честно падала со словами
          // «распирать было нечем» (304 px против контейнера 343).
          probe: Math.round(probe.scrollWidth),
        };
      });

      expect(
        measured.probe,
        `проба ${measured.probe} px не шире контейнера ${measured.container} px — распирать было нечем`,
      ).toBeGreaterThan(measured.container);
      expect(
        measured.aside,
        `колонка ${measured.aside} px при контейнере ${measured.container} px — её распёрло содержимым`,
      ).toBeLessThanOrEqual(measured.container);
    });

    // Цена варианта C на узких ширинах принята владельцем при выборе, но проверить,
    // что она не стала ХУЖЕ названной, всё равно надо: карточки у нас несут больше
    // данных, чем в мокапе (продолжительность), и лишняя строка сдвинула бы описание
    // ниже обещанного.
    // Инвариант раскладки, не зависящий ни от числа дат, ни от их истечения: описание
    // начинается сразу под блоком расписания, а не через пустоту. Он и есть постоянная
    // часть «цены» — переменная часть (высота самого блока) приходит из данных, и
    // потолок ниже к ней привязан явно.
    test(`описание начинается сразу под расписанием @d3-narrow-gap-${width}`, async ({ page }) => {
      await openSeminar(page, MOST_DATES.path);

      const schedule = await box(page.locator(SCHEDULE), 'расписание');
      const description = await box(page.locator(DESCRIPTION), 'описание');
      const gap = description.y - (schedule.y + schedule.height);
      expect(
        Math.round(gap),
        `между расписанием и описанием ${Math.round(gap)} px — больше, чем отступ раскладки`,
      ).toBeLessThanOrEqual(40);
      expect(Math.round(gap), `описание залезает на расписание: ${Math.round(gap)} px`)
        .toBeGreaterThanOrEqual(0);
    });

    test(`описание не уезжает ниже названной цены @d3-narrow-named-cost-${width}`, async ({ page }) => {
      await openSeminar(page, MOST_DATES.path);

      expect(
        MOST_DATES.dates,
        `цена названа для ${NAMED_COST_DATES} дат, а у самой заполненной страницы их ${MOST_DATES.dates}: при большем числе потолок покраснеет от данных, при меньшем станет вакуумным. Число надо переснять на текущих данных и обновить NAMED_COST`,
      ).toBe(NAMED_COST_DATES);

      const description = await box(page.locator(DESCRIPTION), 'описание');
      expect(
        Math.round(description.y),
        `описание на ${Math.round(description.y)} px при названной цене ${NAMED_COST[width]} (страница ${MOST_DATES.path}, дат ${MOST_DATES.dates})`,
      ).toBeLessThanOrEqual(NAMED_COST[width]);
    });
  });
}
