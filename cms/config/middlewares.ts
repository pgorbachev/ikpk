import type { Core } from '@strapi/strapi';

/**
 * `strapi::session` в объектной форме, а не строкой: спека
 * `cms-content-authoring-and-migration` требует, чтобы cookie сессии админки не
 * уходила по незащищённому соединению — `secure` задаётся конфигурацией, а не
 * подразумевается умолчанием мидлвари.
 */
const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Middlewares => [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  {
    name: 'strapi::session',
    config: {
      cookie: {
        secure: env.bool('SESSION_COOKIE_SECURE', true),
      },
    },
  },
  'strapi::favicon',
  'strapi::public',
];

export default config;
