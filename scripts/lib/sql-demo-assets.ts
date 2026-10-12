export interface SqlDemoAssetSource {
  sourceHash: string;
  Files?: {
    id: string; fileType: string | null; originalName: string | null; extension: string | null;
    url: string | null; status: string; privacy: string;
    [field: string]: unknown;
  }[];
  FileBindingOrganizationInfo?: { id: number; fileId: string; organizationInfoId: number; [field: string]: unknown }[];
  Articles?: { id: number; status: string; imageId: string | null; content: string | null; [field: string]: unknown }[];
  Videos?: { id: number; status: string; imageId: string | null; link: string | null; [field: string]: unknown }[];
}

export interface SqlDemoVerifiedAssetMapping {
  sourceFileId: string;
  sourceUrl: string;
  targetPublicUrl: string;
  sha256: string;
  detectedMimeType: string;
  verification: {
    status: 'verified';
    loader: 'sql-demo-asset-loader';
    attestationId: string;
  };
}

export interface SqlDemoAllowlistedAssets {
  images: SqlDemoVerifiedAssetMapping[];
  documents: (SqlDemoVerifiedAssetMapping & { detectedMimeType: 'application/pdf' })[];
}

export type SqlDemoAssetReachability =
  | { kind: 'sql-header' }
  | { kind: 'article-body'; articleSourceId: number }
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
  targetPublicUrl?: string;
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

export interface SqlDemoAssetLoaderInput {
  /** Native reader/mapping output with its already-verified source digest. */
  source: SqlDemoAssetSource;
  baseline: { sqlSha256: string; archiveSha256: string };
  assetRoot: string;
  assetManifest: SqlDemoAssetManifest;
  approvedBodyFileGrants: {
    articleSourceId: number;
    sourceFileId: string;
    sourceSha256: string;
    decisionId: string;
  }[];
  supplementRoot: string;
  supplementManifest: SqlDemoSupplementManifest;
  expectedSupplements: { codeRevision: string; manifestSha256: string };
}

/**
 * An attestation is created only by the loader after its offline verifier has checked
 * the resolved path, source SHA-256 and byte magic. It is never read from input data.
 * Image verification is to reuse the shared import-media verifier; this loader does
 * not own a second raster codec. PDF validation is a separate document guard.
 */
export interface SqlDemoOfflineAssetProof {
  sourceFileId: string;
  sourceUrl: string;
  archiveRelativePath: string;
  resolvedLocalPath: string;
  sourceSha256: string;
  detectedMimeType: string;
  targetPublicUrl: string;
  reachability: SqlDemoAssetReachability;
}

export interface SqlDemoAssetLoaderResult {
  allowlistedAssets: SqlDemoAllowlistedAssets;
  offlineMedia: SqlDemoOfflineAssetProof[];
  supplements: {
    sourcePath: string;
    revision: string;
    sha256: string;
    scope: SqlDemoSupplementScope;
    replacesMissingSourceFileId?: string;
  }[];
  provenance: {
    baseline: { sqlSha256: string; archiveSha256: string };
    assets: Pick<SqlDemoOfflineAssetProof, 'sourceFileId' | 'archiveRelativePath' | 'sourceSha256' | 'reachability'>[];
    supplements: SqlDemoAssetLoaderResult['supplements'];
  };
}

/**
 * Offline asset join boundary. The implementation must verify each local file before
 * constructing a composer attestation; callers cannot submit pre-verified mappings.
 */
export async function loadSqlDemoAssets(input: SqlDemoAssetLoaderInput): Promise<SqlDemoAssetLoaderResult> {
  void input;
  throw new Error('SQL demo offline asset loader is not implemented');
}
