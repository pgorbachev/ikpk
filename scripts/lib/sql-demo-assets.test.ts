import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSqlDemoAssets, type SqlDemoAssetLoaderInput } from './sql-demo-assets.js';

const syntheticSqlSha256 = 'a'.repeat(64);
const syntheticArchiveSha256 = 'b'.repeat(64);
const syntheticCodeRevision = 'synthetic-code-revision-42';
const syntheticSupplementManifestSha256 = 'c'.repeat(64);
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
  return {
    source: {
      sourceHash: syntheticSqlSha256,
      Files: [],
      FileBindingOrganizationInfo: [],
      Articles: [],
      Videos: [],
    },
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
    supplementManifest: {
      schemaVersion: 1,
      scope: 'sql-demo-approved-supplements',
      sha256: syntheticSupplementManifestSha256,
      codeRevision: syntheticCodeRevision,
      entries: [],
    },
    expectedSupplements: {
      codeRevision: syntheticCodeRevision,
      manifestSha256: syntheticSupplementManifestSha256,
    },
  };
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
  return input;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('offline SQL asset loader contract', () => {
  it('joins by public Files identity and reports a local SHA/magic-derived alias, not a filename match', async () => {
    const base = await root();
    const input = await imageInput(base, { bytes: pngBytes() });
    // Caller-supplied "verified" claims are outside the manifest contract and must be ignored.
    Object.assign(input.assetManifest.entries[0]!, { verification: { status: 'verified', attestationId: 'spoofed' } });
    // A same-name decoy has a different SQL identity and must never satisfy this join.
    await putFile(input.assetRoot, 'decoy/synthetic.webp', jpegBytes());

    const result = await loadSqlDemoAssets(input);

    expect(result.allowlistedAssets.images).toMatchObject([{
      sourceFileId: 'file-1', sourceUrl: '/files/file-1.webp',
      detectedMimeType: 'image/png', targetPublicUrl: expect.stringMatching(/\.png$/),
      verification: { status: 'verified', loader: 'sql-demo-asset-loader' },
    }]);
    expect(result.offlineMedia[0]).toMatchObject({
      sourceFileId: 'file-1', sourceSha256: sha256(pngBytes()), detectedMimeType: 'image/png',
    });
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

    expect(result.allowlistedAssets.images[0]).toMatchObject({ detectedMimeType: 'image/jpeg' });
    expect(result.allowlistedAssets.images[0]?.targetPublicUrl).toMatch(/\.jpg?$/);
    expect(result.offlineMedia[0]).toMatchObject({ detectedMimeType: 'image/jpeg' });
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
    input.source.FileBindingOrganizationInfo = [{
      id: 701, title: 'Synthetic notice', priority: 1, fileId: 'pdf-1', organizationInfoId: 601,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    input.assetManifest.entries = [{
      sourceFileId: 'pdf-1', archiveRelativePath: 'pdf-1/notice.pdf', sha256: sha256(bytes),
      sourceFileType: 'document', sourceStatus: 'active', sourcePrivacy: 'public',
      reachability: { kind: 'document-binding', bindingSourceId: 701 },
    }];

    const result = await loadSqlDemoAssets(input);

    expect(result.allowlistedAssets.documents).toMatchObject([{
      sourceFileId: 'pdf-1', detectedMimeType: 'application/pdf',
    }]);
    expect(result.allowlistedAssets.images).toEqual([]);
    expect(result.offlineMedia[0]).toMatchObject({ detectedMimeType: 'application/pdf' });
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
    const input = await imageInput(base, { status, privacy, reachability: { kind: 'article-body', articleSourceId: 902 } });
    input.source.Articles = [{
      id: 902, status: 'active', name: 'Synthetic article', imageId: null,
      content: '<p><img src="/files/file-1.webp" alt="synthetic" /></p>', author: 'Synthetic author',
      priority: 1, seoTitle: '', seoDescription: '', slug: 'synthetic-article',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }];

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(inactive|disabled|private|unlinked|owner|grant|approved)/i);
  });

  it('requires the exact article ID, file ID and source SHA grant for an unlinked body image', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'unlinked', reachability: { kind: 'article-body', articleSourceId: 903 } });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    input.source.Articles = [{
      id: 903, status: 'active', name: 'Synthetic article', imageId: null,
      content: '<p><img src="/files/file-1.webp" alt="synthetic" /></p>', author: 'Synthetic author',
      priority: 1, seoTitle: '', seoDescription: '', slug: 'synthetic-article',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    input.approvedBodyFileGrants = [{
      articleSourceId: 903, sourceFileId: 'file-1', sourceSha256: sha256(bytes), decisionId: 'synthetic-decision-1',
    }];

    const result = await loadSqlDemoAssets(input);

    expect(result.offlineMedia[0]?.reachability).toEqual({ kind: 'article-body', articleSourceId: 903 });
    expect(result.allowlistedAssets.images[0]?.verification.status).toBe('verified');
  });

  it.each([
    ['different article', (input: SqlDemoAssetLoaderInput) => { input.approvedBodyFileGrants[0]!.articleSourceId = 904; }],
    ['different file ID', (input: SqlDemoAssetLoaderInput) => { input.approvedBodyFileGrants[0]!.sourceFileId = 'other-file'; }],
    ['different source SHA', (input: SqlDemoAssetLoaderInput) => { input.approvedBodyFileGrants[0]!.sourceSha256 = 'e'.repeat(64); }],
  ])('rejects a body-file grant with a mismatched %s', async (_label, mutateGrant) => {
    const base = await root();
    const input = await imageInput(base, { status: 'unlinked', reachability: { kind: 'article-body', articleSourceId: 903 } });
    const bytes = await readFile(join(input.assetRoot, 'file-1', 'synthetic.webp'));
    input.source.Articles = [{
      id: 903, status: 'active', name: 'Synthetic article', imageId: null,
      content: '<p><img src="/files/file-1.webp" alt="synthetic" /></p>', author: 'Synthetic author',
      priority: 1, seoTitle: '', seoDescription: '', slug: 'synthetic-article',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    input.approvedBodyFileGrants = [{
      articleSourceId: 903, sourceFileId: 'file-1', sourceSha256: sha256(bytes), decisionId: 'synthetic-decision-1',
    }];
    mutateGrant(input);

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(body|owner|grant|approval|identity|SHA)/i);
  });

  it('accepts an active direct header image without any body grant', async () => {
    const base = await root();
    const input = await imageInput(base, { status: 'active', reachability: { kind: 'sql-header' } });
    input.source.Articles = [{
      id: 904, status: 'active', name: 'Synthetic article', imageId: 'file-1',
      content: '', author: 'Synthetic author', priority: 1, seoTitle: '', seoDescription: '', slug: 'header-image',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }];

    const result = await loadSqlDemoAssets(input);

    expect(result.allowlistedAssets.images[0]?.sourceFileId).toBe('file-1');
    expect(result.provenance.assets).toHaveLength(1);
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

    const result = await loadSqlDemoAssets(input);

    expect(result.supplements[0]).toMatchObject({
      scope: 'missing-original-replacement', replacesMissingSourceFileId: 'missing-original-77',
    });
    expect(result.offlineMedia.some((asset) => asset.sourceFileId === 'missing-original-77')).toBe(false);
  });

  it('rejects arbitrary supplement overlays and stale code revisions', async () => {
    const base = await root();
    const input = baseInput(base);
    input.supplementManifest.entries = [{
      name: 'synthetic-overlay', scope: 'public-static-page', sourcePath: 'overlay.json',
      revision: 'stale-code-revision', sha256: 'f'.repeat(64),
    }];
    await putFile(base, 'supplements/overlay.json', Buffer.from('{"overlay":true}'));

    await expect(loadSqlDemoAssets(input)).rejects.toThrow(/(overlay|revision|pinned|supplement)/i);
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
