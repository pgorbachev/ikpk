import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, extname, join, posix, resolve } from 'node:path';
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

export interface VerifiedOfflineImageSource extends ImageSource {
  sourceSha256: string;
  resolvedLocalPath: string;
}

interface OfflineMediaAllowlistEntry {
  sourceUrl: string;
  sourceIdentity: string;
  sourcePath: string;
  sourceSha256: string;
  sourceFilename: string;
  declaredMime: string;
  ownerApproved: boolean;
}

const GENERIC_IMAGE_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'application/binary',
  'application/x-octet-stream',
  'binary/octet-stream',
]);
const IMAGE_MIME_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
]);

function sniffImageMime(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.readUInt32LE(4) >= 8 &&
    bytes.readUInt32LE(4) <= bytes.length - 8 &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))
  ) {
    return 'image/webp';
  }
  throw new Error('image bytes are not a supported JPEG, PNG, or WebP');
}

function imageMimeFromBytes(bytes: Buffer, declaredMime: string): string {
  const detectedMime = sniffImageMime(bytes);
  const declared = declaredMime.split(';')[0].trim().toLowerCase();
  const normalizedDeclared = IMAGE_MIME_ALIASES.get(declared) ?? declared;
  if (!GENERIC_IMAGE_MIME_TYPES.has(normalizedDeclared) && normalizedDeclared !== detectedMime) {
    throw new Error(`image content type ${declared} conflicts with detected ${detectedMime}`);
  }
  return detectedMime;
}

interface ImageUploaderOptions {
  root: string;
  knownMediaByHash: Map<string, number>;
  knownMediaBySourceHash: Map<string, number>;
  storedHashById: Map<number, string>;
  mediaById: Map<number, ImportableMediaFile>;
  fetchImage?: (url: string) => Promise<Response>;
  offlineMedia?: {
    root: string;
    allowlist: readonly OfflineMediaAllowlistEntry[];
  };
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

/** Reads one pinned local raster source without network access or upload side effects. */
export async function readVerifiedOfflineImageSource(input: {
  root: string;
  sourceIdentity: string;
  sourcePath: string;
  sourceSha256: string;
  sourceFilename: string;
}): Promise<VerifiedOfflineImageSource> {
  if (
    typeof input.sourceIdentity !== 'string' || !input.sourceIdentity ||
    typeof input.sourcePath !== 'string' || !input.sourcePath ||
    input.sourcePath.includes('\\') || posix.isAbsolute(input.sourcePath) || /^[A-Za-z]:/.test(input.sourcePath) ||
    input.sourcePath.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
    posix.normalize(input.sourcePath) !== input.sourcePath
  ) {
    throw new Error('offline media source path is not a canonical relative path');
  }
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256)) {
    throw new Error(`offline media source SHA-256 is invalid for ${input.sourceIdentity}`);
  }
  if (
    typeof input.sourceFilename !== 'string' || !input.sourceFilename ||
    input.sourceFilename.includes('/') || input.sourceFilename.includes('\\') ||
    basename(input.sourceFilename) !== input.sourceFilename ||
    input.sourceFilename === '.' || input.sourceFilename === '..'
  ) {
    throw new Error(`offline media source filename is invalid for ${input.sourceIdentity}`);
  }

  const realRoot = await realpath(input.root);
  const expectedPath = resolve(realRoot, ...input.sourcePath.split('/'));
  const actualPath = await realpath(expectedPath);
  if (actualPath !== expectedPath) {
    throw new Error(`offline media source path contains a symbolic link or resolves outside its exact path for ${input.sourceIdentity}`);
  }

  const bytes = await readFile(actualPath);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  if (sourceSha256 !== input.sourceSha256) {
    throw new Error(`offline media source SHA-256 differs from the pin for ${input.sourceIdentity}`);
  }

  const mime = sniffImageMime(bytes);
  const extension = mime === 'image/jpeg' ? '.jpg' : mime === 'image/png' ? '.png' : '.webp';
  const originalExtension = extname(input.sourceFilename);
  const stem = basename(input.sourceFilename, originalExtension);
  if (!stem) throw new Error(`offline media source filename has no usable name for ${input.sourceIdentity}`);
  return {
    bytes,
    filename: `${stem}${extension}`,
    mime,
    sourceSha256,
    resolvedLocalPath: actualPath,
  };
}

async function offlineSource(
  offlineMedia: NonNullable<ImageUploaderOptions['offlineMedia']>,
  sourceUrl: string,
): Promise<ImageSource> {
  const entriesByUrl = new Map<string, OfflineMediaAllowlistEntry[]>();
  const identities = new Set<string>();
  const pathHashes = new Map<string, string>();

  for (const entry of offlineMedia.allowlist) {
    if (
      !entry || typeof entry.sourceUrl !== 'string' || !entry.sourceUrl ||
      typeof entry.sourceIdentity !== 'string' || !entry.sourceIdentity ||
      typeof entry.sourcePath !== 'string' || !entry.sourcePath ||
      typeof entry.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceSha256) ||
      typeof entry.sourceFilename !== 'string' || !entry.sourceFilename ||
      typeof entry.declaredMime !== 'string' || !entry.declaredMime ||
      typeof entry.ownerApproved !== 'boolean'
    ) {
      throw new Error('offline media allowlist contains an invalid entry');
    }

    const entriesForUrl = entriesByUrl.get(entry.sourceUrl) ?? [];
    entriesForUrl.push(entry);
    entriesByUrl.set(entry.sourceUrl, entriesForUrl);
    if (identities.has(entry.sourceIdentity)) {
      throw new Error(`offline media allowlist has an ambiguous source identity ${entry.sourceIdentity}`);
    }
    identities.add(entry.sourceIdentity);

    const previousHash = pathHashes.get(entry.sourcePath);
    if (previousHash && previousHash !== entry.sourceSha256) {
      throw new Error(`offline media allowlist has conflicting hashes for source path ${entry.sourcePath}`);
    }
    pathHashes.set(entry.sourcePath, entry.sourceSha256);
  }

  const matches = entriesByUrl.get(sourceUrl) ?? [];
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'offline media source URL is ambiguous' : 'offline media source URL is not allowlisted');
  }
  const entry = matches[0];
  if (entry.ownerApproved !== true) throw new Error('offline media source is not owner-approved');
  const verified = await readVerifiedOfflineImageSource({
    root: offlineMedia.root,
    sourceIdentity: entry.sourceIdentity,
    sourcePath: entry.sourcePath,
    sourceSha256: entry.sourceSha256,
    sourceFilename: entry.sourceFilename,
  });
  // The allowlist's filename and MIME are provenance. Upload metadata follows the
  // verified bytes so a stale extension cannot mislabel the raster data.
  return { bytes: verified.bytes, filename: verified.filename, mime: verified.mime };
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
      let source: ImageSource;
      if (options.offlineMedia) {
        source = await offlineSource(options.offlineMedia, url);
      } else {
        const localFilename = APPROVED_LOCAL_IMAGES.get(url);
        source = localFilename
          ? await localSource(options.root, localFilename)
          : await remoteSource(fetchImage, url);
        source.mime = imageMimeFromBytes(source.bytes, source.mime);
      }
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
