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

export const CANARY_PATH = '/__rich-content-canary';
export const CANARY_CONTROL_TOKEN = 'rc-fixture-control-9f3c2e1a';
export const CANARY_HOSTILE_TOKEN = 'rc-hostile-canary-7b41d0ee';

export const RESERVED_ATTRS = [
  'data-wrapped',
  'data-legacy-cta',
  'data-legacy-cta-unresolved',
  'data-safe-rich-content',
] as const;

export const RESERVED_CLASSES = ['table-scroll', 'legacy-cta-unresolved'] as const;
