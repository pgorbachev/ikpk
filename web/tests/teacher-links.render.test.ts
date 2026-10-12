import { describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const component = (path: string) => import(pathToFileURL(join(import.meta.dirname, '..', 'src', path)).href);

describe('optional institute relation does not create teacher links', () => {
  it('home Teachers renders a person without an institute as a non-link card', async () => {
    vi.doMock('../src/lib/data.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/lib/data.js')>(),
      getTeachers: () => [{
        slug: 'unassigned-person',
        name: 'Персона без института, врач',
        photo: '/media/users/1/images/1-1727012293952.webp',
        institute_legacy_id: undefined,
      }],
    }));
    const { default: Teachers } = await component('components/home/sections/Teachers.astro');
    const container = await AstroContainer.create();
    const html = await container.renderToString(Teachers as never);

    expect(html).toContain('Персона без института');
    expect(html).not.toMatch(/href="\/(?:undefined|null)\/prepodavatel\//);
    expect(html).not.toContain('href="/undefined/prepodavatel/unassigned-person"');
  });

  it('home TeachersFeatured also renders an unassigned person without a link', async () => {
    const { default: TeachersFeatured } = await component('components/home/sections/TeachersFeatured.astro');
    const container = await AstroContainer.create();
    const html = await container.renderToString(TeachersFeatured as never);

    expect(html).toContain('Персона без института');
    expect(html).not.toMatch(/href="\/(?:undefined|null)\/prepodavatel\//);
  });

  it('seminar header keeps an unassigned teacher name without inventing a route', async () => {
    const { default: SeminarArchitectureHeader } = await component('components/seminars/SeminarArchitectureHeader.astro');
    const container = await AstroContainer.create();
    const html = await container.renderToString(SeminarArchitectureHeader as never, {
      props: {
        architecture: 'faculty',
        seminar: { name: 'Семинар проверки', slug: 'seminar-check' },
        courseGroup: { name: 'Программа проверки', slug: 'program-check' },
        institute: { name: 'Институт проверки', slug: 'institute-check' },
        code: '',
        schedule: [],
        teacherFallback: {
          name: 'Персона без института, врач',
          slug: 'unassigned-person',
          institute_legacy_id: undefined,
          photo: '/media/users/1/images/1-1727012293952.webp',
        },
      },
    });

    expect(html).toContain('Персона без института');
    expect(html).not.toMatch(/href="\/(?:undefined|null)\/prepodavatel\//);
    expect(html).not.toContain('href="/undefined/prepodavatel/unassigned-person"');
  });
});
