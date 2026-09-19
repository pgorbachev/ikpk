import { expect, it } from 'vitest';
import { publicationOccurrences } from './publication/occurrences';
import { loadFixture } from './helpers/rich-content-safety/load-fixture';
import { matchOccurrences, type OccurrenceRule } from './helpers/rich-content-safety/hazard-scan';
import type { ExecutableSlot } from './helpers/rich-content-safety/ast-sinks';

const rules = loadFixture<{ occurrences: OccurrenceRule[] }>('output-occurrence-registry.json').occurrences;
const slots = loadFixture<ExecutableSlot[]>('executable-source-slots.json');
const article = { title: 'Changed <title>', body_text: 'Changed body', published_at: '2026-09-19' };
it('projects exact article templates from captured input and rejects extra or modified output', () => {
  const projected = publicationOccurrences(rules, slots, [article], 'ci');
  const template = projected.filter((rule) => rule.route === '/statyi' && rule.identity.startsWith('template|'));
  expect(template).toHaveLength(1);
  expect(template[0].identity).toContain('data-title=changed <title>');
  const html = '<select id="articles-sort-select"></select><template data-article-card data-astro-cid-l6mabxp2 data-body="changed body" data-page="1" data-published-at="2026-09-19" data-title="changed &lt;title&gt;"></template>';
  expect(matchOccurrences(html, '/statyi', template, slots)).toEqual([]);
  expect(matchOccurrences(`${html}<script>unexpected()</script>`, '/statyi', template, slots)).not.toEqual([]);
  expect(matchOccurrences(html.replace('changed body', 'tampered'), '/statyi', template, slots)).not.toEqual([]);
  expect(matchOccurrences(html + html, '/statyi', template, slots)).not.toEqual([]);
  expect(matchOccurrences('', '/statyi', template, slots)).not.toEqual([]);
});
it('ci moves only the reviewed payment script anchor; active roles preserve the registry', () => {
  const ci = publicationOccurrences(rules, slots, [], 'ci');
  const changed = ci.filter((rule, index) => rule.placement !== rules.filter((r) => !r.identity.startsWith('template|') || r.route !== '/statyi')[index]?.placement);
  expect(changed).toHaveLength(1);
  expect(changed[0]).toMatchObject({ route: '/oplata', placement: 'after:#payment-dialog-title' });
  expect(publicationOccurrences(rules, slots, [], 'stand').find((r) => r.route === '/oplata' && r.builds?.includes('demo') && r.identity === changed[0].identity)?.placement).toBe('after:#payment-err-consent');
});
