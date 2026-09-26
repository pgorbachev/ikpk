import type { StrapiApp } from '@strapi/strapi/admin';

export default {
  config: {
    locales: ['ru'],
  },
  bootstrap(_app: StrapiApp) {
    void _app;
  },
};
