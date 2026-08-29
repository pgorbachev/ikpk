import { describe, it, expect } from 'vitest';
import { lastDay, plannedSlugs } from '../scripts/lib/planned-seminars';

// Проверяем ВЫВОД, а не снимок данных.
//
// Прежняя проверка сравнивала поле `status` в снимке seminars
// с расписанием на текущую дату. Она краснела от хода времени: 3 августа 2026
// года гейт упал на семинаре, чья единственная дата прошла 29 июля, — код при
// этом был исправен, устарел снимок. Такой гейт не отличает дефект от
// календаря, поэтому его место занимают фикстуры с фиксированной датой.
//
// Исходный дефект, ради которого проверка появилась, фикстурами покрыт: событие
// в прошлом не делает семинар запланированным.
const TODAY = '2026-08-03';
const entry = (
  slug: string,
  startAt: string,
  endAt?: string,
  status = 'active',
): { status: string; startAt: string; endAt?: string; seminar: { slug: string } } => ({
  status,
  startAt,
  ...(endAt ? { endAt } : {}),
  seminar: { slug },
});

describe('вывод запланированных семинаров', () => {
  it('прошедшее событие не делает семинар запланированным', () => {
    const planned = plannedSlugs([entry('past', '2026-07-29')], TODAY);
    expect([...planned]).toEqual([]);
  });

  it('событие в будущем делает семинар запланированным', () => {
    const planned = plannedSlugs([entry('future', '2026-09-01')], TODAY);
    expect([...planned]).toEqual(['future']);
  });

  // Полное сравнение метки времени выбрасывало идущий сегодня семинар уже в
  // 00:01 дня проведения — «Даты уточняются» на семинаре, который идёт прямо
  // сейчас.
  it('событие сегодня остаётся запланированным', () => {
    const planned = plannedSlugs([entry('today', `${TODAY}T00:00:00.000Z`)], TODAY);
    expect([...planned]).toEqual(['today']);
  });

  // 60 событий из 63 длятся несколько дней: пока идёт последний день, семинар
  // актуален, хотя начался в прошлом.
  it('многодневное событие актуально до последнего дня', () => {
    const planned = plannedSlugs([entry('multi', '2026-08-01', '2026-08-05')], TODAY);
    expect([...planned]).toEqual(['multi']);
  });

  it('многодневное событие целиком в прошлом не считается', () => {
    const planned = plannedSlugs([entry('over', '2026-07-20', '2026-07-25')], TODAY);
    expect([...planned]).toEqual([]);
  });

  it('неактивная запись расписания не считается', () => {
    const planned = plannedSlugs([entry('cancelled', '2026-09-01', undefined, 'cancelled')], TODAY);
    expect([...planned]).toEqual([]);
  });

  it('запись без семинара не считается', () => {
    const planned = plannedSlugs([{ status: 'active', startAt: '2026-09-01', seminar: null }], TODAY);
    expect([...planned]).toEqual([]);
  });

  it('один семинар с несколькими событиями попадает в набор один раз', () => {
    const planned = plannedSlugs(
      [entry('twice', '2026-09-01'), entry('twice', '2026-10-01')],
      TODAY,
    );
    expect([...planned]).toEqual(['twice']);
  });

  describe('последний день события', () => {
    it('берёт endAt, когда он позже начала', () => {
      expect(lastDay({ startAt: '2026-08-01', endAt: '2026-08-05' })).toBe('2026-08-05');
    });

    // Данные приходят из чужого API: endAt раньше startAt встречается, и
    // «последним днём» тогда обязан быть startAt, иначе идущее событие уедет в
    // прошлое.
    it('берёт startAt, когда endAt раньше начала', () => {
      expect(lastDay({ startAt: '2026-08-05', endAt: '2026-08-01' })).toBe('2026-08-05');
    });

    it('обходится без дат', () => {
      expect(lastDay({})).toBe('');
    });
  });
});
