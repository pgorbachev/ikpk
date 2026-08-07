// Реестр вариантов главной. Вариант = тонкая композиция (layout + список секций),
// а не копия страницы.
//
// Секции берутся из src/components/home/sections/*. Заблокированные контентом
// (trust/testimonials/lead) показываются только в превью с плейсхолдером.
//
// Preview-роуты собираются только при DEMO_FORMS (build:demo) — иначе черновики
// утекали бы в прод по прямому URL. noindex + catch-all hub по образцу demo-zayavka.

export type SectionKey =
  | 'hero-offer'
  | 'hero-centered'
  | 'hero-hybrid'
  | 'hero-editorial'
  | 'hero-faculty'
  | 'hero-modular'
  | 'advantages'
  | 'approach'
  | 'programs'
  | 'programs-catalog'
  | 'news'
  | 'segments'
  | 'upcoming'
  | 'upcoming-table'
  | 'upcoming-modular'
  | 'event-line'
  | 'event-teacher'
  | 'positioning-editorial'
  | 'trust-dl'
  | 'institutes-strips'
  | 'audience-toc'
  | 'audience-modular'
  | 'teachers'
  | 'teachers-featured'
  | 'tracks'
  | 'trust'
  | 'testimonials'
  | 'lead'
  | 'cta'
  | 'cta-editorial';

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
  // ── Прототипы каркаса (план 005 / studio-references §7) ───────────────────
  //
  // Три направления различаются АРХИТЕКТУРОЙ подачи, а не айдентикой: палитра,
  // логотип, эмблемы и контент общие. Собственные секции первого экрана и
  // подачи событий разводят направления окончательно.
  editorial: {
    id: 'editorial',
    label: 'Institutional Editorial — страницу несёт текст',
    layout: 'topnav',
    title: 'Институт клинической прикладной кинезиологии — ИКПК',
    description:
      'Постдипломное обучение прикладной кинезиологии, краниосакральной и висцеральной терапии для врачей. Лицензированная образовательная организация, три института-направления, 29 преподавателей.',
    sections: [
      'hero-editorial',
      'event-line',
      'positioning-editorial',
      'trust-dl',
      'institutes-strips',
      'audience-toc',
      'upcoming-table',
      'teachers',
      'news',
      'cta-editorial',
    ],
    preloadHero: true,
  },
  faculty: {
    id: 'faculty',
    label: 'Faculty Human — страницу несут преподаватели',
    layout: 'topnav',
    title: 'Обучение у практикующих преподавателей — ИКПК',
    description:
      'Прикладная кинезиология, краниосакральная и висцеральная терапия: 29 преподавателей с медицинским образованием и международными дипломами. Расписание семинаров в Санкт-Петербурге и Москве.',
    sections: [
      'hero-faculty',
      'event-teacher',
      'teachers-featured',
      'programs',
      'segments',
      'upcoming',
      'approach',
      'news',
      'cta',
    ],
    preloadHero: true,
  },
  modular: {
    id: 'modular',
    label: 'Modular Education — страницу несёт система программ',
    layout: 'topnav',
    title: 'Программы и расписание обучения — ИКПК',
    description:
      '126 семинаров, 26 программ, ступени от базовых до продвинутых. Расписание с датами, городами и стоимостью, запись на обучение онлайн.',
    sections: [
      'hero-modular',
      'upcoming-modular',
      'programs-catalog',
      'audience-modular',
      'tracks',
      'teachers',
      'advantages',
      'news',
      'cta',
    ],
  },
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
    sections: ['hero-centered', 'teachers', 'segments', 'upcoming', 'trust', 'testimonials', 'lead', 'cta'],
  },
  d: {
    id: 'd',
    label: 'D — content-complete: синтез + весь parity-контент (верхнее меню)',
    layout: 'topnav',
    title: 'Обучение прикладной кинезиологии — ИКПК',
    description:
      'Практико-ориентированное постдипломное обучение прикладной кинезиологии, краниосакральной и висцеральной терапии для врачей, массажистов и реабилитологов. Ближайшие очные семинары в Санкт-Петербурге и Москве.',
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

/** Три направления каркаса для демо выбора владельца. */
export const ARCHITECTURE_IDS = ['editorial', 'faculty', 'modular'] as const;
export type ArchitectureId = (typeof ARCHITECTURE_IDS)[number];
