import { describe, expect, it } from 'vitest';
import { mapSqlPublicContent, type SqlPublicSource } from './sql-public-content.js';

const sourceHash = `sha256:${'a'.repeat(64)}`;
const timestamps = { createdAt: '2026-10-12T00:00:00', updatedAt: '2026-10-12T00:00:00' };

function source(overrides: Partial<SqlPublicSource> = {}): SqlPublicSource {
  return {
    sourceHash,
    Institutes: [1, 2, 3].map((id) => ({
      id, name: `Institute ${id}`, shortName: null, description: '', imageId: null,
    })),
    Programs: [{
      id: 101, status: 'active', name: 'Program title', slug: 'sql-program-slug', instituteId: 1,
      priority: 0, seoTitle: '', seoDescription: '', content: null, imageId: null,
    }],
    Seminars: [{
      id: 201, status: 'active', name: 'Seminar title', slug: 'sql-seminar-slug', programId: 101,
      description: null, curriculum: null, targetAudience: null, learningProcess: null,
      certificates: null, recommendations: null, priority: 0, seoTitle: '', seoDescription: '',
    }],
    Teachers: [],
    TeachersAndInstitutes: [],
    SeminarsTeacher: [],
    Events: [{
      id: 301, status: 'active', seminarId: 201, cityId: 71, imageId: null, teacherId: null,
      oldPrice: null, newPrice: 0, startAt: '2026-11-01', endAt: '2026-11-01',
      additionalText: null, duration: null, description: null, registrationFormLink: null,
      isFree: true, isEventCollection: false,
    }],
    EventsAndTeachers: [],
    Articles: [],
    ...overrides,
  };
}

const options = {
  expectedSourceHash: sourceHash,
  acceptedLegacyIds: {
    Institutes: { 1: 'institute-legacy-1', 2: 'institute-legacy-2', 3: 'institute-legacy-3' },
    Programs: { 101: 'program-legacy-101' },
    Seminars: { 201: 'seminar-legacy-201' },
    Articles: {},
  },
};

function map(overrides: Partial<SqlPublicSource> = {}) {
  return mapSqlPublicContent(source(overrides), options);
}

describe('mapSqlPublicContent auxiliary public collections', () => {
  it('keeps SQL source IDs, accepted legacy IDs, and SQL slugs as distinct values', () => {
    const program = map().entities.programs[0];

    expect(program).toMatchObject({
      sourceId: 101,
      legacy_id: 'program-legacy-101',
      slug: 'sql-program-slug',
    });
  });

  it('resolves an event city ID to the existing city text and rejects a dangling city relation', () => {
    const result = map({
      Cities: [
        { ...timestamps, id: 71, name: 'Synthetic City', status: 'active' },
        { ...timestamps, id: 72, name: 'Deleted City', status: 'deleted' },
      ],
    });

    expect(result.entities.events[0]).toMatchObject({ city: 'Synthetic City' });
    expect(result.entities.events[0]).not.toHaveProperty('cityName');
    expect(result.provenance.exclusions).toContainEqual({ table: 'Cities', sourceId: 72, reason: 'status is not active' });

    expect(() => map({ Cities: [] })).toThrow(/Events#301.*cityId.*71/);
  });

  it('maps active news and promotion SQL publication days to CMS date, not changed updatedAt', () => {
    const result = map({
      News: [
        { ...timestamps, id: 401, name: 'News', description: 'News body', imageId: null, status: 'active', link: null, priority: 2, createdAt: '2026-10-10T12:45:00' },
        { ...timestamps, id: 402, name: 'Deleted news', description: null, imageId: null, status: 'deleted', link: null, priority: 3, createdAt: '2026-10-09T00:00:00' },
      ],
      Promotions: [
        { ...timestamps, id: 501, name: 'Shop offer', description: 'Offer body', imageId: null, link: null, status: 'active', priority: 1, type: 'SHOP', createdAt: '2026-10-08T23:50:00' },
        { ...timestamps, id: 503, name: 'Institute offer', description: null, imageId: null, link: null, status: 'active', priority: 2, type: 'INSTITUTE', createdAt: '2026-10-06T01:00:00' },
        { ...timestamps, id: 502, name: 'Deleted offer', description: null, imageId: null, link: null, status: 'deleted', priority: 2, type: null, createdAt: '2026-10-07T00:00:00' },
      ],
    });

    expect(result.entities.news).toHaveLength(1);
    expect(result.entities.news?.[0]).toMatchObject({ sourceId: 401, name: 'News', date: expect.stringMatching(/^2026-10-10(?:T|$)/) });
    expect(result.entities.news?.[0]).not.toHaveProperty('published_date');
    expect(result.entities.promotions).toHaveLength(2);
    expect(result.entities.promotions?.[0]).toMatchObject({ sourceId: 501, name: 'Shop offer', type: 'SHOP', date: expect.stringMatching(/^2026-10-08(?:T|$)/) });
    expect(result.entities.promotions?.[1]).toMatchObject({ sourceId: 503, name: 'Institute offer', type: 'INSTITUTE', date: expect.stringMatching(/^2026-10-06(?:T|$)/) });
    expect(result.provenance.exclusions).toContainEqual({ table: 'News', sourceId: 402, reason: 'status is not active' });
    expect(result.provenance.exclusions).toContainEqual({ table: 'Promotions', sourceId: 502, reason: 'status is not active' });
  });

  it('maps the six accepted video playlist identities and title without publishing source links or an invented type', () => {
    const playlistIds = [31, 32, 33, 34, 36, 37];
    const result = map({
      Videos: playlistIds.map((id) => ({
        ...timestamps,
        id, name: `Playlist ${id}`, link: `https://private.example.test/original/${id}`,
        status: 'active', priority: id, imageId: null,
      })),
    });

    expect(result.entities.videos?.map(({ sourceId, slug, title }) => ({ sourceId, slug, title }))).toEqual(
      playlistIds.map((id) => ({ sourceId: id, slug: String(id), title: `Playlist ${id}` })),
    );
    expect(JSON.stringify(result.entities.videos)).not.toContain('private.example.test');
    expect(result.entities.videos?.every((video) => !Object.hasOwn(video, 'type'))).toBe(true);

    expect(() => map({ Videos: [{
      ...timestamps, id: 35, name: 'Unapproved playlist', link: null, status: 'active', priority: 0, imageId: null,
    }] })).toThrow(/Videos#35/);
  });

  it('projects active organization sections and binds public PDF metadata by source IDs and binding title', () => {
    const result = map({
      OrganizationInfo: [
        { ...timestamps, id: 601, name: 'Synthetic section', priority: 4, content: '<p>SQL section</p>', status: 'active' },
        { ...timestamps, id: 602, name: 'Deleted section', priority: 5, content: 'hidden', status: 'deleted' },
      ],
      FileBindingOrganizationInfo: [
        { ...timestamps, id: 701, title: 'Synthetic regulation', priority: 1, fileId: 'pdf-1', organizationInfoId: 601 },
      ],
      Files: [
        { ...timestamps, id: 'pdf-1', fileType: 'application/pdf', originalName: 'regulation.pdf', extension: 'pdf', url: '/documents/regulation.pdf', status: 'active', privacy: 'public' },
        { ...timestamps, id: 'private-pdf', fileType: 'application/pdf', originalName: 'private.pdf', extension: 'pdf', url: '/private.pdf', status: 'active', privacy: 'private' },
      ],
      InstituteAdditionalInfo: [
        { ...timestamps, id: 801, name: 'Supplement', description: 'Synthetic institute information', instituteId: 1 },
      ],
    });

    expect(result.entities.organizationInfo).toHaveLength(1);
    expect(result.entities.organizationInfo?.[0]).toMatchObject({ sourceId: 601, name: 'Synthetic section', content: '<p>SQL section</p>' });
    expect(result.entities.documents).toEqual([
      expect.objectContaining({ sourceId: 'pdf-1', title: 'Synthetic regulation', extension: 'pdf', fileType: 'application/pdf' }),
    ]);
    expect(result.entities.instituteAdditionalInfo?.[0]).toMatchObject({ sourceId: 801, instituteId: 1 });
  });

  it('fails with the named source identity for unresolved auxiliary relations', () => {
    expect(() => map({
      InstituteAdditionalInfo: [{ ...timestamps, id: 811, name: 'Orphan', description: null, instituteId: null }],
    })).toThrow(/InstituteAdditionalInfo#811.*instituteId/);
  });

  it('requires InstituteAdditionalInfo.instituteId to reference a selected institute', () => {
    expect(() => map({
      InstituteAdditionalInfo: [{ ...timestamps, id: 812, name: 'Unknown institute', description: null, instituteId: 999 }],
    })).toThrow(/InstituteAdditionalInfo#812.*instituteId/);
  });

  it('rejects an unapproved promotion type with its source identity', () => {
    expect(() => map({
      Promotions: [{ ...timestamps, id: 504, name: 'Unsupported', description: null, imageId: null, link: null, status: 'active', priority: 3, type: 'banner' }],
    })).toThrow(/Promotions#504.*type/);
  });

  it('fails with the binding identity when its organization or file relation is unresolved', () => {
    expect(() => map({
      FileBindingOrganizationInfo: [{ ...timestamps, id: 712, title: 'Orphan binding', priority: 1, fileId: 'missing-file', organizationInfoId: 699 }],
      Files: [],
      OrganizationInfo: [],
    })).toThrow(/FileBindingOrganizationInfo#712/);
  });
});
