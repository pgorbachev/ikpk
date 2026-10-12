import type { SqlPublicContentOptions, SqlPublicContentResult, SqlPublicSource } from './sql-public-content.js';
import type { SqlMaterializerOptions } from './sql-public-materializer.js';
import type {
  SqlDemoAcceptedSupplements,
  SqlDemoAllowlistedAssets,
  SqlDemoOwnerDecisions,
} from './sql-demo-release.js';

export const SQL_DEMO_PRIVATE_JSON_NAMES = [
  'approved-supplements.json',
  'reached-media-manifest.json',
  'article-body-reached-public-unlinked-media.json',
  'classification-candidates.json',
  'public-schema-inventory.json',
  'content-media-manifest.json',
  'demo-owner-decisions.json',
  'video-source-reference-decisions.json',
] as const;

export type SqlDemoPrivateJsonName = typeof SQL_DEMO_PRIVATE_JSON_NAMES[number];

export interface SqlDemoPrivateInputRootConfig {
  baseline: { sqlSha256: string; archiveSha256: string };
  roots: { assetRoot: string; supplementRoot: string };
  /** Established source-table identity mapping supplied by the pinned private release config. */
  acceptedLegacyIds: SqlPublicContentOptions['acceptedLegacyIds'];
  /** Raw private JSON bytes and their independently supplied expected SHA-256 pins. */
  privateJson: Record<SqlDemoPrivateJsonName, { bytes: Uint8Array; expectedSha256: string }>;
  /** Git blob bytes selected by the pinned supplement manifest. */
  supplementBlobs: { path: string; revision: string; sha256: string; bytes: Uint8Array }[];
}

export interface SqlDemoSelectedPublicHeaderReference {
  sourceTable: 'Institutes' | 'Programs' | 'Teachers' | 'Events' | 'Articles' | 'News' | 'Promotions' | 'Videos';
  sourceId: number;
  imageId: string;
}

export interface SqlDemoNormalizedPrivateInputs {
  mapperOptions: SqlPublicContentOptions;
  loader: {
    source: SqlPublicSource;
    selectedPublicHeaders: { sourceHash: string; references: SqlDemoSelectedPublicHeaderReference[] };
    baseline: { sqlSha256: string; archiveSha256: string };
    assetRoot: string;
    assetManifest: unknown;
    approvedBodyFileGrants: { sourceFileId: string; sourceSha256: string; decisionId: string }[];
    supplementRoot: string;
    supplementManifest: unknown;
    expectedSupplements: { codeRevision: string; manifestSha256: string };
  };
  composer: {
    acceptedSupplements: SqlDemoAcceptedSupplements;
    allowlistedAssets: SqlDemoAllowlistedAssets;
    ownerDecisions: SqlDemoOwnerDecisions;
  };
  materializer: Pick<SqlMaterializerOptions, 'classification'>['classification'];
}

/**
 * Phase one verifies every pinned byte stream before parsing any private JSON and
 * prepares the pre-mapper classification/identity inputs. Implementation follows.
 */
export function prepareSqlDemoPrivateInputs(
  config: SqlDemoPrivateInputRootConfig,
): Pick<SqlPublicContentOptions, 'expectedSourceHash' | 'acceptedLegacyIds' | 'classificationCandidates'> {
  void config;
  return {} as Pick<SqlPublicContentOptions, 'expectedSourceHash' | 'acceptedLegacyIds' | 'classificationCandidates'>;
}

/**
 * Phase two joins the verified native source and mapper output, then creates only
 * the existing loader, composer, and materializer DTO inputs. Implementation follows.
 */
export function normalizeSqlDemoPrivateInputs(
  input: {
    config: SqlDemoPrivateInputRootConfig;
    mapperOptions: Pick<SqlPublicContentOptions, 'expectedSourceHash' | 'acceptedLegacyIds' | 'classificationCandidates'>;
    nativeSqlPublicSource: SqlPublicSource;
    mapped: SqlPublicContentResult;
  },
): SqlDemoNormalizedPrivateInputs {
  void input;
  return {} as SqlDemoNormalizedPrivateInputs;
}
