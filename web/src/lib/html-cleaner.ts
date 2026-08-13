/**
 * HTML cleaner for the IKPK website rebuild.
 * Transforms scraped Next.js HTML (with CSS Module hashed classes) into clean semantic HTML.
 *
 * Transformation pipeline (applied in order):
 *  0. Localize media URLs (storage.yandexcloud.net → local /media/**) and
 *     inject width/height on <img> from the media manifest (CLS guard)
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

import { injectImgDimensions } from './media.js';
import { registrationHref, isDemoForms } from './forms.js';
import {
  authenticate,
  isSafeRichHtml,
  sanitizeUntrustedTree,
  terminalSanitize,
  type SafeRichHtml,
  type SanitizeContext,
} from './rich-html-sanitize.js';

export { isSafeRichHtml, terminalSanitize };
export type { SafeRichHtml };

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
 * Removes residual UI controls that should never survive content extraction.
 */
function removeResidualUiArtifacts(html: string): string {
  return html
    .replace(/<button\b[^>]*>\s*Показать\s+ещ(?:е|ё)\s*<\/button>/gi, '')
    .replace(/<a\b[^>]*>\s*Показать\s+ещ(?:е|ё)\s*<\/a>/gi, '');
}

/**
 * Unwraps inline spacer wrappers from scraped content.
 * These wrappers often carry fixed heights and cause visual overlap once the
 * original JS/CSS is gone.
 */
function unwrapInlineSpacerWrappers(html: string): string {
  const openRe = /<div([^>]*\sstyle="[^"]*\b(?:min-|max-)?height\s*:\s*\d+px[^"]*"[^>]*)>/gi;
  let result = html;
  let searchFrom = 0;

  for (let guard = 0; guard < 50_000; guard++) {
    openRe.lastIndex = searchFrom;
    const m = openRe.exec(result);
    if (!m) break;

    const style = m[1].match(/\bstyle="([^"]*)"/i)?.[1]?.toLowerCase() ?? '';
    const safeSpacer = /\b(?:min-|max-)?height\s*:\s*\d+px/.test(style)
      && !/(position\s*:|overflow\s*:|transform\s*:|display\s*:\s*(?:flex|grid|inline-flex))/i.test(style);

    if (!safeSpacer) {
      searchFrom = m.index + 1;
      continue;
    }

    const end = elementEnd(result, m.index, 'div');
    const inner = result.slice(m.index + m[0].length, end - '</div>'.length);

    if (!/<(?:h[2-6]|p|ul|ol|details)\b/i.test(inner)) {
      searchFrom = m.index + 1;
      continue;
    }

    result = result.slice(0, m.index) + inner + result.slice(end);
    openRe.lastIndex = m.index;
    searchFrom = m.index;
  }

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
function transformCollapsibles(
  html: string,
  panels?: Record<string, string>,
): string {
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

    // Контент, восстановленный с живого сайта отдельным проходом браузера:
    // Radix не монтирует закрытую панель, поэтому в HTTP-скрейпе её нет.
    if (!content && panels) {
      content = (panels[title] ?? '').trim();
    }

    // Заголовок, раскрывающийся в пустоту, хуже отсутствия заголовка: он
    // обещает контент, которого нет. Часть секций на живом сайте и правда
    // пустая — такие просто не выводим.
    const replacement = content
      ? `<details open><summary>${title}</summary>${content}</details>`
      : '';

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

function removeResidualBrokenTagText(html: string): string {
  return html.replace(/>\s*\/(li|ul|ol|div|section|article|p|button|a)\s*</gi, '><');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Removes the legacy seminar tail that includes the old schedule block and
 * newsletter form copied from the original React layout.
 */
export function stripLegacySeminarTail(html: string): string {
  if (!html) return html;
  return html.replace(/<div\b[^>]*class="[^"]*seminar-form_actionControl__[^"]*"[^>]*>[\s\S]*$/i, '');
}

/**
 * Cleans scraped Next.js body HTML for use in the Astro rebuild.
 * Applies all transformation rules in the correct order.
 */
/**
 * Политика rel для внешних ссылок в контенте (discovery/domain_strategy.md):
 * - medshop.ikpk.su — дубль kinezio.shop, будет закрыт 301-редиректом:
 *   не передаём SEO-вес (nofollow) и держим noopener;
 * - disk.yandex.ru — утечка веса на Яндекс.Диск: nofollow noopener;
 * - kinezio.shop / mudriydoctor.ru — свои проекты: noopener достаточно.
 */
// Сопоставление по РАСПАРСЕННОМУ hostname (не по подстроке): исключает и
// ложные срабатывания на URL в query-параметрах, и обход через поддомены.
const NOFOLLOW_HOSTS = ['medshop.ikpk.su', 'disk.yandex.ru'];
const NOOPENER_HOSTS = ['kinezio.shop', 'mudriydoctor.ru'];

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain);
}

/** rel-атрибуты, которые политика требует для данного URL (undefined — без требований). */
export function relForExternalUrl(url: string): string[] | undefined {
  let hostname: string;
  try {
    // protocol-relative (//host/…) резолвим относительно https
    hostname = new URL(url, 'https://ikpk.su').hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (NOFOLLOW_HOSTS.some((d) => hostMatches(hostname, d))) return ['nofollow', 'noopener'];
  if (NOOPENER_HOSTS.some((d) => hostMatches(hostname, d))) return ['noopener'];
  return undefined;
}

/**
 * Демо-режим: ссылки на CRM-формы Bitrix24, вшитые в КОНТЕНТ (а не в поле
 * registrationFormLink), тоже не должны писать в продакшен-CRM заказчика.
 * В данных таких порталов два: b24-cbqwqo и b24-kbo5ls. В прод-сборке
 * (DEMO_FORMS не задана) функция ничего не делает.
 */
function redirectFormLinksInDemo(html: string): string {
  if (!isDemoForms || !html.includes('bitrix24site.ru')) return html;
  return html.replace(/<a\b[^>]*>/gi, (tag) => {
    const href = tag.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const url = href?.[1] ?? href?.[2];
    if (!url || !/bitrix24site\.ru/i.test(url)) return tag;
    const replaced = registrationHref(url);
    let out = tag.replace(url, replaced);
    // на локальную заглушку не нужен новый таб
    if (!/^https?:\/\//.test(replaced)) {
      out = out.replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*')/i, '');
    }
    return out;
  });
}

/**
 * Легаси-контент приносит два визуальных дефекта, заметных глазом:
 *
 * 1. Нативная <button> без класса (например «Произвести оплату» на /oplata) —
 *    серый браузерный контрол посреди страницы, к тому же МЁРТВЫЙ: на старом
 *    сайте её обрабатывал React, у нас обработчика нет. Пока форма не подключена,
 *    ведём пользователя на якорь ВНУТРИ ЭТОЙ ЖЕ страницы, который сообщает
 *    страница (legacyCtaHref) — обычно её блок контактов. Уводить на другую
 *    страницу нельзя: подпись кнопки обещает действие, а не переход.
 * 2. Аккордеоны, обёрнутые в <ul><li> — у карточек торчат маркеры списка.
 *    Разворачиваем такие обёртки, чтобы маркеры не появлялись ни в одном
 *    браузере (CSS :has() не покрыл бы старый Safari).
 */
function normalizeLegacyControls(html: string, legacyCtaHref?: string): string {
  let out = html;

  // 1. кнопки без класса → ссылка на адрес, КОТОРЫЙ СООБЩИЛА СТРАНИЦА.
  //    Раньше здесь стоял жёстко вписанный /raspisanie-i-tseny, и это был дефект:
  //    правило срабатывает на любой легаси-кнопке, а не только на кнопке оплаты.
  //    В сборке получилось четыре кнопки на двух страницах, ведущие не туда, куда
  //    обещает подпись: «Хочу сотрудничать!» (×3) и «Произвести оплату» уводили в
  //    прайс на семинары.
  //
  //    Очистка не знает, куда должна вести кнопка конкретной страницы, и не имеет
  //    права это придумывать. Не сообщили адрес — контрол помечается как
  //    неразрешённый, подпись сохраняется, ложной кликабельности не создаётся, а
  //    build-гейт на такую метку краснеет.
  out = out.replace(
    /<button(?![^>]*\bclass=)[^>]*>([\s\S]*?)<\/button>/gi,
    (_m, label) =>
      legacyCtaHref
        ? `<a class="btn btn-primary" href="${legacyCtaHref}" ${LEGACY_CTA_ATTR}>${label}</a>`
        : `<span class="legacy-cta-unresolved" ${LEGACY_CTA_UNRESOLVED_ATTR}>${label}</span>`
  );

  // 2. <ul>/<li> вокруг аккордеонов — это не список, а layout-обёртка из
  //    легаси-вёрстки: у крупных блоков торчат маркеры. Меняем теги на <div>,
  //    а не разворачиваем: у <li> бывает id — цель анкорной ссылки
  //    (/svedeniya-ob-obrazovatelnoy-organizatsii#3), её нельзя потерять.
  //    Через CSS (:has) не решить — старый Safari его не поддерживает.
  const accordionInside = /^(?:\s*<div[^>]*>)*\s*<details/i;
  // Порядок важен: сначала внешний <ul>, потом <li>. Наоборот не работает —
  // после замены <li> на <div> список перестаёт опознаваться как обёртка
  // аккордеонов и остаётся невалидный <ul> с <div> внутри.
  for (const tag of ['ul', 'li']) {
    const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
    let from = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      openRe.lastIndex = from;
      const m = openRe.exec(out);
      if (!m) break;

      const end = elementEnd(out, m.index, tag);
      const inner = out.slice(m.index + m[0].length, end - `</${tag}>`.length);
      // для <ul> достаточно, чтобы аккордеон был в любом из <li>
      const hit = tag === 'li'
        ? accordionInside.test(inner)
        : /<li[^>]*>(?:\s*<div[^>]*>)*\s*<details/i.test(inner);
      if (!hit) {
        from = m.index + 1;
        continue;
      }

      const attrs = m[1] ?? '';
      out =
        out.slice(0, m.index) +
        `<div${attrs}>` + inner + '</div>' +
        out.slice(end);
      from = m.index + 1;
    }
  }

  // Хост www.medshop.ikpk.su не отвечает вообще, а он стоял и в ссылке, и в
  //    видимой подписи. Домен без www рабочий; какой домен магазина считать
  //    актуальным (medshop.ikpk.su или kinezio.shop, как на старом сайте) —
  //    вопрос к заказчику, поэтому здесь убираем только заведомо мёртвый www.
  out = out.replaceAll('www.medshop.ikpk.su', 'medshop.ikpk.su');

  // Широкая таблица на узком экране получает горизонтальную прокрутку, а
  //    прокручиваемая область обязана быть достижима с клавиатуры — иначе часть
  //    таблицы недоступна тем, кто не пользуется мышью (WCAG 2.1.1, axe:
  //    scrollable-region-focusable). Обёртка даёт и прокрутку, и фокус, и
  //    подпись для программ чтения с экрана.
  out = out.replace(
    /<table(?![^>]*\bdata-wrapped\b)/gi,
    '<div class="table-scroll" tabindex="0" role="region" aria-label="Таблица">§TABLE§',
  );
  out = out.replace(/<\/table>/gi, '</table></div>');
  out = out.replaceAll('§TABLE§', '<table data-wrapped');

  // 0. Пустая обёртка списка — висячий маркер без текста. Остаётся, когда из
  //    <li> убрали содержимое (например секцию без контента).
  out = out.replace(/<li[^>]*>\s*<\/li>/gi, '');
  out = out.replace(/<(ul|ol)[^>]*>\s*<\/\1>/gi, '');

  // 3. Разворот обёрток иногда оставляет список внутри списка без <li>:
  //    <ul><ul>…</ul></ul>. Это невалидно, а вложенный список ещё и получает
  //    лишний отступ. Внешний уровень снимаем.
  const openList = /<(ul|ol)(\s[^>]*)?>/gi;
  let listFrom = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    openList.lastIndex = listFrom;
    const m = openList.exec(out);
    if (!m) break;

    const tag = m[1].toLowerCase();
    const end = elementEnd(out, m.index, tag);
    const inner = out.slice(m.index + m[0].length, end - `</${tag}>`.length);
    const trimmed = inner.trim();

    // внутри ровно один список и ничего больше
    const nested = trimmed.match(/^<(ul|ol)(\s[^>]*)?>/i);
    const wholeInner =
      nested && elementEnd(trimmed, 0, nested[1]) === trimmed.length;
    if (!wholeInner) {
      listFrom = m.index + 1;
      continue;
    }

    out = out.slice(0, m.index) + trimmed + out.slice(end);
    listFrom = m.index;
  }

  return out;
}

function applyExternalLinkPolicy(html: string): string {
  if (!html.includes('<a ')) return html;
  return html.replace(/<a\b[^>]*>/gi, (tag) => {
    const href = tag.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const url = href?.[1] ?? href?.[2];
    if (!url) return tag;
    const wanted = relForExternalUrl(url);
    if (!wanted) return tag;
    const relMatch = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const existing = (relMatch?.[1] ?? relMatch?.[2] ?? '').split(/\s+/).filter(Boolean);
    const merged = [...new Set([...existing, ...wanted])].join(' ');
    if (relMatch) {
      return tag.replace(relMatch[0], `rel="${merged}"`);
    }
    return tag.replace(/^<a\b/i, `<a rel="${merged}"`);
  });
}

/**
 * Атрибуты легаси-контрола. Экспортируются, чтобы гейты не искали магическую
 * строку: переименование здесь обязано ломать тесты, а не оставлять их
 * вечнозелёными на маркере, который больше никто не эмитит.
 */
export const LEGACY_CTA_ATTR = 'data-legacy-cta';
export const LEGACY_CTA_UNRESOLVED_ATTR = 'data-legacy-cta-unresolved';

export interface CleanOptions {
  /**
   * Контент свёрнутых секций, восстановленный с живого сайта
   * (см. web/scripts/recover-collapsibles.mjs), в виде {заголовок: html}.
   */
  panels?: Record<string, string>;
  /**
   * Куда ведёт легаси-кнопка этой страницы (например якорь на её же блок
   * контактов). Не задан — контрол помечается неразрешённым: очистка не
   * придумывает адрес за страницу, см. normalizeLegacyControls.
   */
  legacyCtaHref?: string;
  sourceType?: string;
  sourceId?: string;
}

const KNOWN_REMOTE_UPLOAD =
  'https://ikpk.su/api/upload/file/0acd713c-1477-4c6c-93ad-1596d2a17304';
const LOCAL_UPLOAD_WEBP = '/media/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp';

function rewriteKnownRemoteUpload(html: string): string {
  return html.split(KNOWN_REMOTE_UPLOAD).join(LOCAL_UPLOAD_WEBP);
}

export function cleanBodyHtml(html: string, opts: CleanOptions = {}): SafeRichHtml {
  const ctx: SanitizeContext = {
    sourceType: opts.sourceType ?? 'fragment',
    sourceId: opts.sourceId ?? 'unknown',
  };
  if (!html) return authenticate('');

  let result = sanitizeUntrustedTree(html, ctx);
  result = rewriteKnownRemoteUpload(result);
  // Локализация URL бакета живёт в единственной точке — data.ts loadJson
  // (весь raw JSON до парсинга); здесь только размеры <img> из манифеста.
  result = injectImgDimensions(result);
  result = removeFormContainers(result);
  result = removeOrphanedFormUI(result);
  result = removeResidualUiArtifacts(result);
  result = unwrapLayoutWrappers(result);
  result = unwrapInlineSpacerWrappers(result);
  result = transformCollapsibles(result, opts.panels);
  result = cleanTypographyClasses(result);
  result = unwrapSeRoot(result);
  result = stripCssModuleClasses(result);
  result = stripH1Tags(result);
  result = cleanOrphanedTags(result);
  result = applyExternalLinkPolicy(result);
  result = normalizeLegacyControls(result, opts.legacyCtaHref);
  result = redirectFormLinksInDemo(result);
  result = removeResidualBrokenTagText(result);
  result = terminalSanitize(result, 'authenticated', ctx);

  return authenticate(result);
}

/**
 * Strips h1 tags from HTML (kept for backwards compatibility).
 * @deprecated Use cleanBodyHtml() instead.
 */
export function stripH1(html: string): string {
  return html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '');
}
