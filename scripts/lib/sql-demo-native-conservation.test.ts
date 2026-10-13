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
      institutes: [row(1, 'institutes', 'institutes/one', { name: 'Synthetic Institute', slug: 'one', shortName: null, description: 'Synthetic institute description', image: [], order: 1, seo: { seo_title: 'Institute SEO', seo_description: 'Institute summary' } })],
      'course-groups': [
        row(2, 'course-groups', 'program-one', { name: 'Synthetic Program One', slug: 'program-one', description: null, image: [], order: 2, is_article_category: true, seo: { seo_title: 'Program SEO one', seo_description: 'Program summary one' }, institute: relation('institutes', 'institutes/one') }),
        row(3, 'course-groups', 'program-two', { name: 'Synthetic Program Two', slug: 'program-two', description: 'Program two description', image: [], order: 3, is_article_category: true, seo: { seo_title: 'Program SEO two', seo_description: 'Program summary two' }, institute: relation('institutes', 'institutes/one') }),
      ],
      teachers: [row(5, 'teachers', '101', { name: 'Synthetic Teacher', slug: '101', trait: 'teacher', order: 4, bio: 'Synthetic biography', institute: relation('institutes', 'institutes/one'), photo: [{ id: avatarId, url: avatarUrl }] })],
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

function tenCollectionFixture(): { release: SqlDemoRelease; a: SqlDemoStrapi5Readback; b: SqlDemoStrapi5Readback } {
  const release = structuredClone(expected);
  const entities = release.entities as unknown as Record<string, Record<string, unknown>[]>;
  entities.seminars = [{ sourceId: 201, legacy_id: 'seminar-one', name: 'Seminar', slug: 'seminar-one', description: 'Description', documents_state: 'unconfirmed', order: 1, full_text: null, learning_plan: 'Plan', learning_mode: 'Mode', recommendations: 'Recommendation', course_group_legacy_id: 'program-one', directTeachers: ['101'], seo: { seo_title: 'Seminar SEO', seo_description: 'Seminar summary' } }];
  entities.events = [{ sourceId: 301, legacy_id: '301', name: 'Event', startAt: '2030-05-10T09:00:00.000Z', endAt: '2030-05-10T16:00:00.000Z', city: 'City', newPrice: 120, oldPrice: 150, isFree: false, isEventCollection: true, entry_status: 'active', registrationFormLink: null, description: null, additionalText: null, duration: '7h', imageId: null, seminar_legacy_id: 'seminar-one', primaryTeachers: ['101'] }];
  entities.news = [{ sourceId: 501, legacy_id: 'news-one', name: 'News', description: 'News description', date: '2030-01-02T03:04:05.000Z', link: null, priority: 1, imageId: null }];
  entities.promotions = [{ sourceId: 601, legacy_id: 'promotion-one', name: 'Promotion', description: 'Promotion description', date: '2030-01-02T03:04:05.000Z', type: 'SHOP', link: null, priority: 1, active: true, imageId: null }];
  entities.videos = [{ sourceId: 701, legacy_id: 'video-one', name: 'Video', slug: 'video-one', videos: [{ id: 'video-id-1', title: 'Video title' }], seo: { seo_title: 'Video SEO', seo_description: 'Video summary' } }];
  entities.pages = [{ legacy_id: 'page-one', title: 'Page', slug: 'page-one', body: '<p>Page body</p>', seo: { seo_title: 'Page SEO', seo_description: 'Page summary' } }];
  const a = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
  const relation = (id: number, collection: string, legacyId: string) => ({ id, documentId: `target-a-${collection}-${legacyId}`, legacy_id: legacyId });
  const row = (id: number, collection: string, legacyId: string, fields: Record<string, unknown>) => ({ ...relation(id, collection, legacyId), publishedAt: '2031-01-02T00:00:00.000Z', ...fields });
  a.collections.seminars = [row(6, 'seminars', 'seminar-one', { name: 'Seminar', slug: 'seminar-one', description: 'Description', documents_state: 'unconfirmed', order: 1, full_text: null, learning_plan: 'Plan', learning_mode: 'Mode', recommendations: 'Recommendation', seo: { seo_title: 'Seminar SEO', seo_description: 'Seminar summary' }, course_group: relation(2, 'course-groups', 'program-one'), teachers: [relation(5, 'teachers', '101')] })];
  a.collections['schedule-entries'] = [row(7, 'schedule-entries', '301', { name: 'Event', startAt: '2030-05-10T09:00:00.000Z', endAt: '2030-05-10T16:00:00.000Z', city: 'City', price: 120, oldPrice: 150, isFree: false, isEventCollection: true, entry_status: 'active', registrationFormLink: null, description: null, additionalText: null, duration: '7h', image: null, seminar: relation(6, 'seminars', 'seminar-one'), teachers: [relation(5, 'teachers', '101')] })];
  a.collections['news-items'] = [row(8, 'news-items', 'news-one', { name: 'News', description: 'News description', date: '2030-01-02T03:04:05.000Z', link: null, priority: 1, image: null })];
  a.collections.promotions = [row(9, 'promotions', 'promotion-one', { name: 'Promotion', description: 'Promotion description', date: '2030-01-02T03:04:05.000Z', type: 'SHOP', link: null, priority: 1, active: true, image: null })];
  a.collections['video-playlists'] = [row(10, 'video-playlists', 'video-one', { name: 'Video', slug: 'video-one', videos: [{ id: 'video-id-1', title: 'Video title' }], seo: { seo_title: 'Video SEO', seo_description: 'Video summary' } })];
  a.collections.pages = [row(11, 'pages', 'page-one', { title: 'Page', slug: 'page-one', body: '<p>Page body</p>', seo: { seo_title: 'Page SEO', seo_description: 'Page summary' } })];
  return { release, a, b: structuredClone(a) };
}

describe('native SQL release conservation', () => {
  it('CORRECTIVE REVIEW accepts native teacher.photo as a multiple-media array', () => {
    const { release, a, b } = tenCollectionFixture();
    for (const rb of [a, b]) {
      const currentPhoto = rb.collections.teachers![0]!.photo as unknown[];
      rb.collections.teachers![0]!.photo = [currentPhoto[0]];
    }
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();
  });

  it('CORRECTIVE REVIEW accepts native empty multiple-media institute/course-group fields', () => {
    const { release, a, b } = tenCollectionFixture();
    for (const rb of [a, b]) {
      rb.collections.institutes![0]!.image = [];
      for (const row of rb.collections['course-groups']!) row.image = [];
    }
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();
  });

  it('CORRECTIVE REVIEW accepts a native schedule entry carrying the derived CMS admin_label', () => {
    const { release, a, b } = tenCollectionFixture();
    for (const rb of [a, b]) rb.collections['schedule-entries']![0]!.admin_label = '10 мая 2030 · City';
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();
  });

  it('CORRECTIVE REVIEW rejects a malformed derived admin_label', () => {
    const { release, a, b } = tenCollectionFixture();
    b.collections['schedule-entries']![0]!.admin_label = { authentication_token: 'SYNTHETIC-PRIVATE-TOKEN' };
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow();
  });

  it('CORRECTIVE REVIEW rejects additional media in a teacher.photo array', () => {
    const { release, a, b } = tenCollectionFixture();
    b.collections.teachers![0]!.photo = [b.collections.teachers![0]!.photo, b.collections.articles![0]!.image];
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow();
  });

  it.each(['a', 'iframe'] as const)('CORRECTIVE REVIEW preserves %s URLs rather than treating them as body images', (tag) => {
    const { release, a, b } = tenCollectionFixture();
    const attr = tag === 'a' ? 'href' : 'src';
    release.entities.articles[0]!.body = `<${tag} ${attr}="${IMAGE_URL}"></${tag}>`;
    a.collections.articles![0]!.body = release.entities.articles[0]!.body;
    b.collections.articles![0]!.body = `<${tag} ${attr}="${b.media[0]!.url}"></${tag}>`;
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow();
  });
  it('CORRECTIVE REVIEW allows a shared documentId across different collections', () => {
    const { release, a, b } = tenCollectionFixture();
    for (const rb of [a, b]) {
      rb.collections.articles![0]!.documentId = rb.collections.institutes![0]!.documentId;
    }
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();
  });

  it('CORRECTIVE REVIEW rejects repeated documentId within one collection', () => {
    const { release, a, b } = tenCollectionFixture();
    b.collections['course-groups']![1]!.documentId = b.collections['course-groups']![0]!.documentId;
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow(/duplicate documentId/);
  });

  it.each(['full_text', 'learning_plan', 'learning_mode', 'recommendations'] as const)('CORRECTIVE REVIEW keeps explicit null for seminar %s', (field) => {
    const { release, a, b } = tenCollectionFixture();
    (release.entities.seminars[0]! as unknown as Record<string, unknown>)[field] = null;
    a.collections.seminars![0]![field] = null;
    b.collections.seminars![0]![field] = 'Unexpected';
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow(new RegExp(field));
  });

  it.each(['2021-03-04T09:00:00.000Z', '2021-03-05T00:00:00.000Z', '2021-03-04T00:00:00+00:00', 'invalid'])('CORRECTIVE REVIEW rejects article time outside the strict approved DAY: %s', (value) => {
    const { release, a, b } = tenCollectionFixture();
    b.collections.articles![0]!.published_date = value;
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow(/published_date/);
  });

  it('CORRECTIVE REVIEW permits explicit Strapi timestamps and SEO component identity', () => {
    const { release, a, b } = tenCollectionFixture();
    for (const rb of [a, b]) {
      rb.collections.articles![0]!.createdAt = '2031-01-01T00:00:00.000Z';
      rb.collections.articles![0]!.updatedAt = '2031-01-02T00:00:00.000Z';
      (rb.collections.articles![0]!.seo as Record<string, unknown>).id = 71;
    }
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();
  });
  it('CORRECTIVE REVIEW rejects the current canonical token injected as an actual image URL', () => {
    const { release, a, b } = tenCollectionFixture();
    release.entities.articles[0]!.body = `<img src="${IMAGE_URL}">`;
    for (const rb of [a, b]) rb.collections.articles![0]!.body = '<img src="ikpk-verified-media:file-image-1">';
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow();
  });

  it('CORRECTIVE REVIEW accepts a verified body image URL backed by deduplicated source claims', () => {
    const { release, a, b } = tenCollectionFixture();
    release.provenance.assetMappings[1]!.sha256 = SOURCE_SHA;
    release.entities.articles[0]!.body = `<img src="${IMAGE_URL}">`;
    for (const rb of [a, b]) {
      const media = rb.media[0]!;
      (media.provider_metadata as { ikpk_media_import: { sources: Record<string, unknown> } }).ikpk_media_import.sources[AVATAR_URL] = { version: 1, sha256: SOURCE_SHA, storedSha256: STORED_SHA };
      (rb as {media: SqlDemoStrapi5Readback['media']}).media = [media];
      rb.collections.teachers![0]!.photo = [{ id: media.id, url: media.url }];
      rb.collections.articles![0]!.body = `<img src="${media.url}">`;
    }
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();
  });

  it('CORRECTIVE REVIEW rejects a private unknown field nested in SEO', () => {
    const { release, a, b } = tenCollectionFixture();
    (b.collections.articles![0]!.seo as Record<string, unknown>).authentication_token = 'SYNTHETIC-PRIVATE-TOKEN';
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow();
  });

  it('CORRECTIVE REVIEW preserves template subtree content', () => {
    const { release, a, b } = tenCollectionFixture();
    release.entities.articles[0]!.body = '<template><p>Expected</p></template>';
    a.collections.articles![0]!.body = '<template><p>Lost</p></template>';
    b.collections.articles![0]!.body = '<template><p>Lost</p></template>';
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow();
  });

  it('CORRECTIVE REVIEW rejects unexpected system-named fields in plain JSON video data', () => {
    const { release, a, b } = tenCollectionFixture();
    (b.collections['video-playlists']![0]!.videos as Record<string, unknown>[])[0]!.documentId = 'SYNTHETIC-UNEXPECTED-PUBLIC-DATA';
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow();
  });
  it.each(['institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries', 'articles', 'news-items', 'promotions', 'video-playlists', 'pages'] as const)('REVIEW rejects a lost record in %s', (collection) => {
    const { release, a, b } = tenCollectionFixture();
    b.collections[collection] = [];
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow(/missing/);
  });

  it('REVIEW baseline independently populates all ten collections', () => {
    const { release, a, b } = tenCollectionFixture();
    expect(Object.keys(a.collections)).toHaveLength(10);
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();
  });

  it('REVIEW requires an explicit readback key when a composed collection is empty', () => {
    const { release, a, b } = tenCollectionFixture();
    release.entities.pages = [];
    a.collections.pages = [];
    b.collections.pages = [];

    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();
    delete b.collections.pages;
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow(/pages|collection/i);
  });

  it('REVIEW rejects unexpected content in an explicitly null seminar field', () => {
    const { release, a, b } = tenCollectionFixture();
    b.collections.seminars![0]!.full_text = '<p>Unexpected content</p>';
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow();
  });

  it('REVIEW rejects an invented canonical media token in an HTML image src', () => {
    const { release, a, b } = tenCollectionFixture();
    release.entities.articles[0]!.body = `<p><img src="${IMAGE_URL}"></p>`;
    a.collections.articles![0]!.body = '<p><img src="ikpk-media:file-image-1"></p>';
    b.collections.articles![0]!.body = '<p><img src="ikpk-media:file-image-1"></p>';
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).toThrow();
  });

  it('REVIEW accepts a single target media row legitimately deduplicating equal-byte source files', () => {
    const { release, a, b } = tenCollectionFixture();
    release.provenance.assetMappings[1]!.sha256 = SOURCE_SHA;
    for (const rb of [a, b]) {
      const media = rb.media[0]!;
      (media.provider_metadata as { ikpk_media_import: { sources: Record<string, unknown> } }).ikpk_media_import.sources[AVATAR_URL] = { version: 1, sha256: SOURCE_SHA, storedSha256: STORED_SHA };
      (rb as {media: SqlDemoStrapi5Readback['media']}).media = [media];
      rb.collections.teachers![0]!.photo = [{ id: media.id, url: media.url }];
    }
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();
  });
  it('REVIEW accepts collection-scoped numeric Strapi IDs', () => {
    const a = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const b = structuredClone(a);
    for (const rb of [a, b]) {
      rb.collections.articles![0]!.id = 1;
      rb.collections.teachers![0]!.id = 1;
      rb.collections['course-groups']![0]!.id = 1;
      (rb.collections.articles![0]!.categories as {id: number}[])[0]!.id = 1;
    }
    expect(() => assertSqlDemoNativeConservation(expected, classification, a, b)).not.toThrow();
  });

  it('REVIEW accepts the real datetime representation of the approved article DAY', () => {
    const a = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const b = structuredClone(a);
    for (const rb of [a, b]) rb.collections.articles![0]!.published_date = '2021-03-04T00:00:00.000Z';
    expect(() => assertSqlDemoNativeConservation(expected, classification, a, b)).not.toThrow();
  });

  it('REVIEW fails closed on malformed relation members', () => {
    const a = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const b = structuredClone(a);
    (b.collections.articles![0]!.categories as unknown[]).push(null);
    expect(() => assertSqlDemoNativeConservation(expected, classification, a, b)).toThrow();
  });

  it('REVIEW detects private data accidentally present in published rows', () => {
    const a = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const b = structuredClone(a);
    b.collections.articles![0]!.authentication_token = 'SYNTHETIC-PRIVATE-TOKEN';
    expect(() => assertSqlDemoNativeConservation(expected, classification, a, b)).toThrow();
  });

  it('REVIEW safely describes malformed media source claims without echoing sensitive URLs', () => {
    const { release, a, b } = tenCollectionFixture();
    (b.media[0]!.provider_metadata as { ikpk_media_import: { sources: Record<string, unknown> } }).ikpk_media_import.sources['https://synthetic.invalid/image?token=SYNTHETIC-PRIVATE-TOKEN'] = null;
    let message: string | undefined;
    try {
      assertSqlDemoNativeConservation(release, classification, a, b);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/malformed/);
    expect(message).not.toContain('SYNTHETIC-PRIVATE-TOKEN');
  });

  it('REVIEW rejects an unknown claimed SQL source URL without echoing its query', () => {
    const { release, a, b } = tenCollectionFixture();
    const privateClaimedUrl = 'https://synthetic.invalid/file?token=SYNTHETIC-PRIVATE-TOKEN';
    const sources = (b.media[0]!.provider_metadata as { ikpk_media_import: { sources: Record<string, unknown> } }).ikpk_media_import.sources;
    sources[privateClaimedUrl] = { version: 1, sha256: SOURCE_SHA, storedSha256: STORED_SHA };

    let message: string | undefined;
    try {
      assertSqlDemoNativeConservation(release, classification, a, b);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBeDefined();
    expect(message).not.toContain('SYNTHETIC-PRIVATE-TOKEN');
  });

  it('REVIEW enforces single and many native relation shapes while ignoring unrelated provider metadata', () => {
    const { release, a, b } = tenCollectionFixture();
    b.media[0]!.provider_metadata = {
      ...(b.media[0]!.provider_metadata as Record<string, unknown>),
      unrelated_provider_metadata: { status: 'synthetic' },
    };
    expect(() => assertSqlDemoNativeConservation(release, classification, a, b)).not.toThrow();

    const singleAsArray = structuredClone(b);
    singleAsArray.collections.seminars![0]!.course_group = [singleAsArray.collections['course-groups']![0]];
    singleAsArray.collections.teachers![0]!.institute = [singleAsArray.collections.institutes![0]];
    let singleRelationError: string | undefined;
    try { assertSqlDemoNativeConservation(release, classification, a, singleAsArray); }
    catch (error) { singleRelationError = (error as Error).message; }

    const manyAsObject = structuredClone(b);
    manyAsObject.collections.articles![0]!.categories = manyAsObject.collections['course-groups']![0];
    let manyRelationError: string | undefined;
    try { assertSqlDemoNativeConservation(release, classification, a, manyAsObject); }
    catch (error) { manyRelationError = (error as Error).message; }
    expect([singleRelationError, manyRelationError]).toEqual([expect.any(String), expect.any(String)]);
  });

  it('REVIEW rejects URL aliasing in ordinary title text', () => {
    const e = structuredClone(expected);
    e.entities.articles[0]!.title = IMAGE_URL;
    const a = target('target-a', 41, 'https://cms-a.synthetic.invalid/uploads/image-one.webp', 42, 'https://cms-a.synthetic.invalid/uploads/teacher-one.webp', ['program-one', 'program-two']);
    const b = structuredClone(a);
    a.collections.articles![0]!.title = 'https://cms-a.synthetic.invalid/uploads/image-one.webp';
    b.collections.articles![0]!.title = 'https://cms-a.synthetic.invalid/uploads/image-one.webp';
    expect(() => assertSqlDemoNativeConservation(e, classification, a, b)).toThrow();
  });
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
