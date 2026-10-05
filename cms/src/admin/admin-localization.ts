export const ADMIN_LANGUAGE_STORAGE_KEY = 'strapi-admin-language';
export const DEFAULT_ADMIN_LOCALE = 'ru';

type LanguageStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Strapi сам запоминает выбор языка в localStorage. Записываем русский только
 * при первом открытии, чтобы последующий явный выбор пользователя сохранялся.
 */
export function ensureDefaultAdminLocale(storage: LanguageStorage): void {
  if (storage.getItem(ADMIN_LANGUAGE_STORAGE_KEY) === null) {
    storage.setItem(ADMIN_LANGUAGE_STORAGE_KEY, DEFAULT_ADMIN_LOCALE);
  }
}
