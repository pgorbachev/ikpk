import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SqlPublicContentResult, SqlPublicSource } from './sql-public-content.js';
import {
  normalizeSqlDemoPrivateInputs,
  prepareSqlDemoPrivateInputs,
  SQL_DEMO_PRIVATE_JSON_NAMES,
  type SqlDemoPrivateInputRootConfig,
  type SqlDemoPrivateJsonName,
} from './sql-demo-private-inputs.js';

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const hash = (digit: string): string => digit.repeat(64);
const ACCEPTED_CORPUS_REVISION = '8be955a699493cc9040cd2c63420f7430eff76f7';
const APPLICATION_REVISION = 'ae47f0da834b0b3e102d7cd01ebf62e95ad6d03a';
const ENGINEERING_REVISION = '06e3c64516939e7c0b98eb63c7978425a9aa2f04';
const SYNTHETIC_RUTUBE_URL = 'https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef/?p=synthetic';

const sectionMarkup = [
  '<li id="702"><div data-state="closed"><button class="collapsible_trigger"><h2 data-collapsible-title="true">Synthetic SQL section B</h2></button></div></li>',
  '<li id="555"><div data-state="closed"><button class="collapsible_trigger"><h2 data-collapsible-title="true">Synthetic blank section</h2></button></div></li>',
  '<li id="401"><div data-state="closed"><button class="collapsible_trigger"><h2 data-collapsible-title="true">Synthetic SQL section A</h2></button></div></li>',
].join('');

const pageCorpus = [{
  body_html: `<ul>${sectionMarkup}</ul>`,
  body_text: 'Synthetic static page body',
  images: [],
  legacy_id: 'static-page-synthetic',
  legacy_url: '/synthetic/static-page',
  seo_description: 'Synthetic SEO description',
  seo_title: 'Synthetic SEO title',
  slug: 'static-page-synthetic',
  title: 'Synthetic static page',
}];
const pageCorpusBytes = Buffer.from(JSON.stringify(pageCorpus));
const staticPageSupplement = {
  path: 'synthetic-corpus/static_pages.json',
  revision: ACCEPTED_CORPUS_REVISION,
  role: 'accepted fixed page corpus supplement',
  sha256: sha256(pageCorpusBytes),
  bytes: pageCorpusBytes,
};

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}

function privateDocuments(overrides: Partial<Record<SqlDemoPrivateJsonName, unknown>> = {}) {
  const base: Record<SqlDemoPrivateJsonName, unknown> = {
    'approved-supplements.json': {
      schema_version: 1,
      scope: 'sql-demo-approved-supplements',
      sql_baseline_sha256: hash('a'),
      accepted_corpus_revision: ACCEPTED_CORPUS_REVISION,
      application_candidate_revision: APPLICATION_REVISION,
      fixed_engineering_evidence_revision: ENGINEERING_REVISION,
      supplements: [{
        path: staticPageSupplement.path,
        revision: staticPageSupplement.revision,
        role: staticPageSupplement.role,
        sha256: staticPageSupplement.sha256,
        bytes: pageCorpusBytes.byteLength,
        same_blob_verified_at: '2026-10-12',
      }],
    },
    'reached-media-manifest.json': {
      schema_version: 1,
      scope: 'sql-demo-public-media',
      baseline_sql_sha256: hash('a'),
      archive_sha256: hash('b'),
      existing_content_image_manifest_sha256: hash('c'),
      verified_assets: [
        { source_file_id: 'file-1', archive_relative_path: 'media/file-1.png', sha256: hash('5'), source_file_type: 'image', status: 'active', privacy: 'public', bytes: 12, zip_crc_verified: true, source_extension: 'png', extension_matches_magic: true, magic_class: 'png', mime_type_from_magic: 'image/png', reached_via: 'selected SQL header' },
        { source_file_id: 'file-2', archive_relative_path: 'media/file-2.png', sha256: hash('6'), source_file_type: 'image', status: 'active', privacy: 'public', bytes: 12, zip_crc_verified: true, source_extension: 'png', extension_matches_magic: true, magic_class: 'png', mime_type_from_magic: 'image/png', reached_via: 'selected SQL header' },
        { source_file_id: 'file-3', archive_relative_path: 'media/file-3.png', sha256: hash('7'), source_file_type: 'image', status: 'active', privacy: 'public', bytes: 12, zip_crc_verified: true, source_extension: 'png', extension_matches_magic: true, magic_class: 'png', mime_type_from_magic: 'image/png', reached_via: 'selected SQL header' },
        { source_file_id: 'file-501', archive_relative_path: 'media/file-501.png', sha256: hash('8'), source_file_type: 'image', status: 'active', privacy: 'public', bytes: 12, zip_crc_verified: true, source_extension: 'png', extension_matches_magic: true, magic_class: 'png', mime_type_from_magic: 'image/png', reached_via: 'selected SQL header' },
      ],
      documents: [],
      video_thumbnails: [],
    },
    'article-body-reached-public-unlinked-media.json': {
      schema_version: 1,
      scope: 'article-body-reached-public-unlinked-media',
      baseline_sql_sha256: hash('a'),
      archive_sha256: hash('b'),
      entries: [{
        source_file_id: 'body-granted', archive_relative_path: 'media/body-granted.png', bytes: 12, crc_verified: true,
        declared_extension: 'png', sha256: hash('4'), source_file_type: 'image', source_privacy: 'public', source_status: 'unlinked',
        target_extension_from_magic: 'png', verified_mime: 'image/png', allowlist_class: 'approved body-only article media',
        reachability: 'image reference discovered from active article HTML',
      }],
    },
    'classification-candidates.json': {
      schemaVersion: 1,
      artifactKind: 'classification-candidates',
      status: 'candidate',
      teachers: [{ sourceTeacherId: 101, candidateTrait: 'teacher', confidence: 'high', evidence: ['synthetic evidence'], primaryApproval: 'pending' }],
      programs: [{ sourceProgramId: 501, isArticleCategory: true, status: 'candidate' }],
      articles: [{ sourceArticleId: 301, sourceProgramIds: [501], confidence: 'medium', evidence: ['synthetic evidence'], primaryApproval: 'pending' }],
    },
    'public-schema-inventory.json': { schema_version: 1, scope: 'public-schema-inventory', tables: [] },
    'content-media-manifest.json': {
      schema_version: 1,
      scope: 'content-media',
      baseline_sha256: hash('a'),
      archive_sha256: hash('b'),
      canonical_format: 'synthetic-canonical-v1',
      canonical_sha256: hash('c'),
      entries: [],
      unresolved: [],
    },
    'demo-owner-decisions.json': {
      schemaVersion: 1,
      decisionDate: '2026-10-12',
      decisionScope: 'synthetic demo import only',
      sourceEvidence: {
        archiveSha256: hash('b'),
        candidateFile: 'synthetic-candidates.json',
        candidateFileSha256: hash('d'),
        mediaEvidenceFile: 'synthetic-media.json',
        mediaEvidenceFileSha256: hash('e'),
        sourceSqlSha256: hash('a'),
      },
      ownerDecision: {
        demoWriteOrImportAuthorization: true,
        demoWriteOrImportScope: 'synthetic demo import',
        deploymentSubjectToTechnicalReleaseGates: true,
        productionAcceptance: false,
        source: { productionAcceptance: false },
        media: { productionAcceptance: false, otherUnlinkedFilesApproved: false },
        classification: { productionAcceptance: false },
      },
      classifications: {
        status: 'approved-for-demo',
        confidenceAndEvidenceRemainAsCandidateValues: true,
        productionAcceptance: false,
        people: [{
          sourceTeacherId: 101, candidateTrait: 'teacher', confidence: 'high', evidence: ['synthetic evidence'],
          demoProvisionalApproved: true, candidatePrimaryApprovalUnchanged: 'pending', productionAcceptance: false,
        }],
        articles: [{
          sourceArticleId: 301, sourceProgramIds: [501], confidence: 'medium', evidence: ['synthetic evidence'],
          demoProvisionalApproved: true, candidatePrimaryApprovalUnchanged: 'pending', productionAcceptance: false,
        }],
      },
      mediaAllowlist: {
        status: 'approved-for-demo',
        allowlistOnly: true,
        wildcard: false,
        exactIdentityCount: 1,
        allEntriesReachableFromActiveArticleHtml: true,
        allSourceEntriesArePublicAndUnlinked: true,
        allCrcSizeAndSha256ChecksVerified: true,
        otherUnlinkedFilesApproved: false,
        entries: [{
          sourceFileId: 'body-granted', sourceSha256: hash('4'), demoApproved: true,
          verifiedMime: 'image/png', approvedExtension: 'png', sourceBytes: 12,
        }],
      },
    },
    'video-source-reference-decisions.json': {
      schema_version: 1,
      scope: 'approved SQL video source reference decisions',
      source_reference_count: 0,
      canonicalized_same_host_embed_count: 0,
      external_safe_link_count: 0,
      owner_decision_date: '2026-10-12',
      owner_decision_summary: 'Synthetic empty decision set',
      target_rel: 'noopener noreferrer',
      records: [],
    },
  };
  return Object.fromEntries(SQL_DEMO_PRIVATE_JSON_NAMES.map((name) => {
    const bytes = jsonBytes(overrides[name] ?? base[name]);
    return [name, { bytes, expectedSha256: sha256(bytes) }];
  })) as SqlDemoPrivateInputRootConfig['privateJson'];
}

function config(overrides: Partial<SqlDemoPrivateInputRootConfig> = {}): SqlDemoPrivateInputRootConfig {
  return {
    baseline: { sqlSha256: hash('a'), archiveSha256: hash('b') },
    roots: { assetRoot: '/synthetic/assets', supplementRoot: '/synthetic/supplements' },
    acceptedLegacyIds: {
      Institutes: { 1: 'institute-1', 2: 'institute-2', 3: 'institute-3' },
      Programs: { 501: 'program-501' }, Seminars: { 900: 'seminar-900' },
      Teachers: { 101: 'teacher-101' }, Articles: { 301: 'article-301' },
    },
    privateJson: privateDocuments(),
    supplementBlobs: [{
      path: staticPageSupplement.path, revision: staticPageSupplement.revision,
      sha256: staticPageSupplement.sha256, bytes: staticPageSupplement.bytes,
    }],
    ...overrides,
  };
}

const createdAt = '2026-01-01 00:00:00';
const updatedAt = '2026-01-01 00:00:00';
const file = (id: string, fileType: 'image' | 'document', status: string, privacy: string, url: string, extension: string) => ({
  id, fileType, originalName: `${id}.${extension}`, extension, url, status, privacy, createdAt, updatedAt,
});

const source: SqlPublicSource = {
  sourceHash: `sha256:${hash('a')}`,
  Institutes: [
    { id: 1, name: 'Synthetic institute one', shortName: null, description: 'Synthetic', imageId: 'file-1' },
    { id: 2, name: 'Synthetic institute two', shortName: null, description: 'Synthetic', imageId: 'file-2' },
    { id: 3, name: 'Synthetic institute three', shortName: null, description: 'Synthetic', imageId: 'file-3' },
  ],
  Programs: [{ id: 501, status: 'active', name: 'Synthetic program', slug: 'program-501', instituteId: 1, priority: 1, seoTitle: 'Program', seoDescription: 'Synthetic', content: null, imageId: 'file-501' }],
  Seminars: [{ id: 900, status: 'active', name: 'Synthetic seminar', slug: 'seminar-900', programId: 501, description: `<iframe src="${SYNTHETIC_RUTUBE_URL}"></iframe>`, curriculum: null, targetAudience: null, learningProcess: null, certificates: null, recommendations: null, priority: 1, seoTitle: 'Seminar', seoDescription: 'Synthetic' }],
  Teachers: [{ id: 101, status: 'active', fullName: 'Synthetic teacher', description: 'Synthetic', imageId: null, priority: 1 }],
  TeachersAndInstitutes: [], SeminarsTeacher: [], Events: [], EventsAndTeachers: [],
  Articles: [{ id: 301, status: 'active', name: 'Synthetic article', imageId: null, content: '<p><img src="/synthetic/body-granted.png"></p>', author: 'Synthetic', priority: 1, seoTitle: 'Article', seoDescription: 'Synthetic', slug: 'article-301', createdAt: '2026-01-01', updatedAt: '2026-01-02' }],
  Files: [
    file('file-1', 'image', 'active', 'public', '/synthetic/file-1.png', 'png'),
    file('file-2', 'image', 'active', 'public', '/synthetic/file-2.png', 'png'),
    file('file-3', 'image', 'active', 'public', '/synthetic/file-3.png', 'png'),
    file('file-501', 'image', 'active', 'public', '/synthetic/file-501.png', 'png'),
    file('file-unselected', 'image', 'active', 'public', '/synthetic/unselected.png', 'png'),
    file('body-granted', 'image', 'unlinked', 'public', '/synthetic/body-granted.png', 'png'),
    file('other-unlinked', 'image', 'unlinked', 'public', '/synthetic/other.png', 'png'),
    file('f-shared', 'image', 'active', 'public', '/synthetic/shared.png', 'png'),
    file('f-body', 'image', 'unlinked', 'public', '/synthetic/body.webp', 'webp'),
    file('pdf-1', 'document', 'active', 'public', '/synthetic/one.pdf', 'pdf'),
    file('thumb-1', 'image', 'active', 'public', '/synthetic/thumb.jpg', 'jpg'),
  ],
  OrganizationInfo: [
    { id: 702, name: 'Synthetic SQL section B', priority: 10, content: '<p>SQL B</p>', status: 'active', createdAt, updatedAt },
    { id: 401, name: 'Synthetic SQL section A', priority: 20, content: '<p>SQL A</p>', status: 'active', createdAt, updatedAt },
  ],
  FileBindingOrganizationInfo: [{ id: 801, title: 'Synthetic PDF', priority: 1, fileId: 'pdf-1', organizationInfoId: 702, createdAt, updatedAt }],
  Videos: [{ id: 77, name: 'Synthetic video', link: '/synthetic/video', status: 'active', priority: 1, imageId: 'thumb-1', createdAt, updatedAt }],
};

const mapped: SqlPublicContentResult = {
  entities: {
    institutes: [1, 2, 3].map((sourceId) => ({ sourceId, legacy_id: `institute-${sourceId}`, slug: `institute-${sourceId}`, imageId: `file-${sourceId}` })),
    programs: [{ sourceId: 501, legacy_id: 'program-501', slug: 'program-501', instituteId: 1, imageId: 'file-501' }],
    seminars: [{ sourceId: 900, legacy_id: 'seminar-900', slug: 'seminar-900', name: 'Synthetic seminar', description: `<iframe src="${SYNTHETIC_RUTUBE_URL}"></iframe>` }],
    teachers: [{ sourceId: 101, legacy_id: 'teacher-101', slug: 'teacher-101' }],
    events: [],
    articles: [{ sourceId: 301, legacy_id: 'article-301', slug: 'article-301', body: '<p><img src="/synthetic/body-granted.png"></p>' }],
    news: [], promotions: [], videos: [], organizationInfo: [
      { sourceId: 702, legacy_id: '702', name: 'Synthetic SQL section B', priority: 10, content: '<p>SQL B</p>' },
      { sourceId: 401, legacy_id: '401', name: 'Synthetic SQL section A', priority: 20, content: '<p>SQL A</p>' },
    ],
    documents: [{ sourceId: 'pdf-1', fileId: 'pdf-1', bindingSourceId: 801, organizationInfoSourceId: 702, title: 'Synthetic PDF', priority: 1, originalName: 'pdf-1.pdf', extension: 'pdf', fileType: 'application/pdf', url: '/synthetic/one.pdf' }],
    instituteAdditionalInfo: [],
  },
  provenance: {
    sourceHash: `sha256:${hash('a')}`, sourceIdentity: [], videoMetadata: [], exclusions: [], rejectedRelations: [],
    classificationCandidates: [
      { table: 'Teachers', sourceId: 101, targetLegacyId: 'teacher-101', value: 'teacher', approval: 'pending' },
      { table: 'Articles', sourceId: 301, sourceProgramId: 501, targetLegacyId: 'article-301', approval: 'pending' },
    ], sourceMetadata: [],
  },
};

const proof = (sourceFileId: string, path: string, digest: string, sourceFileType: 'image' | 'document', extra: Record<string, unknown> = {}) => ({
  source_file_id: sourceFileId,
  archive_relative_path: path,
  sha256: digest,
  source_file_type: sourceFileType,
  status: 'active',
  privacy: 'public',
  bytes: 12,
  zip_crc_verified: true,
  source_extension: sourceFileType === 'document' ? 'pdf' : 'png',
  extension_matches_magic: true,
  magic_class: sourceFileType === 'document' ? 'pdf' : 'png',
  mime_type_from_magic: sourceFileType === 'document' ? 'application/pdf' : 'image/png',
  reached_via: ['synthetic SQL identity'],
  ...extra,
});

function normalize(overrides: Partial<Parameters<typeof normalizeSqlDemoPrivateInputs>[0]> = {}) {
  const currentConfig = overrides.config ?? config();
  const mapperOptions = prepareSqlDemoPrivateInputs(currentConfig);
  return normalizeSqlDemoPrivateInputs({ config: currentConfig, mapperOptions, nativeSqlPublicSource: source, mapped, ...overrides });
}

describe('SQL demo private input preparation and normalization', () => {
  it('checks every pinned raw JSON digest before attempting to parse any file', () => {
    const input = config();
    const firstBytes = Buffer.from('{ malformed json');
    input.privateJson['approved-supplements.json'] = { bytes: firstBytes, expectedSha256: sha256(firstBytes) };
    input.privateJson['classification-candidates.json'] = { bytes: Buffer.from('{ also malformed'), expectedSha256: hash('1') };

    expect(() => prepareSqlDemoPrivateInputs(input)).toThrow(/classification-candidates\.json.*sha-?256/i);
  });

  it('rejects changed pinned Git blob bytes at the accepted corpus revision', () => {
    const input = config();
    input.supplementBlobs[0] = { ...input.supplementBlobs[0]!, bytes: Buffer.from('changed pinned page corpus') };
    expect(() => prepareSqlDemoPrivateInputs(input)).toThrow(/synthetic-corpus\/static_pages\.json.*(hash|sha-?256|blob)/i);
  });

  it('requires native SQL, baseline, archive, and manifest pins to agree', () => {
    const input = config();
    const documents = JSON.parse(Buffer.from(input.privateJson['reached-media-manifest.json'].bytes).toString()) as Record<string, unknown>;
    documents.archive_sha256 = hash('d');
    const bytes = jsonBytes(documents);
    input.privateJson['reached-media-manifest.json'] = { bytes, expectedSha256: sha256(bytes) };
    expect(() => normalize({ config: input })).toThrow(/archive.*(identity|hash|pin)/i);

    const wrongSource = { ...source, sourceHash: `sha256:${hash('e')}` };
    expect(() => normalize({ nativeSqlPublicSource: wrongSource })).toThrow(/SQL.*(identity|hash|pin)/i);
  });

  it('merges existing, reached, and body-reached manifests by file ID and joins document and thumbnail metadata to byte proofs', () => {
    const input = config({ privateJson: privateDocuments({
      'content-media-manifest.json': {
        schema_version: 1, scope: 'content-media', baseline_sha256: hash('a'), archive_sha256: hash('b'), canonical_format: 'synthetic-canonical-v1', canonical_sha256: hash('c'),
        entries: [{ legacy_file_id: 'f-shared', archive_relative_path: 'media/shared.png', bytes: 12, crc_verified: true, sha256: hash('1') }], unresolved: [],
      },
      'reached-media-manifest.json': {
        schema_version: 1, scope: 'sql-demo-public-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'), existing_content_image_manifest_sha256: hash('c'),
        verified_assets: [
          proof('file-1', 'media/one.png', hash('5'), 'image'), proof('file-2', 'media/two.png', hash('6'), 'image'),
          proof('file-3', 'media/three.png', hash('7'), 'image'), proof('file-501', 'media/program.png', hash('8'), 'image'),
          proof('f-shared', 'media/shared.png', hash('1'), 'image'),
          proof('pdf-1', 'docs/one.pdf', hash('2'), 'document'), proof('thumb-1', 'media/thumb.jpg', hash('3'), 'image'),
        ],
        documents: [{ binding_id: 801, organization_info_id: 702, priority: 1, section_name: 'Synthetic SQL section B', source_file_id: 'pdf-1', target_media_id: 'synthetic-target-pdf', target_status: 'active', title: 'Synthetic PDF' }],
        video_thumbnails: [{ source_file_id: 'thumb-1', source_video_id: 77, source_video_name: 'Synthetic video', target_media_id: 'synthetic-target-thumb', target_status: 'active' }],
      },
      'article-body-reached-public-unlinked-media.json': {
        schema_version: 1, scope: 'article-body-reached-public-unlinked-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'),
        entries: [
          { source_file_id: 'body-granted', archive_relative_path: 'media/body-granted.png', bytes: 12, crc_verified: true, declared_extension: 'png', sha256: hash('4'), source_file_type: 'image', source_privacy: 'public', source_status: 'unlinked', target_extension_from_magic: 'png', verified_mime: 'image/png', allowlist_class: 'approved body-only article media', reachability: 'image reference discovered from active article HTML' },
        ],
      },
    }) });
    const sourceWithSelectedTeacherImage = {
      ...source,
      Teachers: source.Teachers.map((teacher) => ({ ...teacher, imageId: 'f-shared' })),
    };
    const mappedWithSelectedTeacherImage = {
      ...mapped,
      entities: {
        ...mapped.entities,
        teachers: mapped.entities.teachers.map((teacher) => ({ ...teacher, imageId: 'f-shared' })),
      },
    };
    const result = normalize({ config: input, nativeSqlPublicSource: sourceWithSelectedTeacherImage, mapped: mappedWithSelectedTeacherImage });
    const entries = (result.loader.assetManifest as { entries: { sourceFileId: string }[] }).entries;
    expect(entries.map((entry) => entry.sourceFileId).sort()).toEqual(['body-granted', 'f-shared', 'file-1', 'file-2', 'file-3', 'file-501', 'pdf-1', 'thumb-1']);
    expect(entries).toHaveLength(8);
    expect(entries.filter((entry) => entry.sourceFileId === 'f-shared')).toHaveLength(1);
    expect(entries.map((entry) => entry.sourceFileId)).not.toContain('f-body');
  });

  it.each([
    ['digest', { sha256: hash('9') }],
    ['path', { archive_relative_path: 'media/other.png' }],
    ['status', { status: 'disabled' }],
    ['privacy', { privacy: 'private' }],
  ])('rejects an identity collision against the native or accepted manifest on %s', (_field, change) => {
    const input = config({ privateJson: privateDocuments({
      'content-media-manifest.json': {
        schema_version: 1, scope: 'content-media', baseline_sha256: hash('a'), archive_sha256: hash('b'), canonical_format: 'synthetic-canonical-v1', canonical_sha256: hash('c'),
        entries: [{ legacy_file_id: 'f-shared', archive_relative_path: 'media/shared.png', bytes: 12, crc_verified: true, sha256: hash('1') }], unresolved: [],
      },
      'reached-media-manifest.json': {
        schema_version: 1, scope: 'sql-demo-public-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'), existing_content_image_manifest_sha256: hash('c'),
        verified_assets: [proof('f-shared', 'media/shared.png', hash('1'), 'image', change)], documents: [], video_thumbnails: [],
      },
      'article-body-reached-public-unlinked-media.json': {
        schema_version: 1, scope: 'article-body-reached-public-unlinked-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'), entries: [{
          source_file_id: 'body-granted', archive_relative_path: 'media/body-granted.png', bytes: 12, crc_verified: true, declared_extension: 'png', sha256: hash('4'), source_file_type: 'image', source_privacy: 'public', source_status: 'unlinked', target_extension_from_magic: 'png', verified_mime: 'image/png', allowlist_class: 'approved body-only article media', reachability: 'active article HTML image reference',
        }],
      },
    }) });
    expect(() => normalize({ config: input })).toThrow(/f-shared.*(collision|conflict|differ|mismatch)/i);
  });

  it('omits unrelated unlinked source files rather than treating their presence as an invalid grant', () => {
    const result = normalize();
    const entries = (result.loader.assetManifest as { entries: { sourceFileId: string }[] }).entries;
    expect(entries.map((entry) => entry.sourceFileId)).not.toContain('other-unlinked');
    expect(result.loader.approvedBodyFileGrants.map((grant) => grant.sourceFileId)).toEqual(['body-granted']);
  });

  it('rejects an active article image request that lacks its exact owner file and hash grant', () => {
    const withUnapprovedImage = {
      ...source,
      Articles: source.Articles.map((article) => ({ ...article, content: `${article.content}<img src="/synthetic/other.png">` })),
    };
    const input = config({ privateJson: privateDocuments({
      'article-body-reached-public-unlinked-media.json': {
        schema_version: 1, scope: 'article-body-reached-public-unlinked-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'),
        entries: [
          { source_file_id: 'body-granted', archive_relative_path: 'media/body.png', bytes: 12, crc_verified: true, declared_extension: 'png', sha256: hash('4'), source_file_type: 'image', source_privacy: 'public', source_status: 'unlinked', target_extension_from_magic: 'png', verified_mime: 'image/png', allowlist_class: 'synthetic', reachability: 'active article HTML image reference' },
          { source_file_id: 'other-unlinked', archive_relative_path: 'media/other.png', bytes: 12, crc_verified: true, declared_extension: 'png', sha256: hash('5'), source_file_type: 'image', source_privacy: 'public', source_status: 'unlinked', target_extension_from_magic: 'png', verified_mime: 'image/png', allowlist_class: 'synthetic', reachability: 'active article HTML image reference' },
        ],
      },
    }) });
    const mappedWithUnapprovedImage = {
      ...mapped,
      entities: { ...mapped.entities, articles: mapped.entities.articles.map((article) => ({ ...article, body: `${article.body}<img src="/synthetic/other.png">` })) },
    };
    expect(() => normalize({ config: input, nativeSqlPublicSource: withUnapprovedImage, mapped: mappedWithUnapprovedImage })).toThrow(/other-unlinked.*(grant|allowlist|approval)/i);
  });

  it('rejects a body-file grant whose pinned digest differs from the reached source file', () => {
    const ownerBytes = Buffer.from(config().privateJson['demo-owner-decisions.json'].bytes);
    const owner = JSON.parse(ownerBytes.toString()) as { mediaAllowlist: { entries: { sourceFileId: string; sourceSha256: string }[] } };
    owner.mediaAllowlist.entries[0]!.sourceSha256 = hash('9');
    const input = config({ privateJson: privateDocuments({ 'demo-owner-decisions.json': owner }) });
    expect(() => normalize({ config: input })).toThrow(/body-granted.*(hash|sha-?256|grant)/i);
  });

  it('keeps demo provisional classification separate from pending primary approval and production acceptance', () => {
    const input = config();
    const beforeCandidates = Buffer.from(input.privateJson['classification-candidates.json'].bytes);
    const result = normalize({ config: input });
    expect(result.mapperOptions.classificationCandidates).toMatchObject({
      teachers: [{ sourceId: 101, trait: 'teacher' }], articles: [{ sourceId: 301, sourceProgramIds: [501] }],
    });
    expect(result.materializer).toMatchObject({
      status: 'pending-confirmation', teachers: [{ sourceId: 101, trait: 'teacher' }],
      articles: [{ sourceId: 301, sourceProgramIds: [501] }],
    });
    expect(mapped.provenance.classificationCandidates.every((candidate) => candidate.approval === 'pending')).toBe(true);
    expect(input.privateJson['classification-candidates.json'].bytes).toEqual(beforeCandidates);

    const missingActive = { ...source, Teachers: [...source.Teachers, { id: 102, status: 'active', fullName: 'Synthetic active teacher', description: '', imageId: null, priority: 2 }] };
    expect(() => normalize({ nativeSqlPublicSource: missingActive })).toThrow(/Teachers#102.*(classification|coverage)/i);
    const extra = config({ privateJson: privateDocuments({
      'classification-candidates.json': {
        schemaVersion: 1, artifactKind: 'classification-candidates', status: 'candidate',
        teachers: [{ sourceTeacherId: 101, candidateTrait: 'teacher', confidence: 'high', evidence: ['synthetic'], primaryApproval: 'pending' }, { sourceTeacherId: 999, candidateTrait: 'method-author', confidence: 'low', evidence: ['synthetic'], primaryApproval: 'pending' }],
        programs: [{ sourceProgramId: 501, isArticleCategory: true, status: 'candidate' }],
        articles: [{ sourceArticleId: 301, sourceProgramIds: [501], confidence: 'medium', evidence: ['synthetic'], primaryApproval: 'pending' }],
      },
    }) });
    expect(() => normalize({ config: extra })).toThrow(/Teachers#999.*(active|classification|coverage)/i);
  });

  it('requires classification program IDs to match active source programs', () => {
    const unknownProgram = config({ privateJson: privateDocuments({
      'classification-candidates.json': {
        schemaVersion: 1, artifactKind: 'classification-candidates', status: 'candidate',
        teachers: [{ sourceTeacherId: 101, candidateTrait: 'teacher', confidence: 'high', evidence: ['synthetic'], primaryApproval: 'pending' }],
        programs: [{ sourceProgramId: 501, isArticleCategory: true, status: 'candidate' }, { sourceProgramId: 999, isArticleCategory: false, status: 'candidate' }],
        articles: [{ sourceArticleId: 301, sourceProgramIds: [501], confidence: 'medium', evidence: ['synthetic'], primaryApproval: 'pending' }],
      },
    }) });
    expect(() => normalize({ config: unknownProgram })).toThrow(/Programs#999.*(active|classification|coverage)/i);
  });

  it('derives selected header references only from mapper entities and the same provenance source hash', () => {
    const result = normalize();
    expect(result.loader.selectedPublicHeaders).toEqual({
      sourceHash: hash('a'),
      references: [
        { sourceTable: 'Institutes', sourceId: 1, imageId: 'file-1' },
        { sourceTable: 'Institutes', sourceId: 2, imageId: 'file-2' },
        { sourceTable: 'Institutes', sourceId: 3, imageId: 'file-3' },
        { sourceTable: 'Programs', sourceId: 501, imageId: 'file-501' },
      ],
    });
    expect(result.loader.source.sourceHash).toBe(hash('a'));
    expect(source.sourceHash).toBe(`sha256:${hash('a')}`);
    expect(mapped.provenance.sourceHash).toBe(`sha256:${hash('a')}`);
    expect(JSON.stringify(result.loader.selectedPublicHeaders)).not.toContain('file-unselected');
  });

  it('rejects mapper provenance from a different SQL source before selecting asset headers', () => {
    const wrongMapperResult = { ...mapped, provenance: { ...mapped.provenance, sourceHash: `sha256:${hash('f')}` } };
    expect(() => normalize({ mapped: wrongMapperResult })).toThrow(/mapper.*source hash/i);
  });

  it('normalizes the pinned page DTO and maps organization IDs to exact DOM positions, counting a blank panel', () => {
    const result = normalize();
    expect(result.composer.acceptedSupplements.pages).toEqual([{
      sourcePath: 'synthetic-corpus/static_pages.json',
      revision: ACCEPTED_CORPUS_REVISION,
      sha256: sha256(pageCorpusBytes),
      page: {
        title: 'Synthetic static page', slug: 'static-page-synthetic', legacy_id: 'static-page-synthetic',
        body: `<ul>${sectionMarkup}</ul>`,
        seo: { seo_title: 'Synthetic SEO title', seo_description: 'Synthetic SEO description' },
      },
    }]);
    const locations = result.composer.acceptedSupplements.targetLocations.filter((location) => location.sourceTable === 'OrganizationInfo');
    expect(locations.map(({ sourceId, anchor }) => ({ sourceId, anchor }))).toEqual([
      { sourceId: 702, anchor: 'section-1' }, { sourceId: 401, anchor: 'section-3' },
    ]);
  });

  it('normalizes one pinned Seminars.description video decision while preserving the query string', () => {
    const decisionFile = {
      schema_version: 1,
      scope: 'approved SQL video source reference decisions',
      source_reference_count: 1,
      canonicalized_same_host_embed_count: 1,
      external_safe_link_count: 0,
      owner_decision_date: '2026-10-12',
      owner_decision_summary: 'Synthetic single source-reference decision',
      target_rel: 'noopener noreferrer',
      records: [{
        decision: 'external-link',
        link_text: 'Synthetic video',
        safe_target_href: SYNTHETIC_RUTUBE_URL,
        source_id: 900,
        source_slug: 'seminar-900',
        source_table: 'Seminars',
        source_url: SYNTHETIC_RUTUBE_URL,
        target_rel: 'noopener noreferrer',
      }],
    };
    const input = config({ privateJson: privateDocuments({ 'video-source-reference-decisions.json': decisionFile }) });
    const result = normalize({ config: input });

    expect(result.composer.ownerDecisions.videoReferences).toEqual([{
      sourceTable: 'Seminars',
      sourceId: 900,
      field: 'description',
      originalURL: SYNTHETIC_RUTUBE_URL,
      action: 'external-link',
      expectedOutput: `<a href="${SYNTHETIC_RUTUBE_URL}" rel="noopener noreferrer">Открыть видео</a>`,
    }]);
  });

  it('rejects document binding metadata without a matching verified byte proof', () => {
    const input = config({ privateJson: privateDocuments({
      'reached-media-manifest.json': {
        schema_version: 1, scope: 'sql-demo-public-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'), existing_content_image_manifest_sha256: hash('c'),
        verified_assets: [],
        documents: [{ binding_id: 801, organization_info_id: 702, priority: 1, section_name: 'Synthetic SQL section B', source_file_id: 'pdf-1', target_media_id: 'synthetic-target-pdf', target_status: 'active', title: 'Synthetic PDF' }],
        video_thumbnails: [],
      },
    }) });
    expect(() => normalize({ config: input })).toThrow(/pdf-1.*(byte|proof|verified)/i);
  });
});
