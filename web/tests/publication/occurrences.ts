import assert from 'node:assert/strict';
import { occurrenceIdentity, projectIdentity, type OccurrenceRule } from '../helpers/rich-content-safety/hazard-scan';
import type { ExecutableSlot } from '../helpers/rich-content-safety/ast-sinks';

type Article = { title: string; body_text?: string; published_at?: string | null };

/** Project the two input-dependent occurrences from trusted inputs, never from output.
 * Everything else keeps the reviewed registry's exact route/identity/placement/count.
 * Unknown CMS routes intentionally fail closed until their source mapping is reviewed.
 */
export function publicationOccurrences(rules: OccurrenceRule[], slots: ExecutableSlot[], articles: Article[], paymentRole: string): OccurrenceRule[] {
  const slot = slots.find((item) => item.file === 'pages/statyi/index.astro' && item.identity.startsWith('template|'));
  assert(slot, 'missing reviewed article template source slot');
  const templates = rules.filter((rule) => rule.route === '/statyi' && rule.slotId === slot.slotId);
  assert(templates.length > 0, 'missing reviewed article template occurrence');
  const prototype = templates[0];
  const scope = [...projectIdentity(prototype.identity).staticAttrs].filter(([name]) => /^data-astro-cid-/.test(name));
  assert.equal(scope.length, 1, 'article template needs its reviewed scoped attribute');
  assert(templates.every((rule) => rule.placement === prototype.placement && rule.count === 1), 'article template registry shape changed');
  const date = (value?: string | null) => { const result = value ? Date.parse(value) : NaN; return Number.isFinite(result) ? result : 0; };
  const projected = rules.filter((rule) => !templates.includes(rule)).map((rule) => {
    // PaymentForm.astro omits the form only in ci; its bundled script remains.
    if (rule.route === '/oplata' && ['after:#payment-err-consent', 'after:#payment-dialog-title'].includes(rule.placement)
      && /^script\|src=\/_astro\/PaymentForm\.astro_astro_type_script_index_/.test(rule.identity)) {
      return { ...rule, placement: paymentRole === 'ci' ? 'after:#payment-dialog-title' : 'after:#payment-err-consent' };
    }
    return rule;
  });
  for (const [index, article] of [...articles].sort((a, b) => date(b.published_at) - date(a.published_at)).entries()) {
    const attrs = { 'data-article-card': '', ...Object.fromEntries(scope),
      'data-page': String(Math.floor(index / 6) + 1), 'data-title': article.title.toLowerCase(),
      'data-body': (article.body_text || '').slice(0, 300).toLowerCase(), 'data-published-at': article.published_at || '' };
    projected.push({ ...prototype, identity: occurrenceIdentity({ name: 'template', attrs, start: 0, end: 0, selfClosing: false }, '') });
  }
  return projected;
}
