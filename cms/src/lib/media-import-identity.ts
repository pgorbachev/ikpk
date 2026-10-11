export const MEDIA_IMPORT_METADATA_KEY = 'ikpk_media_import';

export interface MediaImportSourceIdentity {
  version: 1;
  sha256: string;
  storedSha256: string;
  adoptedFrom?: string;
}

export interface MediaImportMetadata {
  sources: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sourceIdentityFromProviderMetadata(
  providerMetadata: unknown,
  sourceUrl: string,
): MediaImportSourceIdentity | undefined {
  if (!isRecord(providerMetadata)) return undefined;
  const imported = providerMetadata[MEDIA_IMPORT_METADATA_KEY];
  if (!isRecord(imported) || !isRecord(imported.sources)) return undefined;
  const identity = imported.sources[sourceUrl];
  if (
    !isRecord(identity) || identity.version !== 1 || typeof identity.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(identity.sha256) || typeof identity.storedSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(identity.storedSha256)
  ) return undefined;
  return {
    version: 1,
    sha256: identity.sha256,
    storedSha256: identity.storedSha256,
    ...(typeof identity.adoptedFrom === 'string' ? { adoptedFrom: identity.adoptedFrom } : {}),
  };
}

export function mergeMediaImportIdentity(
  providerMetadata: unknown,
  sourceUrl: string,
  identity: MediaImportSourceIdentity,
): Record<string, unknown> {
  if (!/^[a-f0-9]{64}$/.test(identity.sha256) || !/^[a-f0-9]{64}$/.test(identity.storedSha256)) {
    throw new Error('source SHA-256 must be a lowercase 64-character hexadecimal digest');
  }
  if (typeof sourceUrl !== 'string' || sourceUrl.length > 2048 || !sourceUrl || !isAllowedSourceUrl(sourceUrl)) {
    throw new Error('source URL must be absolute HTTP(S) or an approved local media key');
  }

  const current = isRecord(providerMetadata) ? providerMetadata : {};
  const currentImport = isRecord(current[MEDIA_IMPORT_METADATA_KEY])
    ? current[MEDIA_IMPORT_METADATA_KEY]
    : {};
  const currentSources = isRecord(currentImport.sources) ? currentImport.sources : {};
  if (!Object.prototype.hasOwnProperty.call(currentSources, sourceUrl) && Object.keys(currentSources).length >= 200) {
    throw new Error('media source identity limit reached');
  }
  const imported: MediaImportMetadata = {
    sources: {
      ...currentSources,
      [sourceUrl]: {
        version: 1,
        sha256: identity.sha256,
        storedSha256: identity.storedSha256,
        ...(identity.adoptedFrom ? { adoptedFrom: identity.adoptedFrom } : {}),
      },
    },
  };

  return { ...current, [MEDIA_IMPORT_METADATA_KEY]: imported };
}

function isAllowedSourceUrl(sourceUrl: string): boolean {
  if (/^\/media\/legacy\/(?:logo-v2|logo-upledger-inst|logo-barral-inst)\.png$/.test(sourceUrl)) return true;
  try {
    const parsed = new URL(sourceUrl);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname) &&
      !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
