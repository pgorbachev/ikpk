export const MEDIA_IMPORT_METADATA_KEY = 'ikpk_media_import';

export interface MediaImportSourceIdentity {
  sha256: string;
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
  if (!isRecord(identity) || typeof identity.sha256 !== 'string') return undefined;
  return {
    sha256: identity.sha256,
    ...(typeof identity.adoptedFrom === 'string' ? { adoptedFrom: identity.adoptedFrom } : {}),
  };
}

export function mergeMediaImportIdentity(
  providerMetadata: unknown,
  sourceUrl: string,
  identity: MediaImportSourceIdentity,
): Record<string, unknown> {
  if (!/^[a-f0-9]{64}$/.test(identity.sha256)) {
    throw new Error('source SHA-256 must be a lowercase 64-character hexadecimal digest');
  }
  if (!sourceUrl || ( !/^https?:\/\//i.test(sourceUrl) && !/^\/media\/legacy\//.test(sourceUrl))) {
    throw new Error('source URL must be absolute HTTP(S) or an approved local media key');
  }

  const current = isRecord(providerMetadata) ? providerMetadata : {};
  const currentImport = isRecord(current[MEDIA_IMPORT_METADATA_KEY])
    ? current[MEDIA_IMPORT_METADATA_KEY]
    : {};
  const currentSources = isRecord(currentImport.sources) ? currentImport.sources : {};
  const imported: MediaImportMetadata = {
    sources: {
      ...currentSources,
      [sourceUrl]: {
        sha256: identity.sha256,
        ...(identity.adoptedFrom ? { adoptedFrom: identity.adoptedFrom } : {}),
      },
    },
  };

  return { ...current, [MEDIA_IMPORT_METADATA_KEY]: imported };
}
