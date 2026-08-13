/**
 * Независимая полная копия закрытой матрицы spec. Не импортирует runtime policy.
 */

export const ALLOWED_ELEMENTS = [
  'p', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'section', 'article',
  'aside', 'address', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'details', 'summary',
  'strong', 'b', 'em', 'i', 'u', 's', 'sup', 'sub', 'code', 'pre', 'blockquote',
  'a', 'img', 'figure', 'figcaption', 'time', 'label', 'input', 'table', 'caption',
  'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'iframe',
] as const;

export const GLOBAL_ATTRS = ['id', 'class', 'title', 'lang', 'dir'] as const;

export const DISCARD_WITH_CONTENT = [
  'script', 'style', 'object', 'embed', 'svg', 'math', 'template', 'base', 'meta', 'link',
] as const;

export const RUTUBE_IFRAME_ATTRS = {
  sandbox: 'allow-scripts allow-same-origin allow-presentation',
  allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
  referrerpolicy: 'no-referrer',
  loading: 'lazy',
  title: 'Видео RUTUBE',
  allowfullscreen: true,
} as const;

export const RUTUBE_SRC_RE = /^https:\/\/rutube\.ru\/play\/embed\/[A-Za-z0-9_-]+\/$/;

export const BYTE_LIMIT = 2_097_152;
export const NODE_LIMIT = 50_000;
export const DEPTH_LIMIT = 256;

export const CANARY_PATH = '/rich-content-canary';
export const CANARY_CONTROL_TOKEN = 'rc-fixture-control-9f3c2e1a';
export const CANARY_HOSTILE_TOKEN = 'rc-hostile-canary-7b41d0ee';

export const RESERVED_ATTRS = [
  'data-wrapped',
  'data-legacy-cta',
  'data-legacy-cta-unresolved',
  'data-safe-rich-content',
] as const;

export const RESERVED_CLASSES = ['table-scroll', 'legacy-cta-unresolved'] as const;

/** Утверждённые structural forms authenticated mode (spec: системные маркеры). */
export const AUTHENTICATED_FORMS = {
  tableWrapper:
    '<div class="table-scroll" role="region" tabindex="0"><table data-wrapped><tbody><tr><td>ячейка</td></tr></tbody></table></div>',
  resolvedCta: '<a href="#oplata-svyaz" data-legacy-cta>Произвести оплату</a>',
  unresolvedCta: '<span class="legacy-cta-unresolved" data-legacy-cta-unresolved>Хочу сотрудничать!</span>',
} as const;

/** Полная отдельная iframe-строка test-owned matrix. Не импортирует runtime. */
export const RUTUBE_IFRAME_ALLOWED_ATTRS = [
  'src',
  'sandbox',
  'allow',
  'referrerpolicy',
  'loading',
  'title',
  'allowfullscreen',
] as const;

export const RUTUBE_IFRAME_FORBIDDEN_ATTRS = [
  'srcdoc',
  'name',
  'width',
  'height',
  'align',
  'allowpaymentrequest',
  'csp',
  'fetchpriority',
  'importance',
  'scrolling',
  'frameborder',
  'longdesc',
  'marginwidth',
  'marginheight',
  'onload',
  'onerror',
] as const;

export const EXACT_RUTUBE_SRC = 'https://rutube.ru/play/embed/4a1e6023bd7a3716d8ff56bf98c96e97/';

export function exactRutubeIframe(): string {
  return `<iframe src="${EXACT_RUTUBE_SRC}" sandbox="${RUTUBE_IFRAME_ATTRS.sandbox}" allow="${RUTUBE_IFRAME_ATTRS.allow}" referrerpolicy="${RUTUBE_IFRAME_ATTRS.referrerpolicy}" loading="${RUTUBE_IFRAME_ATTRS.loading}" title="${RUTUBE_IFRAME_ATTRS.title}" allowfullscreen></iframe>`;
}

export const NESTED_BROWSING_HAZARDS = ['frame', 'frameset', 'object', 'embed', 'iframe'] as const;

export const FORBIDDEN_URL_SCHEMES = ['javascript:', 'vbscript:', 'file:', 'data:'] as const;

/** Allowlist `a[href]` после разбора схемы. Не denylist. */
export const ALLOWED_HREF_SCHEMES = ['http', 'https', 'mailto', 'tel'] as const;

export const RASTER_MEDIA_EXT_RE = /\.(webp|png|jpg|jpeg)$/i;
export const SRCSET_CANDIDATE_RE = /^(\/media\/_w\/(\d+)\/\S+) (\d+)w$/;

/**
 * Единственный ожидаемый recovered+sanitized DOM для malformed fixture.
 * Recovered tree — HTML5 (Chromium DOMParser); sanitizer удаляет script.
 */
export const MALFORMED_INPUT = '<b><i>misnested</b></i><p>ok<script>alert(1)</script>';
export const MALFORMED_EXPECTED_SANITIZED = '<b><i>misnested</i></b><p>ok</p>';

export const PARSER_PACKAGES_RE = /parse5|jsdom|htmlparser2|dompurify|sanitize-html|linkedom|cheerio|node-html-parser/i;
