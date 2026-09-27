import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicScheduleTitle } from '../src/lib/schedule-public-title';

describe('публичное название проведения', () => {
  it('берёт опубликованное название семинара, а не служебное имя проведения', () => {
    const imported = { name: 'Н-ПК-1', seminar: { name: 'НПК-1' } };
    expect(publicScheduleTitle(imported)).toBe('НПК-1');
    expect(publicScheduleTitle({ seminar: { name: '  НПК-2  ' } })).toBe('НПК-2');
  });

  it('расписание и ближайшие семинары берут заголовок из этой функции', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const schedule = readFileSync(join(root, 'pages/raspisanie-i-tseny.astro'), 'utf8');
    const home = readFileSync(join(root, 'lib/home.ts'), 'utf8');
    expect(schedule).toContain('publicScheduleTitle(entry)');
    expect(schedule).not.toContain('title: entry.name');
    expect(home).toContain('publicScheduleTitle(e)');
    expect(home).not.toContain('title: e.name');
  });

  it('не подставляет служебное имя, если название семинара в снимке пустое', () => {
    expect(() => publicScheduleTitle({ seminar: { name: '  ' } })).toThrow(/названия семинара/);
    expect(() => publicScheduleTitle({ seminar: null })).toThrow(/названия семинара/);
  });
});
