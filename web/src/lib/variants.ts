// Реестр вариантов главной. Вариант = тонкая композиция (layout + список секций),
// а не копия страницы. Добавить C/D — дописать запись сюда.
//
// Секции берутся из src/components/home/sections/*. Заблокированные контентом
// (trust/testimonials/lead) показываются только в превью с плейсхолдером.

export type SectionKey =
  | 'hero-offer'
  | 'hero-centered'
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
  },
  c: {
    id: 'c',
    label: 'C — акцент на практику и преподавателей (верхнее меню)',
    layout: 'topnav',
    title: 'Обучение прикладной кинезиологии — от первого семинара до практики | ИКПК',
    description:
      'Постдипломное обучение прикладной кинезиологии, краниосакральной и висцеральной терапии: практика с первого модуля, практикующие преподаватели.',
    // Иная композиция: центрированный hero, преподаватели подняты выше
    // (личность преподавателя — ключевой фактор решения по маркетологу).
    sections: ['hero-centered', 'teachers', 'segments', 'upcoming', 'trust', 'testimonials', 'lead', 'cta'],
  },
};

export function getVariant(id: string): Variant | undefined {
  return variants[id];
}
