import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeSqlDemoSupplementManifestSha256,
  loadSqlDemoAssets,
  type SqlDemoSelectedPublicHeaderReference,
  type SqlDemoAssetLoaderInput,
} from './sql-demo-assets.js';

const syntheticSqlSha256 = 'a'.repeat(64);
const syntheticArchiveSha256 = 'b'.repeat(64);
const syntheticCodeRevision = 'c'.repeat(40);
const tempRoots: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function pdfBytes(): Buffer {
  return Buffer.from('%PDF-1.7\nsynthetic document\n%%EOF\n');
}

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ikpk-sql-demo-assets-'));
  tempRoots.push(directory);
  await mkdir(join(directory, 'archive'), { recursive: true });
  await mkdir(join(directory, 'supplements'), { recursive: true });
  return directory;
}

async function putFile(base: string, relativePath: string, bytes: Buffer): Promise<string> {
  const path = join(base, relativePath);
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

function baseInput(base: string): SqlDemoAssetLoaderInput {
  const supplementManifest = {
    schemaVersion: 1 as const,
    scope: 'sql-demo-approved-supplements' as const,
    codeRevision: syntheticCodeRevision,
    entries: [],
  };
  const supplementManifestSha256 = computeSqlDemoSupplementManifestSha256(supplementManifest);
  return {
    source: {
      sourceHash: syntheticSqlSha256,
      Files: [],
      FileBindingOrganizationInfo: [],
      Articles: [],
      Videos: [],
    },
    selectedPublicHeaders: { sourceHash: syntheticSqlSha256, references: [] },
    baseline: { sqlSha256: syntheticSqlSha256, archiveSha256: syntheticArchiveSha256 },
    assetRoot: join(base, 'archive'),
    assetManifest: {
      schemaVersion: 1,
      scope: 'sql-demo-public-assets',
      baselineSqlSha256: syntheticSqlSha256,
      archiveSha256: syntheticArchiveSha256,
      entries: [],
    },
    approvedBodyFileGrants: [],
    supplementRoot: join(base, 'supplements'),
    supplementManifest: { ...supplementManifest, sha256: supplementManifestSha256 },
    expectedSupplements: {
      codeRevision: syntheticCodeRevision,
      manifestSha256: supplementManifestSha256,
    },
  };
}

function pinSyntheticSupplements(input: SqlDemoAssetLoaderInput): void {
  const digest = computeSqlDemoSupplementManifestSha256(input.supplementManifest);
  input.supplementManifest.sha256 = digest;
  input.expectedSupplements.manifestSha256 = digest;
}

type MissingOriginalReplacement = {
  sourceFileId: string;
  replacementPath: string;
  replacementRevision: string;
  replacementSha256: string;
  sourceBytesAvailable: false;
};

type InputWithMissingOriginalReplacement = SqlDemoAssetLoaderInput & {
  approvedMissingOriginalReplacements: MissingOriginalReplacement[];
};

async function missingOriginalReplacementInput(base: string): Promise<InputWithMissingOriginalReplacement> {
  const sourceFileId = '1dec5ad5-a0ff-4b56-8ab9-f9ceb0308631';
  const replacementPath = 'web/public/institutes/barral-logo.png';
  const replacementRevision = syntheticCodeRevision;
  const replacementBytes = pngBytes();
  const replacementSha256 = sha256(replacementBytes);
  await putFile(base, `supplements/${replacementPath}`, replacementBytes);

  const input = baseInput(base) as InputWithMissingOriginalReplacement;
  input.source.Institutes = [{ id: 3, status: 'active', imageId: sourceFileId }];
  input.source.Files = [fileRow({
    id: sourceFileId, fileType: 'image', status: 'active', privacy: 'public',
    originalName: 'barral-original.webp', extension: 'webp', url: '/storage/institutes/barral-original.webp',
  })];
  input.selectedPublicHeaders.references = [{
    sourceTable: 'Institutes', sourceId: 3, imageId: sourceFileId,
  } as unknown as SqlDemoSelectedPublicHeaderReference];
  input.approvedMissingOriginalReplacements = [{
    sourceFileId, replacementPath, replacementRevision, replacementSha256, sourceBytesAvailable: false,
  }];
  input.supplementManifest.entries = [{
    name: replacementPath,
    scope: 'missing-original-replacement',
    sourcePath: replacementPath,
    revision: replacementRevision,
    sha256: replacementSha256,
    replacesMissingSourceFileId: sourceFileId,
  }];
  pinSyntheticSupplements(input);
  return input;
}

function fileRow(overrides: Partial<NonNullable<SqlDemoAssetLoaderInput['source']['Files']>[number]> = {}) {
  return {
    id: 'file-1', fileType: 'image', originalName: 'synthetic.png', extension: 'webp',
    url: '/files/synthetic.png', status: 'active', privacy: 'public',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function imageInput(base: string, options: {
  id?: string;
  bytes?: Buffer;
  status?: 'active' | 'disabled' | 'unlinked';
  privacy?: 'public' | 'private';
  reachability?: SqlDemoAssetLoaderInput['assetManifest']['entries'][number]['reachability'];
  selectedHeader?: boolean;
} = {}): Promise<SqlDemoAssetLoaderInput> {
  const bytes = options.bytes ?? pngBytes();
  const relativePath = `archive/${options.id ?? 'file-1'}/synthetic.webp`;
  await putFile(base, relativePath, bytes);
  const input = baseInput(base);
  const status = options.status ?? 'active';
  const privacy = options.privacy ?? 'public';
  input.source.Files = [fileRow({
    id: options.id ?? 'file-1', status, privacy,
    extension: 'webp', originalName: 'synthetic.webp',
    url: `/files/${options.id ?? 'file-1'}.webp`,
  })];
  input.assetManifest.entries = [{
    sourceFileId: options.id ?? 'file-1',
    archiveRelativePath: relativePath.slice('archive/'.length),
    sha256: sha256(bytes),
    sourceFileType: 'image',
    sourceStatus: status,
    sourcePrivacy: privacy,
    reachability: options.reachability ?? { kind: 'sql-header' },
  }];
  if (
    (options.reachability === undefined || options.reachability.kind === 'sql-header') &&
    status === 'active' && privacy === 'public' && options.selectedHeader !== false
  ) {
    const sourceId = 904;
    const reference: SqlDemoSelectedPublicHeaderReference = {
      sourceTable: 'Articles', sourceId, imageId: options.id ?? 'file-1',
    };
    input.source.Articles = [{ id: sourceId, status: 'active', imageId: reference.imageId, content: '' }];
    input.selectedPublicHeaders.references = [reference];
  }
  return input;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('offline SQL asset loader contract', () => {
  it('joins by public Files identity and derives image MIME and extension from bytes', async () => {
    const base = await root();
    const input = await imageInput(base, { bytes: pngBytes() });
    // Caller-supplied "verified" claims are outside the manifest contract and must be ignored.
    Object.assign(input.assetManifest.entries[0]!, { verification: { status: 'verified', attestationId: 'spoofed' } });
    // A same-name decoy has a different SQL identity and must never satisfy this join.
    await putFile(input.assetRoot, 'decoy/synthetic.webp', jpegBytes());

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia[0]).toMatchObject({
      sourceFileType: 'image', sourceFileId: 'file-1', sourceUrl: '/files/file-1.webp',
      sourceSha256: sha256(pngBytes()), detectedMimeType: 'image/png', detectedExtension: 'png',
      verification: { status: 'verified', loader: 'sql-demo-asset-loader' },
    });
    expect(result.offlineMedia[0]?.verification.attestationId).not.toBe('spoofed');
    expect(result.offlineMedia[0]).not.toHaveProperty('targetPublicUrl');
    expect(result.offlineMedia[0]?.resolvedLocalPath).toContain('archive');
  });

  it('rejects bytes whose SHA differs from the pinned source media digest', async () => {
    const base = await root();
    const input = await imageInput(base, { bytes: pngBytes() });
    input.assetManifest.entries[0]!.sha256 = sha256(jpegBytes());

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(SHA|hash|digest|checksum)/i);
  });

  it.each([
    ['SQL baseline digest', (input: SqlDemoAssetLoaderInput) => { input.baseline.sqlSha256 = 'd'.repeat(64); }],
    ['readback SQL digest', (input: SqlDemoAssetLoaderInput) => { input.source.sourceHash = 'd'.repeat(64); }],
    ['archive inventory digest', (input: SqlDemoAssetLoaderInput) => { input.assetManifest.archiveSha256 = 'e'.repeat(64); }],
  ])('fails closed when the pinned %s does not match', async (_label, mutate) => {
    const base = await root();
    const input = await imageInput(base);
    mutate(input);

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(baseline|archive).*(hash|SHA|digest|pinned)/i);
  });

  it('rejects an asset whose real path escapes the extracted archive root', async () => {
    const base = await root();
    const input = await imageInput(base);
    const outside = await putFile(base, 'outside/secret.png', pngBytes());
    await symlink(outside, join(input.assetRoot, 'file-1', 'escape.webp'));
    input.assetManifest.entries[0]!.archiveRelativePath = 'file-1/escape.webp';

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(path|realpath|contain|escape|outside)/i);
  });

  it('derives PNG or JPEG MIME and extension from bytes when SQL declares a wrong extension', async () => {
    const base = await root();
    const input = await imageInput(base, { bytes: jpegBytes() });

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia[0]).toMatchObject({
      sourceFileType: 'image', detectedMimeType: 'image/jpeg', detectedExtension: 'jpg',
    });
  });

  it('keeps an active public PDF document in the document set with a PDF byte guard', async () => {
    const base = await root();
    const bytes = pdfBytes();
    const relativePath = 'archive/pdf-1/notice.pdf';
    await putFile(base, relativePath, bytes);
    const input = baseInput(base);
    input.source.Files = [fileRow({
      id: 'pdf-1', fileType: 'document', extension: 'pdf', originalName: 'notice.pdf', url: '/files/notice.pdf',
    })];
    input.source.FileBindingOrganizationInfo = [{ id: 701, fileId: 'pdf-1', organizationInfoId: 601 }];
    input.assetManifest.entries = [{
      sourceFileId: 'pdf-1', archiveRelativePath: 'pdf-1/notice.pdf', sha256: sha256(bytes),
      sourceFileType: 'document', sourceStatus: 'active', sourcePrivacy: 'public',
      reachability: { kind: 'document-binding', bindingSourceId: 701 },
    }];

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineDocuments).toMatchObject([{
      sourceFileType: 'document', sourceFileId: 'pdf-1', detectedMimeType: 'application/pdf',
      detectedExtension: 'pdf',
    }]);
    expect(result.offlineMedia).toEqual([]);
  });

  it('rejects non-PDF bytes even when SQL fileType and extension say document/pdf', async () => {
    const base = await root();
    const bytes = pngBytes();
    await putFile(base, 'archive/pdf-1/not-really.pdf', bytes);
    const input = baseInput(base);
    input.source.Files = [fileRow({ id: 'pdf-1', fileType: 'document', extension: 'pdf', originalName: 'notice.pdf', url: '/files/notice.pdf' })];
    input.assetManifest.entries = [{
      sourceFileId: 'pdf-1', archiveRelativePath: 'pdf-1/not-really.pdf', sha256: sha256(bytes),
      sourceFileType: 'document', sourceStatus: 'active', sourcePrivacy: 'public',
      reachability: { kind: 'document-binding', bindingSourceId: 701 },
    }];

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(PDF|application\/pdf|magic)/i);
  });

  it.each([
    ['disabled', 'public'], ['active', 'private'], ['unlinked', 'public'],
  ] as const)('does not admit a %s/%s image without the exact body grant when required', async (status, privacy) => {
    const base = await root();
    const input = await imageInput(base, { status, privacy, reachability: { kind: 'article-body', articleSourceIds: [902] } });
    input.source.Articles = [{
      id: 902, status: 'active', imageId: null,
      content: '<p><img src="/files/file-1.webp" alt="synthetic" /></p>',
    }];

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(inactive|disabled|private|unlinked|owner|grant|approved)/i);
  });

  it('requires one exact file ID and source SHA grant for an unlinked body image', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'unlinked', reachability: { kind: 'article-body', articleSourceIds: [903] } });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    input.source.Articles = [{
      id: 903, status: 'active', imageId: null,
      content: '<p><img src="/files/file-1.webp" alt="synthetic" /></p>',
    }];
    input.approvedBodyFileGrants = [{
      sourceFileId: 'file-1', sourceSha256: sha256(bytes), decisionId: 'synthetic-decision-1',
    }];

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia[0]?.reachability).toEqual({ kind: 'article-body', articleSourceIds: [903] });
    expect(result.offlineMedia[0]?.verification.status).toBe('verified');
  });

  it('resolves a canonical upload alias by Files identity while preserving the native storage URL', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'unlinked', reachability: { kind: 'article-body', articleSourceIds: [903] } });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    const alias = 'https://ikpk.su/api/upload/file/123e4567-e89b-12d3-a456-426614174025';
    const storageUrl = '/storage/articles/body-image.webp';
    input.source.Files![0]!.id = '123e4567-e89b-12d3-a456-426614174025';
    input.source.Files![0]!.url = storageUrl;
    const sourceFileId = input.source.Files![0]!.id;
    input.assetManifest.entries[0]!.sourceFileId = sourceFileId;
    input.approvedBodyFileGrants = [{
      sourceFileId, sourceSha256: sha256(bytes), decisionId: 'synthetic-upload-alias-decision',
    }];
    input.source.Articles = [{
      id: 903, status: 'active', imageId: null,
      content: `<p><img src="${alias}" alt="synthetic" /></p>`,
    }];

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia).toHaveLength(1);
    expect(result.offlineMedia[0]).toMatchObject({ sourceFileId, sourceUrl: storageUrl, reachability: { kind: 'article-body', articleSourceIds: [903] } });
  });

  it.each([
    ['wrong host', 'https://elsewhere.ikpk.su/api/upload/file/123e4567-e89b-12d3-a456-426614174025'],
    ['wrong scheme', 'http://ikpk.su/api/upload/file/123e4567-e89b-12d3-a456-426614174025'],
    ['query', 'https://ikpk.su/api/upload/file/123e4567-e89b-12d3-a456-426614174025?download=1'],
    ['fragment', 'https://ikpk.su/api/upload/file/123e4567-e89b-12d3-a456-426614174025#image'],
    ['trailing slash', 'https://ikpk.su/api/upload/file/123e4567-e89b-12d3-a456-426614174025/'],
    ['userinfo', 'https://user@ikpk.su/api/upload/file/123e4567-e89b-12d3-a456-426614174025'],
    ['explicit port', 'https://ikpk.su:443/api/upload/file/123e4567-e89b-12d3-a456-426614174025'],
    ['upper-case UUID', 'https://ikpk.su/api/upload/file/123E4567-E89B-12D3-A456-426614174025'],
    ['encoded UUID', 'https://ikpk.su/api/upload/file/%31' + '23e4567-e89b-12d3-a456-426614174025'],
  ])('rejects a non-canonical upload alias (%s)', async (_shape, alias) => {
    const base = await root();
    const input = await imageInput(base, { status: 'unlinked', reachability: { kind: 'article-body', articleSourceIds: [903] } });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    const sourceFileId = '123e4567-e89b-12d3-a456-426614174025';
    input.source.Files![0]!.id = sourceFileId;
    input.source.Files![0]!.url = '/storage/articles/body-image.webp';
    input.assetManifest.entries[0]!.sourceFileId = sourceFileId;
    input.approvedBodyFileGrants = [{ sourceFileId, sourceSha256: sha256(bytes), decisionId: 'synthetic-upload-alias-decision' }];
    input.source.Articles = [{ id: 903, status: 'active', imageId: null, content: `<img src="${alias}">` }];

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(alias|reference|source|Files|identity|join)/i);
  });

  it.each([
    ['different file ID', (input: SqlDemoAssetLoaderInput) => { input.approvedBodyFileGrants[0]!.sourceFileId = 'other-file'; }],
    ['different source SHA', (input: SqlDemoAssetLoaderInput) => { input.approvedBodyFileGrants[0]!.sourceSha256 = 'e'.repeat(64); }],
  ])('rejects a body-file grant with a mismatched %s', async (_label, mutateGrant) => {
    const base = await root();
    const input = await imageInput(base, { status: 'unlinked', reachability: { kind: 'article-body', articleSourceIds: [903] } });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    input.source.Articles = [{
      id: 903, status: 'active', imageId: null,
      content: '<p><img src="/files/file-1.webp" alt="synthetic" /></p>',
    }];
    input.approvedBodyFileGrants = [{
      sourceFileId: 'file-1', sourceSha256: sha256(bytes), decisionId: 'synthetic-decision-1',
    }];
    mutateGrant(input);

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(body|owner|grant|approval|identity|SHA)/i);
  });

  it('accepts one file grant when the same body file is reached from two active articles', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'unlinked', reachability: { kind: 'article-body', articleSourceIds: [903, 905] } });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    input.source.Articles = [903, 905].map((id) => ({
      id, status: 'active', imageId: null,
      content: '<p><img src="/files/file-1.webp" alt="synthetic" /></p>',
    }));
    input.approvedBodyFileGrants = [{
      sourceFileId: 'file-1', sourceSha256: sha256(bytes), decisionId: 'synthetic-decision-1',
    }];

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia[0]?.reachability).toEqual({ kind: 'article-body', articleSourceIds: [903, 905] });
    expect(input.approvedBodyFileGrants).toHaveLength(1);
  });

  it.each([
    ['an HTML comment', '<!-- <img src="/files/file-1.webp" alt="synthetic" /> -->'],
    ['a script string', '<script>const html = "<img src=\'/files/file-1.webp\'>";</script>'],
    ['an alt-text string', '<p><img alt="<img src=\'/files/file-1.webp\' />" /></p>'],
  ])('does not treat an image-like string in %s as an article body reference', async (_label, content) => {
    const base = await root();
    const input = await imageInput(base, {
      status: 'unlinked', reachability: { kind: 'article-body', articleSourceIds: [903] },
    });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    input.source.Articles = [{ id: 903, status: 'active', imageId: null, content }];
    input.approvedBodyFileGrants = [{
      sourceFileId: 'file-1', sourceSha256: sha256(bytes), decisionId: 'synthetic-decision-1',
    }];

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(reachability|body reference|source reference|grant)/i);
  });

  it('decodes a numeric entity in an unquoted img src inside picture', async () => {
    const base = await root();
    const input = await imageInput(base, {
      status: 'unlinked', reachability: { kind: 'article-body', articleSourceIds: [903] },
    });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    input.source.Articles = [{
      id: 903, status: 'active', imageId: null,
      content: '<picture><source srcset="/files/other.webp"><img src=/files/file&#45;1.webp></picture>',
    }];
    input.approvedBodyFileGrants = [{
      sourceFileId: 'file-1', sourceSha256: sha256(bytes), decisionId: 'synthetic-decision-1',
    }];

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia[0]?.reachability).toEqual({ kind: 'article-body', articleSourceIds: [903] });
  });

  it('rejects manifest article reachability that does not match active body URL references', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'unlinked', reachability: { kind: 'article-body', articleSourceIds: [904] } });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    input.source.Articles = [{
      id: 903, status: 'active', imageId: null,
      content: '<p><img src="/files/file-1.webp" alt="synthetic" /></p>',
    }];
    input.approvedBodyFileGrants = [{
      sourceFileId: 'file-1', sourceSha256: sha256(bytes), decisionId: 'synthetic-decision-1',
    }];

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(reachability|body reference|source reference)/i);
  });

  it('accepts an active direct header image without any body grant', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'active', reachability: { kind: 'sql-header' } });

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia[0]?.sourceFileId).toBe('file-1');
    expect(result.provenance.assets).toHaveLength(1);
    expect(result.provenance.assets[0]).toMatchObject({
      selectedPublicHeaderReferences: [{ sourceTable: 'Articles', sourceId: 904, imageId: 'file-1' }],
    });
  });

  it('derives video-thumbnail reachability from the exact native video join when the manifest row is deduplicated as a header', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'active', reachability: { kind: 'sql-header' }, selectedHeader: false });
    input.source.Articles = [];
    input.source.Videos = [{ id: 77, status: 'active', imageId: 'file-1', link: '/synthetic/video-77' }];
    input.selectedPublicHeaders.references = [{ sourceTable: 'Videos', sourceId: 77, imageId: 'file-1' }];

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia).toHaveLength(1);
    expect(result.offlineMedia[0]).toMatchObject({
      sourceFileId: 'file-1', reachability: { kind: 'video-thumbnail', videoSourceId: 77 },
    });
    expect(result.provenance.assets[0]?.selectedPublicHeaderReferences).toEqual([
      { sourceTable: 'Videos', sourceId: 77, imageId: 'file-1' },
    ]);
  });

  it('rejects a video thumbnail manifest identity that does not match the selected native video and file', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'active', reachability: { kind: 'video-thumbnail', videoSourceId: 78 }, selectedHeader: false });
    input.source.Articles = [];
    input.source.Videos = [{ id: 77, status: 'active', imageId: 'file-1', link: '/synthetic/video-77' }];
    input.selectedPublicHeaders.references = [{ sourceTable: 'Videos', sourceId: 77, imageId: 'file-1' }];

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/file-1.*(video|thumbnail|reachability)/i);
  });

  it('rejects an active asset with a sql-header manifest entry but no selected mapper header reference', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'active', selectedHeader: false });

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(reachability|header|reference|source relation)/i);
  });

  it('requires selected header references to carry the pinned SQL source hash', async () => {
    const base = await root();
    const input = await imageInput(base);
    input.selectedPublicHeaders.sourceHash = 'd'.repeat(64);

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(header|mapper|source).*(hash|SHA|digest|pinned)/i);
  });

  it('rejects a selected header source ID that does not identify the referenced SQL entity', async () => {
    const base = await root();
    const input = await imageInput(base);
    input.selectedPublicHeaders.references[0]!.sourceId = 905;

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(header|source).*(identity|ID|reference|join)/i);
  });

  it('fails closed for a reached asset with an unknown SQL file ID or a missing manifest entry', async () => {
    const base = await root();
    const input = await imageInput(base);
    input.assetManifest.entries[0]!.sourceFileId = 'unknown-file-id';

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(unknown|missing|Files#|identity|join)/i);
  });

  it('pins named static and video supplements to the selected code revision and manifest hash', async () => {
    const base = await root();
    const staticBytes = Buffer.from('{"page":"synthetic"}');
    const thumbBytes = jpegBytes();
    await putFile(base, 'supplements/static-page.json', staticBytes);
    await putFile(base, 'supplements/video-thumb.jpg', thumbBytes);
    const input = baseInput(base);
    input.supplementManifest.entries = [
      { name: 'synthetic-static-page', scope: 'public-static-page', sourcePath: 'static-page.json', revision: syntheticCodeRevision, sha256: sha256(staticBytes) },
      { name: 'synthetic-video-thumbnail', scope: 'public-video-thumbnail', sourcePath: 'video-thumb.jpg', revision: syntheticCodeRevision, sha256: sha256(thumbBytes) },
    ];
    pinSyntheticSupplements(input);

    const result = await loadSqlDemoAssets(input);

    expect(result.supplements).toEqual(input.supplementManifest.entries.map((entry) => ({
      sourcePath: entry.sourcePath, revision: entry.revision, sha256: entry.sha256, scope: entry.scope,
    })));
    expect(result.provenance.supplements).toEqual(result.supplements);
  });

  it('records a missing original when an explicitly scoped branding replacement is accepted', async () => {
    const base = await root();
    const replacementBytes = pngBytes();
    await putFile(base, 'supplements/branding-replacement.png', replacementBytes);
    const input = baseInput(base);
    input.supplementManifest.entries = [{
      name: 'synthetic-branding-replacement', scope: 'missing-original-replacement',
      sourcePath: 'branding-replacement.png', revision: syntheticCodeRevision,
      sha256: sha256(replacementBytes), replacesMissingSourceFileId: 'missing-original-77',
    }];
    pinSyntheticSupplements(input);

    const result = await loadSqlDemoAssets(input);

    expect(result.supplements[0]).toMatchObject({
      scope: 'missing-original-replacement', replacesMissingSourceFileId: 'missing-original-77',
    });
    expect(result.offlineDocuments.some((asset) => asset.sourceFileId === 'missing-original-77')).toBe(false);
  });

  it('joins an approved named replacement to an active public header without claiming original bytes', async () => {
    const input = await missingOriginalReplacementInput(await root());
    const replacement = input.approvedMissingOriginalReplacements[0]!;

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceFileId: replacement.sourceFileId,
        sourceUrl: '/storage/institutes/barral-original.webp',
        sourceBytesAvailable: false,
        substitution: {
          replacementSha256: replacement.replacementSha256,
          replacementPath: replacement.replacementPath,
          replacementRevision: replacement.replacementRevision,
        },
        detectedMimeType: 'image/png',
        detectedExtension: 'png',
      }),
    ]));
    const proof = result.offlineMedia.find((asset) => asset.sourceFileId === replacement.sourceFileId)!;
    expect(proof).not.toHaveProperty('sourceSha256');
    expect(result.provenance.assets).toContainEqual(expect.objectContaining({
      sourceFileId: replacement.sourceFileId,
      sourceBytesAvailable: false,
      substitution: {
        replacementSha256: replacement.replacementSha256,
        replacementPath: replacement.replacementPath,
        replacementRevision: replacement.replacementRevision,
      },
    }));
    expect(result.provenance.assets.find((asset) => asset.sourceFileId === replacement.sourceFileId))
      .not.toHaveProperty('sourceSha256');
  });

  it.each([
    ['owner decision has the wrong source file ID', (input: InputWithMissingOriginalReplacement) => {
      input.approvedMissingOriginalReplacements[0]!.sourceFileId = 'wrong-source-file';
    }],
    ['owner decision has the wrong replacement path', (input: InputWithMissingOriginalReplacement) => {
      input.approvedMissingOriginalReplacements[0]!.replacementPath = 'web/public/institutes/not-barral.png';
    }],
    ['owner decision has the wrong replacement hash', (input: InputWithMissingOriginalReplacement) => {
      input.approvedMissingOriginalReplacements[0]!.replacementSha256 = 'f'.repeat(64);
    }],
    ['the approved replacement supplement is absent', (input: InputWithMissingOriginalReplacement) => {
      input.supplementManifest.entries = [];
    }],
  ])('rejects a missing-original replacement when %s', async (_label, mutate) => {
    const input = await missingOriginalReplacementInput(await root());
    mutate(input);
    pinSyntheticSupplements(input);

    await expect(loadSqlDemoAssets(input)).rejects.toThrow();
  });

  it('rejects a same-revision overlay added after the supplement manifest was pinned', async () => {
    const base = await root();
    const input = baseInput(base);
    input.supplementManifest.entries = [{
      name: 'synthetic-static-page', scope: 'public-static-page', sourcePath: 'page.json',
      revision: syntheticCodeRevision, sha256: sha256(Buffer.from('{"page":"approved"}')),
    }];
    pinSyntheticSupplements(input);
    await putFile(base, 'supplements/page.json', Buffer.from('{"page":"approved"}'));
    const overlayBytes = Buffer.from('{"overlay":true}');
    await putFile(base, 'supplements/overlay.json', overlayBytes);
    input.supplementManifest.entries.push({
      name: 'synthetic-overlay', scope: 'public-static-page', sourcePath: 'overlay.json',
      revision: syntheticCodeRevision, sha256: sha256(overlayBytes),
    });

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(manifest|supplement).*(hash|SHA|digest|pinned)/i);
  });

  it('rejects a supplement source revision that is not a full Git SHA', async () => {
    const base = await root();
    const input = baseInput(base);
    input.supplementManifest.entries = [{
      name: 'synthetic-static-page', scope: 'public-static-page', sourcePath: 'page.json',
      revision: 'stale-code-revision', sha256: 'f'.repeat(64),
    }];
    pinSyntheticSupplements(input);

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(revision|pinned|supplement)/i);
  });

  it('preserves a historical supplement revision distinct from the release code revision', async () => {
    const base = await root();
    const bytes = Buffer.from('{"historical":"approved"}');
    await putFile(base, 'supplements/historical-page.json', bytes);
    const input = baseInput(base);
    const historicalRevision = 'd'.repeat(40);
    input.supplementManifest.entries = [{
      name: 'historical-static-page',
      scope: 'public-static-page',
      sourcePath: 'historical-page.json',
      revision: historicalRevision,
      sha256: sha256(bytes),
    }];
    pinSyntheticSupplements(input);

    const result = await loadSqlDemoAssets(input);

    expect(result.supplements[0]?.revision).toBe(historicalRevision);
    expect(result.supplements[0]?.revision).not.toBe(input.supplementManifest.codeRevision);
  });

  it('rejects a supplement manifest whose digest differs from the pinned release', async () => {
    const base = await root();
    const input = baseInput(base);
    input.supplementManifest.sha256 = 'e'.repeat(64);

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(manifest|supplement).*(hash|SHA|digest|pinned)/i);
  });

  it('rejects supplement bytes whose SHA differs from the pinned manifest entry', async () => {
    const base = await root();
    const input = baseInput(base);
    await putFile(base, 'supplements/static-page.json', Buffer.from('{"page":"tampered"}'));
    input.supplementManifest.entries = [{
      name: 'synthetic-static-page', scope: 'public-static-page', sourcePath: 'static-page.json',
      revision: syntheticCodeRevision, sha256: sha256(Buffer.from('{"page":"approved"}')),
    }];
    pinSyntheticSupplements(input);

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(supplement|SHA|hash|digest)/i);
  });

  it('does not use network fallback for missing local source bytes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const base = await root();
    const input = await imageInput(base);
    input.assetManifest.entries[0]!.archiveRelativePath = 'missing/source.png';

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(local|missing|source|path|file)/i);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
