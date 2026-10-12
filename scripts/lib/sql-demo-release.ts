import type { SqlPublicContentResult } from './sql-public-content.js';

export interface SqlDemoPageDto {
  title: string;
  slug: string;
  body: string;
  seo_title?: string;
  seo_description?: string;
  legacy_id?: string;
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
  organizationPage: SqlDemoPageDto;
  organizationSectionTargets: {
    sourceTable: 'OrganizationInfo';
    sourceId: number;
    targetSectionKey: string;
    targetAnchor: string;
  }[];
}

export interface SqlDemoAllowlistedAssets {
  images: {
    sourceFileId: string;
    sourceUrl: string;
    targetPublicUrl: string;
    sha256: string;
    mimeType: string;
    approvalId: string;
  }[];
  documents: {
    sourceFileId: string;
    sourceUrl: string;
    targetPublicUrl: string;
    sha256: string;
    mimeType: 'application/pdf';
    approvalId: string;
  }[];
}

export interface SqlDemoOwnerDecisions {
  approvedUnlinkedArticleImages: { sourceFileId: string; approvalId: string }[];
  externalVideoLinks: { sourceId: number; sourceUrl: string; approvalId: string }[];
}

export interface SqlDemoRelease {
  entities: SqlPublicContentResult['entities'] & {
    pages: SqlDemoPageDto[];
    institutes: (SqlPublicContentResult['entities']['institutes'][number] & {
      order: number;
      seo?: { seo_title?: string; seo_description?: string };
    })[];
  };
  provenance: SqlPublicContentResult['provenance'] & {
    acceptedCorpus: SqlDemoAcceptedSupplements['acceptedCorpus'];
    supplements: { sourcePath: string; revision: string; sha256: string }[];
    approvedAssets: { sourceFileId: string; sha256: string; mimeType: string; approvalId: string }[];
    ownerDecisionIds: string[];
    externalVideoLinks: SqlDemoOwnerDecisions['externalVideoLinks'];
  };
}

export function composeSqlDemoRelease(
  mapped: SqlPublicContentResult,
  acceptedSupplements: SqlDemoAcceptedSupplements,
  allowlistedAssets: SqlDemoAllowlistedAssets,
  ownerDecisions: SqlDemoOwnerDecisions,
): SqlDemoRelease {
  throw new Error('composeSqlDemoRelease is not implemented');
}
