import type { SnapshotFile } from './snapshot-paths.ts';

export interface RedirectRow {
  old_path: string;
  new_path: string;
  redirect_type: '301';
}

interface AddressableType {
  collections: string[];
  ownerTypes: string[];
  prefix: string;
}

const ADDRESSABLE_TYPES: AddressableType[] = [
  { collections: ['institutes'], ownerTypes: ['institute'], prefix: '/instituty' },
  { collections: ['course_groups', 'programs'], ownerTypes: ['course-group', 'program'], prefix: '/programmy' },
  { collections: ['seminars'], ownerTypes: ['seminar'], prefix: '/seminary' },
  { collections: ['teachers', 'persons'], ownerTypes: ['person', 'teacher'], prefix: '/specialisty' },
  { collections: ['articles'], ownerTypes: ['article'], prefix: '/statyi' },
  { collections: ['video_playlists'], ownerTypes: ['video-playlist'], prefix: '/video' },
  { collections: ['static_pages', 'pages'], ownerTypes: ['static-page', 'page'], prefix: '' },
];

function stringField(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if ((typeof value === 'string' || typeof value === 'number') && String(value) !== '') return String(value);
  }
  return undefined;
}

function isPublished(record: Record<string, unknown>): boolean {
  return record.publishedAt !== null && record.published_at !== null;
}

function currentRecords(snapshot: SnapshotFile): Map<string, Record<string, unknown>> {
  const current = new Map<string, Record<string, unknown>>();

  for (const type of ADDRESSABLE_TYPES) {
    const records = type.collections.flatMap((collection) => {
      const value = snapshot.content.types[collection];
      return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    });

    const versions = new Map<string, Record<string, unknown>[]>();
    for (const record of records) {
      const id = stringField(record, ['documentId', 'document_id', 'id', 'legacy_id']);
      if (!id) continue;
      const group = versions.get(id) ?? [];
      group.push(record);
      versions.set(id, group);
    }

    for (const [id, rows] of versions) {
      const published = rows.find(
        (row) =>
          (typeof row.publishedAt === 'string' && row.publishedAt !== '') ||
          (typeof row.published_at === 'string' && row.published_at !== ''),
      );
      const record = published ?? rows.find((row) => isPublished(row) && !('publishedAt' in row) && !('published_at' in row));
      if (!record) continue;

      const slug = stringField(record, ['slug']);
      if (!slug) continue;
      const address = `${type.prefix}/${slug}`.replace(/^\/\//, '/');
      for (const ownerType of type.ownerTypes) current.set(`${ownerType}\0${id}`, { ...record, address });
    }
  }

  return current;
}

/**
 * Выводит nginx-редиректы только для владельцев, чья опубликованная версия есть
 * в том же снимке. Поэтому история удалённой или снятой с публикации записи
 * сохраняет занятость адреса в CMS, но не порождает цель в отсутствующую страницу.
 */
export function redirectsFromAddressHistory(snapshot: SnapshotFile): RedirectRow[] {
  const rawHistory = snapshot.content.types.address_histories;
  if (!Array.isArray(rawHistory)) return [];

  const current = currentRecords(snapshot);
  const redirects = new Map<string, string>();

  for (const raw of rawHistory as Record<string, unknown>[]) {
    const from = stringField(raw, ['address']);
    const ownerId = stringField(raw, ['owner_id', 'ownerId']);
    const ownerType = stringField(raw, ['owner_type', 'ownerType']);
    if (!from || !ownerId || !ownerType) continue;

    const target = current.get(`${ownerType}\0${ownerId}`)?.address;
    if (typeof target !== 'string' || target === from) continue;
    redirects.set(from, target);
  }

  return [...redirects]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([old_path, new_path]) => ({ old_path, new_path, redirect_type: '301' }));
}
