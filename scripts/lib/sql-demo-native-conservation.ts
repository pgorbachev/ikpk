import type { SqlDemoRelease } from './sql-demo-release.js';
import type { SqlMaterializerOptions } from './sql-public-materializer.js';

export type SqlDemoNativeCollection =
  | 'institutes'
  | 'course-groups'
  | 'teachers'
  | 'seminars'
  | 'schedule-entries'
  | 'articles'
  | 'news-items'
  | 'promotions'
  | 'video-playlists'
  | 'pages';

/** Published record returned by a populated Strapi 5 Content API GET. */
export interface SqlDemoStrapi5PublishedRecord extends Record<string, unknown> {
  id: number;
  documentId: string;
  publishedAt: string;
  legacy_id: string;
}

/** Media row from the current Strapi inventory plus its independently hashed stored bytes. */
export interface SqlDemoStrapi5MediaReadback {
  id: number;
  url: string;
  provider_metadata?: unknown;
  verifiedStoredSha256: string;
}

export interface SqlDemoStrapi5Readback {
  collections: Partial<Record<SqlDemoNativeCollection, readonly SqlDemoStrapi5PublishedRecord[]>>;
  media: readonly SqlDemoStrapi5MediaReadback[];
}

/**
 * Compare each freshly read Strapi target with the composed SQL release, then compare
 * the two logical results while ignoring generated document and media identities.
 */
export function assertSqlDemoNativeConservation(
  expected: SqlDemoRelease,
  classification: SqlMaterializerOptions['classification'],
  targetA: SqlDemoStrapi5Readback,
  targetB: SqlDemoStrapi5Readback,
): void {
  void expected;
  void classification;
  void targetA;
  void targetB;
  throw new Error('SQL demo native conservation comparison is not implemented');
}
