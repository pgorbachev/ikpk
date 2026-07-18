import type { CourseGroup, Seminar } from './data.js';

const COURSE_GROUP_PREVIEW_SUPPLEMENTS: Record<string, string> = {
  'institut-klinicheskoy-prikladnoy-kineziologii/avtorskie-seminary-zharovoj-ls': '/media/users/1/images/1-1763647472405.webp',
  // 1-1727009703371.webp удалён из бакета (404, 2026-07-18); живой сайт
  // показывает для этой карточки 1-1727015894124.webp
  'institut-klinicheskoy-prikladnoy-kineziologii/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami': '/media/users/1/images/1-1727015894124.webp',
  'institut-klinicheskoy-prikladnoy-kineziologii/kurs-po-kitajskoj-medicine-s-pozicij-prikladnoj-kineziologii': '/media/users/1/images/1-1727012293952.webp',
  'institut-klinicheskoy-prikladnoy-kineziologii/massazh': '/media/users/1/images/1-1727011243617.webp',
  'institut-klinicheskoy-prikladnoy-kineziologii/postdiplomnye-programmy-po-prikladnoj-kineziologii': '/media/users/1/images/1-1727008400454.webp',
  'institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya': '/media/users/1/images/1-1738743647069.webp',
  'institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya-dlya-fitnesa': '/media/users/1/images/1-1750867614518.webp',
  'institut-klinicheskoy-prikladnoy-kineziologii/psihokineziologiya': '/media/users/1/images/1-1727010569718.webp',
  'institut-apledzhera/dolgoletie': '/media/users/1/images/1-1727013541190.webp',
  'institut-apledzhera/imunnyj-otvet': '/media/users/1/images/1-1727013432165.webp',
  'institut-apledzhera/kraniosakralnaya-terapiya': '/media/users/1/images/1-1727012977171.webp',
  'institut-apledzhera/kraniosakralnaya-terapiya-specializirovannye': '/media/users/1/images/1-1727013627255.webp',
  'institut-apledzhera/mozg': '/media/users/1/images/1-1741670535444.webp',
  'institut-apledzhera/pediatriya-akusherstvo-i-novorozhdennye': '/media/users/1/images/1-1746101352886.webp',
  'institut-apledzhera/primenenie-principov-akupunktury': '/media/users/1/images/1-1727013158497.webp',
  'institut-apledzhera/vebinary-i-mezhseminarskie-vstrechi': '/media/users/1/images/1-1763647923254.webp',
  'institut-barralya/nevralnye-tehniki': '/media/users/1/images/1-1727014615301.webp',
  'institut-barralya/novyj-manualnyj-podhod-k-sustavam': '/media/users/1/images/1-1727014970955.webp',
  'institut-barralya/prodvinutye-visceralnye-tehniki': '/media/users/1/images/1-1727014437129.webp',
  'institut-barralya/specializirovannye-programmy': '/media/users/1/images/1-1727015130714.webp',
  'institut-barralya/tehniki-vyslushivaniya': '/media/users/1/images/1-1727014827260.webp',
  'institut-barralya/visceralnye-tehniki': '/media/users/1/images/1-1727013977160.webp',
};

function firstSeminarImage(seminars: Seminar[]): string {
  return seminars.find((seminar) => seminar.images?.[0])?.images?.[0] || '';
}

export function getCourseGroupPreviewImage(courseGroup: Pick<CourseGroup, 'slug' | 'institute_legacy_id' | 'images'>, seminars: Seminar[]): string {
  return (
    courseGroup.images?.[0]
    || COURSE_GROUP_PREVIEW_SUPPLEMENTS[`${courseGroup.institute_legacy_id}/${courseGroup.slug}`]
    || firstSeminarImage(seminars)
    || ''
  );
}

