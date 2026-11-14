/** A CMS document ID is authoritative; older snapshots may use a unique slug. */
export function resolveSeminar<T extends { documentId?: unknown; slug?: unknown }>(seminars: readonly T[], relation: { documentId?: unknown; slug?: unknown }): T | undefined {
  const id = relation.documentId;
  const key = id == null ? 'slug' : 'documentId';
  const value = relation[key];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const matches = seminars.filter((seminar) => seminar[key] === value);
  return matches.length === 1 ? matches[0] : undefined;
}
