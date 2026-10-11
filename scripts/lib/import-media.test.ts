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
  const mediaCacheByHash = new Map<string, number>();
  const failures: string[] = [];
  const fetchImage = vi.fn(async () => { throw new Error('unexpected fetch'); });
  const configuredFetchImage = overrides.fetchImage ?? fetchImage;
  const upload = vi.fn(async (...args: [Buffer, string, string]) => {
    void args;
    return 73;
  });
  const saveCache = vi.fn(async () => undefined);
  const imageUploader = createImageUploader({
    root,
    mediaCacheByUrl,
    mediaCacheByHash,
    fetchImage: configuredFetchImage,
    upload,
    saveCache,
    onFailure: (url, error) => failures.push(`${url}: ${error}`),
    ...overrides,
  });
  return { imageUploader, mediaCacheByUrl, mediaCacheByHash, fetchImage: configuredFetchImage, upload, saveCache, failures };
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
    const mediaCacheByHash = new Map([...mediaCacheByUrl.values()].map(({ fileId, hash }) => [hash, fileId]));
    const second = makeUploader({ mediaCacheByUrl, mediaCacheByHash });

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
      mediaCacheByHash: new Map([[hash, 73]]),
      fetchImage: vi.fn(async () => new Response(bytes, { status: 200 })),
    });

    await expect(second.imageUploader('https://images.example.test/same-content.png')).resolves.toBe(73);

    expect(second.fetchImage).toHaveBeenCalledOnce();
    expect(second.upload).not.toHaveBeenCalled();
    expect(second.mediaCacheByUrl.get('https://images.example.test/same-content.png')?.hash).toBe(hash);
    expect(second.failures).toEqual([]);
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
