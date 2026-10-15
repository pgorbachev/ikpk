import { describe, expect, it } from 'vitest';
import { mapSqlPublicContent, type SqlPublicContentOptions, type SqlPublicSource } from './sql-public-content.js';

const sourceHash = `sha256:${'b'.repeat(64)}`;
const timestamps = { createdAt: '2026-10-12T12:00:00', updatedAt: '2027-01-02T09:15:00' };
const base: SqlPublicSource = {
  sourceHash,
  Institutes: [1, 2, 3].map((id) => ({ id, name: `Synthetic institute ${id}`, shortName: null, description: '', imageId: null })),
  Programs: [], Seminars: [], Teachers: [], TeachersAndInstitutes: [], SeminarsTeacher: [],
  Events: [], EventsAndTeachers: [], Articles: [],
};
const options: SqlPublicContentOptions = {
  expectedSourceHash: sourceHash,
  acceptedLegacyIds: {
    Institutes: { 1: 'institute-1', 2: 'institute-2', 3: 'institute-3' },
    Programs: {}, Seminars: {}, Articles: {},
  },
};

function map(overrides: Partial<SqlPublicSource> = {}) {
  return mapSqlPublicContent({ ...base, ...overrides }, options);
}

function withTimezone<T>(timezone: string, action: () => T): T {
  const previousTimezone = process.env.TZ;
  process.env.TZ = timezone;
  try {
    return action();
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
}

describe('SQL News and Promotion timestamp conservation', () => {
  const result = () => withTimezone('Pacific/Honolulu', () => map({
        News: [{
          ...timestamps, id: 401, name: 'Synthetic news', description: null, imageId: null,
          status: 'active', link: null, priority: 1, createdAt: '2026-10-10T23:30:00.123456',
        }],
        Promotions: [{
          ...timestamps, id: 501, name: 'Synthetic promotion', description: null, imageId: null,
          link: null, status: 'active', priority: 2, type: 'SHOP', createdAt: '2026-10-11T00:30:00.654321',
        }],
      }));

  it('preserves the News SQL clock in the CMS date independent of host timezone', () => {
    expect(result().entities.news?.[0]).toMatchObject({ sourceId: 401, date: '2026-10-10T23:30:00.123Z' });
  });

  it('preserves the Promotion SQL clock in the CMS date independent of host timezone', () => {
    expect(result().entities.promotions?.[0]).toMatchObject({ sourceId: 501, date: '2026-10-11T00:30:00.654Z' });
  });

  it('retains exact source fractional timestamps as private provenance', () => {
    const mapped = result();
    expect(mapped.provenance.sourceMetadata).toContainEqual({
        table: 'News', sourceId: 401, field: 'createdAt', value: '2026-10-10T23:30:00.123456',
      });
    expect(mapped.provenance.sourceMetadata).toContainEqual({
        table: 'Promotions', sourceId: 501, field: 'createdAt', value: '2026-10-11T00:30:00.654321',
      });
  });

  it('rejects impossible calendar dates and clock values with table and source identity', () => {
    expect(() => map({
      News: [{
        ...timestamps, id: 402, name: 'Invalid date', description: null, imageId: null,
        status: 'active', link: null, priority: 1, createdAt: '2026-02-30T12:45:00',
      }],
    })).toThrow(/News#402.*createdAt/i);

    expect(() => map({
      Promotions: [{
        ...timestamps, id: 502, name: 'Invalid clock', description: null, imageId: null,
        link: null, status: 'active', priority: 2, type: 'INSTITUTE', createdAt: '2026-10-11T24:30:00',
      }],
    })).toThrow(/Promotions#502.*createdAt/i);
  });
});
