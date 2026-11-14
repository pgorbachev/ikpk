import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { WEB_SRC } from './helpers/rich-content-safety/paths.js';
import { CANARY_HOSTILE_TOKEN } from './helpers/rich-content-safety/closed-matrix.js';
import { cleanBodyHtml, contextForSafeRichHtml } from '../src/lib/html-cleaner.js';
import { parse } from 'parse5';
import SeminarPage from '../src/pages/[institute]/[courseGroup]/[seminar].astro';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';

const RICH_CONTENT = join(WEB_SRC, 'components', 'RichContent.astro');

async function loadRichContent(): Promise<{ default: unknown }> {
  expect(existsSync(RICH_CONTENT)).toBe(true);
  const spec: string = pathToFileURL(RICH_CONTENT).href;
  return import(spec) as Promise<{ default: unknown }>;
}

describe('rich-content contract: RichContent.astro terminal sink', () => {
  it('существует singleton компонент', () => {
    expect(existsSync(RICH_CONTENT)).toBe(true);
  });

  it('принимает authenticated SafeRichHtml и ставит sink marker', async () => {
    const authenticated = cleanBodyHtml('<p>ok</p>', { sourceType: 'article', sourceId: 'context-check' });
    expect(authenticated).not.toBeTypeOf('string');
    expect(contextForSafeRichHtml(authenticated)).toEqual({ sourceType: 'article', sourceId: 'context-check' });
    const mod = await loadRichContent();
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default as never, {
      props: { html: authenticated, sinkId: 'article-body' },
    });
    expect(html).toContain('data-safe-rich-content="article-body"');
    expect(html).toContain('ok');
  });

  it('обычная строка проходит untrusted sanitization и теряет reserved markers', async () => {
    const mod = await loadRichContent();
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default as never, {
      props: {
        html: `<div data-safe-rich-content="forged" class="table-scroll"><p>plain</p><script>${CANARY_HOSTILE_TOKEN}</script></div>`,
        sinkId: 'article-body',
      },
    });
    expect(html).toContain('data-safe-rich-content="article-body"');
    expect(html).toContain('plain');
    expect(html).not.toMatch(/data-safe-rich-content="forged"/);
    expect(html).not.toMatch(/table-scroll/);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toContain(CANARY_HOSTILE_TOKEN);
  });

  it('поддельный объект проходит untrusted sanitization и теряет reserved markers', async () => {
    const mod = await loadRichContent();
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default as never, {
      props: {
        html: {
          html: `<div data-safe-rich-content="forged" class="table-scroll"><p>forged</p><script>${CANARY_HOSTILE_TOKEN}</script></div>`,
          token: 'forged',
        },
        sinkId: 'article-body',
      },
    });
    expect(html).toContain('data-safe-rich-content="article-body"');
    expect(html).toContain('forged');
    expect(html).not.toMatch(/data-safe-rich-content="forged"/);
    expect(html).not.toMatch(/table-scroll/);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toContain(CANARY_HOSTILE_TOKEN);
  });

  it('ошибка terminal sanitize для untrusted input содержит sink context', async () => {
    const mod = await loadRichContent();
    const container = await AstroContainer.create();
    await expect(container.renderToString(mod.default as never, {
      props: {
        html: '<img src="/media/uploads/missing-from-sink-context.webp" alt="x">',
        sinkId: 'article-body',
      },
    })).rejects.toThrow(/тип=sink ID=article-body/);
  });

  it('повторно санитизирует hostile html authenticated объекта у set:html', async () => {
    const authenticated = cleanBodyHtml(`<p data-canary-hostile="${CANARY_HOSTILE_TOKEN}">ok</p><script>${CANARY_HOSTILE_TOKEN}</script>`);
    expect(authenticated).not.toBeTypeOf('string');
    expect(htmlOf(authenticated).toLowerCase()).not.toContain('<script');
    expect(htmlOf(authenticated)).not.toContain(CANARY_HOSTILE_TOKEN);
    const mod = await loadRichContent();
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default as never, {
      props: { html: authenticated, sinkId: 'article-body' },
    });
    expect(html).toContain('data-safe-rich-content="article-body"');
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toContain(CANARY_HOSTILE_TOKEN);
  });

  it('data-testid course-group-extra-content не попадает в sanitized root', async () => {
    const authenticated = cleanBodyHtml('<p>x</p>');
    expect(authenticated).not.toBeTypeOf('string');
    const mod = await loadRichContent();
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default as never, {
      props: { html: authenticated, sinkId: 'course-group-extra' },
    });
    const marked = html.match(/data-safe-rich-content="course-group-extra"[\s\S]*$/);
    expect(marked?.[0] ?? html).not.toContain('data-testid="course-group-extra-content"');
  });
});

// The new CMS selector must reach the same terminal sanitizer on the real page.
it('structured seminar audience preserves prose and links but rejects executable HTML and forged markers', async () => {
  const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
  const html = await container.renderToString(SeminarPage, {
    request: new Request('https://ikpk.su/test/program/security-audience'),
    props: {
      institute: { name: 'Институт', slug: 'test' },
      courseGroup: { name: 'Программа', slug: 'program' },
      seminar: { name: 'Семинар', slug: 'security-audience', content_format: 'structured',
        audience: '<p>Для специалистов <a href="https://example.org/program">Программа</a></p><script>audience_attack()</script><img src="x" onerror="audience_attack()"><a href="javascript:audience_attack()">опасная ссылка</a><div data-safe-rich-content="forged-audience">Текст</div>' },
    },
  });
  type Node = { tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] };
  const walk = (node: Node): Node[] => [node, ...(node.childNodes ?? []).flatMap(walk)];
  const nodes = walk(parse(html) as Node);
  const regions = nodes.filter(n => n.attrs?.some(a => a.name === 'data-safe-rich-content' && a.value === 'seminar-audience'));
  expect(regions).toHaveLength(1);
  const audience = walk(regions[0]);
  expect(audience.map(n => n.value ?? '').join('')).toContain('Для специалистов');
  expect(audience.some(n => n.tagName === 'a' && n.attrs?.some(a => a.name === 'href' && a.value === 'https://example.org/program'))).toBe(true);
  expect(audience.some(n => ['script', 'iframe', 'object', 'embed'].includes(n.tagName ?? ''))).toBe(false);
  expect(audience.flatMap(n => n.attrs ?? []).some(a => /^on/i.test(a.name) || /javascript:|forged-audience/i.test(a.value))).toBe(false);
  expect(audience.map(n => n.value ?? '').join('')).not.toContain('audience_attack');
});
