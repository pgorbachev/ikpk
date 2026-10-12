import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { relationFileId } from './strapi-relation-file.js';

describe('Strapi populated media relation slot extraction', () => {
  it.each([
    ['teacher.photo', [{ id: 41 }, { id: 42 }], 41],
    ['institute.image', [{ id: 51 }, { id: 52 }], 51],
    ['course-group.image', [{ id: 61 }, { id: 62 }], 61],
    ['seminar.image', [{ id: 71 }, { id: 72 }], 71],
  ])('uses only slot zero for %s', (_relation, value, expected) => {
    expect(relationFileId(value)).toBe(expected);
  });

  it.each([
    ['Strapi 5 single populated media', { id: 81 }, 81],
    ['Strapi 4 single populated media', { data: { id: 82 } }, 82],
    ['Strapi 4 multiple populated media', { data: [{ id: 83 }, { id: 84 }] }, 83],
  ])('supports %s', (_shape, value, expected) => {
    expect(relationFileId(value)).toBe(expected);
  });

  it('does not scan later slots when slot zero is empty or malformed', () => {
    expect(relationFileId([null, { id: 91 }])).toBeUndefined();
    expect(relationFileId([{ id: 0 }, { id: 92 }])).toBeUndefined();
  });

  it('keeps slot-zero extraction aligned with the four multiple-media CMS fields', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..');
    const fields = [
      ['teacher', 'photo'],
      ['institute', 'image'],
      ['course-group', 'image'],
      ['seminar', 'image'],
    ] as const;
    for (const [contentType, field] of fields) {
      const schema = JSON.parse(await readFile(
        join(repoRoot, 'cms/src/api', contentType, 'content-types', contentType, 'schema.json'),
        'utf8',
      )) as { attributes: Record<string, { type?: string; multiple?: boolean }> };
      expect(schema.attributes[field], `${contentType}.${field}`).toMatchObject({ type: 'media', multiple: true });
    }
  });
});
