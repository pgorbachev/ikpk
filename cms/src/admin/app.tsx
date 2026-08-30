import { DEFAULT_ADMIN_LOCALE, ensureDefaultAdminLocale } from './admin-localization';

export default {
  config: {
    locales: [DEFAULT_ADMIN_LOCALE],
  },
  bootstrap() {
    ensureDefaultAdminLocale(window.localStorage);
  },
};
