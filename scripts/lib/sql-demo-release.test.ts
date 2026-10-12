import { describe, expect, it } from 'vitest';
import { composeSqlDemoRelease, type SqlDemoAcceptedSupplements, type SqlDemoAllowlistedAssets, type SqlDemoOwnerDecisions } from './sql-demo-release.js';
import type { SqlPublicContentResult } from './sql-public-content.js';

const sourceHash = `sha256:${'a'.repeat(64)}`;
const corpusHash = 'b'.repeat(64);
const page = (slug: string, body: string) => ({ title: `Synthetic ${slug}`, slug, body, seo_title: `SEO ${slug}` });

function mapped(overrides: Partial<SqlPublicContentResult['entities']> = {}): SqlPublicContentResult {
  const institutes = [
    { sourceId: 1, legacy_id: 'institute-one', slug: 'institute-one', name: 'Synthetic institute', shortName: null, description: '<p>SQL institute body</p>', imageId: null },
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

function supplements(overrides: Partial<SqlDemoAcceptedSupplements> = {}): SqlDemoAcceptedSupplements {
  return {
    acceptedCorpus: { revision: 'accepted-corpus-r1', sha256: corpusHash },
    pages: [{
      sourcePath: 'web/src/pages/synthetic-static.astro', revision: 'accepted-corpus-r1', sha256: 'c'.repeat(64),
      page: page('synthetic-static', '<p>Accepted static body</p>'),
    }],
    instituteMetadata: [{ sourceId: 1, slug: 'institute-one', order: 7, seo: { seo_title: 'Accepted institute SEO' } }],
    organizationPage: page('svedeni-synthetic', [
      '<section id="section-1"><h2>Existing one</h2><p>Old one</p></section>',
      '<section id="section-2"><h2>Existing two</h2><p>Old two</p></section>',
      '<section id="accepted-unrelated"><h2>Keep me</h2><p>Unrelated accepted content</p></section>',
    ].join('')),
    organizationSectionTargets: [
      { sourceTable: 'OrganizationInfo', sourceId: 601, targetSectionKey: 'education', targetAnchor: 'section-1' },
      { sourceTable: 'OrganizationInfo', sourceId: 602, targetSectionKey: 'documents', targetAnchor: 'section-2' },
    ],
    ...overrides,
  };
}

function assets(overrides: Partial<SqlDemoAllowlistedAssets> = {}): SqlDemoAllowlistedAssets {
  return {
    images: [{
      sourceFileId: 'img-1', sourceUrl: '/sql/image-1', targetPublicUrl: '/media/image-1.png',
      sha256: 'd'.repeat(64), mimeType: 'image/png', approvalId: 'owner-image-1',
    }],
    documents: [{
      sourceFileId: 'pdf-1', sourceUrl: '/sql/document-1.pdf', targetPublicUrl: '/documents/document-1.pdf',
      sha256: 'e'.repeat(64), mimeType: 'application/pdf', approvalId: 'owner-pdf-1',
    }],
    ...overrides,
  };
}

function decisions(overrides: Partial<SqlDemoOwnerDecisions> = {}): SqlDemoOwnerDecisions {
  return {
    approvedUnlinkedArticleImages: [{ sourceFileId: 'img-1', approvalId: 'owner-image-1' }],
    externalVideoLinks: [{ sourceId: 77, sourceUrl: 'https://video.example.test/watch/77?token=synthetic', approvalId: 'owner-video-77' }],
    ...overrides,
  };
}

describe('composeSqlDemoRelease', () => {
  it('builds the existing CMS DTO release from SQL plus pinned accepted supplements and keeps provenance private', () => {
    const input = mapped({
      instituteAdditionalInfo: [{ sourceId: 801, legacy_id: '801', instituteId: 1, name: 'Synthetic section', description: '<p>Extra institute text</p>' }],
      organizationInfo: [
        { sourceId: 601, legacy_id: '601', name: 'Synthetic education section', priority: 20, content: '<p>SQL education content</p>' },
        { sourceId: 602, legacy_id: '602', name: 'Synthetic documents section', priority: 10, content: '' },
      ],
      documents: [
        { sourceId: 'pdf-1', fileId: 'pdf-1', bindingSourceId: 702, organizationInfoSourceId: 602, title: 'Second synthetic document', priority: 2, originalName: 'two.pdf', extension: 'pdf', fileType: 'application/pdf', url: '/sql/document-2.pdf' },
        { sourceId: 'pdf-2', fileId: 'pdf-2', bindingSourceId: 701, organizationInfoSourceId: 602, title: 'First synthetic document', priority: 1, originalName: 'one.pdf', extension: 'pdf', fileType: 'application/pdf', url: '/sql/document-1.pdf' },
      ],
      videos: [{ sourceId: 77, legacy_id: 'playlist-77', slug: 'synthetic-playlist', name: 'Synthetic playlist', title: 'Synthetic playlist', videos: [] }],
    });
    const before = structuredClone(input);

    const release = composeSqlDemoRelease(input, supplements(), assets(), decisions());

    expect(release.entities.pages).toContainEqual(page('synthetic-static', '<p>Accepted static body</p>'));
    expect(release.entities.institutes[0]).toMatchObject({
      sourceId: 1, slug: 'institute-one', order: 7,
      seo: { seo_title: 'Accepted institute SEO' },
    });
    expect(release.entities.institutes[0].description).toContain('<p>SQL institute body</p>');
    expect(release.entities.institutes[0].description.match(/Extra institute text/g)).toHaveLength(1);
    expect(release.entities.organizationInfo).toHaveLength(2);
    expect(release.entities.documents.map(({ title }) => title)).toEqual(['First synthetic document', 'Second synthetic document']);
    expect(release.entities.videos?.[0]).toMatchObject({ name: 'Synthetic playlist', slug: 'synthetic-playlist', legacy_id: 'playlist-77' });
    expect(release.provenance).toMatchObject({
      sourceHash,
      acceptedCorpus: { revision: 'accepted-corpus-r1', sha256: corpusHash },
      supplements: [{ sourcePath: 'web/src/pages/synthetic-static.astro', revision: 'accepted-corpus-r1' }],
    });
    expect(release.entities).not.toHaveProperty('provenance');
    expect(input).toEqual(before);
  });

  it('replaces only mapped organization sections, keeps unrelated accepted content and empty anchors, and preserves SQL document order', () => {
    const input = mapped({
      organizationInfo: [
        { sourceId: 601, legacy_id: '601', name: 'Synthetic education section', priority: 2, content: '<p>SQL education replacement</p>' },
        { sourceId: 602, legacy_id: '602', name: 'Synthetic documents section', priority: 1, content: '' },
      ],
      documents: [
        { sourceId: 'pdf-2', fileId: 'pdf-2', bindingSourceId: 702, organizationInfoSourceId: 602, title: 'Second title', priority: 2, originalName: 'two.pdf', extension: 'pdf', fileType: 'application/pdf', url: '/sql/two.pdf' },
        { sourceId: 'pdf-1', fileId: 'pdf-1', bindingSourceId: 701, organizationInfoSourceId: 602, title: 'First title', priority: 1, originalName: 'one.pdf', extension: 'pdf', fileType: 'application/pdf', url: '/sql/one.pdf' },
      ],
    });
    const release = composeSqlDemoRelease(input, supplements(), assets(), decisions());
    const body = release.entities.pages.find(({ slug }) => slug === 'svedeni-synthetic')?.body ?? '';

    expect(body).toContain('id="section-1"');
    expect(body).toContain('id="section-2"');
    expect(body).toContain('SQL education replacement');
    expect(body).not.toContain('Old one');
    expect(body).not.toContain('Old two');
    expect(body.indexOf('First title')).toBeLessThan(body.indexOf('Second title'));
    expect(body).toContain('href="/documents/document-1.pdf"');
    expect(body).toContain('href="/documents/document-2.pdf"');
    expect(body).toContain('id="accepted-unrelated"');
    expect(body).toContain('Unrelated accepted content');
  });

  it.each([
    ['missing mapping', [{ sourceTable: 'OrganizationInfo' as const, sourceId: 601, targetSectionKey: 'education', targetAnchor: 'section-1' }]],
    ['duplicate mapping', [
      { sourceTable: 'OrganizationInfo' as const, sourceId: 601, targetSectionKey: 'education', targetAnchor: 'section-1' },
      { sourceTable: 'OrganizationInfo' as const, sourceId: 601, targetSectionKey: 'education-copy', targetAnchor: 'section-2' },
      { sourceTable: 'OrganizationInfo' as const, sourceId: 602, targetSectionKey: 'documents', targetAnchor: 'section-2' },
    ]],
    ['unused mapping', [
      { sourceTable: 'OrganizationInfo' as const, sourceId: 601, targetSectionKey: 'education', targetAnchor: 'section-1' },
      { sourceTable: 'OrganizationInfo' as const, sourceId: 602, targetSectionKey: 'documents', targetAnchor: 'section-2' },
      { sourceTable: 'OrganizationInfo' as const, sourceId: 699, targetSectionKey: 'unknown', targetAnchor: 'section-9' },
    ]],
  ])('fails preflight on a %s organization section mapping', (_label, organizationSectionTargets) => {
    expect(() => composeSqlDemoRelease(mapped({
      organizationInfo: [
        { sourceId: 601, legacy_id: '601', name: 'Section one', priority: 1, content: 'synthetic one' },
        { sourceId: 602, legacy_id: '602', name: 'Section two', priority: 2, content: 'synthetic two' },
      ],
    }), supplements({ organizationSectionTargets }), assets(), decisions())).toThrow(/OrganizationInfo#(601|602|699)/);
  });

  it('requires byte-verified exact media mapping and separate PDF allowlisting before composing output', () => {
    const invalidImage = assets({ images: [{
      sourceFileId: 'img-1', sourceUrl: '/sql/image-1', targetPublicUrl: '/media/image-1.png',
      sha256: 'not-a-sha256', mimeType: 'image/png', approvalId: 'owner-image-1',
    }] });
    expect(() => composeSqlDemoRelease(mapped(), supplements(), invalidImage, decisions())).toThrow(/img-1.*sha256/i);

    const rasterizedPdf = assets({ documents: [{
      sourceFileId: 'pdf-1', sourceUrl: '/sql/document-1.pdf', targetPublicUrl: '/media/document-1.png',
      sha256: 'e'.repeat(64), mimeType: 'image/png' as unknown as 'application/pdf', approvalId: 'owner-pdf-1',
    }] });
    expect(() => composeSqlDemoRelease(mapped(), supplements(), rasterizedPdf, decisions())).toThrow(/pdf-1.*application\/pdf/i);
  });

  it('requires the owner decision for each source-referenced unlinked public article image', () => {
    const noApproval = decisions({ approvedUnlinkedArticleImages: [] });
    expect(() => composeSqlDemoRelease(mapped({
      articles: [{ sourceId: 901, legacy_id: 'article-901', slug: 'synthetic-article', title: 'Synthetic article', body: '<p><img src="/sql/image-1" /></p>' }],
    }), supplements(), assets(), noApproval)).toThrow(/img-1.*owner decision/i);
  });

  it('turns an explicitly approved unsupported video embed into an exact safe link and records its full source URL privately', () => {
    const sourceUrl = 'https://video.example.test/watch/346?access=synthetic';
    const input = mapped({
      seminars: [{ sourceId: 346, legacy_id: 'seminar-346', slug: 'synthetic-seminar', name: 'Synthetic seminar', full_text: `<p>Before</p><iframe src="${sourceUrl}"></iframe><p>After</p>` }],
    });
    const approval = { sourceId: 346, sourceUrl, approvalId: 'owner-video-346' };
    const release = composeSqlDemoRelease(input, supplements(), assets(), decisions({ externalVideoLinks: [approval] }));

    expect(release.entities.seminars[0].full_text).toContain(`<a href="${sourceUrl}" rel="noopener noreferrer">Открыть видео</a>`);
    expect(release.entities.seminars[0].full_text).not.toContain('<iframe');
    expect(release.provenance.externalVideoLinks).toContainEqual(approval);
    expect(() => composeSqlDemoRelease(input, supplements(), assets(), decisions({ externalVideoLinks: [] }))).toThrow(/Seminars#346.*owner decision/i);
  });
});
