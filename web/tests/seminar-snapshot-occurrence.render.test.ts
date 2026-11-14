import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import ScheduleEventCard from '../src/components/schedule/ScheduleEventCard.astro';
import SeminarSchedulePanel from '../src/components/seminars/SeminarSchedulePanel.astro';
import { FIELD_MAP } from '../scripts/lib/content-field-map';

const previous = process.env.CONTENT_SNAPSHOT_DIR;
const dirs: string[] = [];
afterEach(() => {
  if (previous === undefined) delete process.env.CONTENT_SNAPSHOT_DIR; else process.env.CONTENT_SNAPSHOT_DIR = previous;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});
const base = { status: 'active', name: 'Семинар', startAt: '2099-11-20T09:00:00.000Z', endAt: '2099-11-20T17:00:00.000Z', seminar: { id: 10, name: 'Семинар', slug: 'seminar' }, institute: { id: 1, name: 'Институт', shortname: 'ИКПК' }, program: { id: 1, slug: 'program', name: 'Программа' }, isFree: true, teachers: [], registrationFormLink: '/registration', additionalText: '' };
async function load(entries: object[], seminars: object[] = [{ id: 10, slug: 'seminar', name: 'Семинар', duration: '24 часа' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'occurrence-snapshot-')); dirs.push(dir);
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ referenceDate: '2026-11-13', content: { types: { schedule_entries: entries, seminars, institutes: [], course_groups: [], teachers: [], articles: [] } } }));
  process.env.CONTENT_SNAPSHOT_DIR = dir; vi.resetModules();
  const data = await import('../src/lib/data'); const home = await import('../src/lib/home');
  return { entries: data.getScheduleEntries(), home };
}
describe('CMS snapshot and public consumers', () => {
  it.each([['schedule_entries', 'isOnline'], ['seminars', 'duration']])('FIELD_MAP captures %s.%s', (type, source) => {
    expect(FIELD_MAP.some((e) => e.type === type && e.source === source)).toBe(true);
  });
  it('online null city, offline city and pinned legacy online reach schedule, seminar panel and counters', async () => {
    const { entries, home } = await load([{ ...base, id: 1, city: null, isOnline: true, duration: '8' }, { ...base, id: 2, city: 'Москва', isOnline: false, duration: '8' }, { ...base, id: 3, city: 'Онлайн', duration: '8' }]);
    expect(entries.map((e) => e.city?.name)).toEqual(['Онлайн', 'Москва', 'Онлайн']);
    const now = new Date('2099-01-01T00:00:00Z'); const stats = home.getCatalogStats(now);
    expect(stats.onlineDates).toBe(2); expect(stats.cityNames).toEqual(['Москва']);
    const upcoming = home.getUpcomingSeminars(3, now);
    expect(upcoming.map((e) => e.cityName)).toEqual(['Онлайн', 'Москва', 'Онлайн']);
    const container = await AstroContainer.create();
    const panel = await container.renderToString(SeminarSchedulePanel, { props: { rows: entries.map((entry) => ({ entry, teachers: [] })) } });
    expect((panel.match(/Записаться на вебинар/g) || []).length).toBe(2);
    expect((panel.match(/Записаться на семинар/g) || []).length).toBe(1); expect(panel).toContain('Москва');
    for (const event of upcoming) {
      const html = await container.renderToString(ScheduleEventCard, { props: { ...event, titleHref: event.href, teacherLabel: '', programName: 'Программа', registrationHref: '/registration' } });
      expect(html).toContain(event.cityName === 'Онлайн' ? 'Записаться на вебинар' : 'Записаться на семинар'); expect(html).toContain(event.cityName);
    }
  });
  it('legacy pinned online and explicit override remain usable', async () => {
    const { entries } = await load([{ ...base, id: 1, city: 'Онлайн', duration: '6 часов' }]);
    expect(entries[0].city.name).toBe('Онлайн');
    expect(entries[0].duration).toBe('6 часов');
    const panel = await (await AstroContainer.create()).renderToString(SeminarSchedulePanel, { props: { rows: [{ entry: entries[0], teachers: [] }] } });
    expect(panel).toContain('Записаться на вебинар');
    expect(panel).toContain('6 часов');
  });
  it('online counters use the normalized snapshot', async () => {
    const { home } = await load([{ ...base, id: 1, city: null, isOnline: true, duration: '8' }, { ...base, id: 2, city: 'Москва', isOnline: false, duration: '8' }]);
    const stats = home.getCatalogStats(new Date('2099-01-01T00:00:00Z'));
    expect(stats.onlineDates).toBe(1); expect(stats.cityNames).toEqual(['Москва']);
  });
  it('home preserves a textual duration and adds hours only to numeric legacy values', async () => {
    const { home } = await load([{ ...base, id: 1, city: 'Москва', duration: '24 часа' }, { ...base, id: 2, city: 'Москва', duration: '8' }]);
    expect(home.getUpcomingSeminars(2, new Date('2099-01-01T00:00:00Z')).map((e) => e.durationLabel)).toEqual(['24 часа', '8 ч']);
  });
  it('inherits published default for empty override but keeps explicit override', async () => {
    const { entries } = await load([{ ...base, id: 1, city: 'Москва', duration: null }, { ...base, id: 2, city: 'Москва', duration: '6 часов' }]);
    expect(entries.map((e) => e.duration)).toEqual(['24 часа', '6 часов']);
    const html = await (await AstroContainer.create()).renderToString(SeminarSchedulePanel, { props: { rows: entries.map((entry) => ({ entry, teachers: [] })) } });
    expect(html).toContain('24 часа'); expect(html).toContain('6 часов');
  });
  it('uses published seminar duration in snapshot, not a stale draft relation value', async () => {
    const { entries } = await load([{ ...base, id: 1, city: 'Москва', duration: null, seminar: { ...base.seminar, duration: 'ЧЕРНОВИК' } }], [{ id: 10, slug: 'seminar', name: 'Семинар', duration: 'Опубликованные 12 часов' }]);
    expect(entries[0].duration).toBe('Опубликованные 12 часов'); expect(entries[0].duration).not.toContain('ЧЕРНОВИК');
  });
});
