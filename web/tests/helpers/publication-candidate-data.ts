import type { SnapshotContent } from '../../scripts/lib/content-snapshot';

type Entity = Record<string, unknown>;
export const candidateEntityTypes = ['institutes', 'course_groups', 'seminars', 'articles', 'teachers', 'video_playlists'] as const;
export type CandidateEntityType = typeof candidateEntityTypes[number];
type Types = SnapshotContent['types'];

/** Mirror the public route ownership and snapshot joins, never a cross-type slug search. */
export function candidateRoute(types: Types, type: CandidateEntityType, entity: Entity): string {
  if (typeof entity.slug !== 'string' || !entity.slug) throw new Error(`missing ${type} slug`);
  const slug = entity.slug;
  if (type === 'articles') return `/statyi/${slug}`;
  if (type === 'institutes') return `/${slug}`;
  if (type === 'video_playlists') return `/video/${slug}`;
  if (type === 'seminars') {
    const group = types.course_groups?.find((row) => row.legacy_id === entity.course_group_legacy_id);
    if (!group) throw new Error(`missing course group for seminar ${slug}`);
    return `${candidateRoute(types, 'course_groups', group)}/${slug}`;
  }
  const institute = types.institutes?.find((row) => row.slug === entity.institute_legacy_id);
  if (!institute) throw new Error(`missing institute for ${type} ${slug}`);
  return type === 'teachers' ? `/${institute.slug}/prepodavatel/${slug}` : `/${institute.slug}/${slug}`;
}

export function candidateTemplateRoutes(types: Types, pages: { route: string; html: string }[]): string[] {
  const routes = new Set(['/', '/statyi', '/raspisanie-i-tseny', '/kontakty', '/oplata', '/svedeniya-ob-obrazovatelnoy-organizatsii']);
  for (const type of candidateEntityTypes) {
    const first = types[type]?.[0];
    if (!first) continue;
    const route = candidateRoute(types, type, first);
    if (!pages.some((page) => page.route === route)) throw new Error(`missing representative ${type} route: ${route}`);
    routes.add(route);
  }
  const seminars = (types.seminars ?? []).map((entity) => pages.find((page) => page.route === candidateRoute(types, 'seminars', entity)));
  // Both actual seminar template states, when present in this captured source/tree.
  for (const populated of [true, false]) {
    const page = seminars.find((page) => page?.html.includes('data-seminar-schedule-panel') && page.html.includes('data-seminar-schedule-card') === populated);
    if (page) routes.add(page.route);
  }
  return [...routes];
}

/** A sample query is test data, not an extra CMS title-length requirement. */
export function candidateSearchSubject(types: Types): { article: Entity; route: string; query: string } | undefined {
  for (const article of types.articles ?? []) {
    const text = `${typeof article.title === 'string' ? article.title : ''} ${typeof article.body_text === 'string' ? article.body_text : ''}`;
    const query = text.match(/[\p{L}\p{M}]+/gu)?.find((token) => (token.match(/\p{L}/gu)?.length ?? 0) >= 2);
    if (query) return { article, route: candidateRoute(types, 'articles', article), query };
  }
  return undefined;
}
