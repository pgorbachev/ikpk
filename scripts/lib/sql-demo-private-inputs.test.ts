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

const supplements = [
  { path: 'public/static-a.json', revision: '8be955a699493cc9040cd2c63420f7430eff76f7', role: 'public-static-page' },
  { path: 'public/static-b.json', revision: 'ae47f0da834b0b3e102d7cd01ebf62e95ad6d03a', role: 'public-static-page' },
  { path: 'engineering/accepted.json', revision: '06e3c64516939e7c0b98eb63c7978425a9aa2f04', role: 'public-static-page' },
].map((entry, index) => {
  const bytes = Buffer.from(`synthetic supplement ${index}`);
  return { ...entry, sha256: sha256(bytes), bytes };
});

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}

function privateDocuments(overrides: Partial<Record<SqlDemoPrivateJsonName, unknown>> = {}) {
  const base: Record<SqlDemoPrivateJsonName, unknown> = {
    'approved-supplements.json': {
      schema_version: 1, scope: 'sql-demo-approved-supplements', sql_baseline_sha256: hash('a'),
      accepted_corpus_revision: 'synthetic-corpus-r1', application_candidate_revision: 'synthetic-app-r1',
      fixed_engineering_evidence_revision: 'synthetic-eng-r1',
      supplements: supplements.map(({ path, revision, sha256, role, bytes }) => ({ path, revision, sha256, role, bytes: bytes.byteLength })),
    },
    'reached-media-manifest.json': {
      schema_version: 1, scope: 'sql-demo-public-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'),
      existing_content_image_manifest_sha256: hash('c'), verified_assets: [], documents: [], video_thumbnails: [],
    },
    'article-body-reached-public-unlinked-media.json': {
      schema_version: 1, scope: 'article-body-reached-public-unlinked-media', baseline_sql_sha256: hash('a'),
      archive_sha256: hash('b'), entries: [],
    },
    'classification-candidates.json': {
      schemaVersion: 1, artifactKind: 'classification-candidates', status: 'candidate',
      teachers: [{ sourceTeacherId: 101, candidateTrait: 'teacher', confidence: 'high', primaryApproval: 'pending' }],
      programs: [{ sourceProgramId: 501, isArticleCategory: true, status: 'candidate' }],
      articles: [{ sourceArticleId: 301, sourceProgramIds: [501], confidence: 'medium', primaryApproval: 'pending' }],
    },
    'public-schema-inventory.json': { schema_version: 1, scope: 'public-schema-inventory', tables: [] },
    'content-media-manifest.json': {
      schema_version: 1, scope: 'content-media', baseline_sha256: hash('a'), archive_sha256: hash('b'), entries: [], unresolved: [],
    },
    'demo-owner-decisions.json': {
      schemaVersion: 1, decisionScope: 'synthetic-demo-only',
      classifications: { status: 'approved-for-demo', people: [], articles: [], confidenceAndEvidenceRemainAsCandidateValues: true },
      mediaAllowlist: { status: 'approved-for-demo', allowlistOnly: true, wildcard: false, entries: [] },
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
      Institutes: { 11: 'institute-11' }, Programs: { 501: 'program-501' },
      Teachers: { 101: 'teacher-101' }, Articles: { 301: 'article-301' },
    },
    privateJson: privateDocuments(),
    supplementBlobs: supplements.map(({ path, revision, sha256: digest, bytes }) => ({ path, revision, sha256: digest, bytes })),
    ...overrides,
  };
}

const source: SqlPublicSource = {
  sourceHash: `sha256:${hash('a')}`,
  Institutes: [{ id: 11, name: 'Synthetic institute', shortName: null, description: 'Synthetic', imageId: 'file-11' }],
  Programs: [{ id: 501, status: 'active', name: 'Synthetic program', slug: 'program-501', instituteId: 11, priority: 1, seoTitle: 'Program', seoDescription: 'Synthetic', content: null, imageId: 'file-501' }],
  Seminars: [],
  Teachers: [{ id: 101, status: 'active', fullName: 'Synthetic teacher', description: 'Synthetic', imageId: null, priority: 1 }],
  TeachersAndInstitutes: [], SeminarsTeacher: [], Events: [], EventsAndTeachers: [],
  Articles: [{ id: 301, status: 'active', name: 'Synthetic article', imageId: null, content: 'Synthetic', author: 'Synthetic', priority: 1, seoTitle: 'Article', seoDescription: 'Synthetic', slug: 'article-301', createdAt: '2026-01-01', updatedAt: '2026-01-02' }],
  Files: [
    { id: 'file-11', fileType: 'image/png', originalName: 'a.png', extension: 'png', url: '/synthetic/a.png', status: 'active', privacy: 'public', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' },
    { id: 'file-501', fileType: 'image/png', originalName: 'b.png', extension: 'png', url: '/synthetic/b.png', status: 'active', privacy: 'public', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' },
    { id: 'file-unselected', fileType: 'image/png', originalName: 'c.png', extension: 'png', url: '/synthetic/c.png', status: 'active', privacy: 'public', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' },
  ],
};

const mapped: SqlPublicContentResult = {
  entities: {
    institutes: [{ sourceId: 11, legacy_id: 'institute-11', slug: 'institute-11', imageId: 'file-11' }],
    programs: [{ sourceId: 501, legacy_id: 'program-501', slug: 'program-501', instituteId: 11, imageId: 'file-501' }],
    seminars: [], teachers: [{ sourceId: 101, legacy_id: 'teacher-101', slug: 'teacher-101' }], events: [],
    articles: [{ sourceId: 301, legacy_id: 'article-301', slug: 'article-301' }],
    news: [], promotions: [], videos: [], organizationInfo: [], documents: [], instituteAdditionalInfo: [],
  },
  provenance: {
    sourceHash: `sha256:${hash('a')}`, sourceIdentity: [], videoMetadata: [], exclusions: [], rejectedRelations: [],
    classificationCandidates: [
      { table: 'Teachers', sourceId: 101, targetLegacyId: 'teacher-101', value: 'teacher', approval: 'pending' },
      { table: 'Articles', sourceId: 301, sourceProgramId: 501, targetLegacyId: 'article-301', approval: 'pending' },
    ],
    sourceMetadata: [],
  },
};

function normalize(overrides: Partial<Parameters<typeof normalizeSqlDemoPrivateInputs>[0]> = {}) {
  const currentConfig = config();
  const mapperOptions = prepareSqlDemoPrivateInputs(currentConfig);
  return normalizeSqlDemoPrivateInputs({ config: currentConfig, mapperOptions, nativeSqlPublicSource: source, mapped, ...overrides });
}

describe('SQL demo private input preparation and normalization', () => {
  it('checks every pinned raw JSON digest before attempting to parse any file', () => {
    const input = config();
    input.privateJson['approved-supplements.json'] = {
      bytes: Buffer.from('{ malformed json'), expectedSha256: sha256(Buffer.from('{ malformed json')),
    };
    input.privateJson['classification-candidates.json'] = {
      bytes: Buffer.from('{ also malformed'), expectedSha256: hash('1'),
    };

    expect(() => prepareSqlDemoPrivateInputs(input)).toThrow(/classification-candidates\.json.*sha-?256/i);
  });

  it('rejects a changed supplement Git blob even when its manifest path and revision still match', () => {
    const input = config();
    input.supplementBlobs[0] = { ...input.supplementBlobs[0]!, bytes: Buffer.from('changed blob') };
    expect(() => prepareSqlDemoPrivateInputs(input)).toThrow(/public\/static-a\.json.*(hash|sha-?256|blob)/i);
  });

  it('requires the native SQL source and every private manifest to share the pinned SQL and archive identities', () => {
    const input = config();
    const docs = JSON.parse(Buffer.from(input.privateJson['reached-media-manifest.json'].bytes).toString()) as Record<string, unknown>;
    docs.archive_sha256 = hash('d');
    const bytes = jsonBytes(docs);
    input.privateJson['reached-media-manifest.json'] = { bytes, expectedSha256: sha256(bytes) };
    expect(() => normalize({ config: input })).toThrow(/archive.*(identity|hash|pin)/i);

    const wrongSource = { ...source, sourceHash: `sha256:${hash('e')}` };
    expect(() => normalize({ nativeSqlPublicSource: wrongSource })).toThrow(/SQL.*(identity|hash|pin)/i);
  });

  it('merges existing, reached-media, and article-body entries by source file identity', () => {
    const input = config({ privateJson: privateDocuments({
      'content-media-manifest.json': {
        schema_version: 1, scope: 'content-media', baseline_sha256: hash('a'), archive_sha256: hash('b'),
        entries: [{ legacy_file_id: 'f-shared', archive_relative_path: 'media/shared.png', sha256: hash('1') }], unresolved: [],
      },
      'reached-media-manifest.json': {
        schema_version: 1, scope: 'sql-demo-public-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'),
        existing_content_image_manifest_sha256: hash('c'),
        verified_assets: [{ source_file_id: 'f-shared', archive_relative_path: 'media/shared.png', sha256: hash('1'), status: 'active', privacy: 'public', source_file_type: 'image' }],
        documents: [{ source_file_id: 'pdf-1', archive_relative_path: 'docs/one.pdf', sha256: hash('2'), target_status: 'active' }],
        video_thumbnails: [{ source_file_id: 'thumb-1', archive_relative_path: 'media/thumb.jpg', sha256: hash('3'), target_status: 'active' }],
      },
      'article-body-reached-public-unlinked-media.json': {
        schema_version: 1, scope: 'article-body-reached-public-unlinked-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'),
        entries: [{ source_file_id: 'f-body', archive_relative_path: 'media/body.webp', sha256: hash('4'), source_status: 'unlinked', source_privacy: 'public', source_file_type: 'image' }],
      },
    }) });
    const result = normalize({ config: input });
    const entries = (result.loader.assetManifest as { entries: { sourceFileId: string }[] }).entries;
    expect(entries.map((entry) => entry.sourceFileId).sort()).toEqual(['f-body', 'f-shared', 'pdf-1', 'thumb-1']);
    expect(entries).toHaveLength(4);
  });

  it.each([
    ['digest', { sha256: hash('9') }],
    ['path', { archive_relative_path: 'media/other.png' }],
    ['status', { status: 'disabled' }],
    ['privacy', { privacy: 'private' }],
  ])('rejects a cross-manifest source identity collision on %s', (_field, change) => {
    const input = config({ privateJson: privateDocuments({
      'content-media-manifest.json': {
        schema_version: 1, scope: 'content-media', baseline_sha256: hash('a'), archive_sha256: hash('b'),
        entries: [{ legacy_file_id: 'f-shared', archive_relative_path: 'media/shared.png', sha256: hash('1') }], unresolved: [],
      },
      'reached-media-manifest.json': {
        schema_version: 1, scope: 'sql-demo-public-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'),
        existing_content_image_manifest_sha256: hash('c'),
        verified_assets: [{ source_file_id: 'f-shared', archive_relative_path: 'media/shared.png', sha256: hash('1'), status: 'active', privacy: 'public', source_file_type: 'image', ...change }],
        documents: [], video_thumbnails: [],
      },
    }) });
    expect(() => normalize({ config: input })).toThrow(/f-shared.*(collision|conflict|differ)/i);
  });

  it('does not grant other public-unlinked files by inheriting the approved body-media set', () => {
    const input = config({ privateJson: privateDocuments({
      'article-body-reached-public-unlinked-media.json': {
        schema_version: 1, scope: 'article-body-reached-public-unlinked-media', baseline_sql_sha256: hash('a'), archive_sha256: hash('b'),
        entries: [{ source_file_id: 'body-granted', archive_relative_path: 'media/body.png', sha256: hash('1'), source_status: 'unlinked', source_privacy: 'public', source_file_type: 'image' }],
      },
      'demo-owner-decisions.json': {
        schemaVersion: 1, mediaAllowlist: { status: 'approved-for-demo', allowlistOnly: true, wildcard: false,
          entries: [{ sourceFileId: 'body-granted', sourceSha256: hash('1'), demoApproved: true }] },
      },
    }) });
    const withOtherUnlinked = {
      ...source,
      Files: [...(source.Files ?? []), { id: 'other-unlinked', fileType: 'image/png', originalName: 'x.png', extension: 'png', url: '/synthetic/x.png', status: 'unlinked', privacy: 'public', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' }],
    };
    expect(() => normalize({ config: input, nativeSqlPublicSource: withOtherUnlinked })).toThrow(/other-unlinked.*(grant|allowlist|approval)/i);
  });

  it('requires exact active-ID classification coverage and preserves provisional confidence and pending approval', () => {
    const result = normalize();
    expect(result.mapperOptions.classificationCandidates).toMatchObject({
      teachers: [{ sourceId: 101, trait: 'teacher' }], articles: [{ sourceId: 301, sourceProgramIds: [501] }],
    });
    expect(result.materializer).toMatchObject({
      status: 'pending-confirmation', teachers: [{ sourceId: 101, trait: 'teacher' }],
      articles: [{ sourceId: 301, sourceProgramIds: [501] }],
    });
    const missingActive = { ...source, Teachers: [...source.Teachers, { id: 102, status: 'active', fullName: 'Synthetic active teacher', description: '', imageId: null, priority: 2 }] };
    expect(() => normalize({ nativeSqlPublicSource: missingActive })).toThrow(/Teachers#102.*(classification|coverage)/i);
    const extra = config({ privateJson: privateDocuments({
      'classification-candidates.json': {
        schemaVersion: 1, artifactKind: 'classification-candidates', status: 'candidate',
        teachers: [{ sourceTeacherId: 101, candidateTrait: 'teacher', confidence: 'high', primaryApproval: 'pending' }, { sourceTeacherId: 999, candidateTrait: 'method-author', confidence: 'low', primaryApproval: 'pending' }],
        programs: [{ sourceProgramId: 501, isArticleCategory: true, status: 'candidate' }],
        articles: [{ sourceArticleId: 301, sourceProgramIds: [501], confidence: 'medium', primaryApproval: 'pending' }],
      },
    }) });
    expect(() => normalize({ config: extra })).toThrow(/Teachers#999.*(active|classification|coverage)/i);
    const unknownProgram = config({ privateJson: privateDocuments({
      'classification-candidates.json': {
        schemaVersion: 1, artifactKind: 'classification-candidates', status: 'candidate',
        teachers: [{ sourceTeacherId: 101, candidateTrait: 'teacher', confidence: 'high', primaryApproval: 'pending' }],
        programs: [{ sourceProgramId: 501, isArticleCategory: true, status: 'candidate' }, { sourceProgramId: 999, isArticleCategory: false, status: 'candidate' }],
        articles: [{ sourceArticleId: 301, sourceProgramIds: [501], confidence: 'medium', primaryApproval: 'pending' }],
      },
    }) });
    expect(() => normalize({ config: unknownProgram })).toThrow(/Programs#999.*(active|classification|coverage)/i);
  });

  it('derives selected header references only from mapped entities and keeps source identity unique', () => {
    const result = normalize();
    expect(result.loader.selectedPublicHeaders).toEqual({
      sourceHash: `sha256:${hash('a')}`,
      references: [
        { sourceTable: 'Institutes', sourceId: 11, imageId: 'file-11' },
        { sourceTable: 'Programs', sourceId: 501, imageId: 'file-501' },
      ],
    });
    expect(JSON.stringify(result.loader.selectedPublicHeaders)).not.toContain('file-unselected');
  });

  it('rejects mapper provenance from a different SQL source before selecting asset headers', () => {
    const wrongMapperResult = {
      ...mapped,
      provenance: { ...mapped.provenance, sourceHash: `sha256:${hash('f')}` },
    };
    expect(() => normalize({ mapped: wrongMapperResult })).toThrow(/mapper.*source hash/i);
  });
});
