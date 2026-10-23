import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPage } from './helpers/dist-pages';
import { attr, findAll, textOf, walk } from './helpers/dom';
import { buildSeminarDatesFixture } from './helpers/seminar-dates-fixture';
import { getCourseGroups, getInstitutes, getScheduleEntries, getSeminars, getSnapshotReferenceDate } from '../src/lib/data';
import { isBeforeStart } from '../src/lib/schedule-window';

const MOBILE_HREF = 'tel:+79810387797';
const MAIN_HREF = 'tel:+78126465450';
const norm = (value: unknown): string => textOf(value).replace(/\s+/g, ' ').trim();
const inCard = (card: Parameters<typeof textOf>[0], testid: string) =>
  [...walk(card)].filter((el) => attr(el, 'data-testid') === testid && attr(el, 'hidden') === null);

/** Built routes with controlled calendar dates.
 * The fixture contains both nearest-date and fallback
 * branches, an already started multi-day session and a next-year session. */
describe('страница программы: ближайшая будущая дата и отсутствие дат', () => {
  let fixture: ReturnType<typeof buildSeminarDatesFixture>;
  beforeAll(() => { fixture = buildSeminarDatesFixture(); }, 150_000);
  afterAll(() => fixture?.close());

  it('каждая карточка показывает свою ближайшую дату, включая год, либо телефон менеджера', () => {
    const { pages, outDir } = fixture;
    const html = readFileSync(join(outDir, pages.institute.slug, pages.group.slug, 'index.html'), 'utf8');
    const cards = findAll(html, (el) => attr(el, 'data-testid') === 'course-group-seminar-card');
    expect(cards).toHaveLength(3);
    for (const [seminar, expected] of [[pages.planned, '30 сен – 2 окт'], [pages.nextYear, '5 янв 2027'], [pages.empty, null]] as const) {
      const card = cards.find((el) => [...walk(el)].some((child) => child.tagName === 'h2' && norm(child) === seminar.name.replace(/\s+/g, ' ').trim()));
      expect(card, seminar.name).toBeTruthy();
      const shown = inCard(card!, 'seminar-nearest-date').map(norm);
      if (expected) {
        expect(shown, seminar.name).toEqual([expected]);
        expect(inCard(card!, 'seminar-date-fallback')).toHaveLength(0);
      } else {
        expect(shown).toEqual([]);
        expect(inCard(card!, 'seminar-date-fallback').map(norm)).toEqual(['Даты пока не назначены']);
        expect([...walk(card!)].some((el) => attr(el, 'href') === MOBILE_HREF)).toBe(true);
      }
    }
  });
});

/** Characterize the ordinary built snapshot separately; it may legitimately have
 * no future offers. The controlled build above always proves both branches. */
describe('исторический снимок: страницы без будущих сеансов', () => {
  it('сохраняет карточки описаний и контакты менеджера на каждой пустой странице', () => {
    const institutes = getInstitutes();
    const entries = getScheduleEntries().filter((entry) => entry.status === 'active'
      && isBeforeStart(entry, getSnapshotReferenceDate()));
    let checked = 0;
    for (const group of getCourseGroups()) {
      const institute = institutes.find((item) => item.slug === group.institute_legacy_id);
      if (!institute) continue;
      const programPath = `/${institute.slug}/${group.slug}`;
      const cards = findAll(readPage(programPath), (el) => attr(el, 'data-testid') === 'course-group-seminar-card');
      const seminars = getSeminars(group.legacy_id);
      expect(cards, programPath).toHaveLength(seminars.length);
      for (const seminar of seminars) {
        if (entries.some((entry) => entry.seminar?.slug === seminar.slug)) continue;
        checked++;
        const card = cards.find((el) => [...walk(el)].some((child) => child.tagName === 'h2' && norm(child) === seminar.name.replace(/\s+/g, ' ').trim()));
        expect(card, `${programPath}/${seminar.slug}`).toBeTruthy();
        expect(inCard(card!, 'seminar-nearest-date')).toHaveLength(0);
        expect(inCard(card!, 'seminar-date-fallback').map(norm)).toEqual(['Даты пока не назначены']);
        expect([...walk(card!)].some((el) => attr(el, 'href') === MOBILE_HREF)).toBe(true);
        const route = `${programPath}/${seminar.slug}`;
        const panels = findAll(readPage(route), (el) => attr(el, 'data-testid') === 'seminar-schedule-empty' && attr(el, 'hidden') === null);
        expect(panels, route).toHaveLength(1);
        expect(norm(panels[0])).toContain('Даты пока не назначены');
        expect(norm(panels[0])).not.toContain('К сожалению, данный курс');
        const phones = [...walk(panels[0])].map((el) => attr(el, 'href'));
        for (const href of [MAIN_HREF, MOBILE_HREF]) expect(phones, route).toContain(href);
      }
    }
    expect(checked, 'характеризация пустых страниц не должна быть вакуумной').toBeGreaterThan(0);
  });
});
