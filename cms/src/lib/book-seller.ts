export const BOOK_PAGE_SLUG = 'knigi-i-uchebnye-materialy';
export const BOOK_PAGE_TEXT = 'body';
export const BOOK_PAGE_MAX_LENGTH = 5000;
export const BOOK_PAGE_TITLE = 'Книги и учебные материалы';
export const BOOK_PAGE_INTRODUCTION = 'Издательский дом ИКПК выпускает книги и учебные материалы. Продавец книг — ИП Тучанфа В.А.';
export const BOOK_PAGE_SEO_TITLE = 'Книги и учебные материалы — ИКПК';
export const BOOK_PAGE_SEO_DESCRIPTION = 'Книжные новинки издательского дома ИКПК, акции и ссылки на площадки продавца.';

export function checkBookIntroduction(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0) return 'Введите вводный текст страницы книг.';
  if (value.length > BOOK_PAGE_MAX_LENGTH) return `Текст не должен быть длиннее ${BOOK_PAGE_MAX_LENGTH} символов.`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return 'Текст содержит недопустимые управляющие символы.';
  return null;
}
