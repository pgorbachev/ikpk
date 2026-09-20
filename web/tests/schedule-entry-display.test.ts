import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPrice, getScheduleEntries, normalizeScheduleEntry } from '../src/lib/data.js';
import { getCatalogStats, getUpcomingSeminars } from '../src/lib/home.js';
import { isCurrentOrFuture } from '../src/lib/schedule-window.js';

/** ru-RU кладёт неразрывный пробел в «не число» и в тысячи — сравниваем видимый текст. */
const visible = (value: string): string => value.replace(/\s+/g, ' ').trim();

describe('formatPrice: нечисло не уходит в подпись', () => {
  it('undefined и NaN не печатаются как «не число»', () => {
    expect(formatPrice(undefined as never)).toBe('');
    expect(formatPrice(Number.NaN)).toBe('');
  });

  it('ноль остаётся «Бесплатно», конечное число — с ₽', () => {
    expect(formatPrice(0)).toBe('Бесплатно');
    expect(visible(formatPrice(37_500))).toBe('37 500 ₽');
  });
});

describe('CMS-форма записи расписания читается как цена и город', () => {
  it('строка city и поле price дают имя города и конечную цену', () => {
    const entry = normalizeScheduleEntry({
      city: 'Набережные Челны',
      price: 37_500,
    });
    expect(entry.city.name).toBe('Набережные Челны');
    expect(entry.newPrice).toBe(37_500);
  });

  it('уже объектный city и newPrice не переписываются', () => {
    const entry = normalizeScheduleEntry({
      city: { id: 3, name: 'Москва' },
      newPrice: 65_000,
    });
    expect(entry.city).toEqual({ id: 3, name: 'Москва' });
    expect(entry.newPrice).toBe(65_000);
  });
});

describe('загрузка снимка сводит CMS-форму', () => {
  const dirs: string[] = [];
  const previousSnapshotDir = process.env.CONTENT_SNAPSHOT_DIR;

  afterEach(() => {
    if (previousSnapshotDir === undefined) delete process.env.CONTENT_SNAPSHOT_DIR;
    else process.env.CONTENT_SNAPSHOT_DIR = previousSnapshotDir;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('getScheduleEntries читает city-строку и price с диска, а не только нормализатор напрямую', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cms-sched-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, 'snapshot.json'),
      JSON.stringify({
        referenceDate: '2026-09-20',
        content: {
          types: {
            schedule_entries: [
              {
                id: 469,
                status: 'active',
                name: 'ПК-5',
                city: 'Набережные Челны',
                price: 37_500,
                isFree: false,
                startAt: '2026-09-22T00:00:00.000Z',
                endAt: '2026-09-25T00:00:00.000Z',
              },
            ],
          },
        },
      }),
    );

    process.env.CONTENT_SNAPSHOT_DIR = dir;
    vi.resetModules();
    const { getScheduleEntries: load, formatPrice: price } = await import('../src/lib/data.js');
    const [entry] = load();
    expect(entry.city.name, 'загрузка не свела строку города').toBe('Набережные Челны');
    expect(entry.newPrice).toBe(37_500);
    expect(visible(price(entry.newPrice))).toBe('37 500 ₽');
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
