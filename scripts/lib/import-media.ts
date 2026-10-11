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
  mediaById: Map<number, ImportableMediaFile>;
  fetchImage?: (url: string) => Promise<Response>;
  upload: (bytes: Buffer, filename: string, mime: string) => Promise<number | null | undefined>;
  persistIdentity: (identity: {
    fileId: number;
    sourceUrl: string;
    sourceSha256: string;
    adoptedFrom?: string;
  }) => Promise<void>;
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

function sourceHashForUrl(providerMetadata: unknown, sourceUrl: string): string | undefined {
  if (!providerMetadata || typeof providerMetadata !== 'object' || Array.isArray(providerMetadata)) return undefined;
  const imported = (providerMetadata as Record<string, unknown>).ikpk_media_import;
  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) return undefined;
  const sources = (imported as Record<string, unknown>).sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return undefined;
  const identity = (sources as Record<string, unknown>)[sourceUrl];
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return undefined;
  const hash = (identity as Record<string, unknown>).sha256;
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
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
        await options.persistIdentity({ fileId: reusedFileId, sourceUrl: url, sourceSha256: hash });
        options.knownMediaBySourceHash.set(hash, reusedFileId);
        rememberIdentity(reusedFileId, url, hash);
        return reusedFileId;
      }

      const relatedFileId = liveFileId(relation?.fileId);
      const relatedFile = relatedFileId === undefined ? undefined : options.mediaById.get(relatedFileId);
      const priorSourceHash = relatedFile && sourceHashForUrl(relatedFile.provider_metadata, url);
      const priorSourceChanged = priorSourceHash !== undefined && priorSourceHash !== hash;
      if (
        relatedFile && !priorSourceChanged && relatedFile.name === source.filename && relatedFile.mime === source.mime
      ) {
        // One-time baseline adoption: Strapi 5.51.2 re-encodes images before storing them,
        // so the served bytes cannot prove the raw source hash. Trust only the current
        // entity's exact relation slot plus URL, filename and MIME. That first observation
        // records the current raw hash; future imports compare that hash and replace on change.
        await options.persistIdentity({
          fileId: relatedFile.id,
          sourceUrl: url,
          sourceSha256: hash,
          adoptedFrom: relation!.entityKey,
        });
        options.knownMediaBySourceHash.set(hash, relatedFile.id);
        rememberIdentity(relatedFile.id, url, hash, relation!.entityKey);
        return relatedFile.id;
      }

      const fileId = await options.upload(source.bytes, source.filename, source.mime);
      if (!fileId) throw new Error(`upload returned no media ID for ${source.filename}`);
      await options.persistIdentity({ fileId, sourceUrl: url, sourceSha256: hash });
      options.knownMediaByHash.set(hash, fileId);
      options.knownMediaBySourceHash.set(hash, fileId);
      options.mediaById.set(fileId, {
        id: fileId,
        name: source.filename,
        mime: source.mime,
        provider_metadata: {
          ikpk_media_import: { sources: { [url]: { sha256: hash } } },
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

  function rememberIdentity(fileId: number, sourceUrl: string, sourceSha256: string, adoptedFrom?: string): void {
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
            [sourceUrl]: { sha256: sourceSha256, ...(adoptedFrom ? { adoptedFrom } : {}) },
          },
        },
      },
    });
  }
}
