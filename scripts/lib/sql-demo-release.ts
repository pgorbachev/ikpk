import type { SqlPublicContentResult } from './sql-public-content.js';

export interface SqlDemoPageDto {
  title: string;
  slug: string;
  body: string;
  legacy_id: string;
  seo?: { seo_title?: string; seo_description?: string };
}

export interface SqlDemoTargetLocation {
  sourceTable: 'OrganizationInfo' | 'InstituteAdditionalInfo' | 'FileBindingOrganizationInfo';
  sourceId: number;
  targetCollection: 'pages' | 'institutes';
  targetLegacyId: string;
  targetField: 'body' | 'description';
  sectionKey: string;
  anchor?: string;
  publicDocumentPath?: string;
}

export interface SqlDemoAcceptedSupplements {
  acceptedCorpus: { revision: string; sha256: string };
  pages: {
    sourcePath: string;
    revision: string;
    sha256: string;
    page: SqlDemoPageDto;
  }[];
  instituteMetadata: {
    sourceId: number;
    slug: string;
    order: number;
    seo?: { seo_title?: string; seo_description?: string };
  }[];
  videoPlaylists: {
    sourceId: number;
    sourcePath: string;
    revision: string;
    sha256: string;
    slug: string;
    legacy_id: string;
    seo?: { seo_title?: string; seo_description?: string };
    videos: unknown[] | null;
    thumbnailSourceFileId: string;
    thumbnailSourceUrl: string;
    thumbnailPublicUrl: string;
  }[];
  targetLocations: SqlDemoTargetLocation[];
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

export interface SqlDemoVideoReferenceDecision {
  sourceTable: 'OrganizationInfo' | 'Seminars' | 'Articles';
  sourceId: number;
  field: 'content' | 'full_text' | 'body';
  originalURL: string;
  action: 'rutube-trailing-slash' | 'external-link';
  expectedOutput: string;
}

export interface SqlDemoOwnerDecisions {
  approvedUnlinkedArticleImages: { sourceFileId: string; sourceUrl: string; decisionId: string }[];
  videoReferences: SqlDemoVideoReferenceDecision[];
}

export interface SqlDemoRelease {
  entities: SqlPublicContentResult['entities'] & {
    pages: SqlDemoPageDto[];
    institutes: (SqlPublicContentResult['entities']['institutes'][number] & {
      order: number;
      seo?: { seo_title?: string; seo_description?: string };
    })[];
    videos: (Omit<NonNullable<SqlPublicContentResult['entities']['videos']>[number], 'sourceId' | 'slug' | 'legacy_id' | 'title'> & {
      name: string;
      slug: string;
      legacy_id: string;
      videos: unknown[] | null;
      seo?: { seo_title?: string; seo_description?: string };
    })[];
  };
  provenance: SqlPublicContentResult['provenance'] & {
    acceptedCorpus: SqlDemoAcceptedSupplements['acceptedCorpus'];
    supplements: { sourcePath: string; revision: string; sha256: string }[];
    targetLocations: SqlDemoTargetLocation[];
    assetMappings: SqlDemoVerifiedAssetMapping[];
    videoSupplements: Pick<SqlDemoAcceptedSupplements['videoPlaylists'][number], 'sourceId' | 'sourcePath' | 'revision' | 'sha256' | 'thumbnailSourceFileId' | 'thumbnailSourceUrl' | 'thumbnailPublicUrl'>[];
    ownerDecisions: {
      approvedUnlinkedArticleImages: SqlDemoOwnerDecisions['approvedUnlinkedArticleImages'];
      videoReferences: SqlDemoVideoReferenceDecision[];
    };
  };
}

export function composeSqlDemoRelease(
  mapped: SqlPublicContentResult,
  acceptedSupplements: SqlDemoAcceptedSupplements,
  allowlistedAssets: SqlDemoAllowlistedAssets,
  ownerDecisions: SqlDemoOwnerDecisions,
): SqlDemoRelease {
  void mapped;
  void acceptedSupplements;
  void allowlistedAssets;
  void ownerDecisions;
  throw new Error('composeSqlDemoRelease is not implemented');
}
