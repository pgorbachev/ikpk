import { describe, expect, it } from 'vitest';
import type { SqlDemoRelease } from './sql-demo-release.js';
import { assertSqlDemoNativeConservation, type SqlDemoStrapi5Readback } from './sql-demo-native-conservation.js';
import type { SqlMaterializerOptions } from './sql-public-materializer.js';

const SOURCE_SHA = 'a'.repeat(64);
const STORED_SHA = 'b'.repeat(64);
const IMAGE_URL = 'https://legacy.synthetic.invalid/media/image-one.png';
const AVATAR_URL = 'https://legacy.synthetic.invalid/media/teacher-one.png';

const expected = {
  entities: {
    institutes: [{ sourceId: 1, legacy_id: 'institutes/one', slug: 'one', name: 'Synthetic Institute', shortName: null, description: 'Synthetic institute description', imageId: null, order: 1, seo: { seo_title: 'Institute SEO', seo_description: 'Institute summary' } }],
    programs: [
      { sourceId: 11, legacy_id: 'program-one', slug: 'program-one', name: 'Synthetic Program One', description: null, imageId: null, order: 2, institute_legacy_id: 'institutes/one', is_article_category: true, seo: { seo_title: 'Program SEO one', seo_description: 'Program summary one' } },
      { sourceId: 12, legacy_id: 'program-two', slug: 'program-two', name: 'Synthetic Program Two', description: 'Program two description', imageId: null, order: 3, institute_legacy_id: 'institutes/one', is_article_category: true, seo: { seo_title: 'Program SEO two', seo_description: 'Program summary two' } },
    ],
    teachers: [{ sourceId: 101, legacy_id: '101', slug: '101', name: 'Synthetic Teacher', bio: 'Synthetic biography', imageId: 'file-avatar-1', order: 4, institute_legacy_id: 'institutes/one' }], seminars: [], events: [],
    articles: [{ sourceId: 401, legacy_id: 'article-one', slug: 'article-one', title: 'Synthetic Article', body: '<p>Expected body</p>', imageId: 'file-image-1', published_date: '2021-03-04', seo: { seo_title: 'Article SEO', seo_description: 'Article summary' } }],
    news: [], promotions: [], organizationInfo: [], documents: [], instituteAdditionalInfo: [],
    videos: [], pages: [],
  },
  provenance: {
    sourceHash: `sha256:${'c'.repeat(64)}`,
    sourceIdentity: [
      { table: 'Institutes', sourceId: 1, targetSlug: 'one', targetLegacyId: 'institutes/one' },
      { table: 'Programs', sourceId: 11, targetSlug: 'program-one', targetLegacyId: 'program-one' },
      { table: 'Programs', sourceId: 12, targetSlug: 'program-two', targetLegacyId: 'program-two' },
      { table: 'Teachers', sourceId: 101, targetSlug: '101', targetLegacyId: '101' },
      { table: 'Articles', sourceId: 401, targetSlug: 'article-one', targetLegacyId: 'article-one' },
    ],
    videoMetadata: [], exclusions: [], rejectedRelations: [], classificationCandidates: [], sourceMetadata: [],
    acceptedCorpus: { revision: '1234567890abcdef1234567890abcdef12345678', sha256: 'd'.repeat(64) },
    supplements: [], targetLocations: [],
    assetMappings: [
      { sourceFileId: 'file-image-1', sourceUrl: IMAGE_URL, targetPublicUrl: 'https://cms-a.synthetic.invalid/uploads/image-one.webp', sha256: SOURCE_SHA, detectedMimeType: 'image/png', verification: { status: 'verified', loader: 'sql-demo-asset-loader', attestationId: 'synthetic-attestation' } },
      { sourceFileId: 'file-avatar-1', sourceUrl: AVATAR_URL, targetPublicUrl: 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', sha256: 'f'.repeat(64), detectedMimeType: 'image/png', verification: { status: 'verified', loader: 'sql-demo-asset-loader', attestationId: 'synthetic-avatar-attestation' } },
    ],
    videoSupplements: [], ownerDecisions: { approvedUnlinkedArticleImages: [], videoReferences: [] },
  },
} as unknown as SqlDemoRelease;

const classification: SqlMaterializerOptions['classification'] = {
  status: 'pending-confirmation', teachers: [{ sourceId: 101, trait: 'teacher' }], articles: [{ sourceId: 401, sourceProgramIds: [11, 12] }],
};

function target(nonce: string, mediaId: number, mediaUrl: string, avatarId: number, avatarUrl: string, categoryOrder: string[], body = '<p>Expected body</p>'): SqlDemoStrapi5Readback {
  const document = (collection: string, legacyId: string) => `${nonce}-${collection}-${legacyId}`;
  const relation = (collection: string, legacyId: string) => ({
    id: collection === 'institutes' ? 1 : legacyId === 'program-two' ? 3 : 2,
    documentId: document(collection, legacyId),
    legacy_id: legacyId,
  });
  const metadata = (sourceUrl: string, sourceHash: string) => ({
    ikpk_media_import: {
      sources: { [sourceUrl]: { version: 1, sha256: sourceHash, storedSha256: STORED_SHA } },
    },
  });
  const row = (id: number, collection: string, legacyId: string, fields: Record<string, unknown>) => ({
    id, documentId: document(collection, legacyId), publishedAt: '2031-01-02T00:00:00.000Z', legacy_id: legacyId, ...fields,
  });
  return {
    collections: {
      institutes: [row(1, 'institutes', 'institutes/one', { name: 'Synthetic Institute', slug: 'one', shortName: null, description: 'Synthetic institute description', order: 1, seo: { seo_title: 'Institute SEO', seo_description: 'Institute summary' } })],
      'course-groups': [
        row(2, 'course-groups', 'program-one', { name: 'Synthetic Program One', slug: 'program-one', description: null, order: 2, is_article_category: true, seo: { seo_title: 'Program SEO one', seo_description: 'Program summary one' }, institute: relation('institutes', 'institutes/one') }),
        row(3, 'course-groups', 'program-two', { name: 'Synthetic Program Two', slug: 'program-two', description: 'Program two description', order: 3, is_article_category: true, seo: { seo_title: 'Program SEO two', seo_description: 'Program summary two' }, institute: relation('institutes', 'institutes/one') }),
      ],
      teachers: [row(5, 'teachers', '101', { name: 'Synthetic Teacher', slug: '101', trait: 'teacher', order: 4, bio: 'Synthetic biography', institute: relation('institutes', 'institutes/one'), photo: { id: avatarId, url: avatarUrl } })],
      articles: [row(4, 'articles', 'article-one', {
        title: 'Synthetic Article', slug: 'article-one', body, published_date: '2021-03-04',
        seo: { seo_title: 'Article SEO', seo_description: 'Article summary' }, image: { id: mediaId, url: mediaUrl },
        categories: categoryOrder.map((legacyId) => relation('course-groups', legacyId)),
      })],
    },
    media: [
      { id: mediaId, url: mediaUrl, provider_metadata: metadata(IMAGE_URL, SOURCE_SHA), verifiedStoredSha256: STORED_SHA },
      { id: avatarId, url: avatarUrl, provider_metadata: metadata(AVATAR_URL, 'f'.repeat(64)), verifiedStoredSha256: STORED_SHA },
    ],
  };
}

describe('native SQL release conservation', () => {
  it('accepts equivalent published targets with different generated IDs and upload URLs', () => {
    const targetA = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const targetB = target('target-b', 902, 'https://cms-b.synthetic.invalid/uploads/image-one.webp', 903, 'https://cms-b.synthetic.invalid/uploads/teacher-one.webp', ['program-two', 'program-one']);

    expect(() => assertSqlDemoNativeConservation(expected, classification, targetA, targetB)).not.toThrow();
  });

  it('compares each target with the expected composed release before comparing targets to each other', () => {
    const wrongA = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two'], '<p>Wrong but matching</p>');
    const wrongB = target('target-b', 902, 'https://cms-b.synthetic.invalid/uploads/image-one.webp', 903, 'https://cms-b.synthetic.invalid/uploads/teacher-one.webp', ['program-two', 'program-one'], '<p>Wrong but matching</p>');

    expect(() => assertSqlDemoNativeConservation(expected, classification, wrongA, wrongB))
      .toThrow(/Articles#401.*body|body.*Articles#401/i);
  });

  it('checks the source digest and independently verified stored bytes without requiring them to match', () => {
    const validA = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const validB = target('target-b', 902, 'https://cms-b.synthetic.invalid/uploads/image-one.webp', 903, 'https://cms-b.synthetic.invalid/uploads/teacher-one.webp', ['program-two', 'program-one']);
    expect(validA.media[0]?.verifiedStoredSha256).not.toBe(SOURCE_SHA);
    expect(() => assertSqlDemoNativeConservation(expected, classification, validA, validB)).not.toThrow();

    const corruptB = structuredClone(validB);
    corruptB.media[0]!.verifiedStoredSha256 = 'e'.repeat(64);
    expect(() => assertSqlDemoNativeConservation(expected, classification, validA, corruptB))
      .toThrow(/media|stored|hash|digest/i);

    const wrongSource = structuredClone(validB);
    const claims = wrongSource.media[0]!.provider_metadata as {
      ikpk_media_import: { sources: Record<string, { sha256: string }> };
    };
    claims.ikpk_media_import.sources[IMAGE_URL]!.sha256 = 'c'.repeat(64);
    expect(() => assertSqlDemoNativeConservation(expected, classification, validA, wrongSource))
      .toThrow(/Files#file-image-1|source.*hash|hash.*source/i);
  });

  it('rejects duplicate logical source rows even when generated document IDs differ', () => {
    const targetA = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const targetB = target('target-b', 902, 'https://cms-b.synthetic.invalid/uploads/image-one.webp', 903, 'https://cms-b.synthetic.invalid/uploads/teacher-one.webp', ['program-two', 'program-one']);
    const repeated = structuredClone(targetB);
    repeated.collections.articles = [...(repeated.collections.articles ?? []), {
      ...(repeated.collections.articles?.[0] as NonNullable<typeof repeated.collections.articles>[number]),
      id: 99,
      documentId: 'target-b-articles-duplicate',
    }];

    expect(() => assertSqlDemoNativeConservation(expected, classification, targetA, repeated))
      .toThrow(/Articles#401|article-one.*duplicate|duplicate.*article-one/i);
  });

  it('rejects a missing source row and a row that is no longer published', () => {
    const validA = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const validB = target('target-b', 902, 'https://cms-b.synthetic.invalid/uploads/image-one.webp', 903, 'https://cms-b.synthetic.invalid/uploads/teacher-one.webp', ['program-two', 'program-one']);
    const missing = structuredClone(validB);
    missing.collections.teachers = [];
    expect(() => assertSqlDemoNativeConservation(expected, classification, validA, missing)).toThrow(/Teachers#101.*missing/i);

    const draft = structuredClone(validB);
    (draft.collections.articles![0] as { publishedAt: string }).publishedAt = '';
    expect(() => assertSqlDemoNativeConservation(expected, classification, validA, draft)).toThrow(/Articles#401.*published/i);
  });

  it('rejects relations whose source identity matches but target IDs are inconsistent', () => {
    const validA = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const corruptB = target('target-b', 902, 'https://cms-b.synthetic.invalid/uploads/image-one.webp', 903, 'https://cms-b.synthetic.invalid/uploads/teacher-one.webp', ['program-two', 'program-one']);
    const relation = (corruptB.collections.articles![0] as unknown as { categories: { id: number; documentId: string; legacy_id: string }[] }).categories[0]!;
    relation.id = 999;
    expect(() => assertSqlDemoNativeConservation(expected, classification, validA, corruptB)).toThrow(/Articles#401.*categories.*inconsistent IDs/i);
  });

  it('rejects unclaimed target media rows instead of silently ignoring them', () => {
    const validA = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const cleanB = target('target-b', 902, 'https://cms-b.synthetic.invalid/uploads/image-one.webp', 903, 'https://cms-b.synthetic.invalid/uploads/teacher-one.webp', ['program-two', 'program-one']);
    const corruptB: SqlDemoStrapi5Readback = { ...cleanB, media: [...cleanB.media, {
      id: 904,
      url: 'https://cms-b.synthetic.invalid/uploads/unexpected.webp',
      provider_metadata: {},
      verifiedStoredSha256: STORED_SHA,
    }] };
    expect(() => assertSqlDemoNativeConservation(expected, classification, validA, corruptB)).toThrow(/media#904.*sources|media#904.*extra/i);
  });
});
