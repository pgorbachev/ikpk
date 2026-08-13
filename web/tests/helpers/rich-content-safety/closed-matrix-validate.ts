/**
 * Test-owned closed-matrix validator. Не импортирует runtime policy/URL validator:
 * копия allowlist живёт в closed-matrix.ts.
 */
import { elementEnd, iterateTags, type OpenTag } from './html-scan.js';
import {
  ALLOWED_ELEMENTS,
  FORBIDDEN_URL_SCHEMES,
  RUTUBE_IFRAME_ALLOWED_ATTRS,
  RUTUBE_IFRAME_ATTRS,
  RUTUBE_SRC_RE,
} from './closed-matrix.js';

const ALLOWED = new Set<string>(ALLOWED_ELEMENTS);
const SKIP_TAGS = new Set(['html', 'head', 'body', '!doctype']);
const GLOBAL = new Set(['id', 'class', 'title', 'lang', 'dir']);
const ARIA_LABEL_TAGS = new Set(['a', 'img', 'figure', 'table']);
const ARIA_REF_TAGS = new Set(['section', 'article', 'aside', 'details', 'figure', 'table']);
const REL_TOKENS = new Set(['nofollow', 'noopener', 'noreferrer', 'sponsored', 'ugc']);
const URL_ATTRS = new Set(['href', 'src', 'poster', 'action', 'formaction', 'cite', 'data']);
const DIR_VALUES = new Set(['ltr', 'rtl', 'auto']);
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const INT_RE = /^[1-9]\d*$/;

export interface MatrixValidateOpts {
  knownSinkIds?: string[];
}

interface Node {
  tag: OpenTag;
  close: number;
}

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

function hasBoolean(attrs: Record<string, string>, name: string): boolean {
  if (!(name in attrs)) return false;
  const v = attrs[name].toLowerCase();
  return v === '' || v === name || v === 'true';
}

function classTokens(attrs: Record<string, string>): Set<string> {
  return new Set((attrs.class ?? '').split(/\s+/).filter(Boolean));
}

function isTableScroll(tag: OpenTag): boolean {
  return tag.name === 'div' && classTokens(tag.attrs).has('table-scroll');
}

function parentOf(nodes: Node[], child: Node): Node | undefined {
  let best: Node | undefined;
  for (const n of nodes) {
    if (n.tag.start < child.tag.start && n.close >= child.close) {
      if (!best || n.tag.start > best.tag.start) best = n;
    }
  }
  return best;
}

function firstElementChild(nodes: Node[], parent: Node): Node | undefined {
  let first: Node | undefined;
  for (const n of nodes) {
    if (n === parent) continue;
    if (n.tag.start <= parent.tag.end - 1) continue;
    if (n.close > parent.close) continue;
    if (parentOf(nodes, n) !== parent) continue;
    if (!first || n.tag.start < first.tag.start) first = n;
  }
  return first;
}

function stripControls(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 32 && code !== 127) out += value[i];
  }
  return out;
}

function decodeUrl(value: string): string {
  let decoded = stripControls(
    value.replace(/&amp;/g, '&').replace(/&#0*(\d+);/g, (_, n) => String.fromCharCode(Number(n))),
  ).trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* malformed percent-encoding */
  }
  return decoded.toLowerCase().replace(/\s+/g, '');
}

function forbiddenUrl(value: string): boolean {
  const lower = decodeUrl(value);
  if (lower.startsWith('//')) return true;
  return FORBIDDEN_URL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

function checkUrls(tag: OpenTag, name: string, value: string, errors: string[]): void {
  const values = name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '') : [value];
  for (const url of values) {
    if (!url) continue;
    if (forbiddenUrl(url)) errors.push(`matrix: запрещённый URL в ${tag.name}[${name}]`);
  }
}

export function validateClosedMatrixHtml(html: string, opts?: MatrixValidateOpts): string[] {
  const errors: string[] = [];
  const nodes: Node[] = [...iterateTags(html)].map((tag) => ({ tag, close: elementEnd(html, tag) }));
  const knownSinks = opts?.knownSinkIds ?? [];

  for (const node of nodes) {
    const { tag } = node;
    if (SKIP_TAGS.has(tag.name)) continue;
    if (!ALLOWED.has(tag.name)) {
      errors.push(`matrix: запрещённый элемент <${tag.name}>`);
      continue;
    }
    const allowed = allowedNames(tag.name);
    const classes = classTokens(tag.attrs);
    const parent = parentOf(nodes, node);

    if (classes.has('table-scroll')) {
      if (!isTableScroll(tag) || tag.attrs.role !== 'region' || tag.attrs.tabindex !== '0') {
        errors.push('matrix: .table-scroll только на div[role=region][tabindex=0]');
      } else {
        const child = firstElementChild(nodes, node);
        if (!child || child.tag.name !== 'table' || !('data-wrapped' in child.tag.attrs)) {
          errors.push('matrix: .table-scroll обязан непосредственно содержать table[data-wrapped]');
        }
      }
    }
    if (classes.has('legacy-cta-unresolved')) {
      if (tag.name !== 'span' || !('data-legacy-cta-unresolved' in tag.attrs)) {
        errors.push('matrix: .legacy-cta-unresolved только на span[data-legacy-cta-unresolved]');
      }
    }

    if (tag.name === 'input') {
      if (tag.attrs.type !== 'checkbox') errors.push('matrix: input[type] только checkbox');
      if (!hasBoolean(tag.attrs, 'disabled')) errors.push('matrix: checkbox обязан быть disabled');
    }
    if (tag.name === 'iframe') {
      for (const req of RUTUBE_IFRAME_ALLOWED_ATTRS) {
        if (!(req in tag.attrs)) errors.push(`matrix: iframe без обязательного ${req}`);
      }
      if (tag.attrs.src && !RUTUBE_SRC_RE.test(tag.attrs.src)) {
        errors.push('matrix: iframe src не точный RUTUBE');
      }
      if (tag.attrs.sandbox && tag.attrs.sandbox !== RUTUBE_IFRAME_ATTRS.sandbox) {
        errors.push('matrix: iframe sandbox не системный');
      }
      if (tag.attrs.allow && tag.attrs.allow !== RUTUBE_IFRAME_ATTRS.allow) {
        errors.push('matrix: iframe allow не системный');
      }
      if (tag.attrs.referrerpolicy && tag.attrs.referrerpolicy !== RUTUBE_IFRAME_ATTRS.referrerpolicy) {
        errors.push('matrix: iframe referrerpolicy не системный');
      }
      if (tag.attrs.loading && tag.attrs.loading !== RUTUBE_IFRAME_ATTRS.loading) {
        errors.push('matrix: iframe loading не lazy');
      }
      if (tag.attrs.title && tag.attrs.title !== RUTUBE_IFRAME_ATTRS.title) {
        errors.push('matrix: iframe title не системный');
      }
    }

    for (const [name, value] of Object.entries(tag.attrs)) {
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'formaction') {
        errors.push(`matrix: запрещённый атрибут ${name} на <${tag.name}>`);
        continue;
      }
      if (name === 'contenteditable') {
        errors.push(`matrix: contenteditable на <${tag.name}>`);
        continue;
      }
      if (URL_ATTRS.has(name) || name === 'srcset') checkUrls(tag, name, value, errors);
      if (name === 'dir' && !DIR_VALUES.has(value)) {
        errors.push(`matrix: dir только ltr|rtl|auto`);
      }
      if (name === 'lang' && value && !LANG_RE.test(value)) {
        errors.push(`matrix: невалидный lang`);
      }
      if ((name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan') && value && !INT_RE.test(value)) {
        errors.push(`matrix: ${name} должен быть положительным целым`);
      }
      if (name === 'loading' && tag.name === 'img' && value && value !== 'lazy' && value !== 'eager') {
        errors.push('matrix: img[loading] только lazy|eager');
      }
      if (name === 'decoding' && value && !['async', 'sync', 'auto'].includes(value)) {
        errors.push('matrix: img[decoding] только async|sync|auto');
      }
      if (name === 'scope' && !['row', 'col', 'rowgroup', 'colgroup'].includes(value)) {
        errors.push('matrix: th/td[scope] не из закрытого списка');
      }
      if (name === 'role' && value === 'region' && !isTableScroll(tag)) {
        errors.push('matrix: role=region только на .table-scroll');
      }
      if (name === 'tabindex' && !isTableScroll(tag)) {
        errors.push('matrix: tabindex только на .table-scroll');
      }
      if (name === 'tabindex' && isTableScroll(tag) && value !== '0') {
        errors.push('matrix: .table-scroll[tabindex] только 0');
      }

      if (name === 'data-safe-rich-content') {
        if (!knownSinks.includes(value)) errors.push(`matrix: неизвестный sink-id ${value}`);
        continue;
      }
      if (name === 'data-wrapped') {
        if (tag.name !== 'table' || !parent || !isTableScroll(parent.tag) || parent.tag.attrs.role !== 'region' || parent.tag.attrs.tabindex !== '0') {
          errors.push('matrix: data-wrapped только на table внутри .table-scroll[role=region][tabindex=0]');
        }
        continue;
      }
      if (name === 'data-legacy-cta') {
        if (tag.name !== 'a' || !/^#[^#]/.test(tag.attrs.href ?? '') || forbiddenUrl(tag.attrs.href ?? '')) {
          errors.push('matrix: data-legacy-cta только на a с локальным fragment href');
        }
        continue;
      }
      if (name === 'data-legacy-cta-unresolved') {
        if (tag.name !== 'span' || 'href' in tag.attrs) {
          errors.push('matrix: data-legacy-cta-unresolved только на span без href');
        }
        continue;
      }
      if (name.startsWith('data-')) {
        errors.push(`matrix: произвольный ${name} на <${tag.name}>`);
        continue;
      }
      if (name === 'aria-label' && !ARIA_LABEL_TAGS.has(tag.name) && !classes.has('table-scroll')) {
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
        errors.push('matrix: a[target] только _blank');
      }
      if (tag.name === 'a' && name === 'rel') {
        for (const token of value.split(/\s+/).filter(Boolean)) {
          if (!REL_TOKENS.has(token)) errors.push(`matrix: a[rel] неизвестный токен ${token}`);
        }
      }
    }
  }
  return errors;
}
