import { getNews, type NewsItem } from './data';

// Редакционные записи закреплённого снимка: новинка и Sale.
export const HOME_OFFER_IDS = { book: 53, sale: 49 } as const;

function requiredNews(id: number): NewsItem {
  const item = getNews().find((news) => news.id === id);
  if (!item) throw new Error(`В снимке контента нет записи news #${id}`);
  return item;
}

export function getHomeOffers(): NewsItem[] {
  return [{
    ...requiredNews(HOME_OFFER_IDS.book),
    link: 'https://kinezio.shop/product/ruchnye-limfaticheskie-tehniki-dlya-manualnyh-terapevtov-v-oblasti-ortopedii/',
  }, {
    ...requiredNews(HOME_OFFER_IDS.sale),
    name: 'Sale',
    link: '/aktsii-i-skidki',
  }];
}

export function getBookMarketplaceLinks() {
  return [
    { label: 'Wildberries', href: 'https://www.wildberries.ru/seller/4139519' },
    { label: 'Ozon', href: 'https://www.ozon.ru/seller/izdatelskiy-dom-ikpk-2323716/knigi-16500/?miniapp=seller_2323716' },
  ];
}
