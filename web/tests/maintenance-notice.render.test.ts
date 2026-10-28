import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { attr, hasClass, parseDocument, textOf, walk } from './helpers/dom';

const TITLE = 'На сайте ведутся технические работы';
const cases = [
  { name: 'BaseLayout', module: '../src/layouts/BaseLayout.astro', path: '/raspisanie-i-tseny', noindex: false },
  { name: 'TopNavLayout', module: '../src/layouts/TopNavLayout.astro', path: '/', noindex: false },
  { name: '404', module: '../src/layouts/BaseLayout.astro', path: '/404', noindex: true },
] as const;
const states: Array<{ name: string; env: Record<string, string | undefined>; notice: number; demo: number }> = [
  { name: 'unset defaults off', env: {}, notice: 0, demo: 0 },
  { name: 'empty defaults off', env: { MAINTENANCE_BANNER: '' }, notice: 0, demo: 0 },
  { name: 'whitespace defaults off', env: { MAINTENANCE_BANNER: ' \t ' }, notice: 0, demo: 0 },
  { name: 'explicit off', env: { MAINTENANCE_BANNER: 'off' }, notice: 0, demo: 0 },
  { name: 'explicit on', env: { MAINTENANCE_BANNER: 'on' }, notice: 1, demo: 0 },
  { name: 'surrounding whitespace is ignored', env: { MAINTENANCE_BANNER: ' on\n' }, notice: 1, demo: 0 },
  { name: 'demo output suppresses maintenance', env: { MAINTENANCE_BANNER: 'on', DEMO_OUTPUT: '1' }, notice: 0, demo: 0 },
  { name: 'demo forms retain only demo notice', env: { MAINTENANCE_BANNER: 'on', DEMO_FORMS: 'stub' }, notice: 0, demo: 1 },
  { name: 'demo profile retains only stage notice', env: { MAINTENANCE_BANNER: 'on', DEMO_FORMS: 'stub', DEMO_PROFILE: 'demo193' }, notice: 0, demo: 1 },
];

beforeEach(() => {
  vi.resetModules();
  for (const key of ['MAINTENANCE_BANNER', 'DEMO_FORMS', 'DEMO_OUTPUT', 'DEMO_PROFILE']) vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(cases)('maintenance notice: $name', ({ module, path, noindex }) => {
  async function render(env: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { default: layout } = await import(module);
    const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
    const html = await container.renderToString(layout, {
      request: new Request(`https://ikpk.su${path}`),
      props: { title: 'Проверка страницы', noindex, hideWidgets: noindex },
      slots: { default: '<h1>Содержимое страницы</h1>' },
    });
    return { html, elements: [...walk(parseDocument(html))] };
  }

  it.each(states)('$name', async ({ env, notice, demo }) => {
    const { html, elements } = await render(env);
    const body = elements.find((el) => el.tagName === 'body')!;
    const main = elements.find((el) => el.tagName === 'main')!;
    const nav = elements.find((el) => el.tagName === 'nav')!;
    expect(body).toBeDefined();
    expect(main).toBeDefined();
    expect(nav).toBeDefined();
    expect(textOf(main)).toContain('Содержимое страницы');
    const notices = elements.filter((el) => hasClass(el, 'maintenance-notice'));
    expect(notices).toHaveLength(notice);
    expect(elements.filter((el) => attr(el, 'aria-label') === 'Технические работы')).toHaveLength(notice);
    expect(elements.filter((el) => attr(el, 'data-demo-banner') !== null)).toHaveLength(demo);
    expect(textOf(main)).not.toContain(TITLE);
    if (notice) {
      const maintenance = notices[0];
      expect(textOf(maintenance)).toContain(TITLE);
      expect(attr(maintenance, 'data-pagefind-ignore')).not.toBeNull();
      expect([...walk(main)]).not.toContain(maintenance);
      expect(elements.indexOf(maintenance)).toBeLessThan(elements.indexOf(nav));
    } else {
      expect(textOf(body)).not.toContain(TITLE);
    }
    if (env.DEMO_PROFILE === 'demo193') expect(textOf(body)).toContain('Стейджинг-стенд: формы заявки отключены');
    if (demo || env.DEMO_OUTPUT) return;

    // The switch must not turn a live build into a demo or alter its SEO/content.
    const canonical = elements.find((el) => el.tagName === 'link' && attr(el, 'rel') === 'canonical');
    expect(canonical && attr(canonical, 'href')).toBe(`https://ikpk.su${path}`);
    const robots = elements.filter((el) => el.tagName === 'meta' && attr(el, 'name') === 'robots');
    expect(robots.map((el) => attr(el, 'content'))).toEqual(noindex ? ['noindex, nofollow'] : []);
    if (module.endsWith('/BaseLayout.astro')) {
      expect(elements.some((el) => attr(el, 'href') === 'https://b24-cbqwqo.bitrix24site.ru/news/')).toBe(true);
    }
    expect(html).toContain('https://mc.yandex.ru/metrika/tag.js');
    expect(html).toContain('https://top-fwz1.mail.ru/js/code.js');
  });

  it.each([
    { name: 'unknown value', env: { MAINTENANCE_BANNER: 'sometimes' } },
    { name: 'unsupported case', env: { MAINTENANCE_BANNER: 'ON' } },
    { name: 'invalid value in demo forms', env: { MAINTENANCE_BANNER: 'sometimes', DEMO_FORMS: 'stub' } },
    { name: 'invalid value in demo output', env: { MAINTENANCE_BANNER: 'sometimes', DEMO_OUTPUT: '1' } },
  ])('rejects $name', async ({ env }) => {
    await expect(render(env)).rejects.toThrow(/MAINTENANCE_BANNER/);
  });
});
