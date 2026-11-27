export const BOOK_PAGE_SLUG = 'knigi-i-uchebnye-materialy';
export const BOOK_PAGE_TEXT = 'body';
export const BOOK_PAGE_MAX_LENGTH = 5000;

export function checkBookIntroduction(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0) return 'Введите вводный текст страницы книг.';
  if (value.length > BOOK_PAGE_MAX_LENGTH) return `Текст не должен быть длиннее ${BOOK_PAGE_MAX_LENGTH} символов.`;
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
  })) return 'Текст содержит недопустимые управляющие символы.';
  return null;
}
