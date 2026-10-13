import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import BaseLayout from '../src/layouts/BaseLayout.astro';
import TopNavLayout from '../src/layouts/TopNavLayout.astro';
import { attr, parseDocument, textOf, walk } from './helpers/dom';

const TITLE = 'На сайте ведутся технические работы';
const MESSAGE = 'Некоторые разделы могут работать некорректно. Приносим извинения за временные неудобства';
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

  it('renders one complete notice before navigation, outside searchable content, without controls', async () => {
    const { elements } = await render();
    const body = elements.find((el) => el.tagName === 'body')!;
    const main = elements.find((el) => el.tagName === 'main')!;
    const nav = elements.find((el) => el.tagName === 'nav')!;
    expect(body).toBeDefined();
    expect(main).toBeDefined();
    expect(nav).toBeDefined();
    expect(textOf(main)).toContain('Содержимое страницы');
    expect(textOf(body).split(TITLE).length - 1, 'notice missing or duplicated in initial HTML').toBe(1);
    const notices = elements.filter((el) => attr(el, 'aria-label') === 'Технические работы');
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    expect(textOf(notice)).toContain(TITLE);
    expect(textOf(notice)).toContain(MESSAGE);
    expect(elements.indexOf(notice)).toBeLessThan(elements.indexOf(nav));
    expect([...walk(main)]).not.toContain(notice);
    for (const searchable of elements.filter((el) => attr(el, 'data-pagefind-body') !== null)) {
      expect([...walk(searchable)]).not.toContain(notice);
    }
    expect([notice, ...walk(notice)].filter((el) =>
      ['button', 'a', 'input', 'select', 'textarea', 'dialog', 'script', 'template'].includes(el.tagName)
      || ['button', 'dialog'].includes(attr(el, 'role') ?? '')
      || attr(el, 'hidden') !== null || attr(el, 'aria-hidden') === 'true',
    )).toHaveLength(0);
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
