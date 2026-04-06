import type { CourseGroup, Seminar } from './data.js';

const IMAGE_BASE = 'https://storage.yandexcloud.net/ikpk-image/media/users/1/images';

const COURSE_GROUP_PREVIEW_SUPPLEMENTS: Record<string, string> = {
  'institut-klinicheskoy-prikladnoy-kineziologii/avtorskie-seminary-zharovoj-ls': `${IMAGE_BASE}/1-1763647472405.webp`,
  'institut-klinicheskoy-prikladnoy-kineziologii/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami': `${IMAGE_BASE}/1-1727009703371.webp`,
  'institut-klinicheskoy-prikladnoy-kineziologii/kurs-po-kitajskoj-medicine-s-pozicij-prikladnoj-kineziologii': `${IMAGE_BASE}/1-1727012293952.webp`,
  'institut-klinicheskoy-prikladnoy-kineziologii/massazh': `${IMAGE_BASE}/1-1727011243617.webp`,
  'institut-klinicheskoy-prikladnoy-kineziologii/postdiplomnye-programmy-po-prikladnoj-kineziologii': `${IMAGE_BASE}/1-1727008400454.webp`,
  'institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya': `${IMAGE_BASE}/1-1738743647069.webp`,
  'institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya-dlya-fitnesa': `${IMAGE_BASE}/1-1750867614518.webp`,
  'institut-klinicheskoy-prikladnoy-kineziologii/psihokineziologiya': `${IMAGE_BASE}/1-1727010569718.webp`,
  'institut-apledzhera/dolgoletie': `${IMAGE_BASE}/1-1727013541190.webp`,
  'institut-apledzhera/imunnyj-otvet': `${IMAGE_BASE}/1-1727013432165.webp`,
  'institut-apledzhera/kraniosakralnaya-terapiya': `${IMAGE_BASE}/1-1727012977171.webp`,
  'institut-apledzhera/kraniosakralnaya-terapiya-specializirovannye': `${IMAGE_BASE}/1-1727013627255.webp`,
  'institut-apledzhera/mozg': `${IMAGE_BASE}/1-1741670535444.webp`,
  'institut-apledzhera/pediatriya-akusherstvo-i-novorozhdennye': `${IMAGE_BASE}/1-1746101352886.webp`,
  'institut-apledzhera/primenenie-principov-akupunktury': `${IMAGE_BASE}/1-1727013158497.webp`,
  'institut-apledzhera/vebinary-i-mezhseminarskie-vstrechi': `${IMAGE_BASE}/1-1763647923254.webp`,
  'institut-barralya/nevralnye-tehniki': `${IMAGE_BASE}/1-1727014615301.webp`,
  'institut-barralya/novyj-manualnyj-podhod-k-sustavam': `${IMAGE_BASE}/1-1727014970955.webp`,
  'institut-barralya/prodvinutye-visceralnye-tehniki': `${IMAGE_BASE}/1-1727014437129.webp`,
  'institut-barralya/specializirovannye-programmy': `${IMAGE_BASE}/1-1727015130714.webp`,
  'institut-barralya/tehniki-vyslushivaniya': `${IMAGE_BASE}/1-1727014827260.webp`,
  'institut-barralya/visceralnye-tehniki': `${IMAGE_BASE}/1-1727013977160.webp`,
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

