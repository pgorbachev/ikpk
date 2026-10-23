import { getNews, type NewsItem } from './data';

// На исходном снимке это были записи news #53 и #49. Текущий CMS-снимок
// может не содержать старые ID, поэтому у карточек есть короткий резервный текст.
export const HOME_OFFER_IDS = { book: 53, sale: 49 } as const;

const fallbackBook: NewsItem = {
  id: HOME_OFFER_IDS.book,
  priority: 0,
  name: 'Новая книга',
  image: { url: '', id: '' },
  description: '<p>Ручные лимфатические техники для мануальных терапевтов в области ортопедии.</p>',
  createdAt: '',
  link: '',
};

const fallbackSale: NewsItem = {
  id: HOME_OFFER_IDS.sale,
  priority: 1,
  name: 'Sale',
  image: { url: '', id: '' },
  description: '<p>Актуальные акции и скидки института и магазина.</p>',
  createdAt: '',
  link: '',
};

export function getHomeOffers(news = getNews()): NewsItem[] {
  return [{
    ...(news.find((item) => item.id === HOME_OFFER_IDS.book) ?? fallbackBook),
    link: 'https://kinezio.shop/product/ruchnye-limfaticheskie-tehniki-dlya-manualnyh-terapevtov-v-oblasti-ortopedii/',
  }, {
    ...(news.find((item) => item.id === HOME_OFFER_IDS.sale) ?? fallbackSale),
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
