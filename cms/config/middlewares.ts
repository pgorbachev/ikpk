import type { Core } from '@strapi/strapi';

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  {
    name: 'strapi::cors',
    config: {
      origin: ['https://ikpk.su'],
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'global::student-document-form-field-guard',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];

export default config;
