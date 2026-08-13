import { describe, expect, it } from 'vitest';
import { cleanBodyHtml } from '../src/lib/html-cleaner.js';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';
import { scanHtmlForHazards, matchOccurrences } from './helpers/rich-content-safety/hazard-scan.js';
import { exactRutubeIframe } from './helpers/rich-content-safety/closed-matrix.js';

describe('rich-content: whole-document hazard scanner', () => {
  it('ловит on*, srcdoc, XML/XLink, forbidden schemes, frame/frameset', () => {
    const html = [
      '<p onclick="alert(1)">x</p>',
      '<iframe srcdoc="<p>y</p>"></iframe>',
      '<a xlink:href="javascript:alert(1)">z</a>',
      '<a href="javascript:alert(1)">j</a>',
      '<frame src="https://evil.test">',
      '<frameset><frame src="https://evil.test"></frameset>',
    ].join('');
    const hits = scanHtmlForHazards(html);
    expect(hits.some((h) => h.reason === 'event-handler')).toBe(true);
    expect(hits.some((h) => h.reason === 'srcdoc')).toBe(true);
    expect(hits.some((h) => h.reason === 'xml-xlink' || h.reason.startsWith('forbidden-scheme'))).toBe(true);
    expect(hits.some((h) => h.reason.includes('frame'))).toBe(true);
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
    const errors = matchOccurrences(
      '<script>window.x=1</script>',
      '/oplata',
      [],
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
