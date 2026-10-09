import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanBodyHtml, getPage } from '../src/lib/data.js';
import {
  PUBLIC_OFFER_HREF,
  PUBLIC_OFFER_LABEL,
  PUBLIC_OFFER_STAMPED_HREF,
} from '../src/lib/public-offer.js';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';

const repoRoot = join(import.meta.dirname, '..', '..');

function pdfAt(name: string): Buffer {
  return readFileSync(join(repoRoot, 'web/public/documents', name));
}

describe('публичная оферта', () => {
  it('раздел «Документы» ссылается на экземпляр без печати', () => {
    const page = getPage('svedeniya-ob-obrazovatelnoy-organizatsii');
    expect(page?.body_html, 'в снимке нет страницы сведений').toBeTruthy();
    const html = htmlOf(
      cleanBodyHtml(page!.body_html, '/svedeniya-ob-obrazovatelnoy-organizatsii'),
    );
    const docs = html.split('<summary>Уставные документы</summary>')[1]?.split('</details>')[0] ?? '';
    expect(docs, 'панель «Уставные документы» не собралась').not.toBe('');
    expect(docs).toContain(`href="${PUBLIC_OFFER_HREF}"`);
    expect(docs).toContain(PUBLIC_OFFER_LABEL);
    expect(docs).not.toContain(PUBLIC_OFFER_STAMPED_HREF);
    expect(html.split(PUBLIC_OFFER_HREF).length - 1).toBe(1);
  });

  it('в раздаче два разных pdf, экземпляр с печатью тяжелее', () => {
    const plain = pdfAt('publichnaya-oferta.pdf');
    const stamped = pdfAt('publichnaya-oferta-s-pechatyu.pdf');
    expect(plain.subarray(0, 5).toString()).toBe('%PDF-');
    expect(stamped.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Buffer.compare(plain, stamped)).not.toBe(0);
    expect(stamped.length).toBeGreaterThan(plain.length);
  });
});
