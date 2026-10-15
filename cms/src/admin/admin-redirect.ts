/**
 * Validate Strapi's post-login redirect after the query parser has decoded it
 * once. Decode once more to preserve the old consumer's behavior, then check
 * the path through any remaining encoding layers before navigating to it.
 */
export function safeAdminRedirect(candidate: unknown, origin: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return '/';

  try {
    const decoded = decodeURIComponent(candidate);
    const isSafeInternalPath = (value: string) => {
      if (!value.startsWith('/') || value.startsWith('//')) return false;

      for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (
          character === '\\' ||
          codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f)
        ) {
          return false;
        }
      }

      return true;
    };

    if (!isSafeInternalPath(candidate) || !isSafeInternalPath(decoded)) return '/';

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

    // Strapi's query parser and the browser each consume an encoding layer. Check
    // every remaining path layer as well, without changing the URL we navigate to.
    // Keeping the original parsed path preserves legitimate percent-encoded routes.
    let decodedPath = target.pathname;
    for (let depth = 0; depth < 8; depth += 1) {
      if (!isSafeInternalPath(decodedPath)) return '/';

      const nextPath = decodeURIComponent(decodedPath);
      if (!isSafeInternalPath(nextPath)) return '/';
      if (nextPath === decodedPath) break;
      decodedPath = nextPath;

      if (depth === 7) return '/';
    }

    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    // Invalid origins and malformed percent escapes both fail closed.
    return '/';
  }
}
