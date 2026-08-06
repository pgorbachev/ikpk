import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
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
describe('страницы не фильтруют расписание по startAt напрямую', () => {
  const PAGES = [
    join('src', 'pages', 'raspisanie-i-tseny.astro'),
    join('src', 'pages', '[institute]', '[courseGroup]', '[seminar].astro'),
  ];

  it('обе страницы используют общий вывод актуальности', () => {
    const offenders: string[] = [];
    for (const rel of PAGES) {
      const text = readFileSync(join(import.meta.dirname, '..', rel), 'utf-8');
      // Опасный признак: сравнение времени начала с текущей датой.
      if (/new Date\((?:entry|e)\.startAt\)\.getTime\(\)\s*>=/.test(text)) {
        offenders.push(`${rel}: фильтр по startAt вместо последнего дня события`);
      }
      if (!/isCurrentOrFuture/.test(text)) {
        offenders.push(`${rel}: не использует isCurrentOrFuture`);
      }
    }
    expect(
      offenders,
      `многодневные события исчезнут после первого дня (в данных таких 60 из 63):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
