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

function makeUploader(overrides: Partial<Parameters<typeof createImageUploader>[0]> = {}) {
  const mediaCacheByUrl = new Map<string, { fileId: number; hash: string }>();
  const knownMediaByHash = new Map<string, number>();
  const failures: string[] = [];
  const fetchImage = vi.fn(async () => { throw new Error('unexpected fetch'); });
  const configuredFetchImage = overrides.fetchImage ?? fetchImage;
  const upload = vi.fn(async (...args: [Buffer, string, string]) => {
    void args;
    return 73;
  });
  const configuredUpload = overrides.upload ? vi.fn(overrides.upload) : upload;
  const saveCache = vi.fn(async () => undefined);
  const imageUploader = createImageUploader({
    root,
    mediaCacheByUrl,
    knownMediaByHash,
    fetchImage: configuredFetchImage,
    saveCache,
    onFailure: (url, error) => failures.push(`${url}: ${error}`),
    ...overrides,
    upload: configuredUpload,
  });
  return { imageUploader, mediaCacheByUrl, knownMediaByHash, fetchImage: configuredFetchImage, upload: configuredUpload, saveCache, failures };
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
    expect(state.mediaCacheByUrl.get(key)?.fileId).toBe(73);
  });

  it('reuses saved URL/hash cache on a repeated run without another fetch or upload', async () => {
    const first = makeUploader();
    await expect(first.imageUploader(legacyImages[0])).resolves.toBe(73);
    const savedCache = JSON.parse(JSON.stringify(Object.fromEntries(first.mediaCacheByUrl)));
    const mediaCacheByUrl = new Map(Object.entries(savedCache) as [string, { fileId: number; hash: string }][]);
    const hash = mediaCacheByUrl.get(legacyImages[0])!.hash;
    mediaCacheByUrl.set(legacyImages[0], { fileId: 999, hash });
    const knownMediaByHash = new Map([[hash, 73]]);
    const second = makeUploader({ mediaCacheByUrl, knownMediaByHash });

    await expect(second.imageUploader(legacyImages[0])).resolves.toBe(73);

    expect(second.fetchImage).not.toHaveBeenCalled();
    expect(second.upload).not.toHaveBeenCalled();
    expect(second.failures).toEqual([]);
  });

  it('reuses content hash across source URLs without creating a second media upload', async () => {
    const first = makeUploader();
    await expect(first.imageUploader(legacyImages[0])).resolves.toBe(73);
    const { hash } = first.mediaCacheByUrl.get(legacyImages[0])!;
    const bytes = await readFile(join(root, 'media-originals', 'legacy', 'logo-v2.png'));
    const second = makeUploader({
      knownMediaByHash: new Map([[hash, 73]]),
      fetchImage: vi.fn(async () => new Response(bytes, { status: 200 })),
    });

    await expect(second.imageUploader('https://images.example.test/same-content.png')).resolves.toBe(73);

    expect(second.fetchImage).toHaveBeenCalledOnce();
    expect(second.upload).not.toHaveBeenCalled();
    expect(second.mediaCacheByUrl.get('https://images.example.test/same-content.png')?.hash).toBe(hash);
    expect(second.failures).toEqual([]);
  });

  it('reuses byte-identical CMS media when the local cache is empty', async () => {
    const bytes = await readFile(join(root, 'media-originals', 'legacy', 'logo-v2.png'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const state = makeUploader({
      knownMediaByHash: new Map([[hash, 219]]),
    });

    await expect(state.imageUploader(legacyImages[0])).resolves.toBe(219);

    expect(state.upload).not.toHaveBeenCalled();
    expect(state.mediaCacheByUrl.get(legacyImages[0])).toEqual({ fileId: 219, hash });
    expect(state.failures).toEqual([]);
  });

  it('does not deduplicate same filenames when their bytes differ', async () => {
    const bytes = Buffer.from('different bytes');
    const otherHash = createHash('sha256').update('other bytes').digest('hex');
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
    expect(state.mediaCacheByUrl.get('https://images.example.test/same-name.png')?.hash)
      .toBe(createHash('sha256').update(bytes).digest('hex'));
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

    const state = makeUploader({ knownMediaByHash });
    for (const [key, id] of expectedIds) {
      await expect(state.imageUploader(key)).resolves.toBe(id);
    }

    expect(state.fetchImage).not.toHaveBeenCalled();
    expect(state.upload).not.toHaveBeenCalled();
    expect([...state.mediaCacheByUrl.values()].map(({ fileId }) => fileId)).toEqual([310, 311, 312]);
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
    const bytes = Buffer.from('remote-image');
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
    expect(importer).toMatch(/const imgId = await uploadImage\(extractImageUrl\(e\.images\)\)/);
  });
});
