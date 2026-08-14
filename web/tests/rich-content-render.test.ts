import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { WEB_SRC } from './helpers/rich-content-safety/paths.js';
import { CANARY_HOSTILE_TOKEN } from './helpers/rich-content-safety/closed-matrix.js';
import { cleanBodyHtml, contextForSafeRichHtml } from '../src/lib/html-cleaner.js';
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
