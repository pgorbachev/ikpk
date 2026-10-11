import { readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { mediaKey } from './cms-migration.js';

const APPROVED_LOCAL_IMAGES = new Map<string, string>([
  ['/media/legacy/logo-v2.png', 'logo-v2.png'],
  ['/media/legacy/logo-upledger-inst.png', 'logo-upledger-inst.png'],
  ['/media/legacy/logo-barral-inst.png', 'logo-barral-inst.png'],
]);

export interface ImportableMediaFile {
  id: number;
  name?: string;
  mime?: string;
  provider_metadata?: unknown;
}

export interface MediaRelationContext {
  entityKey: string;
  fileId?: number;
}

interface ImageSource {
  bytes: Buffer;
  filename: string;
  mime: string;
}

interface ImageUploaderOptions {
  root: string;
  knownMediaByHash: Map<string, number>;
  knownMediaBySourceHash: Map<string, number>;
  storedHashById: Map<number, string>;
  mediaById: Map<number, ImportableMediaFile>;
  fetchImage?: (url: string) => Promise<Response>;
  upload: (bytes: Buffer, filename: string, mime: string) => Promise<number | null | undefined>;
  persistIdentity: (identity: {
    fileId: number;
    sourceUrl: string;
    sourceSha256: string;
    expectedStoredSha256?: string;
    adoptedFrom?: string;
  }) => Promise<string>;
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

function hasSourceClaims(providerMetadata: unknown): boolean {
  if (!providerMetadata || typeof providerMetadata !== 'object' || Array.isArray(providerMetadata)) return false;
  const imported = (providerMetadata as Record<string, unknown>).ikpk_media_import;
  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) return false;
  const sources = (imported as Record<string, unknown>).sources;
  return Boolean(sources && typeof sources === 'object' && !Array.isArray(sources) && Object.keys(sources).length);
}

/** Uploads imported images using the current CMS inventory as authoritative identity state. */
export function createImageUploader(
  options: ImageUploaderOptions,
): (url: string | null, relation?: MediaRelationContext) => Promise<number | null> {
  const fetchImage = options.fetchImage ?? ((url: string) => fetch(url));
  return async (url, relation?: MediaRelationContext) => {
    if (!url) return null;

    try {
      const localFilename = APPROVED_LOCAL_IMAGES.get(url);
      const source = localFilename
        ? await localSource(options.root, localFilename)
        : await remoteSource(fetchImage, url);
      const hash = mediaKey({ bytes: new Uint8Array(source.bytes), sourceUrl: url });
      const persistedSourceId = liveFileId(options.knownMediaBySourceHash.get(hash));
      const storedByteId = liveFileId(options.knownMediaByHash.get(hash));
      const reusedFileId = persistedSourceId ?? storedByteId;
      if (reusedFileId !== undefined) {
        const expectedStoredSha256 = options.storedHashById.get(reusedFileId) ??
          (storedByteId === reusedFileId ? hash : undefined);
        if (!expectedStoredSha256 || !/^[a-f0-9]{64}$/.test(expectedStoredSha256)) {
          throw new Error('verified CMS inventory has no stored-byte fingerprint for reused media');
        }
        const storedSha256 = await options.persistIdentity({
          fileId: reusedFileId,
          sourceUrl: url,
          sourceSha256: hash,
          expectedStoredSha256,
        });
        if (storedSha256 !== expectedStoredSha256) {
          throw new Error('identity endpoint fingerprint differs from the verified CMS inventory');
        }
        options.knownMediaBySourceHash.set(hash, reusedFileId);
        rememberIdentity(reusedFileId, url, hash, storedSha256);
        return reusedFileId;
      }

      const relatedFileId = liveFileId(relation?.fileId);
      const relatedFile = relatedFileId === undefined ? undefined : options.mediaById.get(relatedFileId);
      const storedSha256 = relatedFileId === undefined ? undefined : options.storedHashById.get(relatedFileId);
      if (
        relatedFile && !hasSourceClaims(relatedFile.provider_metadata) && storedSha256 &&
        relatedFile.name === source.filename && relatedFile.mime === source.mime
      ) {
        // Adopt only genuinely unclaimed legacy files. The server checks that the stored bytes
        // still match the inventory fingerprint before recording the raw source identity.
        const adoptedStoredSha256 = await options.persistIdentity({
          fileId: relatedFile.id,
          sourceUrl: url,
          sourceSha256: hash,
          expectedStoredSha256: storedSha256,
          adoptedFrom: relation!.entityKey,
        });
        if (adoptedStoredSha256 !== storedSha256) {
          throw new Error('identity endpoint fingerprint differs from the verified CMS inventory');
        }
        options.knownMediaBySourceHash.set(hash, relatedFile.id);
        rememberIdentity(relatedFile.id, url, hash, adoptedStoredSha256, relation!.entityKey);
        return relatedFile.id;
      }

      const fileId = await options.upload(source.bytes, source.filename, source.mime);
      if (!fileId) throw new Error(`upload returned no media ID for ${source.filename}`);
      const storedHash = await options.persistIdentity({ fileId, sourceUrl: url, sourceSha256: hash });
      if (!/^[a-f0-9]{64}$/.test(storedHash)) throw new Error('identity endpoint returned no valid stored SHA-256');
      options.knownMediaByHash.set(hash, fileId);
      options.knownMediaBySourceHash.set(hash, fileId);
      options.storedHashById.set(fileId, storedHash);
      options.mediaById.set(fileId, {
        id: fileId,
        name: source.filename,
        mime: source.mime,
        provider_metadata: {
          ikpk_media_import: { sources: { [url]: { version: 1, sha256: hash, storedSha256: storedHash } } },
        },
      });
      return fileId;
    } catch (error: unknown) {
      options.onFailure(url, error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  function liveFileId(fileId: number | undefined): number | undefined {
    return fileId !== undefined && options.mediaById.has(fileId) ? fileId : undefined;
  }

  function rememberIdentity(
    fileId: number,
    sourceUrl: string,
    sourceSha256: string,
    storedSha256: string,
    adoptedFrom?: string,
  ): void {
    const file = options.mediaById.get(fileId);
    if (!file) return;
    const metadata = file.provider_metadata && typeof file.provider_metadata === 'object'
      ? file.provider_metadata as Record<string, unknown>
      : {};
    const imported = metadata.ikpk_media_import && typeof metadata.ikpk_media_import === 'object'
      ? metadata.ikpk_media_import as Record<string, unknown>
      : {};
    const sources = imported.sources && typeof imported.sources === 'object'
      ? imported.sources as Record<string, unknown>
      : {};
    options.mediaById.set(fileId, {
      ...file,
      provider_metadata: {
        ...metadata,
        ikpk_media_import: {
          ...imported,
          sources: {
            ...sources,
            [sourceUrl]: {
              version: 1,
              sha256: sourceSha256,
              storedSha256,
              ...(adoptedFrom ? { adoptedFrom } : {}),
            },
          },
        },
      },
    });
  }
}
