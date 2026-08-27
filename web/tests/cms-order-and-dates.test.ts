/**
 * КРАСНЫЕ тесты по change `cms-content-authoring-and-migration`: порядок следования,
 * вычисляемый статус семинара и вывод его дат.
 *
 * Опорная дата приходит АРГУМЕНТОМ во всех проверках. Это не стиль: гейт, сравнивающий
 * сохранённый статус с `new Date()`, уже краснел от хода времени при исправном коде
 * (`AGENTS.md`, «из данных проверять вывод, а не снимок»).
 *
 * Модули `web/scripts/lib/content-order.ts` и `web/scripts/lib/seminar-dates.ts`
 * подгружаются динамически (см. `tests/helpers/cms-authoring-contract.ts`), поэтому до
 * реализации каждый сценарий краснеет отдельно.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadContentOrder,
  loadSeminarDates,
  type ScheduleEvent,
} from './helpers/cms-authoring-contract';

const ROOT = join(import.meta.dirname, '..', '..');
const TODAY = '2026-09-15';

const event = (over: Partial<ScheduleEvent> & Pick<ScheduleEvent, 'id'>): ScheduleEvent => ({
  status: 'active',
  startAt: '2026-10-01',
  endAt: '2026-10-02',
  city: 'Санкт-Петербург',
  ...over,
});

describe('порядок следования задаётся явно и воспроизводим', () => {
  // Scenario: вывод следует заданным значениям порядка
  it('порядок следует значениям, а не названиям', async () => {
    const { byExplicitOrder } = await loadContentOrder();
    const sorted = byExplicitOrder([
      { identifier: 'ser-2', order: 4 },
      { identifier: 'cst-1', order: 1 },
      { identifier: 'ser-1', order: 3 },
      { identifier: 'cst-2', order: 2 },
    ]);
    expect(sorted.map((s) => s.identifier)).toEqual(['cst-1', 'cst-2', 'ser-1', 'ser-2']);
  });

  // Педагогическая последовательность: алфавит уже выводил продвинутую ступень раньше
  // обязательной, поэтому проверка берёт данные, где алфавит и порядок расходятся.
  it('алфавитный порядок отличается от заданного и не побеждает', async () => {
    const { byExplicitOrder } = await loadContentOrder();
    const sorted = byExplicitOrder([
      { identifier: 'aaa-prodvinutyj', order: 2 },
      { identifier: 'zzz-obyazatelnyj', order: 1 },
    ]);
    expect(sorted.map((s) => s.identifier)).toEqual(['zzz-obyazatelnyj', 'aaa-prodvinutyj']);
  });

  // Scenario: новая запись без порядка встаёт последней
  it.each([undefined, null] as const)('запись со значением порядка %s встаёт последней', async (order) => {
    const { byExplicitOrder } = await loadContentOrder();
    const sorted = byExplicitOrder([
      { identifier: 'aaa-novyj', order },
      { identifier: 'zzz-staryj', order: 5 },
    ]);
    expect(sorted.map((s) => s.identifier)).toEqual(['zzz-staryj', 'aaa-novyj']);
  });

  // Scenario: равные значения дают устойчивый порядок.
  // Ключ назван: ЛЕКСИКОГРАФИЧЕСКОЕ сравнение идентификаторов. Слова
  // «детерминированный» недостаточно — оно не говорит, чем сравнивать.
  it('при равных значениях сравниваются идентификаторы лексикографически', async () => {
    const { byExplicitOrder } = await loadContentOrder();
    const sorted = byExplicitOrder([
      { identifier: 'b', order: 1 },
      { identifier: 'a', order: 1 },
    ]);
    expect(sorted.map((s) => s.identifier)).toEqual(['a', 'b']);
  });

  // Расхождение лексикографического и числового сравнения на числоподобных
  // идентификаторах: у перенесённых персон и плейлистов они состоят только из цифр.
  // В нынешнем снимке все двузначные, поэтому расхождение видно только на другой
  // разрядности — данные для него взяты искусственно намеренно.
  it('числоподобные идентификаторы сравниваются как строки: 10 раньше 9', async () => {
    const { byExplicitOrder } = await loadContentOrder();
    const sorted = byExplicitOrder([
      { identifier: '9', order: 1 },
      { identifier: '10', order: 1 },
    ]);
    expect(sorted.map((s) => s.identifier)).toEqual(['10', '9']);
  });

  // «Порядок, в котором записи вернуло хранилище, порядком не считается»: две сборки
  // одного состояния обязаны совпасть, поэтому вход в обратном порядке даёт тот же выход.
  it('порядок входа на результат не влияет', async () => {
    const { byExplicitOrder } = await loadContentOrder();
    const items = [
      { identifier: 'a', order: 1 },
      { identifier: 'b', order: 1 },
      { identifier: 'c', order: null },
    ];
    const forward = byExplicitOrder(items).map((s) => s.identifier);
    const backward = byExplicitOrder([...items].reverse()).map((s) => s.identifier);
    expect(forward).toEqual(backward);
  });
});

/*
 * ОГОВОРКА, БЕЗ КОТОРОЙ КРАСНЫЙ ЦВЕТ ЗДЕСЬ ЧИТАЕТСЯ НЕВЕРНО.
 *
 * Правило статуса УЖЕ реализовано: `web/scripts/lib/planned-seminars.ts` отдаёт
 * `plannedSlugs(entries, today)` — действующее событие с последним днём не раньше
 * опорной даты, дата аргументом. Пять сценариев этого требования на текущем коде
 * выполняются, и проверки на них существуют (`tests/planned-seminars.test.ts`).
 *
 * Красными проверки ниже становятся не потому, что правило не реализовано, а потому что
 * требование о ДАТАХ просит большего, чем набор слагов: страница семинара перечисляет
 * сами события, а страница программы выбирает из них ближайшее по названным ключам.
 * Отсюда шов `seminar-dates.ts`, возвращающий события. Реализация вправе не заводить
 * новый файл, а расширить существующий — тогда путь в контракте меняется, а проверки
 * остаются те же.
 */

describe('статус семинара вычисляется по расписанию относительно опорной даты', () => {
  // Scenario: событие в будущем делает семинар запланированным
  it('действующее событие позже опорной даты делает семинар запланированным', async () => {
    const { plannedEvents } = await loadSeminarDates();
    expect(plannedEvents([event({ id: 1 })], TODAY)).toHaveLength(1);
  });

  // Scenario: событие идёт в опорную дату
  it('событие, последний день которого равен опорной дате, считается запланированным', async () => {
    const { plannedEvents } = await loadSeminarDates();
    expect(
      plannedEvents([event({ id: 1, startAt: '2026-09-14', endAt: TODAY })], TODAY),
    ).toHaveLength(1);
  });

  // Scenario: многодневное событие в середине
  it('многодневное событие в середине остаётся запланированным', async () => {
    const { plannedEvents } = await loadSeminarDates();
    expect(
      plannedEvents([event({ id: 1, startAt: '2026-09-10', endAt: '2026-09-20' })], TODAY),
    ).toHaveLength(1);
  });

  // Scenario: все события завершились
  it('события, целиком прошедшие, не дают статуса', async () => {
    const { plannedEvents } = await loadSeminarDates();
    expect(
      plannedEvents(
        [
          event({ id: 1, startAt: '2026-08-01', endAt: '2026-08-02' }),
          event({ id: 2, startAt: '2026-09-01', endAt: '2026-09-14' }),
        ],
        TODAY,
      ),
    ).toEqual([]);
  });

  // Scenario: отменённое будущее событие не даёт статуса
  it.each(['cancelled', 'completed'])('событие со статусом %s статуса не даёт', async (status) => {
    const { plannedEvents } = await loadSeminarDates();
    expect(plannedEvents([event({ id: 1, status })], TODAY)).toEqual([]);
  });

  // Опорная дата — аргумент: тот же вход при другой дате даёт другой ответ, и это
  // единственное, что отличает вычисление от чтения календаря внутри функции.
  it('ответ зависит от опорной даты, а не от календаря машины', async () => {
    const { plannedEvents } = await loadSeminarDates();
    const events = [event({ id: 1, startAt: '2026-10-01', endAt: '2026-10-02' })];
    expect(plannedEvents(events, '2026-09-15')).toHaveLength(1);
    expect(plannedEvents(events, '2026-10-03')).toHaveLength(0);
  });
});

describe('даты семинара выводятся из расписания', () => {
  // Scenario: на странице программы у каждого семинара своя ближайшая дата
  it('ближайшим становится событие с меньшим первым днём', async () => {
    const { nearestEvent } = await loadSeminarDates();
    const nearest = nearestEvent(
      [
        event({ id: 'pozdnee', startAt: '2026-11-01', endAt: '2026-11-02' }),
        event({ id: 'rannee', startAt: '2026-10-01', endAt: '2026-10-02' }),
      ],
      TODAY,
    );
    expect(nearest?.id).toBe('rannee');
  });

  // Scenario: при равном первом дне ближайшим становится более короткое событие
  it('при равном первом дне ближайшим становится событие с более ранним последним днём', async () => {
    const { nearestEvent } = await loadSeminarDates();
    const nearest = nearestEvent(
      [
        event({ id: 'dlinnoe', startAt: '2026-10-01', endAt: '2026-10-05' }),
        event({ id: 'korotkoe', startAt: '2026-10-01', endAt: '2026-10-02' }),
      ],
      TODAY,
    );
    expect(nearest?.id).toBe('korotkoe');
  });

  // Scenario: при совпадении дат события различаются городом
  it('при совпадении дат ближайшим становится город, который раньше лексикографически', async () => {
    const { nearestEvent } = await loadSeminarDates();
    const nearest = nearestEvent(
      [
        event({ id: 'spb', city: 'Санкт-Петербург' }),
        event({ id: 'msk', city: 'Москва' }),
      ],
      TODAY,
    );
    expect(nearest?.id).toBe('msk');
  });

  // Scenario: события с совпадающими датами дают устойчивый выбор.
  // Идентификатор события — целое число в нынешнем материале, поэтому сравнение
  // следует ТИПУ поля: числовое сравнивается как число.
  it('при совпадении дат и города выбор устойчив и следует типу идентификатора', async () => {
    const { nearestEvent } = await loadSeminarDates();
    const events = [event({ id: 465 }), event({ id: 90 })];
    const first = nearestEvent(events, TODAY);
    const second = nearestEvent([...events].reverse(), TODAY);
    expect(first?.id).toBe(second?.id);
    expect(first?.id, 'числовой идентификатор сравнён лексикографически: 465 раньше 90').toBe(90);
  });

  it('строковый идентификатор события сравнивается лексикографически', async () => {
    const { nearestEvent } = await loadSeminarDates();
    const nearest = nearestEvent([event({ id: 'b' }), event({ id: 'a' })], TODAY);
    expect(nearest?.id).toBe('a');
  });

  // Scenario: идущий многодневный семинар остаётся ближайшим.
  // «Ближайшее» берётся по ПЕРВОМУ дню, а право считаться запланированным — по
  // последнему; иначе идущее событие выпало бы из ближайших в свой второй день.
  it('идущее многодневное событие остаётся ближайшим', async () => {
    const { nearestEvent } = await loadSeminarDates();
    const nearest = nearestEvent(
      [
        event({ id: 'idushchee', startAt: '2026-09-10', endAt: '2026-09-20' }),
        event({ id: 'budushchee', startAt: '2026-10-01', endAt: '2026-10-02' }),
      ],
      TODAY,
    );
    expect(nearest?.id).toBe('idushchee');
  });

  // Scenario: на странице семинара перечислены все запланированные события
  it('все запланированные события возвращаются, а не только ближайшее', async () => {
    const { plannedEvents } = await loadSeminarDates();
    const events = [
      event({ id: 1, startAt: '2026-10-01', endAt: '2026-10-02' }),
      event({ id: 2, startAt: '2026-11-01', endAt: '2026-11-02' }),
      event({ id: 3, startAt: '2026-12-01', endAt: '2026-12-02' }),
    ];
    expect(plannedEvents(events, TODAY)).toHaveLength(3);
  });

  // Scenario: отменённое событие не показано и ближайшим не считается
  it('отменённое ближайшее по дате событие не выбирается и в список не попадает', async () => {
    const { nearestEvent, plannedEvents } = await loadSeminarDates();
    const events = [
      event({ id: 'otmeneno', status: 'cancelled', startAt: '2026-10-01', endAt: '2026-10-02' }),
      event({ id: 'deystvuet', startAt: '2026-11-01', endAt: '2026-11-02' }),
    ];
    expect(nearestEvent(events, TODAY)?.id).toBe('deystvuet');
    expect(plannedEvents(events, TODAY).map((e) => e.id)).toEqual(['deystvuet']);
  });

  // Scenario: семинар без запланированных событий показывает сообщение с телефоном
  // (часть, проверяемая чисто: третьего состояния нет — ближайшего события тоже)
  it('без запланированных событий ближайшего события нет', async () => {
    const { nearestEvent } = await loadSeminarDates();
    expect(
      nearestEvent([event({ id: 1, startAt: '2026-08-01', endAt: '2026-08-02' })], TODAY),
    ).toBeNull();
  });
});

describe('телефон менеджера — значение из контактных данных, а не из шаблона', () => {
  // Требование «Даты семинара выводятся из расписания»: контактные данные обязаны
  // называть, КАКОЙ из номеров является номером менеджера. Сегодня роль второго номера
  // живёт комментарием рядом с константой — то есть в данных её нет, и выбор номера
  // остаётся в шаблоне.
  it('роль номера менеджера объявлена в данных, а не в комментарии', () => {
    const file = join(ROOT, 'web', 'src', 'lib', 'navigation.ts');
    expect(existsSync(file), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${file}`).toBe(true);
    const source = readFileSync(file, 'utf-8');
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');
    // Признак назван узко намеренно. Широкое `manager` проходит по постороннему
    // `MANAGER_HOURS_NOTE` — часам работы, к выбору НОМЕРА не относящимся: это ровно
    // тот декоративный гейт, который зелен, потому что признак не про предмет.
    // Годится либо имя, связывающее менеджера с номером, либо роль как поле данных.
    const namesManagerPhone =
      /(manager|menedzher|менеджер)\w*_?(phone|tel|номер)|(phone|tel|номер)\w*_?(manager|menedzher|менеджер)/i.test(
        withoutComments,
      ) || /role\s*:\s*['"`]manager['"`]/.test(withoutComments);
    expect(
      namesManagerPhone,
      'какой из номеров принадлежит менеджеру, в данных не сказано: роль живёт только в комментарии',
    ).toBe(true);
  });
});

/*
 * СЦЕНАРИИ ЭТИХ ТРЁХ ТРЕБОВАНИЙ БЕЗ АВТОМАТИЧЕСКОЙ ПРОВЕРКИ ЗДЕСЬ
 *
 * - «на странице программы второе событие не показано», «на странице семинара
 *   перечислены все три», «вместо даты показано „уточняйте у менеджера“ с телефоном»,
 *   «у семинара с датой сообщения нет» — предмет СОБРАННОЙ страницы, собираемой из
 *   контента системы управления. Источник сборки переключает change
 *   `cms-content-publication`; до него проверять нечем, и это ограничение названо в
 *   самой спеке (раздел Purpose). Состав данных, из которого страница строится,
 *   проверен выше.
 * - «редактор не может задать статус напрямую» — отсутствие поля в схеме, см.
 *   `tests/cms-schema-contract.test.ts`.
 * - «обе сборки выводят записи в одном и том же порядке» — устойчивость проверена на
 *   функции (порядок входа на результат не влияет); двойная сборка того же состояния
 *   добавила бы к этому только стоимость прогона.
 */
