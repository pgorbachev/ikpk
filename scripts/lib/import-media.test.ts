import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createImageUploader } from './import-media.js';

const root = join(import.meta.dirname, '..', '..');
const legacyImages = [
  '/media/legacy/logo-v2.png',
  '/media/legacy/logo-upledger-inst.png',
  '/media/legacy/logo-barral-inst.png',
];

function pngBytes(seed = 1): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(seed, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
}

function webpBytes(): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  return bytes;
}

function makeUploader(overrides: Partial<Parameters<typeof createImageUploader>[0]> = {}) {
  const knownMediaByHash = overrides.knownMediaByHash ?? new Map<string, number>();
  const knownMediaBySourceHash = overrides.knownMediaBySourceHash ?? new Map<string, number>();
  const storedHashById = overrides.storedHashById ?? new Map<number, string>();
  const mediaById = overrides.mediaById ?? new Map<number, { id: number; name?: string; mime?: string; provider_metadata?: unknown }>();
  const failures: string[] = [];
  const fetchImage = vi.fn(async () => { throw new Error('unexpected fetch'); });
  const configuredFetchImage = overrides.fetchImage ?? fetchImage;
  const upload = vi.fn(async (...args: [Buffer, string, string]) => {
    void args;
    return 73;
  });
  const configuredUpload = overrides.upload ? vi.fn(overrides.upload) : upload;
  const persistIdentity = overrides.persistIdentity ?? vi.fn(async ({ sourceSha256 }: { sourceSha256: string }) => sourceSha256);
  const imageUploader = createImageUploader({
    root,
    knownMediaByHash,
    knownMediaBySourceHash,
    storedHashById,
    mediaById,
    fetchImage: configuredFetchImage,
    persistIdentity,
    onFailure: (url, error) => failures.push(`${url}: ${error}`),
    ...overrides,
    upload: configuredUpload,
  });
  return { imageUploader, knownMediaByHash, knownMediaBySourceHash, mediaById, fetchImage: configuredFetchImage, upload: configuredUpload, persistIdentity, failures };
}

describe('import media upload boundary', () => {
  it.each(legacyImages)('%s uploads the repository-owned bytes and returns the media relation ID', async (key) => {
    const state = makeUploader();
    const filePath = join(root, 'media-originals', 'legacy', key.split('/').at(-1)!);
    const expectedBytes = await readFile(filePath);

    await expect(state.imageUploader(key)).resolves.toBe(73);

    expect(state.fetchImage).not.toHaveBeenCalled();
    expect(state.upload).toHaveBeenCalledOnce();
    expect(state.upload.mock.calls[0][0]).toEqual(expectedBytes);
    expect(state.upload.mock.calls[0][1]).toBe(key.split('/').at(-1));
    expect(state.failures).toEqual([]);
    expect(state.persistIdentity).toHaveBeenCalledWith(expect.objectContaining({ fileId: 73, sourceUrl: key }));
  });

  it('reuses the CMS-backed source identity on a repeated run without another upload', async () => {
    const bytes = await readFile(join(root, 'media-originals', 'legacy', 'logo-v2.png'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const knownMediaBySourceHash = new Map([[hash, 73]]);
    const second = makeUploader({
      knownMediaBySourceHash,
      mediaById: new Map([[73, {
        id: 73,
        name: 'logo-v2.png',
        mime: 'image/png',
        provider_metadata: { ikpk_media_import: { sources: { [legacyImages[0]]: {
          version: 1,
          sha256: hash,
          storedSha256: hash,
        } } } },
      }]]),
      storedHashById: new Map([[73, hash]]),
    });

    await expect(second.imageUploader(legacyImages[0])).resolves.toBe(73);

    expect(second.fetchImage).not.toHaveBeenCalled();
    expect(second.upload).not.toHaveBeenCalled();
    expect(second.failures).toEqual([]);
  });

  it('reuses content hash across source URLs without creating a second media upload', async () => {
    const first = makeUploader();
    await expect(first.imageUploader(legacyImages[0])).resolves.toBe(73);
    const bytes = await readFile(join(root, 'media-originals', 'legacy', 'logo-v2.png'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const storedHash = createHash('sha256').update('stored image bytes').digest('hex');
    const second = makeUploader({
      knownMediaBySourceHash: new Map([[hash, 73]]),
      storedHashById: new Map([[73, storedHash]]),
      mediaById: new Map([[73, { id: 73, name: 'logo-v2.png', mime: 'image/png' }]]),
      fetchImage: vi.fn(async () => new Response(bytes, { status: 200 })),
      persistIdentity: vi.fn(async () => storedHash),
    });

    await expect(second.imageUploader('https://images.example.test/same-content.png')).resolves.toBe(73);

    expect(second.fetchImage).toHaveBeenCalledOnce();
    expect(second.upload).not.toHaveBeenCalled();
    expect(second.knownMediaBySourceHash.get(hash)).toBe(73);
    expect(second.failures).toEqual([]);
  });

  it('reuses byte-identical CMS media from the live inventory without a local cache', async () => {
    const bytes = await readFile(join(root, 'media-originals', 'legacy', 'logo-v2.png'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const state = makeUploader({
      knownMediaByHash: new Map([[hash, 219]]),
      mediaById: new Map([[219, { id: 219, name: 'logo-v2.png', mime: 'image/png' }]]),
    });

    await expect(state.imageUploader(legacyImages[0])).resolves.toBe(219);

    expect(state.upload).not.toHaveBeenCalled();
    expect(state.persistIdentity).toHaveBeenCalledWith({
      fileId: 219,
      sourceUrl: legacyImages[0],
      sourceSha256: hash,
      expectedStoredSha256: hash,
    });
    expect(state.failures).toEqual([]);
  });

  it('adopts an existing related Strapi file when its stored optimized bytes differ from the source', async () => {
    const sourceBytes = pngBytes();
    const storedBytes = Buffer.from('strapi re-encoded image bytes');
    expect(storedBytes).not.toEqual(sourceBytes);
    const sourceUrl = 'https://images.example.test/portrait.png';
    const fileId = 219;
    const state = makeUploader({
      knownMediaByHash: new Map([[createHash('sha256').update(storedBytes).digest('hex'), fileId]]),
      storedHashById: new Map([[fileId, createHash('sha256').update(storedBytes).digest('hex')]]),
      mediaById: new Map([[fileId, { id: fileId, name: 'portrait.png', mime: 'image/png' }]]),
      persistIdentity: vi.fn(async () => createHash('sha256').update(storedBytes).digest('hex')),
      fetchImage: vi.fn(async () => new Response(sourceBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
      // A fresh checkout has no ignored URL cache; adoption is tied to this relation.
    });

    await expect(state.imageUploader(sourceUrl, { entityKey: 'articles:legacy-42:image:0', fileId })).resolves.toBe(fileId);

    expect(state.upload).not.toHaveBeenCalled();
    expect(state.persistIdentity).toHaveBeenCalledWith({
      fileId,
      sourceUrl,
      sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      expectedStoredSha256: createHash('sha256').update(storedBytes).digest('hex'),
      adoptedFrom: 'articles:legacy-42:image:0',
    });
    expect(state.failures).toEqual([]);
  });

  it('adopts a related JPEG when the source server labels its bytes as generic octet-stream', async () => {
    const sourceBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const storedBytes = Buffer.from('strapi optimized jpeg bytes');
    const sourceUrl = 'https://images.example.test/portrait.jpg';
    const fileId = 219;
    const storedSha256 = createHash('sha256').update(storedBytes).digest('hex');
    const state = makeUploader({
      knownMediaByHash: new Map([[storedSha256, fileId]]),
      storedHashById: new Map([[fileId, storedSha256]]),
      mediaById: new Map([[fileId, { id: fileId, name: 'portrait.jpg', mime: 'image/jpeg' }]]),
      persistIdentity: vi.fn(async () => storedSha256),
      fetchImage: vi.fn(async () => new Response(sourceBytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })),
    });

    await expect(state.imageUploader(sourceUrl, { entityKey: 'articles:legacy-42:image:0', fileId })).resolves.toBe(fileId);

    expect(state.upload).not.toHaveBeenCalled();
    expect(state.persistIdentity).toHaveBeenCalledWith({
      fileId,
      sourceUrl,
      sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      expectedStoredSha256: storedSha256,
      adoptedFrom: 'articles:legacy-42:image:0',
    });
    expect(state.failures).toEqual([]);
  });

  it.each([
    ['PNG', pngBytes(), 'image/png'],
    ['WebP', webpBytes(), 'image/webp'],
  ])('detects %s from bytes even when the URL extension disagrees', async (_label, bytes, expectedMime) => {
    const upload = vi.fn(async () => 91);
    const state = makeUploader({
      fetchImage: vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })),
      upload,
    });

    await expect(state.imageUploader('https://images.example.test/photo.jpg')).resolves.toBe(91);

    expect(upload).toHaveBeenCalledWith(bytes, 'photo.jpg', expectedMime);
    expect(state.failures).toEqual([]);
  });

  it('rejects generic non-image bytes before upload', async () => {
    const state = makeUploader({
      fetchImage: vi.fn(async () => new Response(Buffer.from('not an image'), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })),
    });

    await expect(state.imageUploader('https://images.example.test/photo.jpg')).resolves.toBeNull();

    expect(state.upload).not.toHaveBeenCalled();
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]).toContain('not a supported JPEG, PNG, or WebP');
  });

  it('rejects an explicit image MIME that conflicts with the detected bytes', async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const state = makeUploader({
      fetchImage: vi.fn(async () => new Response(jpegBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
    });

    await expect(state.imageUploader('https://images.example.test/photo.jpg')).resolves.toBeNull();

    expect(state.upload).not.toHaveBeenCalled();
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]).toContain('conflicts with detected image/jpeg');
  });

  it('does not reuse media with the same filename and a different detected image type', async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const otherBytes = pngBytes();
    const otherHash = createHash('sha256').update(otherBytes).digest('hex');
    const upload = vi.fn(async () => 91);
    const state = makeUploader({
      knownMediaByHash: new Map([[otherHash, 219]]),
      mediaById: new Map([[219, { id: 219, name: 'portrait.png', mime: 'image/png' }]]),
      fetchImage: vi.fn(async () => new Response(jpegBytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })),
      upload,
    });

    await expect(state.imageUploader('https://images.example.test/portrait.png')).resolves.toBe(91);

    expect(upload).toHaveBeenCalledWith(jpegBytes, 'portrait.png', 'image/jpeg');
    expect(state.persistIdentity).toHaveBeenCalledWith(expect.objectContaining({ fileId: 91 }));
    expect(state.failures).toEqual([]);
  });

  it('uploads a new URL when its related file already has an identity for another source', async () => {
    const oldUrl = 'https://images.example.test/old/same.png';
    const newUrl = 'https://images.example.test/new/same.png';
    const oldHash = createHash('sha256').update('old raw bytes').digest('hex');
    const newBytes = pngBytes(2);
    const state = makeUploader({
      mediaById: new Map([[219, {
        id: 219,
        name: 'same.png',
        mime: 'image/png',
      provider_metadata: {
          ikpk_media_import: { sources: { [oldUrl]: { version: 1, sha256: oldHash, storedSha256: 'c'.repeat(64) } } },
        },
      }]]),
      fetchImage: vi.fn(async () => new Response(newBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
      upload: vi.fn(async () => 310),
    });

    await expect(state.imageUploader(newUrl, { entityKey: 'teachers:legacy-7:photo:0', fileId: 219 })).resolves.toBe(310);

    expect(state.upload).toHaveBeenCalledOnce();
    expect(state.persistIdentity).toHaveBeenCalledWith(expect.objectContaining({ fileId: 310, sourceUrl: newUrl }));
    expect(state.persistIdentity).not.toHaveBeenCalledWith(expect.objectContaining({ fileId: 219 }));
  });

  it('treats an older unversioned source identity as a claim that blocks legacy adoption', async () => {
    const oldUrl = 'https://images.example.test/old/same.png';
    const newUrl = 'https://images.example.test/new/same.png';
    const oldHash = createHash('sha256').update(pngBytes(3)).digest('hex');
    const newBytes = pngBytes(4);
    const state = makeUploader({
      mediaById: new Map([[219, {
        id: 219,
        name: 'same.png',
        mime: 'image/png',
        provider_metadata: { ikpk_media_import: { sources: { [oldUrl]: { sha256: oldHash } } } },
      }]]),
      storedHashById: new Map([[219, createHash('sha256').update('stored legacy image').digest('hex')]]),
      fetchImage: vi.fn(async () => new Response(newBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
      upload: vi.fn(async () => 312),
    });

    await expect(state.imageUploader(newUrl, { entityKey: 'teachers:legacy-8:photo:0', fileId: 219 })).resolves.toBe(312);

    expect(state.upload).toHaveBeenCalledOnce();
    expect(state.persistIdentity).not.toHaveBeenCalledWith(expect.objectContaining({ fileId: 219 }));
  });

  it('does not deduplicate same filenames when their bytes differ', async () => {
    const bytes = pngBytes(5);
    const otherHash = createHash('sha256').update(pngBytes(6)).digest('hex');
    const state = makeUploader({
      knownMediaByHash: new Map([[otherHash, 219]]),
      fetchImage: vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
      upload: vi.fn(async () => 91),
    });

    await expect(state.imageUploader('https://images.example.test/same-name.png')).resolves.toBe(91);

    expect(state.upload).toHaveBeenCalledOnce();
    expect(state.knownMediaBySourceHash.get(createHash('sha256').update(bytes).digest('hex'))).toBe(91);
  });

  it('uploads changed source bytes instead of reusing a relation adopted on an earlier run', async () => {
    const sourceUrl = 'https://images.example.test/same-name.png';
    const previousHash = createHash('sha256').update(pngBytes(7)).digest('hex');
    const changedBytes = pngBytes(8);
    const state = makeUploader({
      knownMediaBySourceHash: new Map([[previousHash, 219]]),
      mediaById: new Map([[219, {
        id: 219,
        name: 'same-name.png',
        mime: 'image/png',
        provider_metadata: {
          ikpk_media_import: { sources: { [sourceUrl]: {
            version: 1,
            sha256: previousHash,
            storedSha256: createHash('sha256').update('stored previous bytes').digest('hex'),
          } } },
        },
      }]]),
      fetchImage: vi.fn(async () => new Response(changedBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
      upload: vi.fn(async () => 310),
    });

    await expect(state.imageUploader(sourceUrl, { entityKey: 'articles:legacy-42:image:0', fileId: 219 })).resolves.toBe(310);

    expect(state.upload).toHaveBeenCalledOnce();
    expect(state.persistIdentity).toHaveBeenCalledWith({
      fileId: 310,
      sourceUrl,
      sourceSha256: createHash('sha256').update(changedBytes).digest('hex'),
    });
  });

  it('does not reuse an old source identity after its Strapi file was replaced in place', async () => {
    const sourceUrl = 'https://images.example.test/replaced.png';
    const sourceBytes = pngBytes(9);
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
    const replacementBytes = Buffer.from('built-in replacement bytes');
    const replacementHash = createHash('sha256').update(replacementBytes).digest('hex');
    const state = makeUploader({
      knownMediaByHash: new Map([[replacementHash, 219]]),
      storedHashById: new Map([[219, replacementHash]]),
      knownMediaBySourceHash: new Map(),
      mediaById: new Map([[219, {
        id: 219,
        name: 'replaced.png',
        mime: 'image/png',
        provider_metadata: {
          ikpk_media_import: { sources: { [sourceUrl]: {
            version: 1,
            sha256: sourceHash,
            storedSha256: createHash('sha256').update('before replacement').digest('hex'),
          } } },
        },
      }]]),
      fetchImage: vi.fn(async () => new Response(sourceBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
      upload: vi.fn(async () => 311),
    });

    await expect(state.imageUploader(sourceUrl, { entityKey: 'teachers:legacy-12:photo:0', fileId: 219 })).resolves.toBe(311);

    expect(state.upload).toHaveBeenCalledOnce();
    expect(state.persistIdentity).toHaveBeenCalledWith(expect.objectContaining({ fileId: 311, sourceUrl, sourceSha256: sourceHash }));
  });

  it('does not reuse a source identity whose media ID is no longer in the live CMS inventory', async () => {
    const bytes = pngBytes(10);
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    const state = makeUploader({
      knownMediaBySourceHash: new Map([[sourceHash, 999]]),
      mediaById: new Map(),
      fetchImage: vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
      upload: vi.fn(async () => 311),
    });

    await expect(state.imageUploader('https://images.example.test/deleted.png')).resolves.toBe(311);

    expect(state.upload).toHaveBeenCalledOnce();
    expect(state.failures).toEqual([]);
  });

  it('uses the matching content ID for each of the three approved local logo relations', async () => {
    const knownMediaByHash = new Map<string, number>();
    const expectedIds = new Map<string, number>();
    for (const [index, key] of legacyImages.entries()) {
      const filename = key.split('/').at(-1)!;
      const bytes = await readFile(join(root, 'media-originals', 'legacy', filename));
      const hash = createHash('sha256').update(bytes).digest('hex');
      const id = 310 + index;
      knownMediaByHash.set(hash, id);
      expectedIds.set(key, id);
    }

    const state = makeUploader({
      knownMediaByHash,
      mediaById: new Map([...knownMediaByHash.values()].map((id) => [id, { id }])),
    });
    for (const [key, id] of expectedIds) {
      await expect(state.imageUploader(key)).resolves.toBe(id);
    }

    expect(state.fetchImage).not.toHaveBeenCalled();
    expect(state.upload).not.toHaveBeenCalled();
    expect([...state.knownMediaBySourceHash.values()]).toEqual([310, 311, 312]);
    expect(state.failures).toEqual([]);
  });

  it.each([
    'media/legacy/logo-v2.png',
    '/media/legacy/unknown.png',
    '/media/legacy/../logo-v2.png',
    '/media/legacy/%2e%2e/logo-v2.png',
    '/etc/passwd',
    '//example.com/logo.png',
    'https://[malformed',
    'https://images.example.test/%ZZ',
  ])('rejects unapproved or malformed target %s without fetch or file upload', async (target) => {
    const state = makeUploader();

    await expect(state.imageUploader(target)).resolves.toBeNull();

    expect(state.fetchImage).not.toHaveBeenCalled();
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.failures).toHaveLength(1);
  });

  it('keeps remote HTTP(S) fetching and upload behavior', async () => {
    const bytes = pngBytes(11);
    const fetchImage = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    const upload = vi.fn(async () => 91);
    const state = makeUploader({ fetchImage, upload });

    await expect(state.imageUploader('https://images.example.test/photo.png')).resolves.toBe(91);

    expect(fetchImage).toHaveBeenCalledWith('https://images.example.test/photo.png');
    expect(upload).toHaveBeenCalledWith(bytes, 'photo.png', 'image/png');
    expect(state.failures).toEqual([]);
  });

  it('wires the returned upload ID to the institute image relation through Strapi upload API', async () => {
    const importer = await readFile(join(import.meta.dirname, '..', 'import.ts'), 'utf8');
    expect(importer).toMatch(/const uploadImportedImage = createImageUploader\(/);
    expect(importer).toMatch(/api<unknown\[]>\("POST", "\/api\/upload"/);
    expect(importer).toMatch(/if \(imgId\) data\.image = imgId/);
    expect(importer).toMatch(/const imgId = await uploadImage\(extractImageUrl\(e\.images\), \{ apiName: "institutes", legacyId: String\(e\.legacy_id\), field: "image" \}, report\)/);
    expect(importer).toMatch(/if \(imgId === false\) continue/);
  });
});
