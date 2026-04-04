/**
 * HTML cleaner for the IKPK website rebuild.
 * Transforms scraped Next.js HTML (with CSS Module hashed classes) into clean semantic HTML.
 *
 * Transformation pipeline (applied in order):
 *  1. Remove entire form containers (subscribe-news-form_, PhoneInput*)
 *  2. Remove orphaned form UI elements left over from form containers
 *  3. Unwrap layout wrapper elements (keep children, remove outer tag)
 *  4. Convert collapsible sections to <details>/<summary>
 *  5. Clean typography classes (strip class from h1-h6/p/span with typography_*)
 *  6. Unwrap se-root containers
 *  7. Strip remaining CSS Module classes (class attributes containing __)
 *  8. Strip h1 tags (page template provides its own h1)
 *  9. Clean up orphaned closing tags and excess whitespace
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core HTML utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the index immediately after the closing tag of the element whose
 * opening tag starts at `start`.  Handles arbitrary nesting of the same tag.
 */
function elementEnd(html: string, start: number, tagName: string): number {
  const tag = tagName.toLowerCase();
  const lower = html.toLowerCase();
  const openStr = `<${tag}`;
  const closeStr = `</${tag}>`;

  // Advance past the opening tag's closing `>`
  let pos = lower.indexOf('>', start);
  if (pos === -1) return html.length;
  // Self-closing tag?
  if (lower[pos - 1] === '/') return pos + 1;
  pos++;

  let depth = 1;

  while (depth > 0 && pos < html.length) {
    const nextClose = lower.indexOf(closeStr, pos);
    if (nextClose === -1) return html.length; // malformed

    const nextOpen = lower.indexOf(openStr, pos);

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Check it is a real open tag (not just a matching prefix in an attribute)
      const charAfter = html[nextOpen + openStr.length];
      if (/[\s>/]/.test(charAfter)) {
        depth++;
        // Skip to end of this open tag so we don't re-match it
        const tagClose = lower.indexOf('>', nextOpen);
        pos = tagClose !== -1 ? tagClose + 1 : nextOpen + 1;
      } else {
        pos = nextOpen + 1;
      }
    } else {
      depth--;
      pos = nextClose + closeStr.length;
    }
  }

  return pos;
}

/** Returns the class attribute value from a tag's attribute string, or "". */
function getClass(attrs: string): string {
  return attrs.match(/class="([^"]*)"/i)?.[1] ?? '';
}

/**
 * Removes all elements of `tagName` whose class attribute satisfies `classTest`,
 * together with all their nested children.
 */
function removeTaggedElements(
  html: string,
  tagName: string,
  classTest: RegExp,
): string {
  const tag = tagName.toLowerCase();
  const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  let result = html;
  let searchFrom = 0;

  for (let guard = 0; guard < 50_000; guard++) {
    openRe.lastIndex = searchFrom;
    const m = openRe.exec(result);
    if (!m) break;

    const cls = getClass(m[1] ?? '');
    if (!classTest.test(cls)) {
      searchFrom = m.index + 1;
      continue;
    }

    // Self-closing tag (e.g. <input …/>)?
    if (m[0].endsWith('/>')) {
      result = result.slice(0, m.index) + result.slice(m.index + m[0].length);
      openRe.lastIndex = m.index;
      searchFrom = m.index;
      continue;
    }

    const end = elementEnd(result, m.index, tag);
    result = result.slice(0, m.index) + result.slice(end);
    openRe.lastIndex = m.index;
    searchFrom = m.index;
  }

  return result;
}

/**
 * Unwraps elements of `tagName` whose class attribute satisfies `classTest`:
 * removes the opening/closing tags but preserves all inner HTML.
 */
function unwrapTaggedElements(
  html: string,
  tagName: string,
  classTest: RegExp,
): string {
  const tag = tagName.toLowerCase();
  const closeStr = `</${tag}>`;
  const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  let result = html;
  let searchFrom = 0;

  for (let guard = 0; guard < 50_000; guard++) {
    openRe.lastIndex = searchFrom;
    const m = openRe.exec(result);
    if (!m) break;

    const cls = getClass(m[1] ?? '');
    if (!classTest.test(cls)) {
      searchFrom = m.index + 1;
      continue;
    }

    const end = elementEnd(result, m.index, tag);
    const inner = result.slice(m.index + m[0].length, end - closeStr.length);
    result = result.slice(0, m.index) + inner + result.slice(end);
    openRe.lastIndex = m.index;
    searchFrom = m.index;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transformation steps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1 – Remove entire form containers.
 * Targets: subscribe-news-form_ prefixed elements and PhoneInput* components,
 * plus the text-field_root and checkbox_checkboxWrapper helper divs that are
 * left as orphans in the scraped HTML.
 */
function removeFormContainers(html: string): string {
  let result = html;

  // Any tag whose class starts with subscribe-news-form_
  const subscribeRe = /subscribe-news-form_/;
  for (const tag of ['div', 'section', 'form', 'span', 'p', 'button', 'a', 'label']) {
    result = removeTaggedElements(result, tag, subscribeRe);
  }
  // <input> with subscribe-news-form_ class (self-closing)
  result = result.replace(/<input\b[^>]*class="[^"]*subscribe-news-form_[^"]*"[^>]*\/?>/gi, '');

  // PhoneInput components (div wrappers and the input itself)
  const phoneRe = /PhoneInput/;
  result = removeTaggedElements(result, 'div', phoneRe);
  result = result.replace(/<input\b[^>]*class="[^"]*PhoneInput[^"]*"[^>]*\/?>/gi, '');

  // text-field_root__ orphaned wrappers
  result = removeTaggedElements(result, 'div', /text-field_root__/);

  // checkbox_checkboxWrapper__ orphaned wrappers
  result = removeTaggedElements(result, 'div', /checkbox_checkboxWrapper__/);

  // Remaining bare <form>…</form> containers left by React portals
  result = result.replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '');

  return result;
}

/**
 * Step 2 – Remove orphaned form UI elements that survived step 1.
 * These are inputs and buttons with CSS-Module form classes that appear
 * outside the form container wrapper in the scraped HTML.
 */
function removeOrphanedFormUI(html: string): string {
  let result = html;
  // <input> with text-field_ or PhoneInput in class
  result = result.replace(
    /<input\b[^>]*class="[^"]*(?:text-field_|PhoneInput)[^"]*"[^>]*\/?>/gi,
    '',
  );
  return result;
}

/**
 * Step 3 – Unwrap layout wrapper elements.
 * Removes the wrapper tag but preserves all inner HTML.
 */
function unwrapLayoutWrappers(html: string): string {
  const layoutRe =
    /\b(?:articles-form_(?:articleContainer|articlesFirstContent|articleSectionContent|articleContent)|seminar-form_|teachers-form_|cooperation_|main_|institute-programs_|contacts_|educational-organization_)/;

  let result = html;

  // Iterate until stable because unwrapping an outer element exposes inner ones
  let prev = '';
  while (prev !== result) {
    prev = result;
    for (const tag of [
      'div', 'section', 'article', 'ul', 'li',
      'address', 'aside', 'main', 'header', 'footer', 'nav',
    ]) {
      result = unwrapTaggedElements(result, tag, layoutRe);
    }
  }

  return result;
}

/**
 * Step 4 – Convert collapsible sections to native <details>/<summary>.
 *
 * The scraped Radix UI collapsible structure is:
 *   <div class="" data-state="closed|open">
 *     <button class="collapsible_trigger__…">
 *       …<h2 data-collapsible-title="true">TITLE</h2>…
 *     </button>
 *     [<div class="…collapsible_content…" data-state="open">CONTENT</div>]
 *   </div>
 */
function transformCollapsibles(html: string): string {
  // Match the outer wrapper: a div that has data-state and wraps a collapsible_trigger
  const stateRe = /<div([^>]*\bdata-state="(?:closed|open)"[^>]*)>/gi;
  let result = html;
  let searchFrom = 0;

  for (let guard = 0; guard < 50_000; guard++) {
    stateRe.lastIndex = searchFrom;
    const m = stateRe.exec(result);
    if (!m) break;

    const end = elementEnd(result, m.index, 'div');
    const inner = result.slice(m.index + m[0].length, end - '</div>'.length);

    if (!inner.includes('collapsible_trigger')) {
      searchFrom = m.index + 1;
      continue;
    }

    // Extract the title text
    const titleMatch = inner.match(
      /data-collapsible-title="true"[^>]*>([\s\S]*?)<\/h\d>/i,
    );
    const title = titleMatch ? titleMatch[1].trim() : '';

    if (!title) {
      searchFrom = m.index + 1;
      continue;
    }

    // Extract inner content from the collapsible_content div (if visible/open)
    let content = '';
    const contentDivMatch = inner.match(
      /<div([^>]*class="[^"]*collapsible_content[^"]*"[^>]*)>/i,
    );
    if (contentDivMatch) {
      // Find the content div's position inside the full result
      const contentDivStart = result.indexOf(contentDivMatch[0], m.index);
      if (contentDivStart !== -1 && contentDivStart < end) {
        const contentEnd = elementEnd(result, contentDivStart, 'div');
        const contentInner = result.slice(
          contentDivStart + contentDivMatch[0].length,
          contentEnd - '</div>'.length,
        );
        content = contentInner.trim();
      }
    }

    const replacement = content
      ? `<details open><summary>${title}</summary>${content}</details>`
      : `<details><summary>${title}</summary></details>`;

    result = result.slice(0, m.index) + replacement + result.slice(end);
    searchFrom = m.index + replacement.length;
    stateRe.lastIndex = searchFrom;
  }

  return result;
}

/**
 * Step 5 – Clean typography classes.
 * Headings, paragraphs and spans whose class consists entirely of typography_*
 * tokens have their class attribute removed.
 */
function cleanTypographyClasses(html: string): string {
  // Match class="…" where EVERY space-separated token starts with typography_
  // Captures: full tag, tag name, and the class value
  return html.replace(
    /<(h[1-6]|p|span)(\s+class="([^"]*)")([\s\S]*?)>/gi,
    (match, tag, _classAttr, cls, rest) => {
      // Only strip when all classes are typography_ or articles-form_articleTitle/Meta
      const tokens = cls.split(/\s+/).filter(Boolean);
      const allTypography = tokens.every((t: string) => t.startsWith('typography_'));
      if (!allTypography) return match;
      // If there are no other attributes, return bare tag; otherwise keep rest
      const otherAttrs = rest.trim();
      return otherAttrs ? `<${tag} ${otherAttrs}>` : `<${tag}>`;
    },
  );
}

/**
 * Step 6 – Unwrap se-root containers.
 * <div class="…se-root…"> → inner HTML only.
 */
function unwrapSeRoot(html: string): string {
  return unwrapTaggedElements(html, 'div', /\bse-root\b/);
}

/**
 * Step 7 – Strip remaining CSS Module class attributes.
 * Any class attribute containing `__` (the CSS Modules hash separator) is removed
 * entirely.  If ALL tokens in the class contain `__`, the whole attribute is dropped.
 * Tokens without `__` are preserved.
 */
function stripCssModuleClasses(html: string): string {
  return html.replace(/(\s*)class="([^"]*)"/gi, (_match, space, cls) => {
    const tokens = cls.split(/\s+/).filter(Boolean);
    const kept = tokens.filter((t: string) => !t.includes('__'));
    if (kept.length === 0) return ''; // drop the entire attribute
    return `${space}class="${kept.join(' ')}"`;
  });
}

/**
 * Step 8 – Strip h1 tags.
 * The page layout template provides its own h1; duplicates from body_html must go.
 */
function stripH1Tags(html: string): string {
  return html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '');
}

/**
 * Step 9 – Remove orphaned closing tags and collapse excess whitespace.
 *
 * After all the removals above, the scraped HTML often has stray closing tags
 * whose opening counterparts were deleted.  We walk the token stream and
 * silently drop any closing tag that has no matching open tag on the stack.
 */
function cleanOrphanedTags(html: string): string {
  const VOID = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  const out: string[] = [];
  const stack: string[] = [];
  const tokenRe = /(<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->|[^<]+)/g;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(html)) !== null) {
    const token = m[0];

    // Non-tag text or HTML comment – always keep
    if (!token.startsWith('<') || token.startsWith('<!--')) {
      out.push(token);
      continue;
    }

    const isClose = token.startsWith('</');
    const isSelfClose = token.endsWith('/>');
    const nameMatch = token.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
    if (!nameMatch) { out.push(token); continue; }

    const tagName = nameMatch[1].toLowerCase();

    if (isClose) {
      // Only emit if there is a matching open tag somewhere in the stack
      const idx = stack.lastIndexOf(tagName);
      if (idx !== -1) {
        // Close any implicitly unclosed tags above it first
        while (stack.length > idx + 1) {
          const unclosed = stack.pop()!;
          if (!VOID.has(unclosed)) out.push(`</${unclosed}>`);
        }
        stack.pop();
        out.push(token);
      }
      // else: orphaned close tag – silently drop
    } else if (isSelfClose || VOID.has(tagName)) {
      out.push(token);
    } else {
      stack.push(tagName);
      out.push(token);
    }
  }

  // Close any tags left open
  while (stack.length > 0) {
    const tag = stack.pop()!;
    if (!VOID.has(tag)) out.push(`</${tag}>`);
  }

  return out.join('').replace(/\s{3,}/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cleans scraped Next.js body HTML for use in the Astro rebuild.
 * Applies all transformation rules in the correct order.
 */
export function cleanBodyHtml(html: string): string {
  if (!html) return html;

  let result = html;
  result = removeFormContainers(result);
  result = removeOrphanedFormUI(result);
  result = unwrapLayoutWrappers(result);
  result = transformCollapsibles(result);
  result = cleanTypographyClasses(result);
  result = unwrapSeRoot(result);
  result = stripCssModuleClasses(result);
  result = stripH1Tags(result);
  result = cleanOrphanedTags(result);

  return result;
}

/**
 * Strips h1 tags from HTML (kept for backwards compatibility).
 * @deprecated Use cleanBodyHtml() instead.
 */
export function stripH1(html: string): string {
  return html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '');
}
