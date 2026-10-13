import { describe, expect, it, vi } from 'vitest';
import { allowedSourceUrl, buildStrapiMediaHashIndex, buildStrapiMediaInventory } from './strapi-media-inventory.js';

function page(data: unknown[], pageNumber: number, pageCount: number, total: number) {
  return { data, meta: { pagination: { page: pageNumber, pageCount, total } } };
}

describe('Strapi media content inventory', () => {
  it('accepts only the exact approved relative legacy media identities alongside safe absolute URLs', () => {
    expect(allowedSourceUrl('/media/legacy/logo-v2.png')).toBe(true);
    expect(allowedSourceUrl('/media/legacy/logo-upledger-inst.png')).toBe(true);
    expect(allowedSourceUrl('/media/legacy/logo-barral-inst.png')).toBe(true);
    expect(allowedSourceUrl('/media/legacy/other.png')).toBe(false);
    expect(allowedSourceUrl('//outside.example/logo.png')).toBe(false);
    expect(allowedSourceUrl('https://user:pass@images.example/logo.png')).toBe(false);
    expect(allowedSourceUrl('https://images.example/logo.png')).toBe(true);
  });

  it('reads every page beyond the first 100 items', async () => {
    const files = Array.from({ length: 205 }, (_, index) => ({ id: index + 1, url: `/uploads/${index}.png` }));
    const getPage = vi.fn(async (requestedPage: number) => {
      const start = (requestedPage - 1) * 100;
      return page(files.slice(start, start + 100), requestedPage, 3, files.length);
    });
    const getBytes = vi.fn(async (url: string) => Buffer.from(url));

    const index = await buildStrapiMediaHashIndex({ getPage, getBytes, baseUrl: 'https://cms.example.test' });

    expect(getPage.mock.calls.map(([requestedPage]) => requestedPage)).toEqual([1, 2, 3]);
    expect(getBytes).toHaveBeenCalledTimes(205);
    expect(index.size).toBe(205);
  });

  it('uses the lowest numeric ID for duplicate content matches', async () => {
    const getPage = vi.fn(async () => page([
      { id: 81, url: '/uploads/first-name.png' },
      { id: 7, url: '/uploads/other-name.png' },
    ], 1, 1, 2));
    const getBytes = vi.fn(async (url: string) => {
      void url;
      return Buffer.from('same bytes');
    });

    const index = await buildStrapiMediaHashIndex({ getPage, getBytes, baseUrl: 'https://cms.example.test' });
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update('same bytes').digest('hex');

    expect(index.get(hash)).toBe(7);
    expect(getBytes.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/uploads/first-name.png', '/uploads/other-name.png',
    ]);
  });

  it('rejects incomplete or failed inventories instead of returning a partial index', async () => {
    const getPage = vi.fn(async (requestedPage: number) => {
      if (requestedPage === 1) return page([{ id: 1, url: '/uploads/1.png' }], 1, 2, 2);
      throw new Error('page unavailable');
    });

    await expect(buildStrapiMediaHashIndex({
      getPage,
      getBytes: async () => Buffer.from('asset'),
      baseUrl: 'https://cms.example.test',
    })).rejects.toThrow('page unavailable');
  });

  it('rejects media-byte download failures rather than treating unknown bytes as unmatched', async () => {
    await expect(buildStrapiMediaHashIndex({
      getPage: async () => page([{ id: 1, url: '/uploads/1.png' }], 1, 1, 1),
      getBytes: async () => { throw new Error('media unavailable'); },
      baseUrl: 'https://cms.example.test',
    })).rejects.toThrow('media unavailable');
  });

  it('does not trust source identity when Strapi stored bytes no longer match its fingerprint', async () => {
    const sourceSha256 = 'a'.repeat(64);
    const getPage = vi.fn(async () => page([{
      id: 17,
      url: '/uploads/replaced.png',
      provider_metadata: {
        ikpk_media_import: {
          sources: {
            'https://images.example.test/original.png': {
              version: 1,
              sha256: sourceSha256,
              storedSha256: 'b'.repeat(64),
            },
          },
        },
      },
    }], 1, 1, 1));
    const inventory = await buildStrapiMediaInventory({
      getPage,
      getBytes: async () => Buffer.from('replacement bytes'),
      baseUrl: 'https://cms.example.test',
    });

    expect(inventory.bySourceHash.has(sourceSha256)).toBe(false);
  });
});
