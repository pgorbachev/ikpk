import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function useDemo193Profile(): Promise<NodeJS.ProcessEnv> {
  const { resolveDemo193Environment } = await import('../scripts/demo193-profile.mjs');
  const env = resolveDemo193Environment({ DEMO_OUTPUT: '1', PAYMENT_ROLE: 'stand', DEMO_FORMS: 'customer.bitrix24site.ru' });
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) vi.stubEnv(key, value);
  }
  return env;
}

describe('rendered demo193 build profile', () => {
  it('keeps the actual Yandex reviews embed on the deployed stage output', async () => {
    await useDemo193Profile();
    const { default: Reviews } = await import('../src/components/home/sections/Reviews.astro');
    const html = await (await AstroContainer.create()).renderToString(Reviews as never);

    expect(html).toContain('data-reviews-embed="https://yandex.ru/maps-reviews-widget/112883331290?comments"');
  });

  it('blocks indexing while retaining the stage banner and ci payment role', async () => {
    const env = await useDemo193Profile();
    const { GET } = await import('../src/pages/robots.txt.ts');
    const response = await GET({} as never);
    expect(await response.text()).toMatch(/^User-agent: \*\s+Disallow: \/$/m);

    const { default: BaseLayout } = await import('../src/layouts/BaseLayout.astro');
    const html = await (await AstroContainer.create({ astroConfig: { site: env.DEMO_SITE_URL } }))
      .renderToString(BaseLayout as never, {
        props: {
          title: 'Profile',
          description: 'Profile',
          schema: { url: 'https://ikpk.su/', '@id': 'https://ikpk.su/#website', description: 'https://ikpk.su/description' },
        },
      });
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex, nofollow"/);
    expect(html).toContain('https://194.226.99.10/');
    const schemaText = html.match(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/s)?.[1];
    if (schemaText === undefined) throw new Error('rendered profile has no JSON-LD schema');
    expect(JSON.parse(schemaText)).toEqual({
      url: 'https://194.226.99.10/',
      '@id': 'https://194.226.99.10/#website',
      description: 'https://ikpk.su/description',
    });
    expect(html).toContain('Стейджинг-стенд: формы заявки отключены');
    expect(html).not.toContain('data-payment-role="stand"');
  });
});
