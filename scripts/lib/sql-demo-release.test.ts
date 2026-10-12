import { describe, expect, it } from 'vitest';
import { composeSqlDemoRelease, type SqlDemoAcceptedSupplements, type SqlDemoAllowlistedAssets, type SqlDemoOwnerDecisions, type SqlDemoTargetLocation, type SqlDemoVideoReferenceDecision } from './sql-demo-release.js';
import type { SqlPublicContentResult } from './sql-public-content.js';

const sourceHash = `sha256:${'a'.repeat(64)}`;
const corpusHash = 'b'.repeat(64);
const staticPagesPath = 'discovery/entities/static_pages.json';

function page(slug: string, body: string) {
  return {
    title: `Synthetic ${slug}`, slug, body, legacy_id: slug,
    seo: { seo_title: `SEO ${slug}`, seo_description: `Description ${slug}` },
  };
}

function collapsible(id: number, title: string, content: string): string {
  return `<li id="${id}"><div data-state="open"><button class="collapsible_trigger__synthetic"><h2 data-collapsible-title="true">${title}</h2></button><div class="collapsible_content__synthetic">${content}</div></div></li>`;
}

const acceptedOrganizationBody = [
  '<ul>',
  collapsible(1, 'Synthetic education section', '<p>Accepted education body</p>'),
  collapsible(14, 'Synthetic documents section', '<p>Accepted documents body</p>'),
  collapsible(3, 'Unrelated accepted section', '<p>Keep this accepted body</p>'),
  '</ul>',
].join('');

function mapped(overrides: Partial<SqlPublicContentResult['entities']> = {}): SqlPublicContentResult {
  const institutes = [
    { sourceId: 1, legacy_id: 'institute-one', slug: 'institute-one', name: 'Synthetic institute', shortName: null, description: '<p>SQL institute base</p>', imageId: null },
  ];
  return {
    entities: {
      institutes, programs: [], seminars: [], teachers: [], events: [], articles: [],
      news: [], promotions: [], videos: [], organizationInfo: [], documents: [], instituteAdditionalInfo: [],
      ...overrides,
    },
    provenance: {
      sourceHash, sourceIdentity: [], videoMetadata: [], exclusions: [], rejectedRelations: [],
      classificationCandidates: [], sourceMetadata: [],
    },
  } as SqlPublicContentResult;
}

function baseTargetLocations(): SqlDemoTargetLocation[] {
  return [
    { sourceTable: 'OrganizationInfo', sourceId: 601, targetCollection: 'pages', targetLegacyId: 'svedeni-synthetic', targetField: 'body', sectionKey: 'education', anchor: 'section-2' },
    { sourceTable: 'OrganizationInfo', sourceId: 602, targetCollection: 'pages', targetLegacyId: 'svedeni-synthetic', targetField: 'body', sectionKey: 'documents', anchor: 'section-1' },
    { sourceTable: 'InstituteAdditionalInfo', sourceId: 801, targetCollection: 'institutes', targetLegacyId: 'institute-one', targetField: 'description', sectionKey: 'extra-institute-info', anchor: 'institute-section-1' },
    { sourceTable: 'FileBindingOrganizationInfo', sourceId: 701, targetCollection: 'pages', targetLegacyId: 'svedeni-synthetic', targetField: 'body', sectionKey: 'documents', anchor: 'section-1', publicDocumentPath: '/documents/synthetic-one.pdf' },
    { sourceTable: 'FileBindingOrganizationInfo', sourceId: 702, targetCollection: 'pages', targetLegacyId: 'svedeni-synthetic', targetField: 'body', sectionKey: 'documents', anchor: 'section-1', publicDocumentPath: '/documents/synthetic-two.pdf' },
  ];
}

function supplements(overrides: Partial<SqlDemoAcceptedSupplements> = {}): SqlDemoAcceptedSupplements {
  return {
    acceptedCorpus: { revision: 'accepted-static-corpus-r1', sha256: corpusHash },
    pages: [
      {
        sourcePath: staticPagesPath, revision: 'accepted-static-corpus-r1', sha256: corpusHash,
        page: page('synthetic-static', '<p>Accepted synthetic static body</p>'),
      },
      {
        sourcePath: staticPagesPath, revision: 'accepted-static-corpus-r1', sha256: corpusHash,
        page: page('svedeni-synthetic', acceptedOrganizationBody),
      },
    ],
    instituteMetadata: [{ sourceId: 1, slug: 'institute-one', order: 7, seo: { seo_title: 'Accepted institute SEO', seo_description: 'Accepted institute description' } }],
    videoPlaylists: [],
    targetLocations: baseTargetLocations(),
    ...overrides,
  };
}

function attestation(sourceFileId: string, sourceUrl: string, targetPublicUrl: string, mimeType: string, attestationId: string) {
  return {
    sourceFileId, sourceUrl, targetPublicUrl, sha256: 'd'.repeat(64), detectedMimeType: mimeType,
    verification: { status: 'verified' as const, loader: 'sql-demo-asset-loader' as const, attestationId },
  };
}

function documentAttestation(sourceFileId: string, sourceUrl: string, targetPublicUrl: string, attestationId: string): SqlDemoAllowlistedAssets['documents'][number] {
  return { ...attestation(sourceFileId, sourceUrl, targetPublicUrl, 'application/pdf', attestationId), detectedMimeType: 'application/pdf' };
}

function assets(overrides: Partial<SqlDemoAllowlistedAssets> = {}): SqlDemoAllowlistedAssets {
  return {
    images: [attestation('img-1', '/sql/synthetic-image-1', '/media/synthetic-image-1.png', 'image/png', 'attest-img-1')],
    documents: [
      documentAttestation('pdf-1', '/sql/synthetic-document-1.pdf', '/documents/synthetic-one.pdf', 'attest-pdf-1'),
      documentAttestation('pdf-2', '/sql/synthetic-document-2.pdf', '/documents/synthetic-two.pdf', 'attest-pdf-2'),
    ],
    ...overrides,
  };
}

function ownerDecisions(videoReferences: SqlDemoVideoReferenceDecision[] = []): SqlDemoOwnerDecisions {
  return {
    approvedUnlinkedArticleImages: [{ sourceFileId: 'img-1', sourceUrl: '/sql/synthetic-image-1', decisionId: 'synthetic-image-approval' }],
    videoReferences,
  };
}

function sqlWithOrganizationAndDocuments(): SqlPublicContentResult {
  return mapped({
    instituteAdditionalInfo: [{ sourceId: 801, legacy_id: '801', instituteId: 1, name: 'Synthetic institute extra', description: '<p>Extra institute text</p>' }],
    organizationInfo: [
      { sourceId: 601, legacy_id: '601', name: 'Synthetic education section', priority: 20, content: '<p>SQL education replacement</p>' },
      { sourceId: 602, legacy_id: '602', name: 'Synthetic documents section', priority: 10, content: '' },
    ],
    documents: [
      { sourceId: 'pdf-1', fileId: 'pdf-1', bindingSourceId: 701, organizationInfoSourceId: 602, title: 'Second synthetic document', priority: 2, originalName: 'two.pdf', extension: 'pdf', fileType: 'application/pdf', url: '/sql/synthetic-document-1.pdf' },
      { sourceId: 'pdf-2', fileId: 'pdf-2', bindingSourceId: 702, organizationInfoSourceId: 602, title: 'First synthetic document', priority: 1, originalName: 'one.pdf', extension: 'pdf', fileType: 'application/pdf', url: '/sql/synthetic-document-2.pdf' },
    ],
  });
}

function syntheticVideoInputs() {
  const ids = [131, 132, 133];
  const input = mapped({ videos: ids.map((sourceId) => ({
    sourceId, legacy_id: `video/pleylist/${sourceId}`, slug: String(sourceId), title: `SQL playlist ${sourceId}`,
  })) });
  input.provenance.videoMetadata = ids.map((sourceId) => ({
    sourceId, link: `https://private-source.example.test/playlist/${sourceId}`, priority: sourceId,
    imageId: `sql-image-${sourceId}`,
  }));
  const videoSupplements = ids.map((sourceId) => ({
    sourceId, sourcePath: 'discovery/entities/video_playlists.json', revision: 'accepted-video-r1', sha256: 'f'.repeat(64),
    slug: String(sourceId), legacy_id: `video/pleylist/${sourceId}`,
    seo: { seo_title: `Accepted SEO ${sourceId}`, seo_description: `Accepted description ${sourceId}` },
    videos: null,
    thumbnailSourceFileId: `thumb-${sourceId}`,
    thumbnailSourceUrl: `/accepted/thumb-${sourceId}.jpg`,
    thumbnailPublicUrl: `/media/video-thumbs/synthetic-${sourceId}.jpg`,
  }));
  const imageAttestations = videoSupplements.map((video) => attestation(
    video.thumbnailSourceFileId, video.thumbnailSourceUrl, video.thumbnailPublicUrl, 'image/jpeg', `attest-${video.thumbnailSourceFileId}`,
  ));
  return {
    input,
    supplements: supplements({ videoPlaylists: videoSupplements }),
    assets: assets({ images: [...assets().images, ...imageAttestations] }),
  };
}

describe('composeSqlDemoRelease', () => {
  it('composes existing CMS DTOs from SQL and pinned pages, retaining SQL institute body and private source locations', () => {
    const input = sqlWithOrganizationAndDocuments();
    const before = structuredClone(input);

    const release = composeSqlDemoRelease(input, supplements(), assets(), ownerDecisions());

    expect(release.entities.pages).toEqual(expect.arrayContaining([
      page('synthetic-static', '<p>Accepted synthetic static body</p>'),
      expect.objectContaining({ slug: 'svedeni-synthetic', legacy_id: 'svedeni-synthetic', seo: { seo_title: 'SEO svedeni-synthetic', seo_description: 'Description svedeni-synthetic' } }),
    ]));
    expect(release.entities.pages.every(({ seo }) => !seo || (typeof seo === 'object' && 'seo_title' in seo))).toBe(true);
    expect(release.entities.institutes[0]).toMatchObject({
      sourceId: 1, slug: 'institute-one', order: 7,
      seo: { seo_title: 'Accepted institute SEO', seo_description: 'Accepted institute description' },
    });
    expect(release.entities.institutes[0].description).toContain('<p>SQL institute base</p>');
    expect(String(release.entities.institutes[0].description).match(/Extra institute text/g)).toHaveLength(1);
    expect(release.provenance).toMatchObject({
      sourceHash,
      acceptedCorpus: { revision: 'accepted-static-corpus-r1', sha256: corpusHash },
      supplements: [
        { sourcePath: staticPagesPath, revision: 'accepted-static-corpus-r1', sha256: corpusHash },
        { sourcePath: staticPagesPath, revision: 'accepted-static-corpus-r1', sha256: corpusHash },
      ],
      targetLocations: expect.arrayContaining(baseTargetLocations()),
    });
    expect(release.entities).not.toHaveProperty('provenance');
    expect(input).toEqual(before);

    const repeated = composeSqlDemoRelease(input, supplements(), assets(), ownerDecisions());
    expect(repeated.entities.institutes[0].description).toBe(release.entities.institutes[0].description);
    expect(String(repeated.entities.institutes[0].description).match(/Extra institute text/g)).toHaveLength(1);
  });

  it('maps SQL playlist titles to CMS name and uses only accepted mirror identity, thumbnail attestation and SEO supplement', () => {
    const fixture = syntheticVideoInputs();
    const release = composeSqlDemoRelease(fixture.input, fixture.supplements, fixture.assets, ownerDecisions());

    expect(release.entities.videos).toEqual([131, 132, 133].map((sourceId) => ({
      name: `SQL playlist ${sourceId}`,
      slug: String(sourceId),
      legacy_id: `video/pleylist/${sourceId}`,
      videos: null,
      seo: { seo_title: `Accepted SEO ${sourceId}`, seo_description: `Accepted description ${sourceId}` },
    })));
    expect(JSON.stringify(release.entities.videos)).not.toMatch(/private-source|sql-image|thumbnail|sourceId|priority/);
    expect(release.entities.videos.every((video) => !Object.hasOwn(video, 'title'))).toBe(true);
    expect(release.provenance.videoMetadata).toHaveLength(3);
    expect(release.provenance.videoMetadata[0]).toMatchObject({ link: 'https://private-source.example.test/playlist/131', priority: 131, imageId: 'sql-image-131' });
    expect(release.provenance.videoSupplements).toHaveLength(3);
    expect(release.provenance.videoSupplements[0]).toMatchObject({
      sourceId: 131, sourcePath: 'discovery/entities/video_playlists.json', revision: 'accepted-video-r1',
      thumbnailSourceFileId: 'thumb-131', thumbnailPublicUrl: '/media/video-thumbs/synthetic-131.jpg',
    });
  });

  it.each([
    ['missing', (videoPlaylists: ReturnType<typeof syntheticVideoInputs>['supplements']['videoPlaylists']) => videoPlaylists.slice(0, 2)],
    ['duplicate', (videoPlaylists: ReturnType<typeof syntheticVideoInputs>['supplements']['videoPlaylists']) => [...videoPlaylists, videoPlaylists[0]]],
    ['unused', (videoPlaylists: ReturnType<typeof syntheticVideoInputs>['supplements']['videoPlaylists']) => [...videoPlaylists, { ...videoPlaylists[0], sourceId: 999 }]],
    ['mismatched accepted slug/legacy identity', (videoPlaylists: ReturnType<typeof syntheticVideoInputs>['supplements']['videoPlaylists']) => videoPlaylists.map((video, index) => index === 0 ? { ...video, slug: '999', legacy_id: 'video/pleylist/999' } : video)],
  ])('fails preflight on a %s SQL-to-accepted video supplement identity', (_kind, mutate) => {
    const fixture = syntheticVideoInputs();
    expect(() => composeSqlDemoRelease(fixture.input, {
      ...fixture.supplements,
      videoPlaylists: mutate(fixture.supplements.videoPlaylists),
    }, fixture.assets, ownerDecisions())).toThrow(/Videos#(131|132|133|999)/);
  });

  it('replaces only mapped Radix panels in SQL priority order, retains empty-section document anchors and cleans through the established boundary', async () => {
    const release = composeSqlDemoRelease(sqlWithOrganizationAndDocuments(), supplements(), assets(), ownerDecisions());
    const rawPage = release.entities.pages.find(({ slug }) => slug === 'svedeni-synthetic');
    expect(rawPage).toBeDefined();
    const cleanerModulePath = '../../web/src/lib/html-cleaner.js';
    const { cleanBodyHtml } = await import(cleanerModulePath);
    const cleanBody = cleanBodyHtml(rawPage!.body, { sourceType: 'sql-demo-test', sourceId: rawPage!.slug }).html;

    expect(cleanBody).toContain('id="section-1"');
    expect(cleanBody).toContain('id="section-2"');
    expect(cleanBody).toContain('id="section-3"');
    expect(cleanBody).toContain('SQL education replacement');
    expect(cleanBody).not.toContain('Accepted education body');
    expect(cleanBody).not.toContain('Accepted documents body');
    expect(cleanBody.indexOf('First synthetic document')).toBeGreaterThan(cleanBody.indexOf('id="section-1"'));
    expect(cleanBody.indexOf('First synthetic document')).toBeLessThan(cleanBody.indexOf('id="section-2"'));
    expect(cleanBody.indexOf('SQL education replacement')).toBeGreaterThan(cleanBody.indexOf('id="section-2"'));
    expect(cleanBody.indexOf('SQL education replacement')).toBeLessThan(cleanBody.indexOf('id="section-3"'));
    expect(cleanBody).toContain('id="section-1"');
    expect(cleanBody.indexOf('First synthetic document')).toBeLessThan(cleanBody.indexOf('Second synthetic document'));
    expect(cleanBody).toContain('href="/documents/synthetic-one.pdf"');
    expect(cleanBody).toContain('href="/documents/synthetic-two.pdf"');
    expect(cleanBody).toContain('Unrelated accepted section');
    expect(cleanBody).toContain('Keep this accepted body');
  });

  it.each([
    ['missing', baseTargetLocations().slice(1)],
    ['duplicate', [...baseTargetLocations(), baseTargetLocations()[0]]],
    ['unused', [...baseTargetLocations(), { ...baseTargetLocations()[0], sourceId: 699, sectionKey: 'unknown' }]],
  ])('fails preflight on a %s source-to-target location', (_kind, targetLocations) => {
    expect(() => composeSqlDemoRelease(sqlWithOrganizationAndDocuments(), supplements({ targetLocations }), assets(), ownerDecisions()))
      .toThrow(/(OrganizationInfo|InstituteAdditionalInfo|FileBindingOrganizationInfo)#(601|602|801|701|702|699)/);
  });

  it('rejects SQL institute supplements whose source foreign key or accepted target identity is unresolved', () => {
    const orphan = mapped({
      instituteAdditionalInfo: [{ sourceId: 801, legacy_id: '801', instituteId: 999, name: 'Synthetic orphan', description: 'must fail' }],
    });
    expect(() => composeSqlDemoRelease(orphan, supplements(), assets(), ownerDecisions())).toThrow(/InstituteAdditionalInfo#801.*instituteId/);

    const wrongTarget = supplements({ targetLocations: baseTargetLocations().map((location) => location.sourceTable === 'InstituteAdditionalInfo'
      ? { ...location, targetLegacyId: 'missing-institute' }
      : location) });
    expect(() => composeSqlDemoRelease(sqlWithOrganizationAndDocuments(), wrongTarget, assets(), ownerDecisions())).toThrow(/InstituteAdditionalInfo#801.*target/);
  });

  it('requires one pinned corpus entry per page slug and rejects duplicate CMS page identities', () => {
    const duplicateSlug = supplements({ pages: [
      ...supplements().pages,
      { ...supplements().pages[0], page: { ...supplements().pages[0].page, title: 'Duplicate static page' } },
    ] });
    expect(() => composeSqlDemoRelease(mapped(), duplicateSlug, assets(), ownerDecisions())).toThrow(/pages.*slug.*synthetic-static/i);

    const unpinnedOrganizationPage = supplements({ pages: supplements().pages.map((entry) => entry.page.slug === 'svedeni-synthetic'
      ? { ...entry, revision: 'other-revision' }
      : entry) });
    expect(() => composeSqlDemoRelease(mapped(), unpinnedOrganizationPage, assets(), ownerDecisions())).toThrow(/svedeni-synthetic.*pinned.*corpus/i);
  });

  it('requires a loader attestation and exact SQL identity for each separate image and PDF mapping', () => {
    const pending = assets({ images: [{
      ...attestation('img-1', '/sql/synthetic-image-1', '/media/synthetic-image-1.png', 'image/png', 'attest-img-1'),
      verification: { status: 'pending' as 'verified', loader: 'sql-demo-asset-loader' as const, attestationId: 'attest-img-1' },
    }] });
    expect(() => composeSqlDemoRelease(mapped({
      articles: [{ sourceId: 901, legacy_id: 'article-901', slug: 'synthetic-article', title: 'Synthetic article', body: 'Synthetic body', imageId: 'img-1' }],
    }), supplements(), pending, ownerDecisions())).toThrow(/img-1.*loader attestation/i);

    const badDocumentUrl = assets({ documents: [
      attestation('pdf-1', '/sql/mismatched.pdf', '/documents/synthetic-one.pdf', 'application/pdf', 'attest-pdf-1') as SqlDemoAllowlistedAssets['documents'][number],
      assets().documents[1],
    ] });
    expect(() => composeSqlDemoRelease(sqlWithOrganizationAndDocuments(), supplements(), badDocumentUrl, ownerDecisions())).toThrow(/pdf-1.*sourceUrl/i);

    const wrongDocumentMime = assets({ documents: [
      { ...assets().documents[0], detectedMimeType: 'image/png' as 'application/pdf' },
      assets().documents[1],
    ] });
    expect(() => composeSqlDemoRelease(sqlWithOrganizationAndDocuments(), supplements(), wrongDocumentMime, ownerDecisions())).toThrow(/pdf-1.*application\/pdf/i);
  });

  it('requires an exact owner decision for each source-referenced unlinked article image', () => {
    expect(() => composeSqlDemoRelease(mapped({
      articles: [{ sourceId: 901, legacy_id: 'article-901', slug: 'synthetic-article', title: 'Synthetic article', body: '<p><img src="/sql/synthetic-image-1" /></p>', imageId: 'img-1' }],
    }), supplements(), assets(), ownerDecisions([]))).toThrow(/img-1.*owner decision/i);
  });

  it('applies only seven exact video decisions, preserves surrounding text and queries, and rejects unmatched iframe transforms', () => {
    const rutubeIds = [
      '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ];
    const rutube = rutubeIds.map((id) => ({
      originalURL: `https://rutube.ru/play/embed/${id}`,
      expectedOutput: `<iframe src="https://rutube.ru/play/embed/${id}/">`,
      sourceTable: 'Articles' as const, sourceId: 901, field: 'body' as const, action: 'rutube-trailing-slash' as const,
    }));
    const external = [
      {
        sourceTable: 'Seminars' as const, sourceId: 9346, field: 'full_text' as const,
        originalURL: 'https://rutube.ru/play/embed/66666666-6666-4666-8666-666666666666/?p=synthetic',
        action: 'external-link' as const,
        expectedOutput: '<a href="https://rutube.ru/play/embed/66666666-6666-4666-8666-666666666666/?p=synthetic" rel="noopener noreferrer">Открыть видео</a>',
      },
      {
        sourceTable: 'Seminars' as const, sourceId: 9347, field: 'full_text' as const,
        originalURL: 'https://vk.com/video_ext.php?oid=-100&vid=synthetic346&hash=synthetic',
        action: 'external-link' as const,
        expectedOutput: '<a href="https://vk.com/video_ext.php?oid=-100&vid=synthetic346&hash=synthetic" rel="noopener noreferrer">Открыть видео</a>',
      },
    ];
    const decisions = [...rutube, ...external];
    const articleBody = rutube.map(({ originalURL }, index) => `<p>Before ${index}</p><iframe src="${originalURL}"></iframe><p>After ${index}</p>`).join('');
    const input = mapped({
      articles: [{ sourceId: 901, legacy_id: 'article-901', slug: 'synthetic-article', title: 'Synthetic article', body: articleBody }],
      seminars: external.map(({ sourceId, originalURL }) => ({
        sourceId, legacy_id: `seminar-${sourceId}`, slug: `synthetic-${sourceId}`, name: `Synthetic ${sourceId}`,
        full_text: `<p>Before ${sourceId}</p><iframe src="${originalURL}"></iframe><p>After ${sourceId}</p>`,
      })),
    });
    const release = composeSqlDemoRelease(input, supplements(), assets(), ownerDecisions(decisions));
    const article = release.entities.articles[0].body;
    expect(article).toContain('Before 0');
    expect(article).toContain('After 4');
    expect(article).toContain(rutube[0].expectedOutput);
    expect(article).not.toContain('?p=synthetic');
    expect(article).not.toContain(`src="${rutube[0].originalURL}"`);
    expect(release.entities.seminars[0].full_text).toContain(external[0].expectedOutput);
    expect(release.entities.seminars[1].full_text).toContain(external[1].expectedOutput);
    expect(release.provenance.ownerDecisions.videoReferences).toEqual(decisions);

    const unmatched = [...decisions, { ...rutube[0], sourceId: 999 }];
    expect(() => composeSqlDemoRelease(input, supplements(), assets(), ownerDecisions(unmatched))).toThrow(/Articles#999.*video decision/i);
    const unsupportedHost = mapped({
      articles: [{ sourceId: 902, legacy_id: 'article-902', slug: 'synthetic-unsupported', title: 'Synthetic unsupported', body: '<iframe src="https://unapproved.example.test/embed/x"></iframe>' }],
    });
    expect(() => composeSqlDemoRelease(unsupportedHost, supplements(), assets(), ownerDecisions())).toThrow(/Articles#902.*unmatched iframe/i);
  });
});
