import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { WEB_SRC } from './helpers/rich-content-safety/paths.js';
import { CANARY_HOSTILE_TOKEN } from './helpers/rich-content-safety/closed-matrix.js';

const RICH_CONTENT = join(WEB_SRC, 'components', 'RichContent.astro');

describe('rich-content contract: RichContent.astro terminal sink', () => {
  it('существует singleton компонент', () => {
    expect(existsSync(RICH_CONTENT)).toBe(true);
  });

  it('не принимает поддельный token и санитизирует hostile payload у set:html', async () => {
    expect(existsSync(RICH_CONTENT)).toBe(true);
    const mod = await import('../src/components/RichContent.astro');
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default, {
      props: {
        html: `<p>${CANARY_HOSTILE_TOKEN}</p><script>alert(1)</script>`,
        sinkId: 'article-body',
      },
    });
    expect(html).toContain('data-safe-rich-content="article-body"');
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toContain(CANARY_HOSTILE_TOKEN);
  });

  it('data-testid course-group-extra-content не попадает в sanitized root', async () => {
    expect(existsSync(RICH_CONTENT)).toBe(true);
    const mod = await import('../src/components/RichContent.astro');
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default, {
      props: {
        html: '<p>x</p>',
        sinkId: 'course-group-extra',
      },
    });
    const marked = html.match(/data-safe-rich-content="course-group-extra"[\s\S]*$/);
    expect(marked?.[0] ?? html).not.toContain('data-testid="course-group-extra-content"');
  });
});
