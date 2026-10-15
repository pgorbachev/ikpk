import { describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const component = () => import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'components/home/sections/Teachers.astro')).href);

describe('homepage people section', () => {
  it('includes method authors in the visible photo-card limit alongside teachers', async () => {
    const teachers = Array.from({ length: 9 }, (_, index) => ({
      legacy_id: `teacher-${index + 1}`,
      slug: `teacher-${index + 1}`,
      name: `Преподаватель ${index + 1}`,
      trait: 'teacher',
      photo: `/teacher-${index + 1}.jpg`,
      institute_legacy_id: 'institute-a',
    }));
    const authors = Array.from({ length: 3 }, (_, index) => ({
      legacy_id: `author-${index + 1}`,
      slug: `author-${index + 1}`,
      name: `Автор методики ${index + 1}`,
      trait: 'method-author',
      photo: `/author-${index + 1}.jpg`,
      institute_legacy_id: 'institute-a',
    }));

    vi.doMock('../src/lib/data.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/lib/data.js')>(),
      getTeachers: () => [...teachers, ...authors],
    }));

    const { default: Teachers } = await component();
    const container = await AstroContainer.create();
    const html = await container.renderToString(Teachers as never);

    expect(html).toContain('Преподаватели и авторы методик');
    expect(html).toContain('Автор методики 1');
    expect(html).toContain('Преподаватель 1');
    expect(html.match(/class="teacher-card"/g)).toHaveLength(8);
    expect(html).toContain('href="/specialisty/author-1"');
  });
});
