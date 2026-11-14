import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import * as data from '../src/lib/data';
import SeminarPage from '../src/pages/[institute]/[courseGroup]/[seminar].astro';

afterEach(() => vi.restoreAllMocks());

async function renderEvent(overrides: Record<string, unknown>) {
  const seminar = { ...data.getSeminars()[0], description_html: '' };
  const courseGroup = data.getCourseGroups().find((item) => item.legacy_id === seminar.course_group_legacy_id)!;
  const institute = data.getInstitutes().find((item) => item.slug === courseGroup.institute_legacy_id)!;
  const entry = {
    ...data.getScheduleEntries()[0],
    id: 440,
    seminar: { id: 440, name: seminar.name, slug: seminar.slug },
    status: 'active',
    startAt: '2030-06-01T00:00:00.000Z',
    endAt: '2030-06-02T00:00:00.000Z',
    isFree: false,
    newPrice: 12000,
    ...overrides,
  };
  vi.spyOn(data, 'getScheduleEntries').mockReturnValue([entry]);
  vi.spyOn(data, 'getSeminarBuildNow').mockReturnValue(new Date('2030-01-01T00:00:00Z'));
  const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
  const html = await container.renderToString(SeminarPage, {
    props: { seminar, courseGroup, institute },
    request: new Request(`https://ikpk.su/${institute.slug}/${courseGroup.slug}/${seminar.slug}`),
  });
  const schemas = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  const event = schemas.find((schema) => schema['@type'] === 'Event');
  expect(event).toBeDefined();
  return event;
}

describe('structured data reflects the seminar occurrence', () => {
  it('represents an online event without an offline mode or physical address', async () => {
    const event = await renderEvent({ isOnline: true, city: { id: 0, name: 'Онлайн' } });
    expect.soft(event.eventAttendanceMode).toBe('https://schema.org/OnlineEventAttendanceMode');
    expect.soft(event.location?.['@type']).not.toBe('Place');
    expect.soft(event.location ?? {}).not.toHaveProperty('address');
  });

  it('uses the actual city of an offline event', async () => {
    const event = await renderEvent({ isOnline: false, city: { id: 20, name: 'Москва' } });
    expect(event.eventAttendanceMode).toBe('https://schema.org/OfflineEventAttendanceMode');
    expect(event.location.address.addressLocality).toBe('Москва');
  });

  it('does not invent a zero-price offer when the paid price is unknown', async () => {
    const event = await renderEvent({ isOnline: false, city: { id: 20, name: 'Москва' }, newPrice: null });
    expect(event).not.toHaveProperty('offers');
  });

  it('retains an explicit zero-price offer for a free event', async () => {
    const event = await renderEvent({ isOnline: false, city: { id: 20, name: 'Москва' }, isFree: true, newPrice: 0 });
    expect(event.offers).toMatchObject({ '@type': 'Offer', price: '0', priceCurrency: 'RUB' });
  });
});
