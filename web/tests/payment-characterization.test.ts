import { describe, expect, it } from 'vitest';
import { readPage } from './helpers/dist-pages';
import { PAYMENT_ENTRY_ATTR } from './helpers/payment-contract';

/**
 * 3.7 / 3.7b — характеризация уже истинного на main поведения.
 * Рождаются зелёными. Негативная проверка — отдельным worktree.
 */
describe('3.7 точка входа на /oplata не переписана в расписание', () => {
  it('ровно одна точка входа, ни одна не ведёт на /raspisanie-i-tseny', () => {
    const html = readPage('/oplata');
    const content = html.match(/<section class="section">([\s\S]*?)<\/section>/)?.[1] ?? html;
    const entries: { href: string; kind: string }[] = [];
    const attrRe = new RegExp(`<[^>]+\\b${PAYMENT_ENTRY_ATTR}\\b[^>]*>`, 'gi');
    for (const tag of content.matchAll(attrRe)) {
      entries.push({
        kind: 'attr',
        href: tag[0].match(/\bhref="([^"]*)"/i)?.[1] ?? '',
      });
    }
    for (const a of content.matchAll(/<a\s([^>]*\bdata-legacy-cta\b[^>]*)>([^<]*)</gi)) {
      const label = a[2].trim();
      if (/оплат/i.test(label)) {
        entries.push({ kind: 'legacy', href: a[1].match(/\bhref="([^"]*)"/i)?.[1] ?? '' });
      }
    }
    expect(entries.length, 'точек входа в оплату нет — проверка ничего не измерила').toBeGreaterThan(0);
    expect(entries, 'точек входа больше одной').toHaveLength(1);
    expect(entries[0]?.href.includes('/raspisanie-i-tseny'), entries[0]?.href).toBe(false);
  });
});

describe('3.7b блок контактов сохраняется', () => {
  it('собранная /oplata содержит #oplata-svyaz', () => {
    const html = readPage('/oplata');
    expect(html).toMatch(/id="oplata-svyaz"/);
    const block = html.match(/id="oplata-svyaz"[\s\S]{0,800}/)?.[0] ?? '';
    expect(block).toMatch(/tel:/);
    expect(block).toMatch(/mailto:/);
  });
});
