import { getPages } from './data';
import { siteContactPhones } from './site-contact-phones';

// Информационная архитектура навигации — единый источник для TopNavLayout
// и мобильного меню. Все ссылки — реальные роуты (или внешние с external:true),
// чтобы не терять внутреннюю перелинковку при верхнем меню.

export interface NavLink {
  label: string;
  href: string;
  external?: boolean;
  rel?: string;
}

export interface NavItem extends NavLink {
  desktopLabel?: string;
  children?: NavLink[];
}

export const primaryNav: NavItem[] = [
  {
    label: 'Обучение',
    href: '/raspisanie-i-tseny',
    children: [
      { label: 'Институт клинической прикладной кинезиологии', href: '/institut-klinicheskoy-prikladnoy-kineziologii' },
      { label: 'Институт Апледжера', href: '/institut-apledzhera' },
      { label: 'Институт Барраля', href: '/institut-barralya' },
      { label: 'Расписание и цены', href: '/raspisanie-i-tseny' },
      { label: 'Оплата', href: '/oplata' },
    ],
  },
  { label: 'Расписание', href: '/raspisanie-i-tseny' },
  { label: 'Книги и учебные материалы', desktopLabel: 'Книги', href: '/knigi-i-uchebnye-materialy' },
  { label: 'Статьи', href: '/statyi' },
  {
    label: 'Об институте',
    href: '/svedeniya-ob-obrazovatelnoy-organizatsii',
    children: [
      { label: 'Сведения об образовательной организации', href: '/svedeniya-ob-obrazovatelnoy-organizatsii' },
      { label: 'Сотрудничество с нами', href: '/sotrudnichestvo-s-nami' },
      { label: 'Акции и скидки', href: '/aktsii-i-skidki' },
      { label: 'Видео', href: '/video' },
      { label: 'Медицинский центр', href: 'https://mudriydoctor.ru/', external: true, rel: 'noopener noreferrer' },
    ],
  },
  { label: 'Контакты', href: '/kontakty' },
];

export const CTA_HREF = '/raspisanie-i-tseny';
const phones = siteContactPhones(getPages());
export const PHONE = phones.center.text;
export const PHONE_HREF = phones.center.href;
export const MANAGER_PHONE = phones.manager.text;
export const MANAGER_PHONE_HREF = phones.manager.href;
// Выходные — у менеджера, а не у института: семинары в эти дни идут (D14). Без
// оговорки часы читаются как расписание занятий.
export const MANAGER_HOURS_NOTE =
  'Часы работы менеджера; семинары проходят в том числе по субботам и воскресеньям.';
