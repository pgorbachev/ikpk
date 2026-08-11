import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scheduleSupplements } from '../src/lib/schedule-supplements';

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

test.describe('выбор месяца сужает выдачу', () => {
  test('показаны только записи выбранного месяца', async ({ page }) => {
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

  test('месяц вместе с городом даёт пересечение', async ({ page }) => {
    const entries = await openSchedule(page);
    const months = await offeredMonths(page);

    // Пара «месяц + город» подбирается по фактическим признакам страницы.
    const pair = months
      .flatMap((key) => inMonth(entries, key).map((entry) => ({ key, city: entry.city })))
      .find(({ key, city }) => city && inMonth(entries, key).some((entry) => entry.city === city));
    expect(pair, 'на странице нет пары «месяц + город» — проверять было нечего').toBeDefined();

    const expected = inMonth(entries, pair!.key).filter((entry) => entry.city === pair!.city);
    await page.locator(MONTH).selectOption(pair!.key);
    await page.locator(CITY).selectOption(pair!.city);

    const visible = await shown(page);
    expect(visible.length).toBe(Math.min(expected.length, PAGE_SIZE));
    const alien = visible.filter((entry) => !entry.months.includes(pair!.key) || entry.city !== pair!.city);
    expect(alien.map((e) => e.title), 'выдача не является пересечением месяца и города').toEqual([]);
  });

  test('месяц и поиск дают один набор в любом порядке', async ({ page }) => {
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

  test('сочетание без записей показывает пустое состояние', async ({ page }) => {
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

  test('адрес страницы от выбора месяца не меняется', async ({ page }) => {
    await openSchedule(page);
    const before = page.url();
    const months = await offeredMonths(page);
    await page.locator(MONTH).selectOption(months[0]);
    expect(page.url()).toBe(before);
  });
});

test.describe('месяц и остальное управление', () => {
  test('выбор института после месяца ограничивает программы и не меняет список месяцев', async ({ page }) => {
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

  test('пагинация исчезает при выборе месяца и возвращается при сбросе', async ({ page }) => {
    const entries = await openSchedule(page);
    const months = await offeredMonths(page);

    expect(entries.length, `без фильтров записей ${entries.length} — страница одна, скрывать нечего`)
      .toBeGreaterThan(PAGE_SIZE);
    await expect(page.locator(PAGINATION)).toBeVisible();

    const key = months.find((m) => inMonth(entries, m).length > 0 && inMonth(entries, m).length <= PAGE_SIZE);
    expect(key, `ни один месяц не укладывается в одну страницу — проверять было нечего`).toBeDefined();

    await page.locator(MONTH).selectOption(key!);
    await expect(page.locator(PAGINATION)).toBeHidden();

    await page.locator(MONTH).selectOption('');
    await expect(page.locator(PAGINATION)).toBeVisible();
  });

  test('запись-заплатка достижима выбором своего месяца', async ({ page }) => {
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
    expect(
      present,
      'ни одна заплатка не показана на странице (окно актуальности их уже отсекло) — проверять было нечего',
    ).toBeDefined();

    const together = inMonth(entries, present!.key);
    expect(
      together.length,
      `месяц ${present!.key} не укладывается в одну страницу (${together.length}) — заплатка может лежать на второй`,
    ).toBeLessThanOrEqual(PAGE_SIZE);

    await page.locator(MONTH).selectOption(present!.key);

    const visible = await shown(page);
    expect(
      visible.map((entry) => entry.title),
      `заплатка «${present!.title}» не попала в выдачу месяца ${present!.key}`,
    ).toContain(present!.title);
    expect(
      visible.filter((entry) => entry.title !== present!.title).length,
      'в месяце заплатки нет обычных записей — сценарий проверяет не то',
    ).toBeGreaterThan(0);
  });
});

test.describe('контрол месяца доступен', () => {
  test('у контрола есть доступное имя и видимый индикатор фокуса', async ({ page }) => {
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

  test('на экране 375 CSS-пикселей контрол виден, работает и не создаёт переполнения', async ({ page }) => {
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

function syntheticMarkup(entries: SyntheticEntry[], monthKeys: string[]): string {
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
      <label>Месяц<select data-schedule-filter="month" disabled><option value="">Не выбрано</option>${options}</select></label>
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

async function mountSynthetic(page: Page, entries: SyntheticEntry[], monthKeys: string[]): Promise<void> {
  const response = await page.goto(PAGE);
  expect(response?.status(), `${PAGE}: страница не отдалась — скрипт поднимать нечем`).toBe(200);

  await page.evaluate((markup) => {
    document.body.innerHTML = markup;
  }, syntheticMarkup(entries, monthKeys));
  await page.addScriptTag({ content: controlsScriptText() });
  await expect(page.locator(`${ITEM}:not([hidden])`).first()).toBeVisible();
}

test.describe('синтетический набор', () => {
  test('смена месяца возвращает на первую страницу', async ({ page }) => {
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

  test('сравнение идёт по целому ключу, а не по подстроке', async ({ page }) => {
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

  test('пустой список месяцев оставляет контрол выключенным и не гасит остальные фильтры', async ({ page }) => {
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
});
