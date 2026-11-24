import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { attr, byClass, findAll, textOf, walk, type Element } from './dom';

export const organizationSlug = 'svedeniya-ob-obrazovatelnoy-organizatsii';
export const editorialPhone = 'Дежурный партнёра: +7 (812) 646-54-50';

type Phone = [string, string];

function assertPhoneLinks(block: Element, expected: Phone[]) {
  expect(block).toBeDefined();
  const links = [...walk(block)].filter((el) => attr(el, 'href')?.startsWith('tel:'));
  expect(links.map((el) => attr(el, 'href')).sort()).toEqual(expected.map(([number]) => 'tel:' + number).sort());
  for (const [number, display] of expected) {
    const link = links.find((el) => attr(el, 'href') === 'tel:' + number)!;
    expect(textOf(link)).toContain(display);
    expect(attr(link, 'aria-label') ?? textOf(link)).toContain(display);
  }
}

export function assertSitePhoneOutput(dist: string, center: Phone, manager: Phone) {
  const read = (slug: string) => readFileSync(join(dist, slug, 'index.html'), 'utf8');
  const home = read('');
  const contacts = read('kontakty');
  const pair = [center, manager];
  for (const selector of ['topnav-phones', 'topnav-drawer', 'footer-contacts', 'cta-band-phones']) {
    assertPhoneLinks(byClass(home, selector)[0]!, pair);
  }
  assertPhoneLinks(byClass(read('oplata'), 'payment-highlight-text')[0]!, pair);
  assertPhoneLinks(byClass(read('sotrudnichestvo-s-nami'), 'cta-contacts')[0]!, pair);
  const programPath = 'inst-001/cg-001';
  const noDate = findAll(read(programPath), (el) => attr(el, 'data-testid') === 'course-group-seminar-card' && textOf(el).includes('Семинар 2'));
  expect(noDate).toHaveLength(1);
  const link = [...walk(noDate[0])].find((el) => attr(el, 'href') === 'tel:' + manager[0]);
  expect(link).toBeDefined();
  expect(attr(link!, 'hidden')).toBeNull();
  expect(textOf(link)).toContain(manager[1]);
  assertPhoneLinks(byClass(read(programPath + '/sem-002'), 'seminar-schedule-empty')[0]!, pair);
  const [institute, clinic] = byClass(contacts, 'contact-shell-phones');
  assertPhoneLinks(institute!, pair);
  assertPhoneLinks(clinic!, [['+78126465460', '+7 (812) 646-54-60'], manager]);
  for (const phone of pair) expect(textOf(byClass(contacts, 'contact-shell-requisites')[0])).toContain(phone[1]);

  for (const [html, type] of [[home, 'EducationalOrganization'], [contacts, 'Organization']]) {
    const data = findAll(html!, (el) => attr(el, 'type') === 'application/ld+json')
      .map((el) => JSON.parse(el.childNodes.map((node) => 'value' in node ? node.value : '').join('')))
      .find((record) => record['@type'] === type);
    expect(data?.telephone?.slice().sort()).toEqual(pair.map(([number]) => number).sort());
    if (type === 'Organization') expect(data.contactPoint.telephone.slice().sort()).toEqual(data.telephone.slice().sort());
  }

  const org = read(organizationSlug);
  const row = findAll(org, (el) => el.tagName === 'tr' && textOf(el).includes('Контактный телефон'));
  expect(row).toHaveLength(1);
  for (const phone of pair) expect(textOf(row[0])).toContain(phone[1]);
  const structure = findAll(org, (el) => el.tagName === 'details' && textOf(el).startsWith('Структура и органы управления'));
  expect(structure).toHaveLength(1);
  const rolePhones = [...walk(structure[0])].filter((el) => el.tagName === 'li' && /^телефон:/i.test(textOf(el)));
  expect(rolePhones.map(textOf)).toEqual(Array(3).fill('телефон: ' + center[1]));
  expect(textOf(findAll(org, (el) => el.tagName === 'main')[0])).toContain(editorialPhone);
}
