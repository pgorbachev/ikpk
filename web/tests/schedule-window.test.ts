import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isCurrentOrFuture, lastDay } from '../src/lib/schedule-window';

// Многодневное событие обязано оставаться на страницах до последнего дня. Из 63
// записей расписания 60 многодневные, поэтому фильтр по `startAt` убирал бы
// идущий семинар уже на второй день обучения.
//
// Дата фиксированная: проверка не должна краснеть от хода времени — этот дефект в
// проекте уже был (гейт `catalog-data` падал на устаревшем снимке при исправном
// коде).
const TODAY = '2026-08-06';

describe('окно актуальности записи расписания', () => {
  it('событие целиком в будущем актуально', () => {
    expect(isCurrentOrFuture({ startAt: '2026-09-01', endAt: '2026-09-03' }, TODAY)).toBe(true);
  });

  it('идущее многодневное событие актуально во второй день', () => {
    expect(isCurrentOrFuture({ startAt: '2026-08-05', endAt: '2026-08-08' }, TODAY)).toBe(true);
  });

  it('событие, начавшееся и закончившееся в прошлом, неактуально', () => {
    expect(isCurrentOrFuture({ startAt: '2026-07-20', endAt: '2026-07-25' }, TODAY)).toBe(false);
  });

  it('однодневное событие сегодня актуально', () => {
    expect(isCurrentOrFuture({ startAt: `${TODAY}T00:00:00.000Z` }, TODAY)).toBe(true);
  });

  it('последний день события — сегодня: ещё актуально', () => {
    expect(isCurrentOrFuture({ startAt: '2026-08-01', endAt: TODAY }, TODAY)).toBe(true);
  });

  describe('последний день', () => {
    it('берёт endAt, когда он позже начала', () => {
      expect(lastDay({ startAt: '2026-08-01', endAt: '2026-08-05' })).toBe('2026-08-05');
    });

    // Данные приходят из чужого API: endAt раньше startAt встречается, и последним
    // днём тогда обязан быть startAt, иначе идущее событие уедет в прошлое.
    it('берёт startAt, когда endAt раньше начала', () => {
      expect(lastDay({ startAt: '2026-08-05', endAt: '2026-08-01' })).toBe('2026-08-05');
    });

    it('обходится без дат', () => {
      expect(lastDay({})).toBe('');
    });
  });
});

// Гейт против возврата дефекта в разметку: страницы обязаны фильтровать расписание
// через общий вывод, а не сравнивать `startAt` напрямую. Проверка текстовая
// намеренно — поведение страниц Astro на этапе сборки юнит-тестом не наблюдаемо, а
// браузерный тест увидит дефект только в те дни, когда идёт многодневный семинар.
// Гейт против возврата дефекта: НИ ОДИН файл в `src/` не должен сравнивать время
// начала события с текущей датой. Первая редакция перечисляла два пути руками — и
// пропустила третью копию в `web/src/lib/home.ts`, из-за которой расписание
// показывало идущий семинар, а «Ближайшие семинары» на главной нет. Перечисление
// частных случаев запрещено правилами проекта именно по этой причине.
describe('нигде в src нет фильтра расписания по startAt', () => {
  const SRC = join(import.meta.dirname, '..', 'src');
  // Признак общий: сравнение startAt с датой/меткой времени в любом виде.
  const BAD = [
    /new Date\(\s*\w+\.startAt\s*\)\.getTime\(\)\s*[<>]=?/,
    /\w+\.startAt(?:\s*\?\?\s*'')?\.slice\(0,\s*10\)\s*[<>]=?\s*(?!.*isCurrentOrFuture)\w/,
  ];

  function* files(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) yield* files(full);
      else if (/\.(astro|ts)$/.test(name)) yield full;
    }
  }

  it('сравнений startAt с датой не осталось', () => {
    const all = [...files(SRC)];
    expect(all.length, 'файлов в src не найдено — проверять нечего').toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of all) {
      // Файл общего вывода — единственное законное место, где даты сравниваются.
      if (file.endsWith('schedule-window.ts')) continue;
      const text = readFileSync(file, 'utf-8');
      text.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('//')) return;
        if (BAD.some((re) => re.test(line))) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} → ${line.trim().slice(0, 80)}`);
        }
      });
    }
    expect(
      offenders,
      `многодневные события исчезнут после первого дня (в данных таких 60 из 63):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
