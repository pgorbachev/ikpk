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
  OCCURRENCE_TAGS,
  OCCURRENCE_PROVENANCE,
  provenanceError,
  MAP_IFRAME_SRC,
  TEST_MAP_B_SRC,
} from './helpers/rich-content-safety/hazard-scan.js';
import { AUTHENTICATED_FORMS, exactRutubeIframe } from './helpers/rich-content-safety/closed-matrix.js';
import { validateClosedMatrixHtml } from './helpers/rich-content-safety/closed-matrix-validate.js';
import { collectMarkerInventoryErrors } from './helpers/rich-content-safety/marker-inventory.js';
import { LOCAL_UPLOAD_WEBP } from './helpers/rich-content-safety/paths.js';
import {
  SRC_SRCSET_CASES,
  CONSTRAINED_VALUE_CASES,
  PROVENANCE_CASES,
  MATRIX_OPTS,
} from './helpers/rich-content-safety/matrix-tables.js';

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

    const svgs = '<svg fill="none" viewBox="0 0 12 12"></svg><svg fill="none" viewBox="0 0 24 24"></svg>';
    const svgFound = collectOccurrences(svgs);
    const svgAst = slots([
      { slotId: 'src:svg-12', identity: 'svg|fill=quoted:none|viewBox=quoted:0 0 12 12' },
      { slotId: 'src:svg-24', identity: 'svg|fill=quoted:none|viewBox=quoted:0 0 24 24' },
    ]);
    expect(matchOccurrences(svgs, '/x', [
      { slotId: 'src:svg-12', route: '/x', placement: svgFound[0].placement, identity: svgFound[0].identity, count: 1 },
      { slotId: 'src:svg-24', route: '/x', placement: svgFound[1].placement, identity: svgFound[1].identity, count: 1 },
    ], svgAst)).toEqual([]);
    const svgCrossed = matchOccurrences(svgs, '/x', [
      { slotId: 'src:svg-24', route: '/x', placement: svgFound[0].placement, identity: svgFound[0].identity, count: 1 },
    ], svgAst);
    expect(svgCrossed.some((e) => /viewbox/i.test(e))).toBe(true);

    const frames = `<iframe src="${MAP_IFRAME_SRC}" title="Карта ИКПК"></iframe><iframe src="${TEST_MAP_B_SRC}" title="Карта ИКПК"></iframe>`;
    const frameFound = collectOccurrences(frames);
    const frameAst = slots([
      { slotId: 'src:map', identity: 'iframe|src=expression:mapSrc|title=quoted:Карта ИКПК' },
      { slotId: 'src:map-b', identity: 'iframe|src=expression:testMapB|title=quoted:Карта ИКПК' },
    ]);
    expect(matchOccurrences(frames, '/x', [
      { slotId: 'src:map', route: '/x', placement: frameFound[0].placement, identity: frameFound[0].identity, count: 1 },
      { slotId: 'src:map-b', route: '/x', placement: frameFound[1].placement, identity: frameFound[1].identity, count: 1 },
    ], frameAst)).toEqual([]);
    const frameCrossed = matchOccurrences(frames, '/x', [
      { slotId: 'src:map', route: '/x', placement: frameFound[1].placement, identity: frameFound[1].identity, count: 1 },
    ], frameAst);
    expect(frameCrossed.some((e) => /projected|не проецируется/.test(e))).toBe(true);
    expect(provenanceError(
      'iframe|src=expression:mapSrc|title=quoted:Карта ИКПК',
      'iframe|src=https://evil.test/pwn|title=Карта ИКПК',
    )).toMatch(/projected/);
    expect(provenanceError(
      'iframe|src=expression:unknownSrc|title=quoted:Карта ИКПК',
      `iframe|src=${MAP_IFRAME_SRC}|title=Карта ИКПК`,
    )).toMatch(/без test-owned projection/);
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
    expect(validateClosedMatrixHtml('<a href="ftp://evil.test">x</a>', known).some((e) => /URL/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<img src="https://evil.test/x.webp" alt="">', known).some((e) => /img\[src\]/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<img src="/media/uploads/00000000-0000-0000-0000-000000000000.webp" alt="">', known).some((e) => /img\[src\]/.test(e))).toBe(true);
    expect(
      validateClosedMatrixHtml(
        `<img src="${LOCAL_UPLOAD_WEBP}" srcset="/media/_w/480/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp 2400w" alt="">`,
        { ...known, mediaFileExists: () => true },
      ).some((e) => /descriptor/.test(e)),
    ).toBe(true);
    expect(
      validateClosedMatrixHtml(
        `<img src="${LOCAL_UPLOAD_WEBP}" srcset="/media/_w/480/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp 480w" alt="">`,
        { ...known, mediaFileExists: () => true },
      ),
    ).toEqual([]);
    expect(validateClosedMatrixHtml(`<img src="${LOCAL_UPLOAD_WEBP}" alt="фото">`, known)).toEqual([]);
    expect(validateClosedMatrixHtml('<div data-safe-rich-content="forged">x</div>', known).some((e) => /sink-id/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<table data-wrapped><tr><td>x</td></tr></table>', known).some((e) => /data-wrapped/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<div class="table-scroll">x</div>', known).some((e) => /table-scroll/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<p lang="">x</p>', known).some((e) => /lang/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<img src="/media/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp" width="" alt="">', known).some((e) => /width/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<time datetime="not-a-date">x</time>', known).some((e) => /datetime/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<time datetime="2023-02-31">x</time>', known).some((e) => /datetime/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<time datetime="2023">x</time>', known)).toEqual([]);
    expect(validateClosedMatrixHtml('<time datetime="2023-08">x</time>', known)).toEqual([]);
    expect(validateClosedMatrixHtml('<time datetime="14:30">x</time>', known)).toEqual([]);
    expect(validateClosedMatrixHtml('<time datetime="2020-01-15">x</time>', known)).toEqual([]);
    expect(validateClosedMatrixHtml('<div role="button">x</div>', known).some((e) => /role/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<a href="/x" target="_blank">x</a>', known).some((e) => /noopener noreferrer/.test(e))).toBe(true);
    expect(validateClosedMatrixHtml('<a href="/x" target="_blank" rel="noopener noreferrer">x</a>', known)).toEqual([]);
  });

  it('sink marker только на root wrapper; вложенный p и внешний contenteditable ловятся', () => {
    const known = { knownSinkIds: ['article-body'] };
    const nested = '<div contenteditable="true"><p data-safe-rich-content="article-body">ok</p></div>';
    const matrix = validateClosedMatrixHtml(nested, known);
    expect(matrix.some((e) => /root wrapper/.test(e))).toBe(true);
    expect(unmarkedDocumentHazards(nested).some((h) => h.reason === 'contenteditable')).toBe(true);
    expect(validateClosedMatrixHtml('<div data-safe-rich-content="article-body"><p>ok</p></div>', known)).toEqual([]);
  });

  it('marker inventory видит известный sink-id на незарегистрированном route', () => {
    const sinks = [
      {
        id: 'article-body',
        production: { paths: ['/statyi/foo'], count: 1 },
        demo: { sameAsProduction: true },
      },
    ];
    const extra = collectMarkerInventoryErrors(sinks, 'production', [
      { route: '/statyi/foo', html: '<div data-safe-rich-content="article-body">x</div>' },
      { route: '/oplata', html: '<div data-safe-rich-content="article-body">y</div>' },
    ]);
    expect(extra.some((e) => /extra article-body на \/oplata/.test(e))).toBe(true);
    const ok = collectMarkerInventoryErrors(sinks, 'production', [
      { route: '/statyi/foo', html: '<div data-safe-rich-content="article-body">x</div>' },
      { route: '/oplata', html: '<p>нет sink</p>' },
    ]);
    expect(ok).toEqual([]);
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

describe('oracle invariants: src/srcset matrix', () => {
  it.each(SRC_SRCSET_CASES)('$id accept=$accept', ({ html, accept }) => {
    const errors = validateClosedMatrixHtml(html, MATRIX_OPTS);
    if (accept) expect(errors, errors.join('\n')).toEqual([]);
    else expect(errors.length, `${html}\n${errors.join('\n')}`).toBeGreaterThan(0);
  });
});

describe('oracle invariants: constrained value matrix', () => {
  it.each(CONSTRAINED_VALUE_CASES)('$id accept=$accept', ({ html, accept }) => {
    const errors = validateClosedMatrixHtml(html, MATRIX_OPTS);
    if (accept) expect(errors, errors.join('\n')).toEqual([]);
    else expect(errors.length, `${html}\n${errors.join('\n')}`).toBeGreaterThan(0);
  });
});

describe('oracle invariants: occurrence provenance', () => {
  it('каждый OCCURRENCE_TAGS имеет явное правило и case', () => {
    expect(Object.keys(OCCURRENCE_PROVENANCE).sort()).toEqual([...OCCURRENCE_TAGS].sort());
    expect(PROVENANCE_CASES.map((c) => c.tag).sort()).toEqual([...OCCURRENCE_TAGS].sort());
  });

  it.each(PROVENANCE_CASES)('$tag source→output не пересекается с соседним slot', ({ html, sources }) => {
    const found = collectOccurrences(html);
    expect(found, html).toHaveLength(2);
    const resolved = sources.map((source, i) => (source.includes('from-output') ? found[i].identity : source));
    const sourceSlots = [
      { slotId: 'src:a', identity: resolved[0] },
      { slotId: 'src:b', identity: resolved[1] },
    ];
    expect(
      matchOccurrences(html, '/x', [
        { slotId: 'src:a', route: '/x', placement: found[0].placement, identity: found[0].identity, count: 1 },
        { slotId: 'src:b', route: '/x', placement: found[1].placement, identity: found[1].identity, count: 1 },
      ], sourceSlots),
    ).toEqual([]);
    const crossed = matchOccurrences(html, '/x', [
      { slotId: 'src:b', route: '/x', placement: found[0].placement, identity: found[0].identity, count: 1 },
    ], sourceSlots);
    expect(crossed.some((e) => /не проецируется|source body/.test(e))).toBe(true);
  });
});
