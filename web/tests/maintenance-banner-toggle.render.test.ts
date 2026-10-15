import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { attr, hasClass, parseDocument, walk } from './helpers/dom';

const cases = [
  { name: 'BaseLayout', module: '../src/layouts/BaseLayout.astro' },
  { name: 'TopNavLayout', module: '../src/layouts/TopNavLayout.astro' },
] as const;

const states = [
  {
    name: 'production default keeps the maintenance notice on',
    env: {},
    maintenance: 1,
    demo: 0,
  },
  {
    name: 'production explicit on keeps the maintenance notice on',
    env: { MAINTENANCE_BANNER: 'on' },
    maintenance: 1,
    demo: 0,
  },
  {
    name: 'production explicit off removes the maintenance notice',
    env: { MAINTENANCE_BANNER: 'off' },
    maintenance: 0,
    demo: 0,
  },
  {
    name: 'demo build with maintenance on shows only the demo notice',
    env: { MAINTENANCE_BANNER: 'on', DEMO_FORMS: 'stub', DEMO_OUTPUT: '1' },
    maintenance: 0,
    demo: 1,
  },
  {
    name: 'demo build default shows only the demo notice',
    env: { DEMO_FORMS: 'stub', DEMO_OUTPUT: '1' },
    maintenance: 0,
    demo: 1,
  },
] as const;

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(cases)('$name maintenance banner configuration', ({ module }) => {
  async function render(env: Record<string, string>) {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    const { default: layout } = await import(module);
    const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
    const html = await container.renderToString(layout, {
      request: new Request('https://ikpk.su/'),
      props: { title: 'Проверка баннера' },
      slots: { default: '<h1>Содержимое страницы</h1>' },
    });
    return [...walk(parseDocument(html))];
  }

  it.each(states)('$name', async ({ env, maintenance, demo }) => {
    const elements = await render(env);
    expect(elements.filter((element) => hasClass(element, 'maintenance-notice'))).toHaveLength(maintenance);
    expect(elements.filter((element) => attr(element, 'data-demo-banner') !== null)).toHaveLength(demo);
  });

  it('fails closed for an unsupported maintenance flag value', async () => {
    let failure: unknown;
    try {
      await render({ MAINTENANCE_BANNER: 'sometimes' });
    } catch (error) {
      failure = error;
    }
    expect(failure, 'unsupported MAINTENANCE_BANNER value must fail instead of disabling the notice').toBeDefined();
    expect(String(failure)).toMatch(/MAINTENANCE_BANNER/);
  });
});
