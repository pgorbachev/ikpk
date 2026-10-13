import { describe, expect, it } from 'vitest';
import { composeSqlDemoRelease, type SqlDemoAcceptedSupplements, type SqlDemoAllowlistedAssets, type SqlDemoOwnerDecisions, type SqlDemoTargetLocation, type SqlDemoVideoReferenceDecision } from './sql-demo-release.js';
import type { SqlPublicContentResult } from './sql-public-content.js';

const sourceHash = `sha256:${'a'.repeat(64)}`;
const corpusHash = 'b'.repeat(64);
const staticPagesPath = 'synthetic-corpus/static_pages.json';

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
    targetLocations: [],
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
    images: [],
    documents: [],
    ...overrides,
  };
}

function ownerDecisions(videoReferences: SqlDemoVideoReferenceDecision[] = []): SqlDemoOwnerDecisions {
  return {
    approvedUnlinkedArticleImages: [],
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
    sourceId, sourcePath: 'synthetic-corpus/video_playlists.json', revision: 'accepted-video-r1', sha256: 'f'.repeat(64),
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
  it('keeps active SQL article fields authoritative when accepted corpus supplements are composed', () => {
    const sqlArticle = {
      sourceId: 361,
      legacy_id: 'institute-one/program-one/native-seminar-one',
      slug: 'native-seminar-one',
      title: 'Synthetic SQL article title',
      body: '<p>SQL body remains authoritative</p>',
      imageId: null,
      published_date: '2026-10-12T00:00:00.000Z',
      seo: { seo_title: 'SQL title', seo_description: 'SQL description' },
    };
    const input = mapped({ articles: [sqlArticle] });
    const acceptedCorpus = supplements({ pages: [
      {
        sourcePath: staticPagesPath, revision: 'accepted-static-corpus-r1', sha256: corpusHash,
        page: page('synthetic-static', '<p>Accepted corpus structure</p>'),
      },
    ] });

    const release = composeSqlDemoRelease(input, acceptedCorpus, assets(), ownerDecisions());

    expect(release.entities.articles).toEqual([expect.objectContaining(sqlArticle)]);
    expect(release.entities.pages).toEqual([expect.objectContaining({
      slug: 'synthetic-static', body: '<p>Accepted corpus structure</p>',
    })]);
    expect(JSON.stringify(release.entities.articles)).not.toContain('Accepted corpus structure');
  });

  it('composes existing CMS DTOs from SQL and pinned pages, retaining SQL institute body and private source locations', () => {
    const input = sqlWithOrganizationAndDocuments();
    const before = structuredClone(input);
    const targetLocations = baseTargetLocations();
    const documentAssets = assets({ documents: [
      documentAttestation('pdf-1', '/sql/synthetic-document-1.pdf', '/documents/synthetic-one.pdf', 'attest-pdf-1'),
      documentAttestation('pdf-2', '/sql/synthetic-document-2.pdf', '/documents/synthetic-two.pdf', 'attest-pdf-2'),
    ] });

    const release = composeSqlDemoRelease(input, supplements({ targetLocations }), documentAssets, ownerDecisions());

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

    const repeated = composeSqlDemoRelease(input, supplements({ targetLocations }), documentAssets, ownerDecisions());
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
      sourceId: 131, sourcePath: 'synthetic-corpus/video_playlists.json', revision: 'accepted-video-r1',
      thumbnailSourceFileId: 'thumb-131', thumbnailPublicUrl: '/media/video-thumbs/synthetic-131.jpg',
    });
  });

  it('composes all six accepted playlists while requiring thumbnail attestations only for native SQL image IDs', () => {
    const ids = [31, 32, 33, 34, 36, 37];
    const thumbnailIds = new Set([31, 34, 37]);
    const input = mapped({
      videos: ids.map((sourceId) => ({
        sourceId,
        legacy_id: `video/pleylist/${sourceId}`,
        slug: String(sourceId),
        title: `Synthetic SQL playlist ${sourceId}`,
        ...(thumbnailIds.has(sourceId) ? { imageId: `thumb-${sourceId}` } : { imageId: null }),
      })),
    });
    input.provenance.videoMetadata = ids.map((sourceId) => ({
      sourceId, link: `/synthetic/sql-playlist/${sourceId}`, priority: sourceId,
      imageId: thumbnailIds.has(sourceId) ? `thumb-${sourceId}` : null,
    }));
    const videoPlaylists = ids.map((sourceId) => ({
      sourceId, sourcePath: 'synthetic-corpus/video_playlists.json', revision: 'accepted-video-r1', sha256: 'f'.repeat(64),
      slug: String(sourceId), legacy_id: `video/pleylist/${sourceId}`,
      seo: { seo_title: `Accepted SEO ${sourceId}`, seo_description: `Accepted description ${sourceId}` },
      videos: null,
      ...(thumbnailIds.has(sourceId) ? {
        thumbnailSourceFileId: `thumb-${sourceId}`,
        thumbnailSourceUrl: `/accepted/thumb-${sourceId}.jpg`,
        thumbnailPublicUrl: `/media/video-thumbs/synthetic-${sourceId}.jpg`,
      } : {
        thumbnailSourceFileId: null,
        thumbnailSourceUrl: null,
        thumbnailPublicUrl: null,
      }),
    }));
    const accepted = supplements({
      videoPlaylists: videoPlaylists as unknown as SqlDemoAcceptedSupplements['videoPlaylists'],
    });
    const verifiedImages = [...thumbnailIds].map((sourceId) => attestation(
      `thumb-${sourceId}`, `/accepted/thumb-${sourceId}.jpg`, `/media/video-thumbs/synthetic-${sourceId}.jpg`,
      'image/jpeg', `attest-thumb-${sourceId}`,
    ));

    const release = composeSqlDemoRelease(input, accepted, assets({ images: verifiedImages }), ownerDecisions());

    expect(release.entities.videos).toHaveLength(6);
    expect(release.entities.videos.map(({ legacy_id, name, videos }) => ({ legacy_id, name, videos }))).toEqual(ids.map((sourceId) => ({
      legacy_id: `video/pleylist/${sourceId}`, name: `Synthetic SQL playlist ${sourceId}`, videos: null,
    })));
    expect(release.provenance.videoSupplements).toHaveLength(6);
    expect(release.provenance.videoSupplements.filter(({ thumbnailSourceFileId }) => thumbnailSourceFileId === null)).toHaveLength(3);
    expect(release.provenance.assetMappings.map(({ sourceFileId }) => sourceFileId).sort()).toEqual(['thumb-31', 'thumb-34', 'thumb-37']);
    expect(JSON.stringify(release.entities.videos)).not.toMatch(/sql-playlist|thumb-|priority|sourceId/);
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
    const organizationVideo = {
      sourceTable: 'OrganizationInfo' as const, sourceId: 601, field: 'content' as const,
      originalURL: 'https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef',
      action: 'rutube-trailing-slash' as const,
      expectedOutput: '<iframe src="https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef/" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>',
    };
    const input = sqlWithOrganizationAndDocuments();
    input.entities.organizationInfo![0].content = `<p>SQL education replacement</p><iframe src="${organizationVideo.originalURL}"></iframe>`;
    const documentAssets = assets({ documents: [
      documentAttestation('pdf-1', '/sql/synthetic-document-1.pdf', '/documents/synthetic-one.pdf', 'attest-pdf-1'),
      documentAttestation('pdf-2', '/sql/synthetic-document-2.pdf', '/documents/synthetic-two.pdf', 'attest-pdf-2'),
    ] });
    const release = composeSqlDemoRelease(input, supplements({ targetLocations: baseTargetLocations() }), documentAssets, ownerDecisions([organizationVideo]));
    const rawPage = release.entities.pages.find(({ slug }) => slug === 'svedeni-synthetic');
    expect(rawPage).toBeDefined();
    expect(rawPage!.body).toContain(organizationVideo.expectedOutput);
    expect(rawPage!.body).not.toContain(`src="${organizationVideo.originalURL}"`);
    const cleanerModulePath = new URL('../../web/src/lib/html-cleaner.ts', import.meta.url).href;
    const { cleanBodyHtml } = await import(cleanerModulePath);
    const cleanBody = cleanBodyHtml(rawPage!.body, { sourceType: 'sql-demo-test', sourceId: rawPage!.slug }).html;

    expect(cleanBody).toContain('id="section-1"');
    expect(cleanBody).toContain('id="section-2"');
    expect(cleanBody).toContain('id="section-3"');
    expect(cleanBody).toContain('SQL education replacement');
    expect(cleanBody).toContain('src="https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef/"');
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
    const documentAssets = assets({ documents: [
      documentAttestation('pdf-1', '/sql/synthetic-document-1.pdf', '/documents/synthetic-one.pdf', 'attest-pdf-1'),
      documentAttestation('pdf-2', '/sql/synthetic-document-2.pdf', '/documents/synthetic-two.pdf', 'attest-pdf-2'),
    ] });
    expect(() => composeSqlDemoRelease(sqlWithOrganizationAndDocuments(), supplements({ targetLocations }), documentAssets, ownerDecisions()))
      .toThrow(/(OrganizationInfo|InstituteAdditionalInfo|FileBindingOrganizationInfo)#(601|602|801|701|702|699)/);
  });

  it('accepts empty optional SQL source groups only with matching empty pinned locations and PDF mappings', () => {
    const release = composeSqlDemoRelease(mapped(), supplements(), assets(), ownerDecisions());
    expect(release.entities.pages.map(({ slug }) => slug)).toEqual(['synthetic-static', 'svedeni-synthetic']);
    expect(release.provenance.targetLocations).toEqual([]);
    expect(release.provenance.assetMappings).toEqual([]);
  });

  const missingSourceLocationCases: [string, SqlDemoTargetLocation[], SqlDemoAllowlistedAssets][] = [
    ['OrganizationInfo', [baseTargetLocations()[0]], assets()],
    ['InstituteAdditionalInfo', [baseTargetLocations()[2]], assets()],
    ['FileBindingOrganizationInfo', [baseTargetLocations()[3]], assets({ documents: [
      documentAttestation('pdf-1', '/sql/synthetic-document-1.pdf', '/documents/synthetic-one.pdf', 'attest-pdf-1'),
    ] })],
  ];
  it.each(missingSourceLocationCases)('rejects pinned %s locations when their SQL source group is absent', (_table, targetLocations, allowlistedAssets) => {
    expect(() => composeSqlDemoRelease(mapped(), supplements({ targetLocations }), allowlistedAssets, ownerDecisions()))
      .toThrow(/(OrganizationInfo|InstituteAdditionalInfo|FileBindingOrganizationInfo)#\d+.*(unused|source|SQL|row)/i);
  });

  it('rejects a PDF allowlist mapping when no SQL document binds it', () => {
    const orphanPdf = documentAttestation('pdf-orphan', '/sql/orphan.pdf', '/documents/orphan.pdf', 'attest-pdf-orphan');
    expect(() => composeSqlDemoRelease(mapped(), supplements(), assets({ documents: [orphanPdf] }), ownerDecisions()))
      .toThrow(/pdf-orphan.*(SQL document|binding|unused)/i);
  });

  it('rejects SQL institute supplements whose source foreign key or accepted target identity is unresolved', () => {
    const orphan = mapped({
      instituteAdditionalInfo: [{ sourceId: 801, legacy_id: '801', instituteId: 999, name: 'Synthetic orphan', description: 'must fail' }],
    });
    expect(() => composeSqlDemoRelease(orphan, supplements({ targetLocations: [baseTargetLocations()[2]] }), assets(), ownerDecisions())).toThrow(/InstituteAdditionalInfo#801.*instituteId/);

    const wrongTarget = supplements({ targetLocations: baseTargetLocations().map((location) => location.sourceTable === 'InstituteAdditionalInfo'
      ? { ...location, targetLegacyId: 'missing-institute' }
      : location) });
    const documentAssets = assets({ documents: [
      documentAttestation('pdf-1', '/sql/synthetic-document-1.pdf', '/documents/synthetic-one.pdf', 'attest-pdf-1'),
      documentAttestation('pdf-2', '/sql/synthetic-document-2.pdf', '/documents/synthetic-two.pdf', 'attest-pdf-2'),
    ] });
    expect(() => composeSqlDemoRelease(sqlWithOrganizationAndDocuments(), wrongTarget, documentAssets, ownerDecisions())).toThrow(/InstituteAdditionalInfo#801.*target/);
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

    const targetLocations = baseTargetLocations();
    const badDocumentUrl = assets({ documents: [
      attestation('pdf-1', '/sql/mismatched.pdf', '/documents/synthetic-one.pdf', 'application/pdf', 'attest-pdf-1') as SqlDemoAllowlistedAssets['documents'][number],
      documentAttestation('pdf-2', '/sql/synthetic-document-2.pdf', '/documents/synthetic-two.pdf', 'attest-pdf-2'),
    ] });
    expect(() => composeSqlDemoRelease(sqlWithOrganizationAndDocuments(), supplements({ targetLocations }), badDocumentUrl, ownerDecisions())).toThrow(/pdf-1.*sourceUrl/i);

    const wrongDocumentMime = assets({ documents: [
      { ...documentAttestation('pdf-1', '/sql/synthetic-document-1.pdf', '/documents/synthetic-one.pdf', 'attest-pdf-1'), detectedMimeType: 'image/png' as 'application/pdf' },
      documentAttestation('pdf-2', '/sql/synthetic-document-2.pdf', '/documents/synthetic-two.pdf', 'attest-pdf-2'),
    ] });
    expect(() => composeSqlDemoRelease(sqlWithOrganizationAndDocuments(), supplements({ targetLocations }), wrongDocumentMime, ownerDecisions())).toThrow(/pdf-1.*application\/pdf/i);
  });

  it('accepts a direct SQL article imageId without an unlinked-image owner grant', () => {
    const directImage = attestation('direct-image', '/sql/direct-image', '/media/direct-image.png', 'image/png', 'attest-direct-image');
    const input = mapped({
      articles: [{ sourceId: 901, legacy_id: 'article-901', slug: 'synthetic-article', title: 'Synthetic article', body: '<p>Direct image pointer</p>', imageId: 'direct-image' }],
    });
    const release = composeSqlDemoRelease(input, supplements(), assets({ images: [directImage] }), ownerDecisions());
    expect(release.entities.articles[0]).toMatchObject({ sourceId: 901, imageId: 'direct-image' });
  });

  it('rewrites an owner-approved body-only article image to its exact offline URL', () => {
    const bodyImage = attestation('body-image', '/sql/body-only-image', '/media/offline-body-image.png', 'image/png', 'attest-body-image');
    const input = mapped({
      articles: [{ sourceId: 902, legacy_id: 'article-902', slug: 'synthetic-article-body-image', title: 'Synthetic article', body: '<p><img src="/sql/body-only-image" alt="Synthetic" /></p>', imageId: null }],
    });
    const approved = {
      ...ownerDecisions(),
      approvedUnlinkedArticleImages: [{ sourceFileId: bodyImage.sourceFileId, sourceUrl: bodyImage.sourceUrl, decisionId: 'approved-body-image' }],
    };
    const release = composeSqlDemoRelease(input, supplements(), assets({ images: [bodyImage] }), approved);
    expect(release.entities.articles[0].body).toContain('src="/media/offline-body-image.png"');
    expect(release.entities.articles[0].body).not.toContain(bodyImage.sourceUrl);
  });

  it('rewrites a canonical article upload alias through the exact SQL file identity and verified public URL', () => {
    const fileId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    const alias = `https://ikpk.su/api/upload/file/${fileId}`;
    const storagePath = '/storage/article/body.png';
    const verifiedPublicUrl = '/media/verified/article-body.png';
    const verifiedAliasMapping = {
      ...attestation(fileId, storagePath, verifiedPublicUrl, 'image/png', 'attest-upload-alias'),
      sourceReferenceAlias: alias,
    } as SqlDemoAllowlistedAssets['images'][number];
    const input = mapped({
      articles: [{ sourceId: 902, legacy_id: 'article-902', slug: 'synthetic-article-alias', title: 'Synthetic article', body: `<p><img src="${alias}" alt="Synthetic" /></p>`, imageId: null }],
    });
    const approved = {
      ...ownerDecisions(),
      approvedUnlinkedArticleImages: [{ sourceFileId: fileId, sourceUrl: alias, decisionId: 'approved-upload-alias' }],
    };

    const release = composeSqlDemoRelease(input, supplements(), assets({ images: [verifiedAliasMapping] }), approved);

    expect(release.entities.articles[0].body).toContain(`src="${verifiedPublicUrl}"`);
    expect(release.entities.articles[0].body).not.toContain(alias);
    expect(release.provenance.assetMappings).toContainEqual(expect.objectContaining({
      sourceFileId: fileId, sourceUrl: storagePath, sourceReferenceAlias: alias, targetPublicUrl: verifiedPublicUrl,
    }));
  });

  it('rewrites only the two exact owner-approved unlinked rich-text images on their mapped public fields', () => {
    const programFileId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    const seminarFileId = 'b1c2d3e4-f5a6-4789-b012-3456789abcde';
    const programAlias = `https://ikpk.su/api/upload/file/${programFileId}`;
    const seminarAlias = `https://ikpk.su/api/upload/file/${seminarFileId}`;
    const programTarget = '/media/verified/program-content.png';
    const seminarTarget = '/media/verified/seminar-learning.png';
    const programImage = {
      ...attestation(programFileId, '/storage/program-content.png', programTarget, 'image/png', 'attest-program-rich'),
      sourceReferenceAlias: programAlias,
    } as SqlDemoAllowlistedAssets['images'][number];
    const seminarImage = {
      ...attestation(seminarFileId, '/storage/seminar-learning.png', seminarTarget, 'image/png', 'attest-seminar-rich'),
      sha256: 'e'.repeat(64),
      sourceReferenceAlias: seminarAlias,
    } as SqlDemoAllowlistedAssets['images'][number];
    const input = mapped({
      programs: [{ sourceId: 501, legacy_id: 'program-501', slug: 'program-501', name: 'Synthetic program', description: `<p><img src="${programAlias}" alt="Program" /></p>`, imageId: null }],
      seminars: [{ sourceId: 900, legacy_id: 'seminar-900', slug: 'seminar-900', title: 'Synthetic seminar', learning_plan: `<p><img src="${seminarAlias}" alt="Seminar" /></p>` }],
    });
    const approved = {
      ...ownerDecisions(),
      approvedPublicRichTextImages: [
        { sourceTable: 'Programs', sourceId: 501, sourceField: 'description', sourceFileId: programFileId, sourceSha256: 'd'.repeat(64), sourceUrl: programAlias, decisionId: 'approved-program-rich' },
        { sourceTable: 'Seminars', sourceId: 900, sourceField: 'learning_plan', sourceFileId: seminarFileId, sourceSha256: 'e'.repeat(64), sourceUrl: seminarAlias, decisionId: 'approved-seminar-rich' },
      ],
    } as unknown as SqlDemoOwnerDecisions;

    const release = composeSqlDemoRelease(input, supplements(), assets({ images: [programImage, seminarImage] }), approved);

    expect(release.entities.programs[0].description).toContain(`src="${programTarget}"`);
    expect(release.entities.programs[0].description).not.toContain(programAlias);
    expect(release.entities.seminars[0].learning_plan).toContain(`src="${seminarTarget}"`);
    expect(release.entities.seminars[0].learning_plan).not.toContain(seminarAlias);
    expect(release.provenance.assetMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFileId: programFileId, targetPublicUrl: programTarget }),
      expect.objectContaining({ sourceFileId: seminarFileId, targetPublicUrl: seminarTarget }),
    ]));
  });

  it('rejects a body-only image without an exact owner grant or allowlisted mapping', () => {
    const bodyImage = attestation('body-image', '/sql/body-only-image', '/media/offline-body-image.png', 'image/png', 'attest-body-image');
    const bodyOnlyArticle = (src: string) => mapped({
      articles: [{ sourceId: 903, legacy_id: 'article-903', slug: 'synthetic-article-body-unapproved', title: 'Synthetic article', body: `<p><img src="${src}" /></p>`, imageId: null }],
    });
    expect(() => composeSqlDemoRelease(bodyOnlyArticle(bodyImage.sourceUrl), supplements(), assets({ images: [bodyImage] }), ownerDecisions()))
      .toThrow(/body-image.*owner decision/i);
    expect(() => composeSqlDemoRelease(bodyOnlyArticle('/sql/unmapped-image'), supplements(), assets(), ownerDecisions()))
      .toThrow(/Articles#903.*(image|asset|URL|source)/i);
  });

  it('retains an already-accepted Rutube iframe in seminar and program descriptions without an owner decision', () => {
    const acceptedIframe = '<iframe src="https://rutube.ru/play/embed/abcdefabcdefabcdefabcdefabcdefab/"></iframe>';
    const input = mapped({
      programs: [{ sourceId: 77, legacy_id: 'program-77', slug: 'program-77', name: 'Synthetic program', description: acceptedIframe }],
      seminars: [{ sourceId: 9349, legacy_id: 'seminar-9349', slug: 'synthetic-9349', name: 'Synthetic seminar', description: acceptedIframe }],
    });
    const release = composeSqlDemoRelease(input, supplements(), assets(), ownerDecisions());
    expect(release.entities.seminars[0].description).toBe(acceptedIframe);
    expect(release.entities.programs[0].description).toBe(acceptedIframe);
  });

  it('requires an exact decision for a non-normalized SQL seminar embed', () => {
    const input = mapped({
      seminars: [{
        sourceId: 9350, legacy_id: 'seminar-9350', slug: 'synthetic-9350', name: 'Synthetic seminar',
        description: '<iframe src="https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef"></iframe>',
      }],
    });
    expect(() => composeSqlDemoRelease(input, supplements(), assets(), ownerDecisions()))
      .toThrow(/Seminars#9350.*(decision|iframe)/i);
  });

  it.each([
    ['Rutube query embed', 'https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef/?p=synthetic'],
    ['VK oid/id embed', 'https://vk.com/video_ext.php?oid=-123&id=456&hd=2&autoplay=1'],
  ])('transforms the exact %s decision on Seminars.description', (_shape, originalURL) => {
    const input = mapped({
      seminars: [{
        sourceId: 9351, legacy_id: 'seminar-9351', slug: 'synthetic-9351', name: 'Synthetic seminar',
        description: `<iframe src="${originalURL}"></iframe>`,
      }],
    });
    const decision = {
      sourceTable: 'Seminars' as const, sourceId: 9351, field: 'description' as const,
      originalURL, action: 'external-link' as const,
      expectedOutput: `<a href="${originalURL}" rel="noopener noreferrer">Открыть видео</a>`,
    };
    const release = composeSqlDemoRelease(input, supplements(), assets(), ownerDecisions([decision]));
    expect(release.entities.seminars[0].description).toBe(decision.expectedOutput);
  });

  it('preserves already-accepted iframe sources and cleans the seven exact SQL seminar embed decisions', async () => {
    const rutubeIds = [
      '11111111111111111111111111111111', '22222222222222222222222222222222',
      '33333333333333333333333333333333', '44444444444444444444444444444444',
      '55555555555555555555555555555555',
    ];
    const rutube = rutubeIds.map((id) => ({
      originalURL: `https://rutube.ru/play/embed/${id}`,
      expectedOutput: `<iframe src="https://rutube.ru/play/embed/${id}/"></iframe>`,
      sourceTable: 'Seminars' as const, sourceId: 9346, field: 'description' as const, action: 'rutube-trailing-slash' as const,
    }));
    const external = [
      {
        sourceTable: 'Seminars' as const, sourceId: 9347, field: 'description' as const,
        originalURL: 'https://rutube.ru/play/embed/66666666666666666666666666666666/?p=synthetic',
        action: 'external-link' as const,
        expectedOutput: '<a href="https://rutube.ru/play/embed/66666666666666666666666666666666/?p=synthetic" rel="noopener noreferrer">Открыть видео</a>',
      },
      {
        sourceTable: 'Seminars' as const, sourceId: 9348, field: 'description' as const,
        originalURL: 'https://vk.com/video_ext.php?oid=-123&id=456&hd=2&autoplay=1',
        action: 'external-link' as const,
        expectedOutput: '<a href="https://vk.com/video_ext.php?oid=-123&id=456&hd=2&autoplay=1" rel="noopener noreferrer">Открыть видео</a>',
      },
    ];
    const decisions = [...rutube, ...external];
    const acceptedRutube = '<iframe src="https://rutube.ru/play/embed/abcdefabcdefabcdefabcdefabcdefab/"></iframe>';
    const input = mapped({
      programs: [{ sourceId: 77, legacy_id: 'program-77', slug: 'program-77', name: 'Synthetic program', description: acceptedRutube }],
      seminars: [
        {
          sourceId: 9346, legacy_id: 'seminar-9346', slug: 'synthetic-9346', name: 'Synthetic 9346',
          description: `<p>Before</p>${acceptedRutube}${rutube.map(({ originalURL }) => `<iframe src="${originalURL}"></iframe>`).join('')}<p>After</p>`,
        },
        ...external.map(({ sourceId, originalURL }) => ({
          sourceId, legacy_id: `seminar-${sourceId}`, slug: `synthetic-${sourceId}`, name: `Synthetic ${sourceId}`,
          description: `<p>Before ${sourceId}</p><iframe src="${originalURL}"></iframe><p>After ${sourceId}</p>`,
        })),
      ],
    });
    const release = composeSqlDemoRelease(input, supplements(), assets(), ownerDecisions(decisions));
    const cleanerModulePath = new URL('../../web/src/lib/html-cleaner.ts', import.meta.url).href;
    const { cleanBodyHtml } = await import(cleanerModulePath);
    const parse5Url = new URL('../../web/node_modules/parse5/dist/index.js', import.meta.url);
    const { parseFragment } = await import(parse5Url.href);
    type CleanedNode = { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: CleanedNode[] };
    const iframeNodes = (html: string): CleanedNode[] => {
      const result: CleanedNode[] = [];
      const walk = (node: CleanedNode): void => {
        for (const child of node.childNodes ?? []) {
          if (child.tagName === 'iframe') result.push(child);
          walk(child);
        }
      };
      walk(parseFragment(html) as CleanedNode);
      return result;
    };
    const attrValue = (node: CleanedNode, name: string): string | undefined => node.attrs?.find((attr) => attr.name === name)?.value;
    const cleanDescriptions = release.entities.seminars.map((seminar) => cleanBodyHtml(
      String(seminar.description ?? ''),
      { sourceType: 'sql-demo-test', sourceId: String(seminar.sourceId) },
    ).html);
    const cleanProgramDescription = cleanBodyHtml(String(release.entities.programs[0].description ?? ''), {
      sourceType: 'sql-demo-test', sourceId: 'program-77',
    }).html;
    const seminarDescription = cleanDescriptions[0];
    expect(seminarDescription).toContain('Before');
    expect(seminarDescription).toContain('After');
    const seminarIframes = iframeNodes(seminarDescription);
    expect(seminarIframes).toHaveLength(6);
    expect(seminarIframes.map((iframe) => attrValue(iframe, 'src'))).toEqual([
      'https://rutube.ru/play/embed/abcdefabcdefabcdefabcdefabcdefab/',
      ...rutubeIds.map((id) => `https://rutube.ru/play/embed/${id}/`),
    ]);
    expect(attrValue(seminarIframes[0], 'sandbox')).toBe('allow-scripts allow-same-origin allow-presentation');
    expect(attrValue(seminarIframes[0], 'referrerpolicy')).toBe('no-referrer');
    expect(iframeNodes(cleanProgramDescription).map((iframe) => attrValue(iframe, 'src'))).toEqual([
      'https://rutube.ru/play/embed/abcdefabcdefabcdefabcdefabcdefab/',
    ]);
    expect(cleanDescriptions[1]).toContain('Before 9347');
    expect(cleanDescriptions[1]).toContain('After 9347');
    expect(cleanDescriptions[1]).toContain('href="https://rutube.ru/play/embed/66666666666666666666666666666666/?p=synthetic"');
    expect(cleanDescriptions[2]).toContain('Before 9348');
    expect(cleanDescriptions[2]).toContain('After 9348');
    expect(cleanDescriptions[2]).toMatch(/href="https:\/\/vk\.com\/video_ext\.php\?oid=-123&amp;id=456&amp;hd=2&amp;autoplay=1"/);
    expect(release.provenance.ownerDecisions.videoReferences).toEqual(decisions);

    const unmatched = [...decisions, { ...rutube[0], sourceId: 999 }];
    expect(() => composeSqlDemoRelease(input, supplements(), assets(), ownerDecisions(unmatched))).toThrow(/Seminars#999.*video decision/i);
    const unsupportedHost = mapped({
      articles: [{ sourceId: 902, legacy_id: 'article-902', slug: 'synthetic-unsupported', title: 'Synthetic unsupported', body: '<iframe src="https://unapproved.example.test/embed/x"></iframe>' }],
    });
    expect(() => composeSqlDemoRelease(unsupportedHost, supplements(), assets(), ownerDecisions())).toThrow(/Articles#902.*unmatched iframe/i);
  });
});
