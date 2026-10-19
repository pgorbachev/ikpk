import { createHash } from 'node:crypto';

interface MediaFile {
  id: number;
  url: string;
  name?: string;
  mime?: string;
  provider_metadata?: unknown;
}

interface MediaPage {
  data: unknown;
  meta: {
    pagination: {
      page: number;
      pageCount: number;
      total: number;
    };
  };
}

interface StrapiMediaInventoryOptions {
  getPage: (page: number, pageSize: number) => Promise<unknown>;
  getBytes: (url: string) => Promise<Uint8Array>;
  baseUrl: string;
  pageSize?: number;
}

export interface StrapiMediaInventory {
  byStoredHash: Map<string, number>;
  bySourceHash: Map<string, number>;
  storedHashById: Map<number, string>;
  mediaById: Map<number, MediaFile>;
}

function parsePage(value: unknown, requestedPage: number): MediaPage {
  if (!value || typeof value !== 'object') throw new Error('Strapi media page is not an object');
  const response = value as Partial<MediaPage>;
  const pagination = response.meta?.pagination;
  if (!Array.isArray(response.data) || !pagination) {
    throw new Error('Strapi media page is missing data or pagination metadata');
  }
  if (
    !Number.isInteger(pagination.page) || pagination.page !== requestedPage ||
    !Number.isInteger(pagination.pageCount) || pagination.pageCount < 0 ||
    !Number.isInteger(pagination.total) || pagination.total < 0
  ) {
    throw new Error(`Strapi media page has invalid pagination metadata for page ${requestedPage}`);
  }
  return response as MediaPage;
}

function parseFiles(data: unknown[], page: number): MediaFile[] {
  return data.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`Strapi media page ${page} item ${index + 1} is not an object`);
    }
    const file = value as Partial<MediaFile>;
    if (!Number.isSafeInteger(file.id) || (file.id ?? 0) <= 0 || typeof file.url !== 'string' || !file.url) {
      throw new Error(`Strapi media page ${page} item ${index + 1} has no valid id or url`);
    }
    return {
      id: file.id!,
      url: file.url,
      ...(typeof file.name === 'string' ? { name: file.name } : {}),
      ...(typeof file.mime === 'string' ? { mime: file.mime } : {}),
      ...(file.provider_metadata !== undefined ? { provider_metadata: file.provider_metadata } : {}),
    };
  });
}

export function allowedSourceUrl(value: string): boolean {
  if (value.length > 2048) return false;
  if (/^\/media\/legacy\/(?:logo-v2|logo-upledger-inst|logo-barral-inst)\.png$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Canonical five-segment SQL storage key; this is an identity, never a fetch URL. */
export function allowedSqlStorageKey(value: string): boolean {
  if (value.length > 512 || value.includes('\\') || value.includes('%') || value.includes('?') || value.includes('#')) return false;
  const segments = value.split('/');
  return segments.length === 5 && segments[0] === 'media' &&
    segments.slice(1).every((segment) => /^[A-Za-z0-9._~-]+$/.test(segment) && segment !== '.' && segment !== '..');
}

export function allowedSourceIdentity(value: string): boolean {
  return allowedSourceUrl(value) || allowedSqlStorageKey(value);
}

/** Build a content-hash index from the actual bytes in Strapi's paginated media library. */
export async function buildStrapiMediaInventory(
  options: StrapiMediaInventoryOptions,
): Promise<StrapiMediaInventory> {
  const pageSize = options.pageSize ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('Strapi media page size must be positive');

  const firstPage = parsePage(await options.getPage(1, pageSize), 1);
  const { pageCount, total } = firstPage.meta.pagination;
  if ((total === 0) !== (pageCount === 0)) {
    throw new Error('Strapi media inventory has inconsistent empty pagination metadata');
  }
  const pages = [firstPage];
  for (let page = 2; page <= pageCount; page++) {
    const response = parsePage(await options.getPage(page, pageSize), page);
    if (
      response.meta.pagination.pageCount !== pageCount ||
      response.meta.pagination.total !== total
    ) {
      throw new Error('Strapi media inventory changed while pagination was being read');
    }
    pages.push(response);
  }

  const files = pages.flatMap((page, index) => parseFiles(page.data as unknown[], index + 1));
  if (files.length !== total) {
    throw new Error(`Strapi media inventory is incomplete: expected ${total} files, received ${files.length}`);
  }

  const seenIds = new Set<number>();
  for (const file of files) {
    if (seenIds.has(file.id)) throw new Error(`Strapi media inventory contains duplicate file ID ${file.id}`);
    seenIds.add(file.id);
  }

  const hashes = new Array<string>(files.length);
  let nextFile = 0;
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (nextFile < files.length) {
      const index = nextFile++;
      const file = files[index];
      const url = new URL(file.url, options.baseUrl).toString();
      const bytes = await options.getBytes(url);
      hashes[index] = createHash('sha256').update(bytes).digest('hex');
    }
  });
  await Promise.all(workers);

  const byStoredHash = new Map<string, number>();
  const bySourceHash = new Map<string, number>();
  const storedHashById = new Map(files.map((file, index) => [file.id, hashes[index]]));
  const mediaById = new Map(files.map((file) => [file.id, file]));
  for (const [fileIndex, file] of files.entries()) {
    const storedHash = hashes[fileIndex];
    const currentStoredId = byStoredHash.get(storedHash);
    if (currentStoredId === undefined || file.id < currentStoredId) byStoredHash.set(storedHash, file.id);

    const providerMetadata = file.provider_metadata;
    if (!providerMetadata || typeof providerMetadata !== 'object' || Array.isArray(providerMetadata)) continue;
    const imported = (providerMetadata as Record<string, unknown>).ikpk_media_import;
    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) continue;
    const sources = (imported as Record<string, unknown>).sources;
    if (!sources || typeof sources !== 'object' || Array.isArray(sources)) continue;
    for (const [sourceUrl, identity] of Object.entries(sources as Record<string, unknown>)) {
      if (!allowedSourceIdentity(sourceUrl)) continue;
      if (!identity || typeof identity !== 'object' || Array.isArray(identity)) continue;
      const identityRecord = identity as Record<string, unknown>;
      const sourceHash = identityRecord.sha256;
      const storedSha256 = identityRecord.storedSha256;
      if (
        identityRecord.version !== 1 || typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash) ||
        typeof storedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(storedSha256) || storedSha256 !== storedHash
      ) continue;
      const currentSourceId = bySourceHash.get(sourceHash);
      if (currentSourceId === undefined || file.id < currentSourceId) bySourceHash.set(sourceHash, file.id);
    }
  }
  return { byStoredHash, bySourceHash, storedHashById, mediaById };
}

/** Backwards-compatible stored-byte index for callers that only need byte equality. */
export async function buildStrapiMediaHashIndex(
  options: StrapiMediaInventoryOptions,
): Promise<Map<string, number>> {
  return (await buildStrapiMediaInventory(options)).byStoredHash;
}
