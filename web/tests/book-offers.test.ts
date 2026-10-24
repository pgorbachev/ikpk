import { describe, expect, it } from 'vitest';
import { getHomeOffers } from '../src/lib/book-offers.js';

describe('homepage book offers across CMS snapshots', () => {
  it('keeps the book and Sale cards when the current CMS snapshot has no legacy news IDs', () => {
    const offers = getHomeOffers([]);
    expect(offers.map(({ name }) => name)).toEqual(['Новая книга', 'Sale']);
    expect(offers.map(({ link }) => link)).toEqual([
      'https://kinezio.shop/product/ruchnye-limfaticheskie-tehniki-dlya-manualnyh-terapevtov-v-oblasti-ortopedii/',
      '/aktsii-i-skidki',
    ]);
    expect(offers.every(({ description }) => Boolean(description))).toBe(true);
    expect(offers.map(({ image }) => image.url)).toEqual(['/books/lymphatic-book.jpg', '/books/sale.jpg']);
  });

  it('uses editorial content from the snapshot when a legacy card exists', () => {
    const [book, sale] = getHomeOffers([]);
    const offers = getHomeOffers([{ ...book, description: '<p>Обновлённое описание</p>', image: { url: '/media/uploads/book.webp', id: 'book' } }]);
    expect(offers[0].description).toBe('<p>Обновлённое описание</p>');
    expect(offers[0].image.url).toBe('/media/uploads/book.webp');
    expect(offers[1]).toEqual(sale);
  });

  it('fills a missing legacy image while preserving any CMS image that is present', () => {
    const [book, sale] = getHomeOffers([]);
    const offers = getHomeOffers([
      { ...book, image: { url: '', id: '' } },
      { ...sale, image: { url: '/media/uploads/sale.webp', id: 'sale' } },
    ]);
    expect(offers.map(({ image }) => image.url)).toEqual(['/books/lymphatic-book.jpg', '/media/uploads/sale.webp']);
  });
});
