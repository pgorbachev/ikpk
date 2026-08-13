import { describe, expect, it } from 'vitest';
import { cleanBodyHtml } from '../src/lib/html-cleaner.js';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';
import {
  scanHtmlForHazards,
  matchOccurrences,
  collectOccurrences,
  unmarkedDocumentHazards,
} from './helpers/rich-content-safety/hazard-scan.js';
import { exactRutubeIframe } from './helpers/rich-content-safety/closed-matrix.js';

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

  it('не считает hazard-ом точный RUTUBE iframe и JSON-LD script', () => {
    const html = `${exactRutubeIframe()}<script type="application/ld+json">{}</script>`;
    const hits = scanHtmlForHazards(html);
    expect(hits.filter((h) => h.tag === 'iframe' || h.tag === 'script')).toEqual([]);
  });

  it('sanitizer output не оставляет hazards', () => {
    const sanitized = htmlOf(
      cleanBodyHtml('<p onclick="alert(1)">ok</p><script>alert(1)</script><frame src="https://evil.test">'),
    );
    expect(scanHtmlForHazards(sanitized)).toEqual([]);
  });

  it('пустой occurrence registry не совпадает с executable элементами', () => {
    const errors = matchOccurrences('<script>window.x=1</script>', '/oplata', []);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('occurrence matcher требует identity, placement и count, а не только имя тега', () => {
    const html = '<script>alpha()</script><script>beta()</script>';
    const found = collectOccurrences(html);
    expect(found).toHaveLength(2);
    expect(found[0].identity).not.toBe(found[1].identity);

    const oneRule = [
      {
        slotId: 'src:only-alpha',
        route: '/x',
        placement: '*',
        identity: found[0].identity,
        count: 1,
      },
    ];
    const extra = matchOccurrences(html, '/x', oneRule);
    expect(extra.some((e) => /нет occurrence rule/.test(e))).toBe(true);

    const unused = matchOccurrences('<p>no scripts</p>', '/x', oneRule);
    expect(unused.some((e) => /ожидал count=1/.test(e))).toBe(true);

    const dup = '<script>alpha()</script><script>alpha()</script>';
    const dupFound = collectOccurrences(dup);
    expect(dupFound[0].identity).toBe(dupFound[1].identity);
    const dupErrors = matchOccurrences(dup, '/x', [
      { slotId: 'src:alpha', route: '/x', placement: '*', identity: dupFound[0].identity, count: 1 },
    ]);
    expect(dupErrors.length).toBeGreaterThan(0);

    const ok = matchOccurrences(html, '/x', [
      { slotId: 'src:alpha', route: '/x', placement: '*', identity: found[0].identity, count: 1 },
      { slotId: 'src:beta', route: '/x', placement: '*', identity: found[1].identity, count: 1 },
    ]);
    expect(ok).toEqual([]);
  });
});
