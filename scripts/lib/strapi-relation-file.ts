function fileId(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return Number.isSafeInteger(id) && (id as number) > 0 ? id as number : undefined;
}

/** Read the exact first populated media slot from Strapi 5 or its v4 data wrapper. */
export function relationFileId(value: unknown): number | undefined {
  if (Array.isArray(value)) return fileId(value[0]);
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { id?: unknown; data?: unknown };
  if (Array.isArray(candidate.data)) return fileId(candidate.data[0]);
  if (candidate.data && typeof candidate.data === 'object') return fileId(candidate.data);
  return fileId(candidate);
}
