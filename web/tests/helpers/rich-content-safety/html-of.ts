/** Снимает будущий SafeRichHtml до строки, не ломая текущий string-return. */
export function htmlOf(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'html' in result) {
    return String((result as { html: unknown }).html);
  }
  return String(result);
}
