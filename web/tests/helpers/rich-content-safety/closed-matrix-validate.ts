/**
 * Test-owned closed-matrix validator. Не импортирует runtime policy/URL validator:
 * копия allowlist живёт в closed-matrix.ts.
 */
import { iterateTags } from './html-scan.js';
import {
  ALLOWED_ELEMENTS,
  EXACT_RUTUBE_SRC,
  RUTUBE_IFRAME_ALLOWED_ATTRS,
  RUTUBE_IFRAME_ATTRS,
} from './closed-matrix.js';

const ALLOWED = new Set<string>(ALLOWED_ELEMENTS);
const SKIP_TAGS = new Set(['html', 'head', 'body', '!doctype']);
const GLOBAL = new Set(['id', 'class', 'title', 'lang', 'dir']);
const RESERVED_DATA = new Set([
  'data-wrapped',
  'data-legacy-cta',
  'data-legacy-cta-unresolved',
  'data-safe-rich-content',
]);
const ARIA_LABEL_TAGS = new Set(['a', 'img', 'figure', 'table']);
const ARIA_REF_TAGS = new Set(['section', 'article', 'aside', 'details', 'figure', 'table']);
const REL_TOKENS = new Set(['nofollow', 'noopener', 'noreferrer', 'sponsored', 'ugc']);

function extraAttrs(tag: string): Set<string> {
  switch (tag) {
    case 'a':
      return new Set(['href', 'target', 'rel', 'aria-label', 'data-legacy-cta']);
    case 'img':
      return new Set(['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'aria-label']);
    case 'iframe':
      return new Set(RUTUBE_IFRAME_ALLOWED_ATTRS);
    case 'label':
      return new Set(['for']);
    case 'input':
      return new Set(['type', 'disabled', 'checked']);
    case 'th':
    case 'td':
      return new Set(['colspan', 'rowspan', 'scope', 'headers']);
    case 'time':
      return new Set(['datetime']);
    case 'details':
      return new Set(['open', 'aria-labelledby', 'aria-describedby']);
    case 'section':
    case 'article':
    case 'aside':
      return new Set(['aria-labelledby', 'aria-describedby']);
    case 'figure':
      return new Set(['aria-label', 'aria-labelledby', 'aria-describedby']);
    case 'table':
      return new Set(['aria-label', 'aria-labelledby', 'aria-describedby', 'data-wrapped']);
    case 'span':
      return new Set(['data-legacy-cta-unresolved']);
    case 'div':
      return new Set(['role', 'tabindex', 'aria-label']);
    default:
      return new Set();
  }
}

function allowedNames(tag: string): Set<string> {
  if (tag === 'input' || tag === 'iframe') return extraAttrs(tag);
  return new Set([...GLOBAL, ...extraAttrs(tag)]);
}

export function validateClosedMatrixHtml(html: string): string[] {
  const errors: string[] = [];
  for (const tag of iterateTags(html)) {
    if (SKIP_TAGS.has(tag.name)) continue;
    if (!ALLOWED.has(tag.name)) {
      errors.push(`matrix: запрещённый элемент <${tag.name}>`);
      continue;
    }
    const allowed = allowedNames(tag.name);
    const classTokens = new Set((tag.attrs.class ?? '').split(/\s+/).filter(Boolean));
    for (const [name, value] of Object.entries(tag.attrs)) {
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'formaction') {
        errors.push(`matrix: запрещённый атрибут ${name} на <${tag.name}>`);
        continue;
      }
      if (name === 'contenteditable') {
        errors.push(`matrix: contenteditable на <${tag.name}>`);
        continue;
      }
      if (name.startsWith('data-') && !RESERVED_DATA.has(name)) {
        errors.push(`matrix: произвольный ${name} на <${tag.name}>`);
        continue;
      }
      if (RESERVED_DATA.has(name)) continue;
      if (name === 'aria-label' && !ARIA_LABEL_TAGS.has(tag.name) && !classTokens.has('table-scroll')) {
        errors.push(`matrix: aria-label на <${tag.name}>`);
        continue;
      }
      if ((name === 'aria-labelledby' || name === 'aria-describedby') && !ARIA_REF_TAGS.has(tag.name)) {
        errors.push(`matrix: ${name} на <${tag.name}>`);
        continue;
      }
      if (!allowed.has(name)) {
        errors.push(`matrix: атрибут ${name} не в закрытой матрице <${tag.name}>`);
        continue;
      }
      if (tag.name === 'a' && name === 'target' && value !== '_blank') {
        errors.push(`matrix: a[target] только _blank`);
      }
      if (tag.name === 'a' && name === 'rel') {
        for (const token of value.split(/\s+/).filter(Boolean)) {
          if (!REL_TOKENS.has(token)) errors.push(`matrix: a[rel] неизвестный токен ${token}`);
        }
      }
      if (tag.name === 'input' && name === 'type' && value !== 'checkbox') {
        errors.push(`matrix: input[type] только checkbox`);
      }
      if (tag.name === 'iframe') {
        if (name === 'src' && value !== EXACT_RUTUBE_SRC && !/^https:\/\/rutube\.ru\/play\/embed\/[A-Za-z0-9_-]+\/$/.test(value)) {
          errors.push(`matrix: iframe src не точный RUTUBE`);
        }
        if (name === 'sandbox' && value !== RUTUBE_IFRAME_ATTRS.sandbox) {
          errors.push(`matrix: iframe sandbox не системный`);
        }
      }
    }
  }
  return errors;
}
