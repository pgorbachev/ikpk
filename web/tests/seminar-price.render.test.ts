import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import * as data from '../src/lib/data';
import { getUpcomingSeminars } from '../src/lib/home';
import SeminarPage from '../src/pages/[institute]/[courseGroup]/[seminar].astro';
import SchedulePage from '../src/pages/raspisanie-i-tseny.astro';
import SeminarSchedulePanel from '../src/components/seminars/SeminarSchedulePanel.astro';
import type { ScheduleEntry } from '../src/lib/data';

afterEach(() => vi.restoreAllMocks());

it('schedule page prints Nicosia-local-midnight SQL dates under UTC', async () => {
  const entry = {
    ...data.getScheduleEntries()[0],
    startAt: '2024-09-22T21:00:00.000Z',
    endAt: '2024-09-22T21:00:00.000Z',
    status: 'active',
  };
  vi.spyOn(data, 'getScheduleEntries').mockReturnValue([entry]);
  vi.spyOn(data, 'getSnapshotReferenceDate').mockReturnValue('2024-09-23');
  vi.spyOn(data, 'getSeminarBuildNow').mockReturnValue(new Date('2024-09-22T20:00:00.000Z'));
  const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
  const html = await container.renderToString(SchedulePage, {
    request: new Request('https://ikpk.su/raspisanie-i-tseny'),
  });
  expect(html.replace(/\s+/g, ' ')).toContain('23.09.2024');
});

it('schedule panel keeps SQL calendar dates and duration across Nicosia DST under UTC', async () => {
  const entry: ScheduleEntry = {
    id: 9002, status: 'active', name: 'DST test',
    seminar: { id: 9002, name: 'DST test', slug: 'dst-test' },
    institute: { id: 1, name: 'Институт', shortname: 'ИКПК' },
    startAt: '2024-03-29T22:00:00.000Z', endAt: '2024-03-30T21:00:00.000Z',
    teachers: [], image: null, isFree: false, isEventCollection: false,
    description: null, oldPrice: 0, newPrice: 12000,
    city: { id: 1, name: 'Москва' },
    program: { id: 1, slug: 'programma', name: 'Программа' },
    additionalText: '', duration: '16', registrationFormLink: '',
  };
  const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
  const html = (await container.renderToString(SeminarSchedulePanel, {
    props: { rows: [{ entry, teachers: [] }] },
    request: new Request('https://ikpk.su/seminar'),
  })).replace(/\s+/g, ' ');
  expect(html).toContain('30 марта 2024');
  expect(html).toContain('31 марта 2024');
  expect(html).toContain('2 дня (16 часов)');
});

describe('стоимость платного семинара: главная, расписание, карточка и JSON-LD', () => {
  it.each([
    { price: 0, isFree: false, label: 'Стоимость уточняется', offer: undefined },
    { price: undefined, isFree: false, label: 'Стоимость уточняется', offer: undefined },
    { price: Number.NaN, isFree: false, label: 'Стоимость уточняется', offer: undefined },
    { price: Number.POSITIVE_INFINITY, isFree: false, label: 'Стоимость уточняется', offer: undefined },
    { price: -100, isFree: false, label: 'Стоимость уточняется', offer: undefined },
    { price: 37500, isFree: false, label: '37 500 ₽', offer: '37500' },
    { price: 0, isFree: true, label: 'Бесплатно', offer: '0' },
    { price: 37500, isFree: true, label: 'Бесплатно', offer: '0' },
  ])('$price / isFree=$isFree → $label', async ({ price, isFree, label, offer }) => {
    const seminar = { ...data.getSeminars()[0], description_html: '' };
    const courseGroup = data.getCourseGroups().find((group) => group.legacy_id === seminar.course_group_legacy_id)!;
    const institute = data.getInstitutes().find((item) => item.slug === courseGroup.institute_legacy_id)!;
    const entry = {
      ...data.getScheduleEntries()[0],
      id: 440,
      name: seminar.name,
      seminar: { id: 440, name: seminar.name, slug: seminar.slug },
      newPrice: price as number,
      isFree,
      startAt: '2026-11-14T00:00:00.000Z',
      endAt: '2026-11-15T00:00:00.000Z',
      status: 'active',
    };
    vi.spyOn(data, 'getScheduleEntries').mockReturnValue([entry]);
    vi.spyOn(data, 'getSnapshotReferenceDate').mockReturnValue('2026-10-13');
    const visible = (value: string) => value.replace(/\s|&nbsp;|&#160;/g, ' ');
    expect.soft(visible(getUpcomingSeminars(1, new Date('2026-10-13T12:00:00Z'))[0].priceLabel)).toBe(label);

    const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
    const scheduleHtml = await container.renderToString(SchedulePage, {
      request: new Request('https://ikpk.su/raspisanie-i-tseny'),
    });
    expect.soft(visible(scheduleHtml).includes(label), 'цена в расписании').toBe(true);
    const seminarHtml = await container.renderToString(SeminarPage, {
      props: { seminar, courseGroup, institute },
      request: new Request(`https://ikpk.su/${institute.slug}/${courseGroup.slug}/${seminar.slug}`),
    });
    expect.soft(visible(seminarHtml).includes(label), 'цена на странице семинара').toBe(true);
    const schemas = [...seminarHtml.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]));
    const event = schemas.find((schema) => schema['@type'] === 'Event');
    expect(event).toBeDefined();
    expect(event.startDate).toBe('2026-11-14');
    expect(event.endDate).toBe('2026-11-15');
    if (offer === undefined) expect(event).not.toHaveProperty('offers');
    else expect(event.offers).toMatchObject({ '@type': 'Offer', price: offer, priceCurrency: 'RUB' });
  });
});
