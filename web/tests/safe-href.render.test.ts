import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SeminarSchedulePanel from '../src/components/seminars/SeminarSchedulePanel.astro';
import PromotionsPage from '../src/pages/aktsii-i-skidki.astro';
import { getScheduleEntries, type Promotion } from '../src/lib/data';
import * as data from '../src/lib/data';

const rejected = 'javascript:example';
const httpsUrl = 'https://example.com/signup';
const sitePath = '/signup';

function hrefsOf(html: string, className: string): string[] {
  const tags = html.match(/<a\b[^>]*>/g) ?? [];
  const classToken = new RegExp(`\\bclass="[^"]*\\b${className}\\b[^"]*"`);
  return tags
    .filter((tag) => classToken.test(tag))
    .map((tag) => tag.match(/\bhref="([^"]*)"/)?.[1] ?? '');
}

function promo(link: string, name: string): Promotion {
  return {
    id: name.length,
    name,
    priority: 1,
    image: { url: '', id: '' },
    description: '<p>Описание</p>',
    link,
    createdAt: '2026-01-01T00:00:00.000Z',
    type: 'INSTITUTE',
  };
}

describe('reject disallowed URL schemes in registration and promo links', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sign-up button omits a rejected href and keeps https and a single-slash path', async () => {
    const entry = getScheduleEntries()[0];
    const rows = [rejected, httpsUrl, sitePath].map((registrationFormLink, index) => ({
      entry: { ...entry, id: index + 1, registrationFormLink },
      teachers: [],
    }));
    const html = await (await AstroContainer.create()).renderToString(SeminarSchedulePanel, {
      props: { rows },
    });
    const hrefs = hrefsOf(html, 'seminar-register-link');
    expect(hrefs).not.toContain(rejected);
    expect(hrefs).toContain(httpsUrl);
    expect(hrefs).toContain(sitePath);
  });

  it('promo page omits a rejected href and keeps https and a single-slash path', async () => {
    vi.spyOn(data, 'getPromotions').mockReturnValue([
      promo(rejected, 'Rejected'),
      promo(httpsUrl, 'Https'),
      promo(sitePath, 'Path'),
    ]);
    const html = await (await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } }))
      .renderToString(PromotionsPage, {
        request: new Request('https://ikpk.su/aktsii-i-skidki'),
      });
    const hrefs = hrefsOf(html, 'promo-link');
    expect(hrefs).not.toContain(rejected);
    expect(hrefs).toContain(httpsUrl);
    expect(hrefs).toContain(sitePath);
  });
});
