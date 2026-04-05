import type { ScheduleEntry } from './data';

// Supplemental schedule entries to patch parity gaps where the CMS data is missing.
// Dates are set relative to build time (6 months ahead) to stay valid across rebuilds.
// When the real CMS entries are available, remove the corresponding supplement.
function buildRelativeDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export const scheduleSupplements: ScheduleEntry[] = [
  {
    id: 900001,
    status: 'active',
    name: 'Что такое КСТ. Возможности интеграции в другие методы лечения.',
    seminar: {
      id: 900001,
      name: 'Что такое КСТ. Возможности интеграции в другие методы лечения.',
      slug: 'kst-pogovorim-o-sluchayah-iz-praktiki-voprosy-i-otvety',
    },
    institute: {
      id: 2,
      name: 'Институт Апледжера',
      shortname: 'ИА',
    },
    startAt: buildRelativeDate(180),
    endAt: buildRelativeDate(180),
    teachers: [
      {
        id: 63,
        fullName: 'Шрайнер Валерий Эдуардович, MD, CST-D',
      },
    ],
    image: {
      id: 'supplement-1',
      url: 'https://storage.yandexcloud.net/ikpk-image/media/users/1/images/1-1775132739287.webp',
    },
    isFree: true,
    isEventCollection: false,
    description: null,
    oldPrice: 0,
    newPrice: 0,
    city: {
      id: 1,
      name: 'Онлайн',
    },
    program: {
      id: 1,
      slug: 'vebinary-i-mezhseminarskie-vstrechi',
      name: 'Вебинары и межсеминарские встречи',
    },
    additionalText: 'Начало в 19:00 по Москве',
    duration: '2',
    registrationFormLink: 'https://b24-cbqwqo.bitrix24site.ru/crm_form_ve1op/',
  },
  {
    id: 900002,
    status: 'active',
    name: 'Ответы на вопросы, сложности в применении метода КСТ в практической работе',
    seminar: {
      id: 900002,
      name: 'Ответы на вопросы, сложности в применении метода КСТ в практической работе',
      slug: 'mezhseminarskaya-vstrecha-praktikum-dlya-specialistov-kst',
    },
    institute: {
      id: 2,
      name: 'Институт Апледжера',
      shortname: 'ИА',
    },
    startAt: buildRelativeDate(187),
    endAt: buildRelativeDate(187),
    teachers: [
      {
        id: 63,
        fullName: 'Шрайнер Валерий Эдуардович, MD, CST-D',
      },
    ],
    image: {
      id: 'supplement-2',
      url: 'https://storage.yandexcloud.net/ikpk-image/media/users/1/images/1-1775132825348.webp',
    },
    isFree: true,
    isEventCollection: false,
    description: null,
    oldPrice: 0,
    newPrice: 0,
    city: {
      id: 1,
      name: 'Онлайн',
    },
    program: {
      id: 1,
      slug: 'vebinary-i-mezhseminarskie-vstrechi',
      name: 'Вебинары и межсеминарские встречи',
    },
    additionalText: 'Начало в 19:00 по Москве',
    duration: '2',
    registrationFormLink: 'https://b24-cbqwqo.bitrix24site.ru/crm_form_ve1op/',
  },
];
