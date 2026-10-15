import { describe, expect, it } from 'vitest';
import { mapSqlPublicContent, type SqlPublicContentOptions, type SqlPublicSource, type SqlVideoSourceRow } from './sql-public-content';

const approvedVideoIds = [31, 32, 33, 34, 36, 37];
const sourceHash = `sha256:${'a'.repeat(64)}`;
const source: SqlPublicSource = {
  sourceHash,
  Institutes: [1, 2, 3].map((id) => ({ id, name: `Synthetic institute ${id}`, shortName: null, description: '', imageId: null })),
  Programs: [{
    id: 101, status: 'active', name: 'Synthetic program', slug: 'sql-program-slug', instituteId: 1,
    priority: 0, seoTitle: '', seoDescription: '', content: null, imageId: null,
  }],
  Seminars: [{
    id: 201, status: 'active', name: 'Synthetic seminar', slug: 'sql-seminar-slug', programId: 101,
    description: null, curriculum: null, targetAudience: null, learningProcess: null,
    certificates: null, recommendations: null, priority: 0, seoTitle: '', seoDescription: '',
  }],
  Teachers: [], TeachersAndInstitutes: [], SeminarsTeacher: [], Events: [], EventsAndTeachers: [], Articles: [],
};
const options: SqlPublicContentOptions = {
  expectedSourceHash: sourceHash,
  acceptedLegacyIds: {
    Institutes: { 1: 'institute-legacy-1', 2: 'institute-legacy-2', 3: 'institute-legacy-3' },
    Programs: { 101: 'program-legacy-101' },
    Seminars: { 201: 'seminar-legacy-201' },
    Articles: {},
  },
};

function videoRows(ids = approvedVideoIds): SqlVideoSourceRow[] {
  return ids.map((id) => ({
    id,
    name: `Synthetic playlist ${id}`,
    link: `https://source.example.test/original-playlist/${id}`,
    status: 'active',
    priority: id * 10,
    imageId: `source-image-${id}`,
    createdAt: '2026-10-12T12:00:00',
    updatedAt: '2026-10-12T12:00:00',
  }));
}

function mapVideos(rows?: SqlVideoSourceRow[]) {
  const input: SqlPublicSource = rows === undefined ? source : { ...source, Videos: rows };
  return mapSqlPublicContent(input, options);
}

describe('SQL video auxiliary projection regressions', () => {
  it('keeps original playlist URL, SQL priority, and SQL image ID in private provenance only', () => {
    const result = mapVideos(videoRows());

    expect(result.entities.videos).toHaveLength(6);
    expect(result.entities.videos?.map(({ sourceId, slug, title }) => ({ sourceId, slug, title }))).toEqual(
      approvedVideoIds.map((id) => ({ sourceId: id, slug: String(id), title: `Synthetic playlist ${id}` })),
    );
    expect(JSON.stringify(result.entities.videos)).not.toContain('source.example.test');
    expect(result.entities.videos?.every((video) => !('link' in video) && !('priority' in video) && !('imageId' in video))).toBe(true);
    expect(result.provenance.videoMetadata).toEqual(approvedVideoIds.map((id) => ({
      sourceId: id,
      link: `https://source.example.test/original-playlist/${id}`,
      priority: id * 10,
      imageId: `source-image-${id}`,
    })));
  });

  it('requires all six approved active playlist IDs when Videos is supplied', () => {
    expect(() => mapVideos(videoRows(approvedVideoIds.filter((id) => id !== 37))))
      .toThrow(/Videos#37.*missing|missing.*Videos#37/i);
  });

  it('treats a deleted approved playlist as a missing required identity', () => {
    const rows = videoRows().map((row) => row.id === 34 ? { ...row, status: 'deleted' } : row);

    expect(() => mapVideos(rows)).toThrow(/Videos#34.*missing|missing.*Videos#34/i);
  });

  it('still rejects an extra active playlist after supplying all six approved identities', () => {
    const rows = [...videoRows(), ...videoRows([35])];

    expect(() => mapVideos(rows)).toThrow(/Videos#35.*not an approved playlist/i);
  });

  it('keeps omitted Videos input compatible with the approved six-collection slice', () => {
    expect(mapVideos().entities.videos).toEqual([]);
  });
});
