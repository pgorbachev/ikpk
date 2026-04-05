export interface InstituteHeroBranding {
  logoSrc: string;
  width: number;
  height: number;
  horizontal: boolean;
}

const INSTITUTE_HERO_BRANDING: Record<string, InstituteHeroBranding> = {
  'institut-klinicheskoy-prikladnoy-kineziologii': {
    logoSrc: '/institutes/ikpk-logo.png',
    width: 406,
    height: 112,
    horizontal: true,
  },
  'institut-apledzhera': {
    logoSrc: '/institutes/upledger-logo.png',
    width: 390,
    height: 234,
    horizontal: false,
  },
  'institut-barralya': {
    logoSrc: '/institutes/barral-logo.png',
    width: 390,
    height: 234,
    horizontal: false,
  },
};

export function getInstituteHeroBranding(instituteSlug: string) {
  return INSTITUTE_HERO_BRANDING[instituteSlug];
}

