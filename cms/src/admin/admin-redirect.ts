/**
 * Validate Strapi's post-login redirect after the query parser has decoded it
 * once. Decode one more time to preserve the old consumer's behavior, then
 * validate the value that will actually be navigated to.
 */
export function safeAdminRedirect(candidate: unknown, origin: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return '/';

  try {
    const decoded = decodeURIComponent(candidate);
    const containsUnsafeCharacters = (value: string) => {
      for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (character === '\\' || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
          return true;
        }
      }
      return false;
    };

    if (containsUnsafeCharacters(candidate) || containsUnsafeCharacters(decoded)) return '/';
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/';

    const trustedOrigin = new URL(origin);
    if (trustedOrigin.protocol !== 'http:' && trustedOrigin.protocol !== 'https:') return '/';
    const target = new URL(decoded, trustedOrigin);
    if (
      target.origin !== trustedOrigin.origin ||
      target.username !== '' ||
      target.password !== '' ||
      !target.pathname.startsWith('/')
    ) {
      return '/';
    }

    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    // Invalid origins and malformed percent escapes both fail closed.
    return '/';
  }
}
