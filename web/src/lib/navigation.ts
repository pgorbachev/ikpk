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
  { label: 'Магазин', href: 'https://kinezio.shop/', external: true, rel: 'noopener' },
  { label: 'Статьи', href: '/statyi' },
  {
    label: 'Об институте',
    href: '/svedeniya-ob-obrazovatelnoy-organizatsii',
    children: [
      { label: 'Сведения об образовательной организации', href: '/svedeniya-ob-obrazovatelnoy-organizatsii' },
      { label: 'Сотрудничество с нами', href: '/sotrudnichestvo-s-nami' },
      { label: 'Акции и скидки', href: '/aktsii-i-skidki' },
      { label: 'Видео', href: '/video' },
      { label: 'Медицинский центр', href: 'https://mudriydoctor.ru/', external: true, rel: 'noopener' },
    ],
  },
  { label: 'Контакты', href: '/kontakty' },
];

export const CTA_HREF = '/raspisanie-i-tseny';
export const PHONE = '+7 (812) 646-54-50';
export const PHONE_HREF = 'tel:+78126465450';
