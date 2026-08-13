import { describe, expect, it } from 'vitest';
import { cleanBodyHtml } from '../src/lib/html-cleaner.js';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';
import {
  scanHtmlForHazards,
  matchOccurrences,
  collectOccurrences,
  unmarkedDocumentHazards,
  extractMarkedRegions,
  stripMarkedRegions,
} from './helpers/rich-content-safety/hazard-scan.js';
import { AUTHENTICATED_FORMS, exactRutubeIframe } from './helpers/rich-content-safety/closed-matrix.js';
import { validateClosedMatrixHtml } from './helpers/rich-content-safety/closed-matrix-validate.js';

function slots(ids: { slotId: string; identity: string }[]) {
  return ids;
}

describe('rich-content: whole-document hazard scanner', () => {
  it('ловит on*, srcdoc, XML/XLink, forbidden schemes, frame/frameset, refresh-meta', () => {
    const html = [
      '<p onclick="alert(1)">x</p>',
      '<iframe srcdoc="<p>y</p>"></iframe>',
      '<a xlink:href="javascript:alert(1)">z</a>',
      '<a href="javascript:alert(1)">j</a>',
      '<frame src="https://evil.test">',
      '<frameset><frame src="https://evil.test"></frameset>',
      '<meta http-equiv="refresh" content="0;url=https://evil.test">',
    ].join('');
    const hits = scanHtmlForHazards(html);
    expect(hits.some((h) => h.reason === 'event-handler')).toBe(true);
    expect(hits.some((h) => h.reason === 'srcdoc')).toBe(true);
    expect(hits.some((h) => h.reason === 'xml-xlink' || h.reason.startsWith('forbidden-scheme'))).toBe(true);
    expect(hits.some((h) => h.reason.includes('frame'))).toBe(true);
    expect(hits.some((h) => h.reason === 'refresh-meta')).toBe(true);
    expect(unmarkedDocumentHazards(html).some((h) => h.reason === 'refresh-meta')).toBe(true);
  });

  it('ловит unmarked svg/math/template как executable output', () => {
    const html = '<svg><animate attributeName="x" /></svg><math></math><template><p>x</p></template>';
    const hits = scanHtmlForHazards(html);
    expect(hits.some((h) => h.reason === 'executable-or-nested:svg')).toBe(true);
    expect(hits.some((h) => h.reason === 'executable-or-nested:math')).toBe(true);
    expect(hits.some((h) => h.reason === 'executable-or-nested:template')).toBe(true);
    const errors = matchOccurrences(html, '/x', [], []);
    expect(errors.some((e) => /svg/.test(e))).toBe(true);
    expect(errors.some((e) => /math/.test(e))).toBe(true);
    expect(errors.some((e) => /template/.test(e))).toBe(true);
  });

  it('не считает hazard-ом точный RUTUBE iframe и JSON-LD script', () => {
    const html = `${exactRutubeIframe()}<script type="application/ld+json">{}</script>`;
    const hits = scanHtmlForHazards(html);
    expect(hits.filter((h) => h.tag === 'iframe' || h.tag === 'script')).toEqual([]);
  });

  it('sanitizer output не оставляет hazards и проходит closed matrix', () => {
    const sanitized = htmlOf(
      cleanBodyHtml('<p onclick="alert(1)">ok</p><script>alert(1)</script><frame src="https://evil.test">'),
    );
    expect(scanHtmlForHazards(sanitized)).toEqual([]);
    expect(validateClosedMatrixHtml(sanitized)).toEqual([]);
  });

  it('пустой occurrence registry не совпадает с executable элементами', () => {
    const errors = matchOccurrences('<script>window.x=1</script>', '/oplata', [], []);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('occurrence matcher требует identity, placement, count и существующий slotId', () => {
    const html = '<script>alpha()</script><script>beta()</script>';
    const found = collectOccurrences(html);
    expect(found).toHaveLength(2);
    expect(found[0].identity).not.toBe(found[1].identity);

    const source = slots([
      { slotId: 'src:only-alpha', identity: found[0].identity },
      { slotId: 'src:alpha', identity: found[0].identity },
      { slotId: 'src:beta', identity: found[1].identity },
    ]);

    const oneRule = [
      {
        slotId: 'src:only-alpha',
        route: '/x',
        placement: found[0].placement,
        identity: found[0].identity,
        count: 1,
      },
    ];
    const extra = matchOccurrences(html, '/x', oneRule, source);
    expect(extra.some((e) => /нет occurrence rule/.test(e))).toBe(true);

    const unused = matchOccurrences('<p>no scripts</p>', '/x', oneRule, source);
    expect(unused.some((e) => /ожидал count=1/.test(e))).toBe(true);

    const wildcard = matchOccurrences(html, '/x', [{ ...oneRule[0], placement: '*' }], source);
    expect(wildcard.some((e) => /placement="\*" запрещён/.test(e))).toBe(true);

    const stale = matchOccurrences(html, '/x', [{ ...oneRule[0], slotId: 'src:missing' }], source);
    expect(stale.some((e) => /нет в committed source-slot/.test(e))).toBe(true);

    const same = '<p id="a"></p><script>alpha()</script><script>alpha()</script>';
    const sameFound = collectOccurrences(same);
    expect(sameFound[0].identity).toBe(sameFound[1].identity);
    expect(sameFound[0].placement).toBe(sameFound[1].placement);
    const sameSource = slots([
      { slotId: 'src:same-a', identity: sameFound[0].identity },
      { slotId: 'src:same-b', identity: sameFound[0].identity },
    ]);
    const sameOk = matchOccurrences(same, '/x', [
      { slotId: 'src:same-a', route: '/x', placement: sameFound[0].placement, identity: sameFound[0].identity, count: 1 },
      { slotId: 'src:same-b', route: '/x', placement: sameFound[0].placement, identity: sameFound[0].identity, count: 1 },
    ], sameSource);
    expect(sameOk).toEqual([]);

    const leftover = matchOccurrences(same, '/x', [
      { slotId: 'src:same-a', route: '/x', placement: sameFound[0].placement, identity: sameFound[0].identity, count: 1 },
    ], sameSource);
    expect(leftover.some((e) => /нет occurrence rule/.test(e))).toBe(true);

    const ok = matchOccurrences(html, '/x', [
      { slotId: 'src:alpha', route: '/x', placement: found[0].placement, identity: found[0].identity, count: 1 },
      { slotId: 'src:beta', route: '/x', placement: found[1].placement, identity: found[1].identity, count: 1 },
    ], source);
    expect(ok).toEqual([]);

    const crossed = matchOccurrences(html, '/x', [
      { slotId: 'src:beta', route: '/x', placement: found[0].placement, identity: found[0].identity, count: 1 },
    ], source);
    expect(crossed.some((e) => /source body identity/.test(e))).toBe(true);
  });

  it('closed matrix отвергает contenteditable, data-*, incomplete iframe, checkbox, dir/lang, javascript URL и поддельные маркеры', () => {
    const known = { knownSinkIds: ['article-body'] };
    const html = '<div data-safe-rich-content="article-body"><p contenteditable="true" data-evil="x">ok</p></div>';
    const regions = extractMarkedRegions(html);
    expect(regions).toHaveLength(1);
    const errors = validateClosedMatrixHtml(regions[0].outer, known);
    expect(errors.some((e) => /contenteditable/.test(e))).toBe(true);
    expect(errors.some((e) => /data-evil/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<p>ok</p>', known)).toEqual([]);
    expect(validateClosedMatrixHtml(exactRutubeIframe(), known)).toEqual([]);
    expect(validateClosedMatrixHtml(AUTHENTICATED_FORMS.tableWrapper, known)).toEqual([]);
    expect(validateClosedMatrixHtml(AUTHENTICATED_FORMS.resolvedCta, known)).toEqual([]);
    expect(validateClosedMatrixHtml(AUTHENTICATED_FORMS.unresolvedCta, known)).toEqual([]);

    const srcOnly = '<iframe src="https://rutube.ru/play/embed/4a1e6023bd7a3716d8ff56bf98c96e97/"></iframe>';
    expect(validateClosedMatrixHtml(srcOnly, known).some((e) => /обязательного/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<input type="checkbox">', known).some((e) => /disabled/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<p dir="sideways">x</p>', known).some((e) => /dir/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<p lang="1">x</p>', known).some((e) => /lang/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<a href="javascript:alert(1)">x</a>', known).some((e) => /URL/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<div data-safe-rich-content="forged">x</div>', known).some((e) => /sink-id/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<table data-wrapped><tr><td>x</td></tr></table>', known).some((e) => /data-wrapped/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<div class="table-scroll">x</div>', known).some((e) => /table-scroll/.test(e))).toBe(true);
  });

  it('stripMarkedRegions не оставляет вложенный RUTUBE после внутреннего div', () => {
    const html = `<div data-safe-rich-content="article-body"><div class="wrap">inner</div>${exactRutubeIframe()}</div><p>after</p>`;
    const stripped = stripMarkedRegions(html);
    expect(stripped).toContain('after');
    expect(stripped).not.toContain('iframe');
    expect(stripped).not.toContain('inner');
    const occ = matchOccurrences(html, '/x', [], [], { ignoreMarkedRegions: true });
    expect(occ.some((e) => /iframe/.test(e))).toBe(false);
  });
});
