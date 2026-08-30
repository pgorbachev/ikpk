export const ADMIN_LANGUAGE_STORAGE_KEY = 'strapi-admin-language';
export const DEFAULT_ADMIN_LOCALE = 'ru';

type LanguageStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Strapi stores the language choice in localStorage. Set Russian only on the
 * first visit so a deliberate later user choice remains intact.
 */
export function ensureDefaultAdminLocale(storage: LanguageStorage): void {
  if (storage.getItem(ADMIN_LANGUAGE_STORAGE_KEY) === null) {
    storage.setItem(ADMIN_LANGUAGE_STORAGE_KEY, DEFAULT_ADMIN_LOCALE);
  }
}
