import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scheduleSupplements } from '../src/lib/schedule-supplements';
import { calendarToday, isCurrentOrFuture } from '../src/lib/schedule-window';
// Псевдоним, а не прямое имя: параметр `monthKeys` уже занят в `syntheticMarkup` и
// `mountSynthetic`, и тень над импортом читалась бы как одно и то же.
import { monthKeys as monthKeysOf } from '../src/lib/schedule-months';

// ─── Браузерные проверки фильтра расписания по месяцу ────────────────────────
// Спецификация: openspec/changes/schedule-month-filter/specs/schedule-month-filter/spec.md
// Требования: «Выбор месяца складывается с остальными фильтрами и с пагинацией»,
// «Контрол месяца не обещает того, чего не делает», «Месяц записи выводится на
// сервере» (сценарий про заплатки), «Проверка месяца обязана исполняться в гейте
// публикации».
//
// Файл КРАСНЫЙ по замыслу: контрола месяца на странице ещё нет.
//
// Файл исполняется workflow `Tests` — через `npm run test:e2e:schedule`, вписанный
// в job `e2e-smoke` рядом с `test:e2e:catalog`. Положить эти проверки в
// `schedule-parity.spec.ts` нельзя: его не запускает ни один workflow, и проверка
// была бы зелёной ровно потому, что её никто не выполняет.
//
// Общее правило: предмет проверки (месяц, город, число записей) берётся из
// фактического содержимого страницы. Захардкоженный «сентябрь 2026» превратился бы
// в ложное падение при первом обновлении данных, а сценарий без подходящего
// предмета обязан сказать «проверять было нечего», а не отчитаться об успехе.

const PAGE = '/raspisanie-i-tseny';
const MONTH = '[data-schedule-filter="month"]';
const INSTITUTE = '[data-schedule-filter="institute"]';
const PROGRAM = '[data-schedule-filter="program"]';
const CITY = '[data-schedule-filter="city"]';
const SEARCH = '[data-schedule-search]';
const ITEM = '[data-schedule-item]';
const PAGINATION = '[data-schedule-pagination]';
const EMPTY = '[data-schedule-empty]';
const PAGE_SIZE = 25;

interface Entry {
  months: string[];
  city: string;
  institute: string;
  title: string;
}

/**
 * Открыть расписание и убедиться, что разбирать есть что.
 *
 * Код ответа утверждается явно: разбор страницы 404 проходит всегда — на ней нет
 * ни записей, ни контролов, поэтому любой цикл по ним пуст и «нарушений нет».
 * Ожидание включённого контрола заодно проверяет, что скрипт его включает: в
 * разметку он приезжает `disabled`.
 */
async function openSchedule(page: Page): Promise<Entry[]> {
  const response = await page.goto(PAGE);
  expect(response?.status(), `${PAGE}: страница не отдалась — проверять было нечего`).toBe(200);
  await expect(page.locator(MONTH), 'контрол месяца не включён скриптом').toBeEnabled();

  const entries = await readEntries(page, ITEM);
  expect(entries.length, 'на странице нет ни одной записи расписания — проверять было нечего')
    .toBeGreaterThan(0);
  return entries;
}

function readEntries(page: Page, selector: string): Promise<Entry[]> {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => ({
      months: (node.getAttribute('data-months') ?? '').split(' ').filter(Boolean),
      city: node.getAttribute('data-city') ?? '',
      institute: node.getAttribute('data-institute') ?? '',
      title: (node.querySelector('[data-testid="schedule-card-title"]')?.textContent ?? '').trim(),
    })),
  );
}

const shown = (page: Page): Promise<Entry[]> => readEntries(page, `${ITEM}:not([hidden])`);

/** Месяцы, предложенные контролом, кроме пустого значения. */
async function offeredMonths(page: Page): Promise<string[]> {
  const values = await page
    .locator(`${MONTH} option`)
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).filter(Boolean));
  expect(values.length, 'контрол месяца не предложил ни одного месяца — проверять было нечего')
    .toBeGreaterThan(0);
  return values;
}

/** Записи выбранного месяца по признаку карточки — ожидание для выдачи. */
const inMonth = (entries: Entry[], key: string): Entry[] => entries.filter((entry) => entry.months.includes(key));

/** Запись снапшота в объёме, нужном для окна актуальности и склейки с заплатками. */
interface SnapshotEntry {
  status?: string;
  startAt?: string;
  endAt?: string;
  seminar?: { slug?: string };
}

/**
 * Сколько записей живо на дату `today` по ДАННЫМ и окну актуальности — то есть
 * сколько их обязано быть на странице.
 *
 * Зачем второй счёт, если число записей видно на странице: ветка `@month-pagination`
 * выбирается по странице, и она обязана отличать «записей мало законно, события
 * прошли» от «записи потеряли». Первое видно только сверкой с данными.
 *
 * Почему снапшот читается напрямую, а не через `src/lib/data.ts`: тот модуль тянет
 * `import.meta.env` (через `html-cleaner` → `forms`), которого в прогоне Playwright
 * нет вовсе — импорт падает на `forms.ts:22`. Окно и склейка с заплатками берутся из
 * тех же модулей, что у страницы (`schedule-window`, `schedule-supplements`), поэтому
 * расходиться со сборкой может только правило склейки — и на этом ветка покраснеет,
 * а не промолчит.
 */
function liveEntryCount(today: string): number {
  const file = join(import.meta.dirname, '..', '..', 'discovery', 'entities', 'schedule_entries.json');
  const base = JSON.parse(readFileSync(file, 'utf-8')) as SnapshotEntry[];
  expect(base.length, `${file}: снапшот расписания пуст — считать нечего`).toBeGreaterThan(0);

  const key = (entry: SnapshotEntry): string => `${entry.seminar?.slug}:${entry.startAt}`;
  const known = new Set(base.map(key));
  const all = [...base, ...(scheduleSupplements as SnapshotEntry[]).filter((entry) => !known.has(key(entry)))];
  return all.filter((entry) => entry.status === 'active' && isCurrentOrFuture(entry, today)).length;
}

test.describe('выбор месяца сужает выдачу', () => {
  test('показаны только записи выбранного месяца @month-narrow', async ({ page }) => {
    const entries = await openSchedule(page);
    const months = await offeredMonths(page);
    // Берём самый населённый из предложенных: на нём видно и сужение, и что
    // выдача не опустела по постороннней причине.
    const key = months.reduce((best, m) => (inMonth(entries, m).length > inMonth(entries, best).length ? m : best));
    const expected = inMonth(entries, key);
    expect(expected.length, `месяц ${key} без записей — проверять было нечего`).toBeGreaterThan(0);

    await page.locator(MONTH).selectOption(key);

    const visible = await shown(page);
    expect(visible.length).toBe(Math.min(expected.length, PAGE_SIZE));
    const alien = visible.filter((entry) => !entry.months.includes(key));
    expect(alien.map((e) => e.title), `в выдаче записи чужого месяца:\n${alien.map((e) => e.title).join('\n')}`)
      .toEqual([]);
  });

  test('месяц вместе с городом даёт пересечение @month-city', async ({ page }) => {
    const entries = await openSchedule(page);
    const months = await offeredMonths(page);

    // Пара «месяц + город» подбирается по фактическим признакам страницы, и
    // предпочитается та, где пересечение СТРОГО меньше каждого из двух множеств.
    // Прежняя редакция брала любую пару и проверяла, что в этом месяце есть запись с
    // этим городом, — условие, ложным быть не способное: пара из такой записи и
    // построена. Отбор без строгости пропускал бы случай, когда второй фильтр
    // проигнорирован целиком: если весь месяц в одном городе, выдача «месяц» и выдача
    // «месяц + город» совпадают, и подмена неотличима.
    const candidates = months.flatMap((key) => [
      ...new Set(inMonth(entries, key).map((entry) => entry.city).filter(Boolean)),
    ].map((city) => ({ key, city })));
    expect(candidates.length, 'ни у одной записи страницы нет города — пересечение проверять нечем')
      .toBeGreaterThan(0);

    const narrowing = candidates.find(({ key, city }) => {
      const both = inMonth(entries, key).filter((entry) => entry.city === city).length;
      const byCity = entries.filter((entry) => entry.city === city).length;
      return both < inMonth(entries, key).length && both < byCity;
    });
    // Если строгой пары нет (в каждом месяце один город и каждый город в одном месяце),
    // берётся любая: проверка пересечения остаётся верной, просто слабее. Падать из-за
    // состава данных нельзя — по мере прохождения событий записей становится меньше, и
    // строгих пар может не остаться на исправном коде.
    const pair = narrowing ?? candidates[0];

    const expected = inMonth(entries, pair.key).filter((entry) => entry.city === pair.city);
    await page.locator(MONTH).selectOption(pair.key);
    await page.locator(CITY).selectOption(pair.city);

    const visible = await shown(page);
    expect(visible.length).toBe(Math.min(expected.length, PAGE_SIZE));
    const alien = visible.filter((entry) => !entry.months.includes(pair.key) || entry.city !== pair.city);
    expect(alien.map((e) => e.title), 'выдача не является пересечением месяца и города').toEqual([]);
  });

  test('месяц и поиск дают один набор в любом порядке @month-search-order', async ({ page }) => {
    const entries = await openSchedule(page);
    const months = await offeredMonths(page);
    const key = months.reduce((best, m) => (inMonth(entries, m).length > inMonth(entries, best).length ? m : best));

    // Запрос берётся из заголовка фактической записи месяца, а не константой.
    const sample = inMonth(entries, key).find((entry) => entry.title.length > 6);
    expect(sample, `в месяце ${key} нет записи с заголовком — запрос строить не из чего`).toBeDefined();
    const term = sample!.title.split(/\s+/).find((word) => word.length >= 5)?.toLowerCase();
    expect(term, `в заголовке «${sample!.title}» нет слова длиной 5+ — запрос строить не из чего`).toBeDefined();

    await page.locator(SEARCH).fill(term!);
    await page.locator(MONTH).selectOption(key);
    const searchFirst = (await shown(page)).map((entry) => entry.title).sort();

    await page.locator(MONTH).selectOption('');
    await page.locator(SEARCH).fill('');
    await page.locator(MONTH).selectOption(key);
    await page.locator(SEARCH).fill(term!);
    const monthFirst = (await shown(page)).map((entry) => entry.title).sort();

    expect(searchFirst.length, `запрос «${term}» в месяце ${key} не нашёл ничего — проверять было нечего`)
      .toBeGreaterThan(0);
    expect(monthFirst).toEqual(searchFirst);
  });

  test('сочетание без записей показывает пустое состояние @month-empty-state', async ({ page }) => {
    const entries = await openSchedule(page);
    const months = await offeredMonths(page);
    const cities = [...new Set(entries.map((entry) => entry.city).filter(Boolean))];

    const pair = months
      .flatMap((key) => cities.map((city) => ({ key, city })))
      .find(({ key, city }) => !inMonth(entries, key).some((entry) => entry.city === city));
    expect(pair, 'каждое сочетание месяца и города непусто — проверять было нечего').toBeDefined();

    await page.locator(MONTH).selectOption(pair!.key);
    await page.locator(CITY).selectOption(pair!.city);

    await expect(page.locator(EMPTY)).toBeVisible();
    expect((await shown(page)).length).toBe(0);
  });

  test('адрес страницы от выбора месяца не меняется @month-url-stable', async ({ page }) => {
    await openSchedule(page);
    const before = page.url();
    const months = await offeredMonths(page);
    await page.locator(MONTH).selectOption(months[0]);
    expect(page.url()).toBe(before);
  });
});

test.describe('месяц и остальное управление', () => {
  test('выбор института после месяца ограничивает программы и не меняет список месяцев @month-cascade', async ({ page }) => {
    const entries = await openSchedule(page);
    const monthsBefore = await offeredMonths(page);

    const key = monthsBefore.reduce((best, m) =>
      inMonth(entries, m).length > inMonth(entries, best).length ? m : best);
    const institute = inMonth(entries, key).map((entry) => entry.institute).find(Boolean);
    expect(institute, `у записей месяца ${key} нет института — каскад проверять нечем`).toBeDefined();

    await page.locator(MONTH).selectOption(key);
    await page.locator(INSTITUTE).selectOption(institute!);

    const programs = await page
      .locator(`${PROGRAM} option`)
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node as HTMLOptionElement)
          .filter((option) => option.value)
          .map((option) => option.dataset.institute ?? ''),
      );
    expect(programs.length, 'список программ пуст — каскад проверять нечем').toBeGreaterThan(0);
    expect(
      programs.filter((slug) => slug !== institute),
      'в списке программ остались программы чужого института',
    ).toEqual([]);

    // Месяц не каскадируется — так же, как не пересчитывается список городов.
    expect(await offeredMonths(page), 'список месяцев пересчитался под институт').toEqual(monthsBefore);
  });

  test('пагинация исчезает при выборе месяца и возвращается при сбросе @month-pagination', async ({ page }) => {
    const entries = await openSchedule(page);
    const months = await offeredMonths(page);

    // Требование закрывает синтетический сценарий `@month-pagination-return`; здесь —
    // характеризация живого набора, и от хода времени она зависеть не должна.
    // Ветка выбирается по СТРАНИЦЕ, а не по дате в тексте теста, — тем же приёмом и по
    // той же причине, что в `@month-supplement`: предмет «страниц больше одной»
    // исчезает от хода времени, а не от дефекта. Живых записей на 2026-08-12 — 64; окно
    // актуальности убирает их по мере прохождения событий, и на 2026-11-24 живых
    // остаётся ровно 25, то есть требование «больше 25» перестало бы выполняться на
    // исправном коде — внутри единственного прогона, который держит публикацию (TD-21).
    // Падать нельзя: ложное красное в гейте публикации дороже ложного зелёного. `skip`
    // нельзя тоже: помеченный тест в собранном наборе виден, но выполняемым не
    // считается, и мета-гейт покраснел бы по метке `@month-pagination`.
    if (entries.length <= PAGE_SIZE) {
      // Страница одна, скрывать нечего — но ветка не пустая, а утверждает наблюдаемое с
      // двух сторон. Первое: столько записей и должно быть по данным; если по снапшоту и
      // окну живых больше страницы, значит записи потеряны, и ветка краснеет. Второе:
      // при одной странице пагинации не должно быть ни до выбора месяца, ни после, ни
      // после сброса — это ловит обратный дефект, «пагинация показана всегда».
      const today = calendarToday();
      const live = liveEntryCount(today);
      expect(
        live,
        `на странице записей ${entries.length}, не больше страницы, а по снапшоту и окну актуальности на ${today} живых ${live} — записи потеряны`,
      ).toBeLessThanOrEqual(PAGE_SIZE);

      await expect(page.locator(PAGINATION), 'при одной странице пагинация показана').toBeHidden();

      const single = months.find((key) => inMonth(entries, key).length > 0);
      expect(single, 'ни в одном предложенном месяце нет записей — контрол расходится с выдачей')
        .toBeDefined();
      await page.locator(MONTH).selectOption(single!);
      await expect(page.locator(PAGINATION), 'выбор месяца создал пагинацию из одной страницы').toBeHidden();

      await page.locator(MONTH).selectOption('');
      await expect(page.locator(PAGINATION), 'сброс месяца создал пагинацию из одной страницы').toBeHidden();
      return;
    }

    await expect(page.locator(PAGINATION)).toBeVisible();

    const key = months.find((m) => inMonth(entries, m).length > 0 && inMonth(entries, m).length <= PAGE_SIZE);
    expect(key, `ни один месяц не укладывается в одну страницу — проверять было нечего`).toBeDefined();

    await page.locator(MONTH).selectOption(key!);
    await expect(page.locator(PAGINATION)).toBeHidden();

    await page.locator(MONTH).selectOption('');
    await expect(page.locator(PAGINATION)).toBeVisible();
  });

  test('запись-заплатка достижима выбором своего месяца @month-supplement', async ({ page }) => {
    const entries = await openSchedule(page);
    const months = await offeredMonths(page);

    // Идентификатора записи в разметке нет вовсе, поэтому заплатка узнаётся по
    // заголовку из своего источника. «Месяц только с заплаткой» проверить нельзя:
    // обе приходятся на октябрь 2026, где ещё 12 обычных записей.
    const present = scheduleSupplements
      .map((supplement) => ({
        title: supplement.name,
        key: (supplement.startAt ?? '').slice(0, 7),
        entry: entries.find((entry) => entry.title === supplement.name),
      }))
      .find((candidate) => candidate.entry && months.includes(candidate.key));

    // Требование закрывает синтетический сценарий `@month-supplement-synthetic`; здесь —
    // характеризация живого набора, и от хода времени она зависеть не должна.
    //
    // Ветка выбирается по СТРАНИЦЕ, а не по дате в тексте теста, и обе ветки —
    // настоящие проверки.
    //
    // Почему не «падать, если заплаток нет». Обе заплатки однодневные, 2026-10-01 и
    // 2026-10-08; после 2026-10-08 окно актуальности законно уберёт обе, предмет
    // исчезнет от хода времени, а не от дефекта — и проверка начала бы стабильно
    // краснеть ВНУТРИ единственного прогона, который держит публикацию. Ложное
    // красное в гейте публикации дороже ложного зелёного (AGENTS.md), поэтому
    // «проверять было нечего» здесь не тот выход.
    //
    // Почему не `skip`. Помеченный тест в собранном наборе виден, но выполняемым не
    // считается, и мета-гейт покраснел бы по метке `@month-supplement`. Два гейта
    // поймали бы друг друга.
    if (present === undefined) {
      // Заплаток на странице нет. Это законно, только если окно их отсекло; если хотя
      // бы одна ещё в окне, значит её потеряли — и тогда ветка краснеет.
      const today = calendarToday();
      const stillInWindow = scheduleSupplements
        .filter((supplement) => isCurrentOrFuture(supplement, today))
        .map((supplement) => supplement.name);
      expect(
        stillInWindow,
        `заплатки в окне актуальности на ${today}, но на странице их нет — запись потеряна:\n${stillInWindow.join('\n')}`,
      ).toEqual([]);

      const titles = new Set(entries.map((entry) => entry.title));
      expect(
        scheduleSupplements.filter((supplement) => titles.has(supplement.name)).map((s) => s.name),
        'заплатка на странице есть, но её месяц не предложен контролом — она недостижима выбором',
      ).toEqual([]);
      return;
    }

    const together = inMonth(entries, present.key);
    expect(
      together.length,
      `месяц ${present.key} не укладывается в одну страницу (${together.length}) — заплатка может лежать на второй`,
    ).toBeLessThanOrEqual(PAGE_SIZE);

    await page.locator(MONTH).selectOption(present.key);

    const visible = await shown(page);
    expect(
      visible.map((entry) => entry.title),
      `заплатка «${present.title}» не попала в выдачу месяца ${present.key}`,
    ).toContain(present.title);
    expect(
      visible.filter((entry) => entry.title !== present.title).length,
      'в месяце заплатки нет обычных записей — сценарий проверяет не то',
    ).toBeGreaterThan(0);
  });
});

test.describe('контрол месяца доступен', () => {
  test('у контрола есть доступное имя и видимый индикатор фокуса @month-a11y-focus', async ({ page }) => {
    await openSchedule(page);
    const control = page.locator(MONTH);

    // Существующая проверка фокуса берёт `select` через `.first()` — то есть смотрит
    // только на институт и новый контрол не увидит.
    await expect(control).toHaveAccessibleName(/месяц/i);

    await control.focus();
    const info = await control.evaluate((node) => {
      const style = getComputedStyle(node as Element);
      return {
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
        boxShadow: style.boxShadow,
      };
    });
    const hasOutline = info.outlineStyle !== 'none' && parseFloat(info.outlineWidth) > 0;
    const strongShadow = info.boxShadow !== 'none' && !/rgba\([^)]*0?\.0?[0-9]\)/.test(info.boxShadow);
    expect(
      hasOutline || strongShadow,
      `контрол месяца в фокусе без видимого индикатора: outline ${info.outlineWidth} ${info.outlineStyle}, shadow ${info.boxShadow}`,
    ).toBe(true);
  });

  // НОВАЯ ИНФРАСТРУКТУРА, объявляется вслух: это первый в проекте прогон с
  // отключённым JavaScript (`javaScriptEnabled` до сих пор не встречался нигде).
  // Она нужна именно здесь и только здесь: включение контрола скриптом происходит
  // по ходу разбора документа, поэтому измерение в обычном браузерном тесте
  // наблюдает уже конечное состояние и сдвига раскладки увидеть не может ни при
  // каком дефекте. Второй контекст даёт состояние «до включения» честно.
  test('включение контрола не сдвигает раскладку @month-no-layout-shift', async ({ page, browser }) => {
    const measure = async (target: Page): Promise<{ control: unknown; first: unknown }> => {
      const box = async (selector: string): Promise<unknown> => {
        const rect = await target.locator(selector).first().boundingBox();
        expect(rect, `${selector}: элемент не найден — измерять нечего`).not.toBeNull();
        return {
          x: Math.round(rect!.x),
          y: Math.round(rect!.y),
          width: Math.round(rect!.width),
          height: Math.round(rect!.height),
        };
      };
      return { control: await box(MONTH), first: await box(ITEM) };
    };

    const withoutJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 720 } });
    const staticPage = await withoutJs.newPage();
    const response = await staticPage.goto(PAGE);
    expect(response?.status(), `${PAGE}: страница не отдалась без JavaScript — измерять нечего`).toBe(200);
    await expect(staticPage.locator(MONTH), 'без JavaScript контрол месяца выглядит рабочим').toBeDisabled();
    const before = await measure(staticPage);
    await withoutJs.close();

    await openSchedule(page);
    const after = await measure(page);

    expect(after.control, 'включение контрола изменило метрики его бокса').toEqual(before.control);
    expect(after.first, 'включение контрола сдвинуло первую запись списка').toEqual(before.first);
  });

  test('на экране 375 CSS-пикселей контрол виден, работает и не создаёт переполнения @month-mobile', async ({ page }) => {
    // Обычный кегль намеренно: проверка переполнения при удвоенном кегле на этой
    // странице помечена `fixme` по TD-5 и на новом дефекте не покраснеет.
    await page.setViewportSize({ width: 375, height: 812 });
    const entries = await openSchedule(page);
    const months = await offeredMonths(page);

    const control = page.locator(MONTH);
    await expect(control).toBeVisible();
    await expect(control).toBeInViewport();

    const key = months.reduce((best, m) => (inMonth(entries, m).length > inMonth(entries, best).length ? m : best));
    await control.selectOption(key);
    const visible = await shown(page);
    expect(visible.length, `выбор месяца ${key} на узком экране ничего не показал`).toBeGreaterThan(0);
    expect(visible.filter((entry) => !entry.months.includes(key)), 'на узком экране фильтр работает иначе').toEqual([]);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `страница переполняется по горизонтали: ${overflow.scrollWidth} > ${overflow.clientWidth}`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});

// ─── Синтетический набор: то, чего реальные данные не показывают ─────────────
// Скрипт управления поднимается из собранной страницы по своему признаку и
// исполняется над разметкой, которую мы задаём сами. Производственный код при этом
// не меняется вовсе.
//
// Зачем так: сброс на первую страницу на реальных данных НЕНАБЛЮДАЕМ — самый
// населённый месяц даёт 15 записей при 25 на странице, и зажим
// `currentPage = Math.min(currentPage, pageCount)` приводит к первой странице даже
// без сброса. Браузерный тест по данным зелен и при сломанном поведении, то есть был
// бы ложным свидетельством, а негативная мутация «убрать сброс» не покраснела бы и
// объявила бы гейт декоративным.
//
// Цена честная: набор воспроизводит контракт разметки и при её изменении протухнет.
// Поэтому он опирается на те же признаки, что и проверки выше, — расхождение
// проявится падением, а не молчанием.

const distPage = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'dist', 'raspisanie-i-tseny', 'index.html'), 'utf-8');

function controlsScriptText(): string {
  const block = distPage().match(/<script\b[^>]*\bdata-schedule-controls\b[^>]*>([\s\S]*?)<\/script>/i);
  expect(
    block?.[1],
    'блок скрипта управления не опознан по data-schedule-controls — поднимать нечего',
  ).toBeTruthy();
  return block?.[1] ?? '';
}

interface SyntheticEntry {
  months: string[];
  city?: string;
  title: string;
}

function syntheticMarkup(entries: SyntheticEntry[], monthKeys: string[], withMonthControl = true): string {
  const options = monthKeys.map((key) => `<option value="${key}">${key} (${entries.filter((e) => e.months.includes(key)).length})</option>`).join('');
  const cities = [...new Set(entries.map((entry) => entry.city).filter(Boolean))];
  const items = entries
    .map(
      (entry) => `<div data-schedule-item data-institute="" data-program="" data-city="${entry.city ?? ''}"
        data-search="${entry.title.toLowerCase()}" data-months="${entry.months.join(' ')}">
        <article><h2 data-testid="schedule-card-title"><a href="#">${entry.title}</a></h2></article>
      </div>`,
    )
    .join('');

  return `
    <div class="schedule-toolbar">
      <label>Поиск<input type="search" data-schedule-search /></label>
      ${withMonthControl ? `<label>Месяц<select data-schedule-filter="month" disabled><option value="">Не выбрано</option>${options}</select></label>` : ''}
      <label>Институт<select data-schedule-filter="institute"><option value="">Не выбрано</option></select></label>
      <label>Программа<select data-schedule-filter="program" disabled><option value="">Не выбрано</option></select></label>
      <label>Место<select data-schedule-filter="city"><option value="">Не выбрано</option>${cities
        .map((city) => `<option value="${city}">${city}</option>`)
        .join('')}</select></label>
    </div>
    ${items}
    <p data-schedule-empty hidden>По вашему запросу ничего не найдено.</p>
    <nav data-schedule-pagination></nav>
  `;
}

async function mountSynthetic(
  page: Page,
  entries: SyntheticEntry[],
  monthKeys: string[],
  withMonthControl = true,
): Promise<void> {
  const response = await page.goto(PAGE);
  expect(response?.status(), `${PAGE}: страница не отдалась — скрипт поднимать нечем`).toBe(200);

  await page.evaluate((markup) => {
    document.body.innerHTML = markup;
  }, syntheticMarkup(entries, monthKeys, withMonthControl));
  await page.addScriptTag({ content: controlsScriptText() });
  await expect(page.locator(`${ITEM}:not([hidden])`).first()).toBeVisible();
}

test.describe('синтетический набор', () => {
  test('смена месяца возвращает на первую страницу @month-page-reset', async ({ page }) => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      months: ['2026-11'],
      title: `Ноябрь ${String(i + 1).padStart(2, '0')}`,
    }));
    const few = Array.from({ length: 3 }, (_, i) => ({ months: ['2026-12'], title: `Декабрь ${i + 1}` }));
    await mountSynthetic(page, [...many, ...few], ['2026-11', '2026-12']);

    // Без фильтров 33 записи — две страницы. Уходим на вторую.
    await page.locator(`${PAGINATION} [aria-label="Страница 2"]`).click();
    const secondPage = await shown(page);
    expect(secondPage.map((entry) => entry.title), 'вторая страница не открылась — проверять было нечего')
      .not.toContain('Ноябрь 01');

    await page.locator(MONTH).selectOption('2026-11');

    const visible = await shown(page);
    // Со сбросом видно 25 записей ноября с первой; без сброса зажим номера страницы
    // оставил бы вторую страницу — пять записей с «Ноябрь 26».
    expect(visible.length).toBe(PAGE_SIZE);
    expect(visible[0].title).toBe('Ноябрь 01');
  });

  test('сравнение идёт по целому ключу, а не по подстроке @month-whole-key', async ({ page }) => {
    // Ключ `2026-1` — подстрока ключей `2026-10` и `2026-11`. На реальных данных
    // такого не бывает (ключ всегда ровно YYYY-MM), поэтому `includes` там верен
    // ПО СЛУЧАЙНОСТИ формата. Первое расширение ключа (неделя, квартал) сделало бы
    // такой фильтр находящим чужие записи, и обнаружил бы это посетитель.
    await mountSynthetic(
      page,
      [
        { months: ['2026-1'], title: 'Короткий ключ' },
        { months: ['2026-10'], title: 'Октябрь' },
        { months: ['2026-11'], title: 'Ноябрь' },
      ],
      ['2026-1', '2026-10', '2026-11'],
    );

    await page.locator(MONTH).selectOption('2026-1');
    expect((await shown(page)).map((entry) => entry.title)).toEqual(['Короткий ключ']);
  });

  test('событие на три месяца находится в каждом из них @month-three-months', async ({ page }) => {
    // В данных самое длинное событие — 4 дня, поэтому случай проверяется только
    // синтетически. Ключей у такого события три, и выбор ЛЮБОГО из них обязан его
    // показывать: спека требует именно это, а не только «ключей три».
    await mountSynthetic(
      page,
      [
        { months: ['2026-11', '2026-12', '2027-01'], title: 'Долгий курс' },
        { months: ['2026-11'], title: 'Только ноябрь' },
      ],
      ['2026-11', '2026-12', '2027-01'],
    );

    for (const key of ['2026-11', '2026-12', '2027-01']) {
      await page.locator(MONTH).selectOption(key);
      expect(
        (await shown(page)).map((entry) => entry.title),
        `при выборе ${key} долгое событие пропало из выдачи`,
      ).toContain('Долгий курс');
    }

    await page.locator(MONTH).selectOption('2026-12');
    expect(
      (await shown(page)).map((entry) => entry.title),
      'в декабре показана запись, которой там нет',
    ).toEqual(['Долгий курс']);
  });

  test('пустой список месяцев оставляет контрол выключенным и не гасит остальные фильтры @month-empty-list', async ({ page }) => {
    // Ранний выход скрипта при отсутствии одного контрола гасит ВСЕ фильтры, поэтому
    // отсутствие элемента не может быть способом выразить «месяцев нет».
    await mountSynthetic(
      page,
      [
        { months: [], city: 'moskva', title: 'Москва раз' },
        { months: [], city: 'onlayn', title: 'Онлайн раз' },
      ],
      [],
    );

    await expect(page.locator(MONTH)).toBeAttached();
    await expect(page.locator(MONTH)).toBeDisabled();

    await page.locator(CITY).selectOption('moskva');
    expect((await shown(page)).map((entry) => entry.title), 'город перестал фильтровать').toEqual(['Москва раз']);

    await page.locator(CITY).selectOption('');
    await page.locator(SEARCH).fill('онлайн');
    expect((await shown(page)).map((entry) => entry.title), 'поиск перестал работать').toEqual(['Онлайн раз']);
  });

  test('отсутствие контрола месяца не уносит с собой остальные фильтры @month-missing-control', async ({ page }) => {
    // Спека: «скрипт SHALL NOT терять остальные фильтры из-за отсутствия одного».
    // Сегодня ранний выход проверяет четыре контрола, и добавление пятого в то же
    // условие сделало бы отсутствие месяца выключателем поиска, института,
    // программы и города. В разметке контрол есть всегда (это проверяет гейт по
    // dist), поэтому случай воспроизводится только синтетическим набором.
    await mountSynthetic(
      page,
      [
        { months: ['2026-11'], city: 'moskva', title: 'Москва раз' },
        { months: ['2026-12'], city: 'onlayn', title: 'Онлайн раз' },
      ],
      ['2026-11', '2026-12'],
      false,
    );

    await expect(page.locator(MONTH)).toHaveCount(0);

    await page.locator(CITY).selectOption('moskva');
    expect(
      (await shown(page)).map((entry) => entry.title),
      'без контрола месяца скрипт отказался работать целиком',
    ).toEqual(['Москва раз']);
  });

  test('пагинация скрывается выбором месяца и возвращается сбросом @month-pagination-return', async ({ page }) => {
    // Требование «выбор месяца убирает пагинацию, сброс её возвращает» закрывается ЗДЕСЬ,
    // а не проверкой по реальным данным: та требует больше 25 живых записей, а их число
    // убывает от хода времени — на 2026-11-24 живых остаётся ровно 25, и предмет исчезает
    // (TD-21). Здесь набор задаётся сам, поэтому от календаря сценарий не зависит вовсе.
    // Рассуждение спеки про сброс страницы («на реальных данных ненаблюдаемо ⇒ фикстуры»)
    // относится к половине «возвращается» дословно.
    const many = Array.from({ length: 30 }, (_, i) => ({
      months: ['2026-11'],
      title: `Ноябрь ${String(i + 1).padStart(2, '0')}`,
    }));
    const few = Array.from({ length: 3 }, (_, i) => ({ months: ['2026-12'], title: `Декабрь ${i + 1}` }));
    await mountSynthetic(page, [...many, ...few], ['2026-11', '2026-12']);

    // 33 записи при 25 на странице — две страницы, пагинация обязана быть.
    await expect(page.locator(PAGINATION), 'при 33 записях пагинации нет').toBeVisible();

    await page.locator(MONTH).selectOption('2026-12');
    expect((await shown(page)).length, 'в декабре не три записи — набор смонтирован не так').toBe(3);
    await expect(page.locator(PAGINATION), 'три записи, а пагинация осталась').toBeHidden();

    await page.locator(MONTH).selectOption('');
    expect((await shown(page)).length, 'после сброса видно не страницу записей').toBe(PAGE_SIZE);
    await expect(page.locator(PAGINATION), 'сброс месяца не вернул пагинацию').toBeVisible();
  });

  test('заплатка достижима выбором своего месяца независимо от календаря @month-supplement-synthetic', async ({ page }) => {
    // Требование «заплатка доступна через фильтр своего месяца» закрывается ЗДЕСЬ.
    // Почему не проверкой по реальным данным: обе заплатки однодневные (2026-10-01 и
    // 2026-10-08), и после 2026-10-08 окно актуальности законно уводит их со страницы —
    // предмет исчезает от хода времени, и `@month-supplement` остаётся
    // характеризационной проверкой живого набора, а не носителем требования (TD-20).
    //
    // Заплатка здесь НЕ придуманная: имя и даты берутся из `scheduleSupplements`, а
    // ключи месяцев — из того же `monthKeys`, которым их считает сборка. Опорная дата
    // задаётся первым днём самой заплатки, поэтому от календаря вывод не зависит.
    expect(scheduleSupplements.length, 'заплаток в источнике нет — проверять было нечего')
      .toBeGreaterThan(0);

    for (const supplement of scheduleSupplements) {
      const reference = (supplement.startAt ?? '').slice(0, 10);
      const keys = monthKeysOf(supplement, reference);
      expect(keys.length, `у заплатки «${supplement.name}» нет ключей месяца на ${reference}`)
        .toBeGreaterThan(0);

      const own = keys[0];
      const other = own === '2027-01' ? '2027-02' : '2027-01';
      const neighbour = `Обычная запись ${own}`;
      await mountSynthetic(
        page,
        [
          { months: keys, title: supplement.name },
          { months: [own], title: neighbour },
          { months: [other], title: `Обычная запись ${other}` },
        ],
        [own, other],
      );

      await page.locator(MONTH).selectOption(own);
      const inOwn = (await shown(page)).map((entry) => entry.title);
      expect(inOwn, `заплатка «${supplement.name}» не попала в выдачу своего месяца ${own}`)
        .toContain(supplement.name);
      expect(inOwn, `в месяце ${own} нет обычных записей — сценарий проверяет не то`).toContain(neighbour);

      // Вторая половина: в чужом месяце заплатки быть не должно. Без неё сценарий был бы
      // зелен и при фильтре, который не фильтрует вовсе.
      await page.locator(MONTH).selectOption(other);
      expect(
        (await shown(page)).map((entry) => entry.title),
        `заплатка «${supplement.name}» показана в чужом месяце ${other}`,
      ).not.toContain(supplement.name);
    }
  });
});
