import { createHash } from 'node:crypto';

export interface SqlDemoAssetSource {
  sourceHash: string;
  Files?: {
    id: string; fileType: string | null; originalName: string | null; extension: string | null;
    url: string | null; status: string; privacy: string;
  }[];
  FileBindingOrganizationInfo?: { id: number; fileId: string; organizationInfoId: number }[];
  Articles?: { id: number; status: string; imageId: string | null; content: string | null }[];
  Videos?: { id: number; status: string; imageId: string | null; link: string | null }[];
}

export type SqlDemoSelectedPublicHeaderReference = {
  sourceTable: 'Institutes' | 'Programs' | 'Teachers' | 'Events' | 'Articles' | 'News' | 'Promotions' | 'Videos';
  sourceId: number;
  imageId: string;
};

export interface SqlDemoSelectedPublicHeaders {
  /** Hash of the same pinned SQL snapshot used by the public-content mapper. */
  sourceHash: string;
  references: SqlDemoSelectedPublicHeaderReference[];
}

export type SqlDemoAssetReachability =
  | { kind: 'sql-header' }
  | { kind: 'article-body'; articleSourceIds: number[] }
  | { kind: 'video-thumbnail'; videoSourceId: number }
  | { kind: 'document-binding'; bindingSourceId: number }
  | { kind: 'static-supplement'; supplementName: string };

export interface SqlDemoAssetManifestEntry {
  sourceFileId: string;
  archiveRelativePath: string;
  sha256: string;
  sourceFileType: 'image' | 'document';
  sourceStatus: 'active' | 'disabled' | 'unlinked';
  sourcePrivacy: 'public' | 'private';
  reachability: SqlDemoAssetReachability;
}

export interface SqlDemoAssetManifest {
  schemaVersion: 1;
  scope: 'sql-demo-public-assets';
  baselineSqlSha256: string;
  archiveSha256: string;
  entries: SqlDemoAssetManifestEntry[];
}

export type SqlDemoSupplementScope =
  | 'public-static-page'
  | 'public-video-thumbnail'
  | 'missing-original-replacement';

export interface SqlDemoSupplementEntry {
  name: string;
  scope: SqlDemoSupplementScope;
  sourcePath: string;
  revision: string;
  sha256: string;
  /** Required for a replacement; it records that this file does not restore source bytes. */
  replacesMissingSourceFileId?: string;
}

export interface SqlDemoSupplementManifest {
  schemaVersion: 1;
  scope: 'sql-demo-approved-supplements';
  sha256: string;
  codeRevision: string;
  entries: SqlDemoSupplementEntry[];
}

/** Hashes only the named, ordered manifest payload; its advertised sha256 field is excluded. */
export function computeSqlDemoSupplementManifestSha256(
  manifest: Pick<SqlDemoSupplementManifest, 'schemaVersion' | 'scope' | 'codeRevision' | 'entries'>,
): string {
  const payload = {
    schemaVersion: manifest.schemaVersion,
    scope: manifest.scope,
    codeRevision: manifest.codeRevision,
    entries: manifest.entries.map((entry) => ({
      name: entry.name,
      scope: entry.scope,
      sourcePath: entry.sourcePath,
      revision: entry.revision,
      sha256: entry.sha256,
      ...(entry.replacesMissingSourceFileId === undefined
        ? {}
        : { replacesMissingSourceFileId: entry.replacesMissingSourceFileId }),
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export interface SqlDemoAssetLoaderInput {
  /** Native reader/mapping output with its already-verified source digest. */
  source: SqlDemoAssetSource;
  /** Selected mapper output references; this is not an asset-manifest reachability claim. */
  selectedPublicHeaders: SqlDemoSelectedPublicHeaders;
  baseline: { sqlSha256: string; archiveSha256: string };
  assetRoot: string;
  assetManifest: SqlDemoAssetManifest;
  approvedBodyFileGrants: {
    sourceFileId: string;
    sourceSha256: string;
    decisionId: string;
  }[];
  supplementRoot: string;
  supplementManifest: SqlDemoSupplementManifest;
  expectedSupplements: { codeRevision: string; manifestSha256: string };
}

/**
 * An offline proof is created only after the verifier has checked the resolved path,
 * source SHA-256 and byte magic. It is never read from input data.
 * Image verification is to reuse the shared import-media verifier; this loader does
 * not own a second raster codec. PDF validation is a separate document guard.
 */
interface SqlDemoOfflineSourceProof {
  sourceFileId: string;
  sourceUrl: string;
  archiveRelativePath: string;
  resolvedLocalPath: string;
  sourceSha256: string;
  reachability: SqlDemoAssetReachability;
  verification: {
    status: 'verified';
    loader: 'sql-demo-asset-loader';
    attestationId: string;
  };
}

export interface SqlDemoOfflineAssetProof extends SqlDemoOfflineSourceProof {
  sourceFileType: 'image';
  detectedMimeType: 'image/png' | 'image/jpeg';
  detectedExtension: 'png' | 'jpg';
}

export interface SqlDemoOfflineDocumentProof extends SqlDemoOfflineSourceProof {
  sourceFileType: 'document';
  detectedMimeType: 'application/pdf';
  detectedExtension: 'pdf';
}

export interface SqlDemoAssetLoaderResult {
  /** Verified local raster sources; no upload or CMS public URL is implied by this result. */
  offlineMedia: SqlDemoOfflineAssetProof[];
  /** PDF documents remain separate from raster media. */
  offlineDocuments: SqlDemoOfflineDocumentProof[];
  supplements: {
    sourcePath: string;
    revision: string;
    sha256: string;
    scope: SqlDemoSupplementScope;
    replacesMissingSourceFileId?: string;
  }[];
  provenance: {
    baseline: { sqlSha256: string; archiveSha256: string };
    assets: (Pick<SqlDemoOfflineAssetProof, 'sourceFileType' | 'sourceFileId' | 'archiveRelativePath' | 'sourceSha256' | 'reachability'>
      | Pick<SqlDemoOfflineDocumentProof, 'sourceFileType' | 'sourceFileId' | 'archiveRelativePath' | 'sourceSha256' | 'reachability'>)[];
    supplements: SqlDemoAssetLoaderResult['supplements'];
  };
}

/**
 * Offline asset join boundary. The implementation must verify local bytes before
 * emitting this proof; callers cannot submit pre-verified mappings or CMS URLs.
 */
export async function loadSqlDemoAssets(input: SqlDemoAssetLoaderInput): Promise<SqlDemoAssetLoaderResult> {
  void input;
  throw new Error('SQL demo offline asset loader is not implemented');
}
