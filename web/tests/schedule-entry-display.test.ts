import { describe, it, expect } from 'vitest';
import { formatPrice, getScheduleEntries } from '../src/lib/data.js';
import { getCatalogStats, getUpcomingSeminars } from '../src/lib/home.js';
import { isCurrentOrFuture } from '../src/lib/schedule-window.js';

/** ru-RU кладёт неразрывный пробел в «не число» и в тысячи — сравниваем видимый текст. */
const visible = (value: string): string => value.replace(/\s+/g, ' ').trim();

describe('formatPrice: нечисло не уходит в подпись', () => {
  it('undefined и NaN не печатаются как «не число»', () => {
    expect(visible(formatPrice(undefined as never)), 'undefined дал «не число»').not.toMatch(/не число/i);
    expect(visible(formatPrice(Number.NaN)), 'NaN дал «не число»').not.toMatch(/не число/i);
    expect(formatPrice(undefined as never)).toBe('');
    expect(formatPrice(Number.NaN)).toBe('');
  });

  it('ноль остаётся «Бесплатно», конечное число — с ₽', () => {
    expect(formatPrice(0)).toBe('Бесплатно');
    expect(visible(formatPrice(37_500))).toBe('37 500 ₽');
  });
});

describe('CMS-форма записи расписания читается как цена и город', () => {
  it('строка city и поле price дают имя города и конечную цену, а не «Уточняется»/«не число»', async () => {
    const { normalizeScheduleEntry } = await import('../src/lib/data.js');
    const entry = normalizeScheduleEntry({
      id: 469,
      status: 'active',
      name: 'ПК-5',
      seminar: { id: 1, name: 'ПК-5', slug: 'pk-5' },
      institute: { id: 1, name: 'ИКПК', shortname: 'ИКПК' },
      startAt: '2026-09-22T00:00:00.000Z',
      endAt: '2026-09-25T00:00:00.000Z',
      teachers: [],
      image: null,
      isFree: false,
      isEventCollection: false,
      description: null,
      oldPrice: 0,
      price: 37_500,
      city: 'Набережные Челны',
      program: { id: 1, slug: 'pk', name: 'ПК' },
      additionalText: '',
      duration: '36',
      registrationFormLink: '',
    });

    expect(entry.city.name, 'строка города не стала city.name').toBe('Набережные Челны');
    expect(entry.newPrice).toBe(37_500);
    expect(visible(formatPrice(entry.newPrice))).toBe('37 500 ₽');
  });

  it('уже объектный city и newPrice не переписываются', async () => {
    const { normalizeScheduleEntry } = await import('../src/lib/data.js');
    const entry = normalizeScheduleEntry({
      id: 377,
      status: 'active',
      name: 'CST-2',
      seminar: { id: 1, name: 'CST-2', slug: 'cst-2' },
      institute: { id: 2, name: 'Апледжера', shortname: 'Апледжера' },
      startAt: '2026-09-17T00:00:00.000Z',
      endAt: '2026-09-20T00:00:00.000Z',
      teachers: [],
      image: null,
      isFree: false,
      isEventCollection: false,
      description: null,
      oldPrice: 0,
      newPrice: 65_000,
      city: { id: 3, name: 'Москва' },
      program: { id: 1, slug: 'cst', name: 'КСТ' },
      additionalText: '',
      duration: '36',
      registrationFormLink: '',
    });

    expect(entry.city).toEqual({ id: 3, name: 'Москва' });
    expect(entry.newPrice).toBe(65_000);
  });
});

describe('ближайшие семинары — ещё не начавшиеся', () => {
  const TODAY = '2026-09-20';
  const now = new Date(`${TODAY}T12:00:00.000Z`);
  const CST2_SEP = 377;

  it('опора: CST-2 17–20 сентября в снимке ещё идёт 20-го', () => {
    const started = getScheduleEntries().find((entry) => entry.id === CST2_SEP);
    expect(started, 'в закреплённом снимке нет CST-2 id 377').toBeTruthy();
    expect(started!.startAt.slice(0, 10)).toBe('2026-09-17');
    expect(started!.endAt.slice(0, 10)).toBe('2026-09-20');
    expect(
      isCurrentOrFuture(started!, TODAY),
      '20 сентября — последний день CST-2: страница расписания его ещё держит',
    ).toBe(true);
  });

  it('уже начавшийся семинар не занимает строку «Ближайший семинар»', () => {
    const upcoming = getUpcomingSeminars(20, now);
    expect(upcoming.map((item) => item.id), 'CST-2 17–20 сентября остался ближайшим').not.toContain(CST2_SEP);

    const next = upcoming[0];
    expect(next, 'после фильтра не осталось ни одного будущего семинара').toBeTruthy();
    const nextEntry = getScheduleEntries().find((entry) => entry.id === next!.id);
    expect(nextEntry!.startAt.slice(0, 10) >= TODAY, `${next!.title} уже начался к ${TODAY}`).toBe(true);
  });

  it('счётчик дат каталога по-прежнему держит идущее событие до последнего дня', () => {
    const current = getScheduleEntries().filter(
      (entry) => entry.status === 'active' && entry.startAt && isCurrentOrFuture(entry, TODAY),
    );
    expect(current.some((entry) => entry.id === CST2_SEP)).toBe(true);
    expect(getCatalogStats(now).dates).toBe(current.length);
  });
});
