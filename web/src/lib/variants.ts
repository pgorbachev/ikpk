// Реестр вариантов главной. Вариант = тонкая композиция (layout + список секций),
// а не копия страницы. Добавить C/D — дописать запись сюда.
//
// Секции берутся из src/components/home/sections/*. Заблокированные контентом
// (trust/testimonials/lead) показываются только в превью с плейсхолдером.

export type SectionKey =
  | 'hero-offer'
  | 'hero-centered'
  | 'hero-hybrid'
  | 'advantages'
  | 'approach'
  | 'programs'
  | 'news'
  | 'segments'
  | 'upcoming'
  | 'teachers'
  | 'trust'
  | 'testimonials'
  | 'lead'
  | 'cta';

export interface Variant {
  id: string;
  label: string;
  layout: 'topnav';
  title: string;
  description: string;
  sections: SectionKey[];
  /** preload hero-иллюстрации — только для вариантов, где hero её реально
      использует (иначе лишний запрос). */
  preloadHero?: boolean;
}

export const variants: Record<string, Variant> = {
  b: {
    id: 'b',
    label: 'B — редизайн по маркетологу (верхнее меню)',
    layout: 'topnav',
    title: 'Институт клинической прикладной кинезиологии — обучение по международным стандартам',
    description:
      'Постдипломное обучение прикладной кинезиологии, краниосакральной и висцеральной терапии для врачей, массажистов и реабилитологов.',
    sections: ['hero-offer', 'segments', 'upcoming', 'teachers', 'trust', 'testimonials', 'lead', 'cta'],
    preloadHero: true,
  },
  c: {
    id: 'c',
    label: 'C — акцент на практику и преподавателей (верхнее меню)',
    layout: 'topnav',
    title: 'Обучение прикладной кинезиологии — от первого семинара до практики | ИКПК',
    description:
      'Постдипломное обучение прикладной кинезиологии, краниосакральной и висцеральной терапии: практическая отработка на семинарах, практикующие преподаватели.',
    // Иная композиция: центрированный hero, преподаватели подняты выше
    // (личность преподавателя — ключевой фактор решения по маркетологу).
    sections: ['hero-centered', 'teachers', 'segments', 'upcoming', 'trust', 'testimonials', 'lead', 'cta'],
  },
  d: {
    id: 'd',
    label: 'D — content-complete: синтез + весь parity-контент (верхнее меню)',
    layout: 'topnav',
    // Короткий title под основной поисковый интент (рекомендация ревью).
    title: 'Обучение прикладной кинезиологии — ИКПК',
    description:
      'Практико-ориентированное постдипломное обучение прикладной кинезиологии, краниосакральной и висцеральной терапии для врачей, массажистов и реабилитологов. Ближайшие очные семинары в Санкт-Петербурге и Москве.',
    // Полная главная: гибрид-hero + весь обязательный parity-контент
    // (преимущества, подход+статистика, институты, новости) + маркетинговые
    // блоки. Статистика в approach покрывает trust — отдельный trust-плейсхолдер
    // не нужен. testimonials/lead — заглушки (нет видео/PDF от заказчика).
    sections: [
      'hero-hybrid', 'advantages', 'approach', 'programs',
      'segments', 'upcoming', 'teachers', 'news',
      'testimonials', 'lead', 'cta',
    ],
  },
};

export function getVariant(id: string): Variant | undefined {
  return variants[id];
}
