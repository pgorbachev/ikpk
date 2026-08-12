import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isCurrentOrFuture } from '../src/lib/schedule-window';
import { monthKeys, monthLabel, monthOptions } from '../src/lib/schedule-months';

// ─── Тесты по спеке schedule-month-filter, до реализации ─────────────────────
// Спецификация: openspec/changes/schedule-month-filter/specs/schedule-month-filter/spec.md
// Требования: «Месяц записи выводится на сервере», «Событие принадлежит каждому
// месяцу, в котором оно идёт», «Предлагаются только те месяцы, в которых что-то
// есть», «Подпись месяца — вывод чистой функции», «Клиентский код не выводит время».
//
// Файл КРАСНЫЙ по замыслу: модуля `src/lib/schedule-months.ts` ещё нет.
//
// Контракт модуля задаётся здесь, потому что тесты пишутся раньше кода. Реализация
// обязана экспортировать ровно это:
//
//   monthKeys(entry, today): string[]
//       ключи `YYYY-MM` записи — от месяца `startAt` до месяца `lastDay(entry)`
//       включительно, УЖЕ с отсечением месяцев ранее месяца `today`;
//   monthOptions(entries, today): { key: string; count: number }[]
//       список месяцев: объединение отсечённых ключей по возрастанию, `count` —
//       сколько записей идёт в этом месяце (запись через границу считается в оба);
//   monthLabel(key, count?): string
//       подпись: «Сентябрь 2026», с числом — «Сентябрь 2026 (15)».
//
// `today` и `count` приходят аргументами: подпись и ключи, зависящие от хода
// времени, нельзя проверить фикстурами, и проверка краснела бы сама собой — в
// проекте это уже случилось с гейтом статуса семинара.

const MODULE = join(import.meta.dirname, '..', 'src', 'lib', 'schedule-months.ts');

/** Дата, относительно которой считаются фикстуры. Фиксированная: ход времени не
 *  должен красить ни одну проверку этого файла. */
const TODAY = '2026-11-15';

describe('ключи месяцев записи', () => {
  it('событие внутри одного месяца принадлежит одному месяцу', () => {
    expect(monthKeys({ startAt: '2026-12-03T00:00:00.000Z', endAt: '2026-12-06T00:00:00.000Z' }, TODAY))
      .toEqual(['2026-12']);
  });

  it('событие через границу месяца принадлежит обоим', () => {
    // id 443 в данных: 2026-11-30 → 2026-12-02. Разбиение по месяцу начала
    // потеряло бы декабрь, по месяцу окончания — ноябрь.
    expect(monthKeys({ startAt: '2026-11-30T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z' }, TODAY))
      .toEqual(['2026-11', '2026-12']);
  });

  it('событие длиннее двух месяцев принадлежит каждому', () => {
    // В данных такого события нет (самое длинное — 4 дня), но формула сверки
    // обязана работать и на нём: иначе аномалия данных проявится как поломка кода.
    expect(monthKeys({ startAt: '2026-11-20T00:00:00.000Z', endAt: '2027-01-10T00:00:00.000Z' }, TODAY))
      .toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('переход через год даёт соседние месяцы, а не скачок номера', () => {
    expect(monthKeys({ startAt: '2026-12-28T00:00:00.000Z', endAt: '2027-01-04T00:00:00.000Z' }, TODAY))
      .toEqual(['2026-12', '2027-01']);
  });

  it('endAt раньше startAt: последний день — startAt', () => {
    // Данные чужого API, такое встречается; правило уже реализовано в lastDay().
    expect(monthKeys({ startAt: '2026-12-20T00:00:00.000Z', endAt: '2026-11-01T00:00:00.000Z' }, TODAY))
      .toEqual(['2026-12']);
  });

  it('записи без endAt хватает startAt', () => {
    expect(monthKeys({ startAt: '2027-02-10T00:00:00.000Z' }, TODAY)).toEqual(['2027-02']);
  });

  it('записи без startAt хватает endAt, и ключ у неё ровно один', () => {
    // Обратный случай к предыдущему, и он был не покрыт. Пустая строка вместо начала
    // сравнивается с отсечкой как «раньше любого месяца», поэтому без оговорки в
    // модуле такая запись получала бы ключ на КАЖДЫЙ месяц от опорной даты до `endAt`
    // — здесь это ['2026-11', '2026-12', '2027-01', '2027-02'] вместо ['2027-02'] — и
    // находилась бы выбором месяцев, в которых о ней ничего не известно.
    expect(monthKeys({ endAt: '2027-02-10T00:00:00.000Z' }, TODAY)).toEqual(['2027-02']);
  });

  it('прошлый месяц отсечён у идущего события прямо в ключах карточки', () => {
    // Идущее событие, начавшееся в прошлом месяце. Отсечение — часть вывода
    // ключей, а не отдельный шаг над готовым списком: иначе у карточки остаётся
    // ключ, которого нет в списке месяцев, и сверка «каждый ключ есть в списке»
    // краснеет на исправном коде. Именно это было дефектом первой редакции спеки.
    const going = { startAt: '2026-10-29T00:00:00.000Z', endAt: '2026-11-01T00:00:00.000Z' };
    expect(monthKeys(going, '2026-11-01')).toEqual(['2026-11']);
  });

  it('отсечение не трогает месяц опорной даты и будущие', () => {
    const going = { startAt: '2026-11-10T00:00:00.000Z', endAt: '2026-12-05T00:00:00.000Z' };
    expect(monthKeys(going, TODAY)).toEqual(['2026-11', '2026-12']);
  });

  // Инвариант, на котором держится безопасность отсечения: запись прошла окно
  // актуальности, значит её последний день не раньше опорной даты, значит месяц
  // последнего дня не раньше месяца опорной даты — ключ остаётся всегда.
  it('у каждой записи, прошедшей окно, после отсечения остаётся хотя бы один ключ', () => {
    const fixtures = [
      { startAt: '2026-11-15T00:00:00.000Z', endAt: '2026-11-15T00:00:00.000Z' },
      { startAt: '2026-11-14T00:00:00.000Z', endAt: '2026-11-15T00:00:00.000Z' },
      { startAt: '2026-09-01T00:00:00.000Z', endAt: '2026-11-15T00:00:00.000Z' },
      { startAt: '2026-10-31T00:00:00.000Z', endAt: '2026-11-30T00:00:00.000Z' },
      { startAt: '2026-11-16T00:00:00.000Z', endAt: '2026-11-16T00:00:00.000Z' },
      { startAt: '2027-09-01T00:00:00.000Z', endAt: '2027-09-03T00:00:00.000Z' },
      { startAt: '2026-12-20T00:00:00.000Z', endAt: '2026-11-01T00:00:00.000Z' },
      { startAt: '2026-11-20T00:00:00.000Z' },
    ];

    const passing = fixtures.filter((entry) => isCurrentOrFuture(entry, TODAY));
    expect(passing.length, 'фикстуры не проходят окно актуальности — проверять нечего')
      .toBe(fixtures.length);

    const empty = passing.filter((entry) => monthKeys(entry, TODAY).length === 0);
    expect(empty, `записи без ключей после отсечения:\n${JSON.stringify(empty)}`).toEqual([]);
  });

  it('все ключи имеют формат YYYY-MM', () => {
    const keys = monthKeys({ startAt: '2026-11-20T00:00:00.000Z', endAt: '2027-01-10T00:00:00.000Z' }, TODAY);
    expect(keys.length, 'ключей не получено — проверять нечего').toBeGreaterThan(0);
    expect(keys.filter((key) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(key))).toEqual([]);
  });
});

describe('список предложенных месяцев', () => {
  it('объединение ключей по возрастанию при неотсортированном входе', () => {
    // Вход НЕ отсортирован намеренно: на отсортированном проверка порядка зелена
    // по совпадению и сортировку не измеряет вовсе.
    const entries = [
      { startAt: '2027-02-10T00:00:00.000Z', endAt: '2027-02-12T00:00:00.000Z' },
      { startAt: '2026-11-30T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z' },
      { startAt: '2026-12-03T00:00:00.000Z', endAt: '2026-12-06T00:00:00.000Z' },
    ];
    expect(monthOptions(entries, TODAY).map((option) => option.key))
      .toEqual(['2026-11', '2026-12', '2027-02']);
  });

  it('пустой месяц внутри диапазона не появляется в списке', () => {
    // Список — не непрерывный интервал: в данных пусты январь, июль и август 2027
    // при заполненных соседях. Фикстура с разрывом декабрь → февраль.
    const entries = [
      { startAt: '2026-12-03T00:00:00.000Z', endAt: '2026-12-06T00:00:00.000Z' },
      { startAt: '2027-02-10T00:00:00.000Z', endAt: '2027-02-12T00:00:00.000Z' },
    ];
    expect(monthOptions(entries, TODAY).map((option) => option.key)).toEqual(['2026-12', '2027-02']);
  });

  it('каждый ключ каждой записи присутствует в списке', () => {
    const entries = [
      { startAt: '2026-11-30T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z' },
      { startAt: '2026-11-20T00:00:00.000Z', endAt: '2027-01-10T00:00:00.000Z' },
      { startAt: '2027-02-10T00:00:00.000Z', endAt: '2027-02-12T00:00:00.000Z' },
    ];
    const offered = new Set(monthOptions(entries, TODAY).map((option) => option.key));
    const unreachable = entries.flatMap((entry) => monthKeys(entry, TODAY)).filter((key) => !offered.has(key));
    expect(unreachable, `ключи карточек, недостижимые выбором:\n${unreachable.join(', ')}`).toEqual([]);
  });

  it('закончившийся месяц не предлагается, событие достижимо по своему последнему месяцу', () => {
    const going = { startAt: '2026-10-29T00:00:00.000Z', endAt: '2026-11-01T00:00:00.000Z' };
    const options = monthOptions([going], '2026-11-01');
    expect(options.map((option) => option.key)).toEqual(['2026-11']);
    expect(options[0].count).toBe(1);
  });

  it('запись через границу месяца учтена в обоих месяцах', () => {
    const crossing = { startAt: '2026-11-30T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z' };
    const counts = new Map(monthOptions([crossing], TODAY).map((option) => [option.key, option.count]));
    expect(counts.get('2026-11')).toBe(1);
    expect(counts.get('2026-12')).toBe(1);
  });

  // Арифметика из спеки. Формула ИМЕННО через число пересечённых границ:
  //   сумма по месяцам = число записей + Σ(ключей − 1).
  // «Сумма = число записей» неверна и красна на исправном коде; «сумма = записи +
  // число записей с несколькими ключами» верна лишь пока событие не длиннее двух
  // месяцев — это свойство сегодняшних данных, а не устройства.
  it('сумма по месяцам равна числу записей плюс число пересечённых границ', () => {
    const entries = [
      { startAt: '2026-11-16T00:00:00.000Z', endAt: '2026-11-18T00:00:00.000Z' },
      { startAt: '2026-11-30T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z' },
      { startAt: '2026-11-20T00:00:00.000Z', endAt: '2027-01-10T00:00:00.000Z' },
      { startAt: '2027-02-10T00:00:00.000Z', endAt: '2027-02-12T00:00:00.000Z' },
    ];
    const options = monthOptions(entries, TODAY);
    const sum = options.reduce((total, option) => total + option.count, 0);
    const borders = entries.reduce((total, entry) => total + monthKeys(entry, TODAY).length - 1, 0);

    expect(borders, 'в фикстуре нет ни одного пересечения границы — проверять нечего').toBeGreaterThan(1);
    expect(sum).toBe(entries.length + borders);
  });

  it('каждое число в списке равно числу записей этого месяца', () => {
    const entries = [
      { startAt: '2026-11-16T00:00:00.000Z', endAt: '2026-11-18T00:00:00.000Z' },
      { startAt: '2026-11-30T00:00:00.000Z', endAt: '2026-12-02T00:00:00.000Z' },
      { startAt: '2026-12-03T00:00:00.000Z', endAt: '2026-12-06T00:00:00.000Z' },
    ];
    const wrong: string[] = [];
    for (const option of monthOptions(entries, TODAY)) {
      const expected = entries.filter((entry) => monthKeys(entry, TODAY).includes(option.key)).length;
      if (option.count !== expected) wrong.push(`${option.key}: подпись ${option.count}, записей ${expected}`);
    }
    expect(wrong, `число в подписи расходится с выдачей:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('пустой список записей даёт пустой список месяцев', () => {
    // Ветка нужна для контрола: пустой список оставляет его выключенным, но не
    // убирает из разметки (проверка разметки — в schedule-month-dist.test.ts).
    expect(monthOptions([], TODAY)).toEqual([]);
  });
});

describe('подпись месяца', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const NAMES = [
    ['2026-01', 'Январь'],
    ['2026-02', 'Февраль'],
    ['2026-03', 'Март'],
    ['2026-04', 'Апрель'],
    ['2026-05', 'Май'],
    ['2026-06', 'Июнь'],
    ['2026-07', 'Июль'],
    ['2026-08', 'Август'],
    ['2026-09', 'Сентябрь'],
    ['2026-10', 'Октябрь'],
    ['2026-11', 'Ноябрь'],
    ['2026-12', 'Декабрь'],
  ] as const;

  it('ключ 2026-09 даёт «Сентябрь 2026»', () => {
    expect(monthLabel('2026-09')).toContain('Сентябрь 2026');
  });

  it('все двенадцать месяцев — в именительном падеже с заглавной буквы и с годом', () => {
    const wrong: string[] = [];
    for (const [key, name] of NAMES) {
      const label = monthLabel(key);
      if (!label.includes(`${name} ${key.slice(0, 4)}`)) wrong.push(`${key} → «${label}», ожидалось «${name} 2026»`);
    }
    expect(wrong, `подписи месяцев:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('в подписи нет приписки «г.» и строчного начала названия', () => {
    // `Intl` в русской локали при `{month:'long', year:'numeric'}` даёт «сентябрь
    // 2026 г.» — то есть готовый вывод библиотеки требованию не удовлетворяет.
    const wrong: string[] = [];
    for (const [key] of NAMES) {
      const label = monthLabel(key);
      if (/\sг\./.test(label)) wrong.push(`${key} → «${label}»: приписка «г.»`);
      if (label[0] !== label[0].toUpperCase()) wrong.push(`${key} → «${label}»: строчное начало`);
      if (/[а-я]{3}\.\s/.test(label)) wrong.push(`${key} → «${label}»: сокращение месяца`);
    }
    expect(wrong, `подписи месяцев:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('число записей приписывается к подписи в скобках', () => {
    // Решение владельца 2026-08-11 (tasks.md, раздел 1): число записей в подписи
    // ПОКАЗЫВАЕТСЯ, вид — «Сентябрь 2026 (15)».
    expect(monthLabel('2026-09', 15)).toMatch(/^Сентябрь 2026\s*\(15\)$/);
  });

  it('подпись не зависит от текущей даты', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));
    const first = monthLabel('2026-09', 15);
    vi.setSystemTime(new Date('2031-07-02T23:30:00.000Z'));
    const second = monthLabel('2026-09', 15);
    expect(second).toBe(first);
  });

  it('подпись и ключи не зависят от часового пояса окружения', () => {
    // Подпись, собранная через объект даты, разойдётся с ключом ровно на границе
    // месяца: ключ выведен по UTC, а дата вносит пояс сборочной машины.
    const east = 'Pacific/Kiritimati'; // UTC+14
    const west = 'Pacific/Niue'; // UTC−11

    // Сначала убедиться, что смена TZ в этом процессе вообще действует: иначе
    // проверка вакуумна и сообщила бы об успехе, ничего не измерив.
    const dayEast = withTz(east, () => new Date('2026-09-01T00:00:00.000Z').getDate());
    const dayWest = withTz(west, () => new Date('2026-09-01T00:00:00.000Z').getDate());
    expect(dayEast, 'смена process.env.TZ не влияет на Date — проверка часового пояса вакуумна')
      .not.toBe(dayWest);

    const entry = { startAt: '2026-09-01T00:00:00.000Z', endAt: '2026-09-30T00:00:00.000Z' };
    expect(withTz(east, () => monthLabel('2026-09', 15))).toBe(withTz(west, () => monthLabel('2026-09', 15)));
    expect(withTz(east, () => monthLabel('2026-09', 15))).toContain('Сентябрь 2026');
    expect(withTz(east, () => monthKeys(entry, TODAY))).toEqual(withTz(west, () => monthKeys(entry, TODAY)));
  });
});

// ─── Граница вывода о времени ────────────────────────────────────────────────
// Требование «Клиентский код не выводит время» и сценарий «окно актуальности
// осталось в одном модуле». Проверка по исходнику, а не по поведению: месяц
// выводится на этапе сборки, и поведение модуля юнит-тестом от способа его
// получения не отличить — `new Date()` внутри дал бы те же значения на фикстурах
// и покраснел бы однажды, без связи с причиной.
//
// Существующий гейт `schedule-window.test.ts:82-212` ловит своё: сравнение
// `startAt` с датой, причём с разбора AST — вынос в переменную он ловит наравне с
// однострочной формой (пометка переменных `:126-141`, сравнение с помеченной `:150-159`).
// Прежняя редакция этого комментария относила вынос в переменную к непойманному; это
// устарело коммитом `1a7e5e2` внутри той же работы и выправлено по находке ревью 5.5.
// Чего гейт не ловит и сейчас — сборку объекта даты для подписи: там нет сравнения,
// а он ищет именно сравнение. Ради этого проверки ниже и нужны отдельно.
describe('модуль месяцев не выводит время сам', () => {
  const source = (): string => {
    expect(existsSync(MODULE), `нет файла ${MODULE} — проверять нечего`).toBe(true);
    return readFileSync(MODULE, 'utf-8');
  };

  /** Строки без комментариев: комментарий вправе упоминать запрещённое. */
  const codeLines = (): string[] =>
    source()
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'));

  it('внутри нет обращения к текущему времени', () => {
    const offenders = codeLines().filter((line) => /new Date\b|Date\.now|Date\.parse|calendarToday/.test(line));
    expect(offenders, `опорная дата обязана приходить аргументом:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('подпись собирается таблицей, а не Intl или локалью', () => {
    const offenders = codeLines().filter((line) => /\bIntl\b|toLocale[A-Za-z]*String/.test(line));
    expect(
      offenders,
      `вывод Intl зависит от версии ICU в сборочном окружении и даёт «сентябрь 2026 г.»:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('календарные даты целиком модуль не сравнивает', () => {
    // `slice(0, 7)` — ключ месяца, это его работа; `slice(0, 10)` — календарная
    // дата, а решение по датам живёт только в schedule-window.ts.
    const offenders = codeLines().filter((line) => /slice\(\s*0\s*,\s*10\s*\)/.test(line));
    expect(offenders, `вывод о дате принадлежит schedule-window.ts:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('последний день события берётся из schedule-window', () => {
    const text = source();
    expect(text).toMatch(/from\s+'\.\/schedule-window'/);
    expect(text, 'правило про endAt раньше startAt не должно повторяться вторым местом').toMatch(/\blastDay\b/);
  });
});

/** Выполнить fn при подменённом часовом поясе процесса. */
function withTz<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
