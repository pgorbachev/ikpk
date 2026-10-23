import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dist, readPage } from './helpers/dist-pages';

const BOOKS_PATH = '/knigi-i-uchebnye-materialy';
const PRODUCT_URL = 'https://kinezio.shop/product/ruchnye-limfaticheskie-tehniki-dlya-manualnyh-terapevtov-v-oblasti-ortopedii/';
const WB_URL = 'https://www.wildberries.ru/seller/4139519';
const OZON_URL = 'https://www.ozon.ru/seller/izdatelskiy-dom-ikpk-2323716/knigi-16500/?miniapp=seller_2323716';

function links(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
    tag: match[0],
    href: match[1].match(/\bhref="([^"]+)"/)?.[1],
    text: match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  }));
}

describe('Книги и предложения в собранном сайте', () => {
  it('показывает на главной ровно новинку и Sale с действующими адресами', () => {
    const home = readPage('/');
    const offers = home.split('>Предложения</h2>')[1]?.split('</section>')[0];
    expect(offers, 'секция «Предложения» не найдена').toBeTruthy();
    const cards = links(offers!).filter((link) => link.tag.includes('news-card'));
    expect(cards.some((card) => card.text.startsWith('Новая книга'))).toBe(true);
    expect(cards.some((card) => card.text.startsWith('Sale'))).toBe(true);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.href)).toEqual([PRODUCT_URL, '/aktsii-i-skidki']);
    expect(offers).toContain(`href="${BOOKS_PATH}"`);
    expect(offers).not.toMatch(/Наш магазин на WB|Наш новый магазин на Ozon/);
  });

  it('ведёт в раздел книг из меню, футера и карты сайта', () => {
    const home = readPage('/');
    const internal = links(home).filter((link) => link.href === BOOKS_PATH);
    expect(internal.length).toBeGreaterThanOrEqual(3);
    expect(internal.every((link) => link.text.includes('Книги и учебные материалы'))).toBe(true);
    expect(readPage('/sitemap/')).toContain(`href="${BOOKS_PATH}"`);
    expect(readFileSync(join(dist, 'sitemap-0.xml'), 'utf8')).toContain(`${BOOKS_PATH}`);
  });

  it('указывает продавца и выводит безопасные ссылки на каталог и площадки', () => {
    const page = readPage(`${BOOKS_PATH}/`);
    expect(page).toContain('ИП Пилявский Д.С.');
    expect(page).toContain('Издательский дом ИКПК');
    const anchors = links(page);
    expect(anchors.some((link) => link.href === '/aktsii-i-skidki' && link.text.includes('Sale'))).toBe(true);
    for (const href of ['https://kinezio.shop/novinki/', WB_URL, OZON_URL]) {
      const link = anchors.find((candidate) => candidate.href?.replace(/&amp;/g, '&') === href);
      expect(link, `нет ссылки ${href}`).toBeDefined();
      expect(link!.tag).toMatch(/target="_blank"/);
      expect(link!.tag).toMatch(/rel="noopener noreferrer"/);
      expect(link!.text).toMatch(/внешн|Новинки книг/);
    }
  });
});
