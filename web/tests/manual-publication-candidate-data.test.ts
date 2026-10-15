import { describe, expect, it } from 'vitest';
import { candidateEntityTypes, candidateRoute, candidateSearchSubject, candidateTemplateRoutes } from './helpers/publication-candidate-data';

const types = {
  institutes: [{ slug: 'shared', legacy_id: 'institute-legacy' }],
  course_groups: [{ slug: 'shared', legacy_id: 'group-legacy', institute_legacy_id: 'shared' }],
  seminars: [{ slug: 'shared', course_group_legacy_id: 'group-legacy' }],
  articles: [{ slug: 'shared', title: 'Боль' }],
  teachers: [{ slug: 'shared', institute_legacy_id: 'shared' }],
  video_playlists: [{ slug: 'shared' }],
};
const routes = ['/shared', '/shared/shared', '/shared/shared/shared', '/statyi/shared', '/shared/prepodavatel/shared', '/video/shared'];
// Article first: a last-segment search would select it for every entity type.
const pages = [routes[3], ...routes.filter((route) => route !== routes[3])].map((route) => ({ route, html: '<main><h1>Shared slug</h1></main>' }));

describe('candidate route identity follows entity ownership', () => {
  it('keeps all six template routes when every entity has the same slug', () => {
    expect(candidateEntityTypes.map((type) => candidateRoute(types, type, types[type][0]))).toEqual(routes);
    expect(candidateTemplateRoutes(types, pages)).toEqual([
      '/', '/statyi', '/raspisanie-i-tseny', '/kontakty', '/oplata', '/svedeniya-ob-obrazovatelnoy-organizatsii', ...routes,
    ]);
  });

  it('does not accept an article in place of the missing seminar route', () => {
    expect(() => candidateTemplateRoutes(types, pages.filter((page) => page.route !== '/shared/shared/shared')))
      .toThrow('missing representative seminars route: /shared/shared/shared');
  });

  it.each([
    { slug: 'shared' },
    { slug: 'shared', institute_legacy_id: null },
    { slug: 'shared', institute_legacy_id: '' },
  ])('uses the actual flat teacher route when optional institute is absent: $institute_legacy_id', (teacher) => {
    expect(candidateRoute(types, 'teachers', teacher)).toBe('/specialisty/shared');
  });

  it('selects the flat teacher template without mistaking a cross-type shared slug for it', () => {
    const source = { ...types, teachers: [{ slug: 'shared' }] };
    const actualPages = [...pages.filter((page) => page.route !== '/shared/prepodavatel/shared'), { route: '/specialisty/shared', html: '<main>Teacher</main>' }];
    expect(candidateTemplateRoutes(source, actualPages)).toContain('/specialisty/shared');
    expect(candidateTemplateRoutes(source, actualPages)).not.toContain('/shared/prepodavatel/shared');
  });

  it('requires the actual snapshot parent join rather than a matching slug elsewhere', () => {
    expect(() => candidateRoute(types, 'seminars', { slug: 'shared', course_group_legacy_id: 'absent' })).toThrow('missing course group');
    expect(() => candidateRoute(types, 'teachers', { slug: 'shared', institute_legacy_id: 'institute-legacy' })).toThrow('missing institute');
  });
});

describe('candidate search examples do not impose CMS title length', () => {
  it.each([
    { title: 'КТ и МРТ', body_text: '', query: 'КТ' },
    { title: 'Боль', body_text: '', query: 'Боль' },
    { title: 'I', body_text: 'МРТ', query: 'МРТ' },
    { title: 'η', body_text: 'αίμα', query: 'αίμα' },
  ])('selects an indexed article token for $title', ({ title, body_text, query }) => {
    expect(candidateSearchSubject({ articles: [{ slug: 'short', title, body_text }] })).toMatchObject({
      route: '/statyi/short', query, article: { title },
    });
  });

  it('uses a later article when the first has no usable token', () => {
    expect(candidateSearchSubject({ articles: [{ slug: 'one', title: '1 и' }, { slug: 'two', title: 'Боль' }] }))
      .toMatchObject({ route: '/statyi/two', query: 'Боль' });
  });

  it('returns no subject for an empty or tokenless source so the browser can test empty interaction', () => {
    expect(candidateSearchSubject({ articles: [] })).toBeUndefined();
    expect(candidateSearchSubject({ articles: [{ slug: 'one', title: '1 и', body_text: 'A 2 !' }] })).toBeUndefined();
  });
});
