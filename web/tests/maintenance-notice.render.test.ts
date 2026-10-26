import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import BaseLayout from '../src/layouts/BaseLayout.astro';
import TopNavLayout from '../src/layouts/TopNavLayout.astro';
import { attr, parseDocument, textOf, walk } from './helpers/dom';

const TITLE = 'На сайте ведутся технические работы';
const cases = [
  { name: 'BaseLayout', layout: BaseLayout, path: '/raspisanie-i-tseny', noindex: false },
  { name: 'TopNavLayout', layout: TopNavLayout, path: '/', noindex: false },
  { name: '404', layout: BaseLayout, path: '/404', noindex: true },
];

describe.each(cases)('maintenance notice: $name', ({ layout, path, noindex }) => {
  async function render() {
    const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
    const html = await container.renderToString(layout, {
      request: new Request(`https://ikpk.su${path}`),
      props: { title: 'Проверка страницы', noindex, hideWidgets: noindex },
      slots: { default: '<h1>Содержимое страницы</h1>' },
    });
    return { html, elements: [...walk(parseDocument(html))] };
  }

  it('does not render the maintenance notice', async () => {
    const { elements } = await render();
    const body = elements.find((el) => el.tagName === 'body')!;
    const main = elements.find((el) => el.tagName === 'main')!;
    const nav = elements.find((el) => el.tagName === 'nav')!;
    expect(body).toBeDefined();
    expect(main).toBeDefined();
    expect(nav).toBeDefined();
    expect(textOf(main)).toContain('Содержимое страницы');
    expect(textOf(body)).not.toContain(TITLE);
    expect(elements.filter((el) => attr(el, 'aria-label') === 'Технические работы')).toHaveLength(0);
  });

  it('preserves canonical, robots, live forms and analytics without enabling demo forms', async () => {
    const { html, elements } = await render();
    expect(elements.filter((el) => attr(el, 'data-demo-banner') !== null)).toHaveLength(0);
    const canonical = elements.find((el) => el.tagName === 'link' && attr(el, 'rel') === 'canonical');
    expect(canonical && attr(canonical, 'href')).toBe(`https://ikpk.su${path}`);
    const robots = elements.filter((el) => el.tagName === 'meta' && attr(el, 'name') === 'robots');
    expect(robots.map((el) => attr(el, 'content'))).toEqual(noindex ? ['noindex, nofollow'] : []);
    if (layout === BaseLayout) {
      expect(elements.some((el) => attr(el, 'href') === 'https://b24-cbqwqo.bitrix24site.ru/news/')).toBe(true);
    }
    expect(html).toContain('https://mc.yandex.ru/metrika/tag.js');
    expect(html).toContain('https://top-fwz1.mail.ru/js/code.js');
  });
});
