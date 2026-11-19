import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attr, findAll, textOf, walk } from './helpers/dom';
import { buildSeminarDatesFixture } from './helpers/seminar-dates-fixture';

import { refreshStaging194 } from './helpers/staging194-refresh-fixture';

const approvedOrigin = 'https://194.226.99.10';
const real = 'https://b24-fixture.bitrix24site.ru/crm_form/registration/?a=1&b=2';
const temporary = 'https://forms.example.invalid/temporary/?session=26';
const editorialForm = 'https://b24-fixture.bitrix24site.ru/crm_form/editorial/';
const links = { 25: real, 26: temporary, 27: null };

function hrefInCard(html: string, selector: 'schedule' | 'detail', city: string) {
  const cards = findAll(html, (element) => selector === 'schedule'
    ? attr(element, 'data-testid') === 'schedule-card'
    : attr(element, 'data-seminar-schedule-card') !== null);
  const card = cards.find((element) => textOf(element).includes(city));
  expect(card, city).toBeDefined();
  return [...walk(card)].filter((element) => element.tagName === 'a' && /Записаться на/.test(textOf(element)))
    .map((element) => attr(element, 'href'));
}

describe('registration links in the staging194 static output', () => {
  let fixture: ReturnType<typeof buildSeminarDatesFixture>;
  beforeAll(() => {
    fixture = buildSeminarDatesFixture({ registrationLinks: links, editorialFormHref: editorialForm, environment: {
      DEMO_PROFILE: 'demo193',
      DEMO_SITE_URL: approvedOrigin,
      DEPLOY_MODE: 'stand',
      DEMO_FORMS: 'stub',
      PAYMENT_ROLE: 'ci',
      CHAT_LOADER_SRC: 'none',
      CHAT_OFFLINE_MESSAGE: 'absent',
      STAGING194_REGISTRATION_LINKS: '1',
    } });
  }, 150_000);
  afterAll(() => fixture?.close());

  const read = (...path: string[]) => readFileSync(join(fixture.outDir, ...path), 'utf8');

  it('keeps exact URLs with their respective occurrences on the schedule and seminar detail', () => {
    const { institute, group, planned, nextYear } = fixture.pages;
    const schedule = read('raspisanie-i-tseny', 'index.html');
    const detail = read(institute.slug, group.slug, planned.slug, 'index.html');
    const emptyLinkDetail = read(institute.slug, group.slug, nextYear.slug, 'index.html');
    for (const [html, selector] of [[schedule, 'schedule'], [detail, 'detail']] as const) {
      expect(hrefInCard(html, selector, 'Два месяца')).toEqual([real]);
      expect(hrefInCard(html, selector, 'Три месяца')).toEqual([temporary]);
    }
    expect(hrefInCard(schedule, 'schedule', 'Следующий год')).toEqual([]);
    expect(hrefInCard(emptyLinkDetail, 'detail', 'Следующий год')).toEqual(['/raspisanie-i-tseny']);
  });

  it('keeps staging canonical, robots, disabled integrations and a banner that distinguishes the forms', () => {
    const html = read('raspisanie-i-tseny', 'index.html');
    expect(findAll(html, (el) => attr(el, 'rel') === 'canonical').map((el) => attr(el, 'href')))
      .toEqual([`${approvedOrigin}/raspisanie-i-tseny`]);
    expect(findAll(html, (el) => attr(el, 'name') === 'robots').map((el) => attr(el, 'content')))
      .toEqual(['noindex, nofollow']);
    expect(read('robots.txt')).toMatch(/^User-agent: \*\r?\nDisallow: \/\s*$/m);
    expect(html).not.toMatch(/metrika\/tag\.js|mc\.yandex\.(?:ru|com)|crm\/site_button\/loader|data-payment-form/);
    const banners = findAll(html, (el) => attr(el, 'data-demo-banner') !== null).map(textOf);
    expect(banners).toHaveLength(1);
    expect(banners[0]).toMatch(/ссылк.{0,40}запис|запис.{0,40}ссылк/i);
    expect(banners[0]).toMatch(/действу|реальн|работа/i);
    expect(banners[0]).toMatch(/заглушк/i);
  });
  it('uses the stub for a CRM link in editorial HTML', () => {
    const article = read('statyi', 'registration-link-fixture', 'index.html');
    const registration = findAll(article, (el) => el.tagName === 'a' && textOf(el).includes('Запись из статьи'));
    expect(registration.map((el) => attr(el, 'href'))).toEqual(['/demo-zayavka']);
    expect(article).not.toContain(editorialForm);
  });

  it('publishes the matching candidate through the CMS worker', () => {
    const { result, current, active, previous } = refreshStaging194(fixture);
    expect(result.status, JSON.stringify(result)).toBe('succeeded');
    expect(current).not.toBe(previous);
    expect(active.snapshotId).toBe(JSON.parse(readFileSync(join(fixture.snapshotDir, 'snapshot.json'), 'utf8')).snapshotId);
  });

  it.each([
    ['swapped URLs', `
      rewrite('Два месяца', ${JSON.stringify(temporary)});
      rewrite('Три месяца', ${JSON.stringify(real.replace('&', '&amp;'))});
    `],
    ['extra URL', `html = html.replace(/<article\\b[^>]*>.*?<\\/article>/gs, (card) =>
        card.includes('Два месяца') ? card.replace('</article>',
          '<a href="https://extra.example.invalid/another">Записаться на семинар</a></article>') : card);`],
    ['missing CTA', `rewrite('Два месяца', null);`],
    ['URL for an empty occurrence', `rewrite('Следующий год', 'https://extra.example.invalid/empty');`],
    ['missing schedule page', 'fs.unlinkSync(path);'],
  ])('rejects %s before changing the active CMS refresh release', (_scenario, mutate) => {
    const { result, current, active, previous } = refreshStaging194(fixture, String.raw`
      const path = 'dist-demo193/raspisanie-i-tseny/index.html';
      const before = fs.readFileSync(path, 'utf8');
      let html = before;
      function rewrite(city, href) {
        html = html.replace(/<article\b[^>]*>.*?<\/article>/gs, (card) => {
          if (!card.includes(city)) return card;
          const pattern = /<a\b[^>]*class="btn btn-primary"[^>]*>[\s\S]*?<\/a>/;
          if (href === null) return card.replace(pattern, '');
          if (!pattern.test(card)) return card.replace('</article>', '<a href="' + href + '">Записаться на семинар</a></article>');
          return card.replace(pattern, (cta) => cta.replace(/href="[^"]*"/, 'href="' + href + '"'));
        });
      }
      ${mutate}
      if (fs.existsSync(path)) {
        if (html === before) throw Error('candidate mutation did not match the rendered output');
        fs.writeFileSync(path, html);
      }
    `);
    expect(current, JSON.stringify(result)).toBe(previous);
    expect(active.snapshotId).toBe('snap:old');
    expect(result.status).toBe('failed');
    expect(result.switched).toBe(false);
  });

});
