import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { dist, readPage } from './helpers/dist-pages';

// ─── Гейт по собранному dist: месяц доставляется разметкой ────────────────────
// Спецификация: openspec/changes/schedule-month-filter/specs/schedule-month-filter/spec.md
// Требования: «Месяц записи выводится на сервере и доставляется признаком карточки»,
// «Событие принадлежит каждому месяцу, в котором оно идёт», «Предлагаются только те
// месяцы, в которых что-то есть», «Контрол месяца не обещает того, чего не делает»,
// «Клиентский код не выводит время».
//
// Файл КРАСНЫЙ по замыслу: признака месяца у карточек и контрола месяца в разметке
// ещё нет.
//
// Почему гейт по разметке, а не браузерный: месяц выводится на этапе сборки, и
// предмет проверки — отданный документ. Он же закрывает сценарий «без JavaScript»:
// достаточно того, что контрол приезжает выключенным, а записи — не скрытыми;
// отдельного прогона с `javaScriptEnabled: false` (такой инфраструктуры в проекте
// нет ни одной) это не требует.
//
// Контракт разметки задаётся здесь, потому что тесты пишутся раньше кода:
//   запись     — `data-schedule-item` + `data-months="2026-11 2026-12"` (ключи через
//                пробел, сравнение по целому токену);
//   контрол    — `<select data-schedule-filter="month" disabled>`, первый пункт
//                value="" с текстом «Не выбрано», остальные — value="YYYY-MM" с
//                подписью «Ноябрь 2026 (12)»;
//   скрипт     — блок с признаком `data-schedule-controls`, по которому проверка
//                находит именно его, а не соседний inline-скрипт.

const PAGE = '/raspisanie-i-tseny/';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

function html(): string {
  const file = join(dist, PAGE, 'index.html');
  expect(existsSync(file), `нет ${file} — страница не собрана, проверять нечего`).toBe(true);
  return readPage(PAGE);
}

interface ScheduleItem {
  tag: string;
  keys: string[];
  hidden: boolean;
}

/** Открывающие теги записей расписания и их ключи месяцев. */
function scheduleItems(): ScheduleItem[] {
  const found = [...html().matchAll(/<[a-z]+\b[^>]*\bdata-schedule-item\b[^>]*>/gi)].map((match) => {
    const tag = match[0];
    const months = tag.match(/\bdata-months="([^"]*)"/);
    return {
      tag,
      keys: (months?.[1] ?? '').split(' ').filter(Boolean),
      hidden: /\shidden(?=[\s/>=])/.test(tag),
    };
  });
  // Пустая выборка — это провал, а не успех: цикл по нулю записей проходит всегда.
  expect(found.length, `на ${PAGE} не найдено ни одной записи расписания — проверять нечего`)
    .toBeGreaterThan(0);
  return found;
}

interface MonthOption {
  value: string;
  text: string;
  count: number | null;
}

/** Разметка контрола месяца целиком. */
function monthControl(): string {
  const block = html().match(/<select\b[^>]*\bdata-schedule-filter="month"[^>]*>[\s\S]*?<\/select>/i);
  expect(
    block?.[0],
    `на ${PAGE} нет контрола месяца (select с data-schedule-filter="month") — проверять нечего`,
  ).toBeTruthy();
  return block?.[0] ?? '';
}

/** Пункты контрола месяца, кроме пустого значения. */
function monthOptions(): MonthOption[] {
  const options = [...monthControl().matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((match) => {
    const value = match[1].match(/\bvalue="([^"]*)"/)?.[1] ?? '';
    const text = match[2].replace(/<[^>]*>/g, '').trim();
    const count = text.match(/\((\d+)\)\s*$/);
    return { value, text, count: count ? Number(count[1]) : null };
  });
  const months = options.filter((option) => option.value !== '');
  expect(months.length, 'в контроле месяца нет ни одного месяца — проверять нечего').toBeGreaterThan(0);
  return months;
}

/** Содержимое блока скрипта управления расписанием. */
function controlsScript(): string {
  const block = html().match(/<script\b[^>]*\bdata-schedule-controls\b[^>]*>([\s\S]*?)<\/script>/i);
  // Отсутствие опознаваемого блока — падение, а не молчание: иначе проверка ищет
  // не там и докладывает об успехе. В документе есть и другие inline-скрипты.
  expect(
    block?.[1],
    'блок скрипта управления расписанием не найден по признаку data-schedule-controls — проверять нечего',
  ).toBeTruthy();
  return block?.[1] ?? '';
}

describe('признак месяца у записей расписания', () => {
  it('у каждой показанной записи непустой список ключей YYYY-MM', () => {
    const broken = scheduleItems()
      .map((item, index) => ({ index, item }))
      .filter(({ item }) => item.keys.length === 0 || item.keys.some((key) => !KEY.test(key)))
      .map(({ index, item }) => `запись #${index + 1}: data-months="${item.keys.join(' ')}"`);
    expect(broken, `записей без корректного признака месяца: ${broken.length}\n${broken.slice(0, 8).join('\n')}`)
      .toEqual([]);
  });

  it('ключи записи не повторяются и идут по возрастанию', () => {
    const all = scheduleItems();
    // Без этой строки проверка зелена на записях вообще без ключей: пустой список
    // упорядочен и не содержит повторов. То есть она сообщала бы об успехе ровно
    // там, где сломано больше всего.
    expect(
      all.filter((item) => item.keys.length > 0).length,
      'ни у одной записи нет ключей месяца — упорядоченность проверять не на чем',
    ).toBeGreaterThan(0);

    const broken = all
      .filter((item) => {
        const sorted = [...item.keys].sort();
        return new Set(item.keys).size !== item.keys.length || item.keys.join(' ') !== sorted.join(' ');
      })
      .map((item) => item.keys.join(' '));
    expect(broken, `ключи записи не упорядочены или повторяются:\n${broken.slice(0, 8).join('\n')}`).toEqual([]);
  });

  it('ни одна запись не приезжает скрытой', () => {
    // Без JavaScript посетитель обязан видеть расписание целиком: скрытие — работа
    // скрипта, а не разметки.
    const hidden = scheduleItems().filter((item) => item.hidden);
    expect(hidden.length, `записей с атрибутом hidden в разметке: ${hidden.length}`).toBe(0);
  });
});

describe('контрол месяца в разметке', () => {
  it('приезжает выключенным', () => {
    // Образец рядом — список программ: без скрипта элемент не должен выглядеть
    // рабочим. Включение меняет только `disabled`, поэтому раскладка не сдвигается.
    expect(monthControl(), 'контрол месяца приезжает включённым и без скрипта ничего не делает')
      .toMatch(/\sdisabled(?=[\s/>=])/);
  });

  it('пустое значение называется «Не выбрано», как у соседних фильтров', () => {
    const empty = [...monthControl().matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
      .find((match) => (match[1].match(/\bvalue="([^"]*)"/)?.[1] ?? '') === '');
    expect(empty?.[2].replace(/<[^>]*>/g, '').trim()).toBe('Не выбрано');
  });

  it('месяцы предложены по возрастанию', () => {
    const values = monthOptions().map((option) => option.value);
    expect(values.filter((value) => !KEY.test(value)), 'нечитаемые значения пунктов').toEqual([]);
    expect(values).toEqual([...values].sort());
  });

  it('подпись — название месяца в именительном падеже с заглавной буквы и год', () => {
    const wrong: string[] = [];
    for (const option of monthOptions()) {
      const [year, month] = option.value.split('-');
      const expectedName = MONTH_NAMES[Number(month) - 1];
      if (!option.text.startsWith(`${expectedName} ${year}`)) {
        wrong.push(`${option.value} → «${option.text}», ожидалось начало «${expectedName} ${year}»`);
      }
      if (/\sг\./.test(option.text)) wrong.push(`${option.value} → «${option.text}»: приписка «г.»`);
    }
    expect(wrong, `подписи месяцев:\n${wrong.join('\n')}`).toEqual([]);
  });
});

describe('список месяцев и ключи записей сходятся', () => {
  it('ни месяца без записей, ни ключа без месяца в списке', () => {
    const offered = new Set(monthOptions().map((option) => option.value));
    const used = new Set(scheduleItems().flatMap((item) => item.keys));

    const empty = [...offered].filter((key) => !used.has(key));
    const unreachable = [...used].filter((key) => !offered.has(key));

    expect(empty, `предложены месяцы без записей: ${empty.join(', ')}`).toEqual([]);
    expect(unreachable, `ключи записей, недостижимые выбором: ${unreachable.join(', ')}`).toEqual([]);
  });

  it('число в подписи равно числу записей этого месяца', () => {
    // Решение владельца 2026-08-11: число записей в подписи показывается. Оно —
    // второй носитель того же факта, поэтому расхождение обязано ловиться
    // проверкой, а не глазами.
    const all = scheduleItems();
    const wrong: string[] = [];
    for (const option of monthOptions()) {
      const actual = all.filter((item) => item.keys.includes(option.value)).length;
      if (option.count === null) wrong.push(`${option.value} → «${option.text}»: числа записей нет`);
      else if (option.count !== actual) wrong.push(`${option.value}: в подписи ${option.count}, записей ${actual}`);
    }
    expect(wrong, `подпись расходится с выдачей:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('сумма по месяцам равна числу записей плюс число пересечённых границ', () => {
    // Формула ИМЕННО такая. Обе естественные и неверные записать сюда, чтобы их не
    // написали заново:
    //   «сумма = число записей на странице» — красна на исправном коде уже сейчас
    //     (в данных есть события через границу месяца, id 414 и id 443);
    //   «сумма = записи + число записей с несколькими ключами» — верна только пока
    //     событие не длиннее двух месяцев; событие на три месяца даст три ключа и
    //     два пересечения, и проверка покраснеет на исправном коде.
    const all = scheduleItems();
    const borders = all.reduce((total, item) => total + Math.max(0, item.keys.length - 1), 0);
    const sum = monthOptions().reduce((total, option) => total + (option.count ?? 0), 0);

    expect(sum).toBe(all.length + borders);
  });
});

describe('скрипт управления расписанием не выводит время', () => {
  it('блок скрипта опознаётся по признаку, а не по совпадению текста', () => {
    expect(controlsScript().length, 'блок скрипта управления пуст').toBeGreaterThan(0);
  });

  it('внутри нет получения текущего времени и сравнения дат', () => {
    // Наивная реализация фильтра сравнивает дату записи с выбранным значением в
    // браузере — тогда о времени судят два места, сборка и скрипт, и расходятся
    // они не сразу и не заметно.
    const offenders = controlsScript()
      .split('\n')
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => !line.startsWith('//'))
      .filter(({ line }) => /new Date\b|Date\.now|Date\.parse|getTime\(|toISOString|\bIntl\b/.test(line))
      .map(({ line, index }) => `строка ${index + 1}: ${line.slice(0, 90)}`);
    expect(offenders, `работа с датами в клиентском скрипте расписания:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('фильтрация опирается на признак записи', () => {
    // Иначе контрол месяца может приехать в разметку, ничего не фильтруя: список
    // месяцев есть, выбор есть, выдача не меняется.
    expect(
      controlsScript(),
      'скрипт не читает data-months — месяц он получает откуда-то ещё',
    ).toMatch(/dataset\.months|data-months/);
  });
});
