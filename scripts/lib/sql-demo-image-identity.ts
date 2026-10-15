export interface SqlDemoImageIdentityFile {
  id: string;
  url: string | null;
}

const uploadAliasPattern = /^https:\/\/ikpk\.su\/api\/upload\/file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Return the native Files ID only for the one canonical legacy upload URL form. */
export function canonicalSqlUploadFileId(sourceUrl: string): string | undefined {
  const match = uploadAliasPattern.exec(sourceUrl);
  if (match) return match[1];
  let decodedPath = '';
  try { decodedPath = decodeURIComponent(new URL(sourceUrl).pathname); } catch { /* the raw candidate check below still rejects malformed aliases */ }
  if (/api\/upload\/file/i.test(sourceUrl) || /api\/upload\/file/i.test(decodedPath)) {
    throw new Error('image reference is not a canonical SQL upload alias');
  }
  return undefined;
}

/** Join a DOM image reference to exactly one SQL Files row by canonical alias or literal URL. */
export function resolveSqlImageFile<T extends SqlDemoImageIdentityFile>(
  files: readonly T[],
  sourceUrl: string,
  context: string,
): T {
  const aliasId = canonicalSqlUploadFileId(sourceUrl);
  const matches = aliasId === undefined
    ? files.filter((file) => file.url === sourceUrl)
    : files.filter((file) => file.id === aliasId);
  if (matches.length !== 1) {
    throw new Error(`${context} image reference does not resolve to one exact native Files identity`);
  }
  return matches[0]!;
}

/** Confirm a composer source URL names this file, retaining the original storage URL separately. */
export function sourceUrlMatchesSqlImageIdentity(
  sourceFileId: string,
  sourceUrl: string,
  storageUrl: string,
  aliases: readonly string[] = [],
): boolean {
  const aliasId = canonicalSqlUploadFileId(sourceUrl);
  if (aliasId !== undefined) return aliasId === sourceFileId && aliases.includes(sourceUrl);
  return sourceUrl === storageUrl;
}
