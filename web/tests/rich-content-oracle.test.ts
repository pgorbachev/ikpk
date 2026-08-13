import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanBodyHtml } from '../src/lib/html-cleaner.js';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';
import { openOracleHarness, type OracleHarness } from './helpers/rich-content-safety/chromium-oracle.js';
import { DISCARD_WITH_CONTENT, AUTHENTICATED_FORMS, exactRutubeIframe, EXACT_RUTUBE_SRC, RUTUBE_IFRAME_ATTRS } from './helpers/rich-content-safety/closed-matrix.js';
import {
  collectOccurrences,
  MAP_IFRAME_SRC,
  provenanceError,
} from './helpers/rich-content-safety/hazard-scan.js';

const HOSTILE = {
  selfRemoving: '<script>document.currentScript.remove();alert(1)</script><p>after</p>',
  refresh: '<meta http-equiv="refresh" content="0;url=https://evil.test">',
  iframe: '<iframe src="https://evil.test"></iframe>',
  object: '<object data="https://evil.test/x.pdf"></object>',
  stylesheet: '<link rel="stylesheet" href="https://evil.test/x.css">',
  subresource: '<img src="https://evil.test/pixel.png">',
  misnested: '<b><i>x</b></i>',
  foreign: '<svg><script>alert(1)</script></svg>',
  mxss: '<img src=x onerror="alert(1)">',
  entityMxss: '&lt;img src=x onerror=alert(1)&gt;<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
};

describe('rich-content contract: Chromium DOMParser oracle', () => {
  let harness: OracleHarness;

  beforeAll(async () => {
    harness = await openOracleHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('разбирает bytes через DOMParser на about:blank без сети и навигации', async () => {
    const parsed = await harness.parse('<p>hello</p>');
    expect(parsed.mainFrameUrl).toMatch(/^about:blank/);
    expect(parsed.continuedRequests).toEqual([]);
    expect(parsed.html).toContain('hello');
  });

  it('self-removing script виден scanner-у и отвергается после sanitizer', async () => {
    const sanitized = htmlOf(cleanBodyHtml(HOSTILE.selfRemoving));
    const parsed = await harness.parse(sanitized);
    expect(parsed.tagNames).not.toContain('script');
    expect(parsed.continuedRequests).toEqual([]);
  });

  it('refresh/iframe/object/stylesheet/subresource abort и отвергаются', async () => {
    for (const html of [HOSTILE.refresh, HOSTILE.iframe, HOSTILE.object, HOSTILE.stylesheet, HOSTILE.subresource]) {
      const sanitized = htmlOf(cleanBodyHtml(html));
      const parsed = await harness.parse(sanitized);
      expect(parsed.continuedRequests, html).toEqual([]);
      expect(parsed.mainFrameUrl).toMatch(/^about:blank/);
      expect(parsed.tagNames).not.toContain('iframe');
      expect(parsed.tagNames).not.toContain('object');
      expect(parsed.tagNames).not.toContain('meta');
      expect(sanitized).not.toMatch(/evil\.test/);
    }
  });

  it('misnested и foreign content проверяются по browser DOM', async () => {
    const mis = await harness.parse(htmlOf(cleanBodyHtml(HOSTILE.misnested)));
    expect(mis.tagNames).not.toContain('script');
    const foreign = await harness.parse(htmlOf(cleanBodyHtml(HOSTILE.foreign)));
    expect(foreign.tagNames).not.toContain('svg');
    expect(foreign.tagNames).not.toContain('script');
  });

  it('entity-encoded mXSS не оставляет активный img onerror', async () => {
    const parsed = await harness.parse(htmlOf(cleanBodyHtml(HOSTILE.entityMxss)));
    expect(parsed.serialized).not.toMatch(/onerror/i);
    expect(parsed.tagNames).not.toContain('script');
  });

  it('matrix-complement не проходит oracle', async () => {
    for (const tag of DISCARD_WITH_CONTENT) {
      const parsed = await harness.parse(htmlOf(cleanBodyHtml(`<${tag}>payload</${tag}>`)));
      expect(parsed.tagNames, tag).not.toContain(tag);
    }
  });

  it('точные system-marker forms разбираются oracle без сети', async () => {
    for (const [name, html] of Object.entries(AUTHENTICATED_FORMS)) {
      const parsed = await harness.parse(html);
      expect(parsed.continuedRequests, name).toEqual([]);
      expect(parsed.mainFrameUrl).toMatch(/^about:blank/);
    }
  });

  it('точный RUTUBE iframe form проходит oracle с системными attrs', async () => {
    const parsedExact = await harness.parse(exactRutubeIframe());
    expect(parsedExact.continuedRequests).toEqual([]);
    expect(parsedExact.tagNames).toContain('iframe');
    const sanitized = htmlOf(cleanBodyHtml(`<iframe src="${EXACT_RUTUBE_SRC}" sandbox="allow-scripts"></iframe>`));
    const parsed = await harness.parse(sanitized);
    expect(parsed.tagNames).toContain('iframe');
    expect(parsed.html).toContain(`sandbox="${RUTUBE_IFRAME_ATTRS.sandbox}"`);
    expect(parsed.html).toContain(`allow="${RUTUBE_IFRAME_ATTRS.allow}"`);
    expect(parsed.html).toContain(`referrerpolicy="${RUTUBE_IFRAME_ATTRS.referrerpolicy}"`);
  });

  it('mapSrc projection совпадает с Chromium-сериализованным iframe src', async () => {
    const parsed = await harness.parse(`<iframe src="${MAP_IFRAME_SRC}" title="Карта ИКПК"></iframe>`);
    expect(parsed.serialized).toMatch(/&amp;z=16/);
    const found = collectOccurrences(parsed.serialized);
    expect(found).toHaveLength(1);
    expect(provenanceError(
      'iframe|src=expression:mapSrc|title=quoted:Карта ИКПК',
      found[0].identity,
    )).toBeNull();
  });

  it('double-encoded ampersand не проходит mapSrc projection', async () => {
    const html = `<iframe src="${MAP_IFRAME_SRC.replace('&z=16', '&amp;amp;z=16')}" title="Карта ИКПК"></iframe>`;
    const parsed = await harness.parse(html);
    expect(parsed.serialized).toMatch(/&amp;amp;z=16/);
    const found = collectOccurrences(parsed.serialized);
    expect(found).toHaveLength(1);
    expect(provenanceError(
      'iframe|src=expression:mapSrc|title=quoted:Карта ИКПК',
      found[0].identity,
    )).toMatch(/≠ projected/);
  });
});
