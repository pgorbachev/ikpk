import { describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { parse } from 'parse5';
import * as data from '../src/lib/data';
import SeminarPage from '../src/pages/[institute]/[courseGroup]/[seminar].astro';

// Proposed page/snapshot shape follows the CMS field names. It is deliberately
// passed to the actual page, not a test-only renderer or a formatter in isolation.
type Node = { nodeName: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] };
const descendants = (node: Node): Node[] => [node, ...(node.childNodes ?? []).flatMap(descendants)];
const textOf = (node: Node) => descendants(node).map((n) => n.value ?? '').join(' ').replace(/\s+/g, ' ').trim();
const attr = (node: Node, name: string) => node.attrs?.find((a) => a.name === name)?.value;

async function page(fields: Record<string, unknown>): Promise<Node> {
  vi.spyOn(data, 'getScheduleEntries').mockReturnValue([]);
  const html = await (await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } })).renderToString(SeminarPage, {
    request: new Request('https://ikpk.su/test/program/seminar'),
    props: {
      institute: { name: 'Институт', slug: 'test' }, courseGroup: { name: 'Программа', slug: 'program' },
      seminar: { name: 'Семинар', slug: 'seminar', content_format: 'structured', description_html: '<p>Вводный текст</p>', ...fields },
    },
  });
  vi.restoreAllMocks();
  return parse(html) as unknown as Node;
}

function documentSection(root: Node): Node {
  const panels = descendants(root).filter((n) => n.tagName === 'details' &&
    (n.childNodes ?? []).some((child) => child.tagName === 'summary' && /выдаваемые документы/i.test(textOf(child))));
  expect(panels, 'one document accordion in the canonical page').toHaveLength(1);
  return panels[0];
}
const doc = (overrides: Record<string, unknown> = {}) => ({
  document: 'Сертификат Альфа', issuer: 'Институт Альфа', issuer_unknown: false,
  prior_education: 'unspecified', completion_scope: 'this-seminar', ...overrides,
});

describe('structured documents on the canonical seminar page', () => {
  it('keeps the legacy section anchor when migrating the document panel', async () => {
    const root = await page({ documents_state: 'issued', documents: [doc()], content_section_anchors: { documents: 'section-4' } });
    expect(attr(documentSection(root), 'id')).toBe('section-4');
  });
  it('retains all historical anchors around each structured section', async () => {
    const root = await page({ audience:'<p>Для участников</p>', documents_state:'issued', documents:[doc()],
      content_section_anchors:{audience:['1','section-1'],documents:['4','section-4','old-documents']} });
    const nodes=descendants(root);
    for (const id of ['1','section-1','4','section-4','old-documents']) expect(nodes.filter(n=>attr(n,'id')===id),id).toHaveLength(1);
    expect(attr(documentSection(root),'id')).toBe('section-4');
    const ids=nodes.map(n=>attr(n,'id')).filter(Boolean);
    expect(ids.indexOf('4')).toBeLessThan(ids.indexOf('section-4'));
    expect(ids.indexOf('old-documents')).toBeLessThan(ids.indexOf('section-4'));
  });
  it.each([
    {audience:['1','section-1'],documents:['1','section-4']},
    {audience:['1','1']},
    {audience:['unsafe" id="x']},
    {audience:[]},
    {audience:['section-1','section-2']},
    {audience:['seminar-learning-plan']},
  ])('rejects invalid and duplicate historical anchors: %o', async (anchors) => {
    await expect(page({audience:'<p>Для участников</p>', content_section_anchors:anchors})).rejects.toThrow(/якор/i);
  });
  it('preserves source-specific completion conditions without inferring success', async () => {
    const root = await page({ documents_state: 'issued', documents: [
      doc({ document: 'Сертификат', completion_scope: 'unspecified', completion_required: true }),
      doc({ document: 'Удостоверение', completion_scope: 'full-cycle', completion_after_seminar_number: 4 }),
      doc({ document: 'Свидетельство', completion_scope: 'course' }),
    ], nmo: { status: 'awarded', completion_required: true, purpose: 'аккредитация' } });
    const text = textOf(documentSection(root));
    expect(text).toMatch(/после окончания обучения/i);
    expect(text).toMatch(/после 4-го семинара/i);
    expect(text).toMatch(/после окончания курса/i);
    expect(text).toContain('аккредитация');
    expect(text).not.toMatch(/успешн/i);
  });
  it('places the structured facts in one document accordion before recommendations, without the legacy duplicate', async () => {
    const root = await page({
      documents_state: 'issued', documents: [doc()],
      full_text_html: '<h2>Выдаваемые документы</h2><p>СТАРАЯ ПАНЕЛЬ</p>',
      recommendations: '<p>МАРКЕР РЕКОМЕНДАЦИЙ</p>',
    });
    const panel = documentSection(root);
    expect(textOf(panel)).toContain('Сертификат Альфа');
    expect(textOf(root)).not.toContain('СТАРАЯ ПАНЕЛЬ');
    expect(textOf(root).indexOf('Выдаваемые документы')).toBeLessThan(textOf(root).indexOf('МАРКЕР РЕКОМЕНДАЦИЙ'));
  });

  it('keeps multiple documents and their distinct education and completion conditions', async () => {
    const root = await page({ documents_state: 'issued', documents: [
      doc({ document: 'Сертификат цикла', prior_education: 'medical', completion_scope: 'full-cycle' }),
      doc({ document: 'Диплом продолжения', issuer: 'Институт Бета', prior_education: 'physical-or-pedagogical', completion_scope: 'other-seminar', other_seminar_href: '/test/program/next' }),
    ] });
    const panel = documentSection(root);
    const text = textOf(panel);
    expect.soft(text).toContain('Сертификат цикла');
    expect.soft(text).toContain('Диплом продолжения');
    expect.soft(text).toMatch(/медицинск/i);
    expect.soft(text).toMatch(/(?:физкультур|физическ|педагогическ)/i);
    expect.soft(text).toMatch(/(?:всего|полного|полный|весь)\s+(?:обучения|курса|цикла|программы)/i);
    expect.soft(descendants(panel).some((n) => n.tagName === 'a' && attr(n, 'href') === '/test/program/next')).toBe(true);
  });

  it('does not invent an issuer or an education requirement when those facts are unknown', async () => {
    const root = await page({ documents_state: 'issued', documents: [doc({ issuer: null, issuer_unknown: true, prior_education: 'unspecified' })] });
    const text = textOf(documentSection(root));
    expect(text).toContain('Сертификат Альфа');
    expect(text).not.toMatch(/Институт Альфа|медицинск|педагогическ|без образования|любое образование/i);
  });

  it.each([
    ['possible', /возможн/i, /начисля(?:ются|ется)/i],
    ['awarded', /начисля(?:ются|ется)/i, /возможн/i],
  ])('distinguishes NMO status %s', async (status, expected, forbidden) => {
    const root = await page({ documents_state: 'issued', documents: [doc()], nmo: { status, audience: 'Врачи', awarded_for: 'Семинар', url: 'https://edu.example/nmo' } });
    const panel = documentSection(root);
    expect.soft(textOf(panel)).toMatch(expected);
    expect.soft(textOf(panel)).not.toMatch(forbidden);
    expect.soft(descendants(panel).some((n) => n.tagName === 'a' && attr(n, 'href') === 'https://edu.example/nmo')).toBe(true);
  });

  it.each(['training', 'document'])('preserves IAHE registry subject %s and safe links', async (subject) => {
    const registry = { name: 'IAHE', subject, url: 'https://iahe.example/registry' };
    const root = await page({ documents_state: 'issued', documents: [doc({ registry: subject === 'document' ? [registry] : [] })], training_registries: subject === 'training' ? [registry] : [] });
    const panel = documentSection(root);
    const text = textOf(panel);
    expect.soft(text).toContain('IAHE');
    const registrySentence = text.split(/[.!?]/).find((sentence) => sentence.includes('IAHE')) ?? '';
    expect.soft(registrySentence).toMatch(subject === 'training' ? /обучен/i : /(?:документ|сертификат)/i);
    if (subject === 'training') expect.soft(registrySentence).not.toMatch(/(?:документ|сертификат)/i);
    else expect.soft(registrySentence).not.toMatch(/обучен/i);
    expect.soft(descendants(panel).some((n) => n.tagName === 'a' && attr(n, 'href') === registry.url)).toBe(true);
  });

  it('does not create executable links or markup from document facts', async () => {
    const root = await page({ documents_state: 'issued', documents: [doc({ document: '<img src=x onerror=alert(1)>', completion_scope: 'other-seminar', other_seminar_href: 'javascript:alert(1)', registry: [{ name: 'IAHE', subject: 'document', url: 'javascript:alert(2)' }] })], nmo: { status: 'possible', url: 'data:text/html,evil' } });
    const panel = documentSection(root);
    const nodes = descendants(panel);
    expect(nodes.some((n) => n.tagName === 'img')).toBe(false);
    expect(nodes.some((n) => n.attrs?.some((a) => /^on/i.test(a.name)))).toBe(false);
    expect(nodes.filter((n) => n.tagName === 'a').every((n) => !/^\s*(?:javascript|data):/i.test(attr(n, 'href') ?? ''))).toBe(true);
  });
});
