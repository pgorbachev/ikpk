import { readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { mediaKey } from './cms-migration.js';

const APPROVED_LOCAL_IMAGES = new Map<string, string>([
  ['/media/legacy/logo-v2.png', 'logo-v2.png'],
  ['/media/legacy/logo-upledger-inst.png', 'logo-upledger-inst.png'],
  ['/media/legacy/logo-barral-inst.png', 'logo-barral-inst.png'],
]);

export interface ImportMediaCacheEntry {
  fileId: number;
  hash: string;
}

interface ImageSource {
  bytes: Buffer;
  filename: string;
  mime: string;
}

interface ImageUploaderOptions {
  root: string;
  mediaCacheByUrl: Map<string, ImportMediaCacheEntry>;
  knownMediaByHash: Map<string, number>;
  fetchImage?: (url: string) => Promise<Response>;
  upload: (bytes: Buffer, filename: string, mime: string) => Promise<number | null | undefined>;
  saveCache: () => Promise<void>;
  onFailure: (url: string, error: string) => void;
}

async function localSource(root: string, filename: string): Promise<ImageSource> {
  const realRoot = await realpath(root);
  const directory = resolve(realRoot, 'media-originals', 'legacy');
  const expectedPath = join(directory, filename);
  const [realDirectory, actualPath] = await Promise.all([realpath(directory), realpath(expectedPath)]);
  if (realDirectory !== directory || actualPath !== expectedPath) {
    throw new Error('approved local image resolved outside its exact repository path');
  }
  return { bytes: await readFile(actualPath), filename: basename(actualPath), mime: 'image/png' };
}

async function remoteSource(fetchImage: (url: string) => Promise<Response>, url: string): Promise<ImageSource> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('image source must be an absolute HTTP(S) URL or an approved local key');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('image source protocol is not allowed');
  }
  const filename = decodeURIComponent(basename(parsed.pathname)) || 'image.jpg';
  const response = await fetchImage(url);
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    filename,
    mime: response.headers.get('content-type') || 'application/octet-stream',
  };
}

/** Uploads imported images and keeps the transfer's persistent URL/content cache. */
export function createImageUploader(options: ImageUploaderOptions): (url: string | null) => Promise<number | null> {
  const fetchImage = options.fetchImage ?? ((url: string) => fetch(url));
  return async (url) => {
    if (!url) return null;

    try {
      const localFilename = APPROVED_LOCAL_IMAGES.get(url);
      const source = localFilename
        ? await localSource(options.root, localFilename)
        : await remoteSource(fetchImage, url);
      const hash = mediaKey({ bytes: new Uint8Array(source.bytes), sourceUrl: url });
      const reusedFileId = options.knownMediaByHash.get(hash);
      if (reusedFileId) {
        options.mediaCacheByUrl.set(url, { fileId: reusedFileId, hash });
        await options.saveCache();
        return reusedFileId;
      }

      const fileId = await options.upload(source.bytes, source.filename, source.mime);
      if (!fileId) throw new Error(`upload returned no media ID for ${source.filename}`);
      options.mediaCacheByUrl.set(url, { fileId, hash });
      options.knownMediaByHash.set(hash, fileId);
      await options.saveCache();
      return fileId;
    } catch (error: unknown) {
      options.onFailure(url, error instanceof Error ? error.message : String(error));
      return null;
    }
  };
}
