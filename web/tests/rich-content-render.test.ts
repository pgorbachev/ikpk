import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { WEB_SRC } from './helpers/rich-content-safety/paths.js';
import { CANARY_HOSTILE_TOKEN } from './helpers/rich-content-safety/closed-matrix.js';
import { cleanBodyHtml } from '../src/lib/html-cleaner.js';
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
    const authenticated = cleanBodyHtml('<p>ok</p>');
    expect(authenticated).not.toBeTypeOf('string');
    const mod = await loadRichContent();
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default as never, {
      props: { html: authenticated, sinkId: 'article-body' },
    });
    expect(html).toContain('data-safe-rich-content="article-body"');
    expect(html).toContain('ok');
  });

  it('отклоняет обычную строку перед set:html', async () => {
    const mod = await loadRichContent();
    const container = await AstroContainer.create();
    await expect(
      container.renderToString(mod.default as never, {
        props: { html: '<p>plain</p>', sinkId: 'article-body' },
      }),
    ).rejects.toThrow();
  });

  it('отклоняет поддельный runtime token', async () => {
    const mod = await loadRichContent();
    const container = await AstroContainer.create();
    await expect(
      container.renderToString(mod.default as never, {
        props: { html: { html: '<p>forged</p>', token: 'forged' }, sinkId: 'article-body' },
      }),
    ).rejects.toThrow();
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
