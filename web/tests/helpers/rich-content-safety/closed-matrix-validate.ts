/**
 * Test-owned closed-matrix validator. Не импортирует runtime policy/URL validator:
 * копия allowlist живёт в closed-matrix.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { elementEnd, iterateTags, type OpenTag } from './html-scan.js';
import {
  ALLOWED_ELEMENTS,
  ALLOWED_HREF_SCHEMES,
  FORBIDDEN_URL_SCHEMES,
  RASTER_MEDIA_EXT_RE,
  RUTUBE_IFRAME_ALLOWED_ATTRS,
  RUTUBE_IFRAME_ATTRS,
  RUTUBE_SRC_RE,
  SRCSET_CANDIDATE_RE,
} from './closed-matrix.js';
import { MEDIA_MANIFEST, REPO_ROOT, WEB_ROOT } from './paths.js';

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
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const HREF_SCHEMES = new Set<string>(ALLOWED_HREF_SCHEMES);
const MARKER_WRAPPER = 'div';

export interface MediaManifestEntry {
  width?: number;
  height?: number;
  widths?: number[];
}

export interface MatrixValidateOpts {
  knownSinkIds?: string[];
  mediaManifest?: Record<string, MediaManifestEntry>;
  mediaFileExists?: (urlPath: string) => boolean;
}

interface Node {
  tag: OpenTag;
  close: number;
}

let cachedManifest: Record<string, MediaManifestEntry> | undefined;

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

function ancestorHasMarker(nodes: Node[], node: Node): boolean {
  let current = parentOf(nodes, node);
  while (current) {
    if (current.tag.attrs['data-safe-rich-content']) return true;
    current = parentOf(nodes, current);
  }
  return false;
}

function stripControls(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 32 && code !== 127) out += value[i];
  }
  return out;
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&#0*(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function prepareUrl(value: string): string {
  let decoded = stripControls(decodeEntities(value)).trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* malformed percent-encoding */
  }
  return decoded;
}

function compactLower(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

function forbiddenUrl(value: string): boolean {
  const lower = compactLower(prepareUrl(value));
  if (lower.startsWith('//')) return true;
  return FORBIDDEN_URL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

function isAllowedHref(value: string): boolean {
  const prepared = prepareUrl(value);
  if (!prepared) return false;
  const lower = compactLower(prepared);
  if (lower.startsWith('//')) return false;
  if (FORBIDDEN_URL_SCHEMES.some((scheme) => lower.startsWith(scheme))) return false;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(prepared);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!HREF_SCHEMES.has(scheme)) return false;
    if (scheme === 'http' || scheme === 'https') {
      try {
        const parsed = new URL(prepared);
        if (parsed.username || parsed.password) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  return true;
}

function loadDefaultManifest(): Record<string, MediaManifestEntry> {
  cachedManifest ??= JSON.parse(readFileSync(MEDIA_MANIFEST, 'utf-8')) as Record<string, MediaManifestEntry>;
  return cachedManifest;
}

export function defaultMediaFileExists(urlPath: string): boolean {
  const rel = urlPath.replace(/^\/media\//, '');
  if (urlPath.startsWith('/media/_w/')) {
    return existsSync(join(WEB_ROOT, 'public', urlPath.slice(1)));
  }
  return existsSync(join(REPO_ROOT, 'media-originals', rel)) || existsSync(join(WEB_ROOT, 'public', urlPath.slice(1)));
}

function isRasterManifestEntry(entry: MediaManifestEntry | undefined): entry is MediaManifestEntry {
  return Boolean(
    entry &&
      typeof entry.width === 'number' &&
      entry.width > 0 &&
      Number.isInteger(entry.width) &&
      typeof entry.height === 'number' &&
      entry.height > 0 &&
      Number.isInteger(entry.height),
  );
}

function checkImgSrc(
  src: string,
  errors: string[],
  manifest: Record<string, MediaManifestEntry>,
  fileExists: (urlPath: string) => boolean,
): void {
  const path = prepareUrl(src);
  if (!path.startsWith('/media/') || path.startsWith('/media/_w/') || !RASTER_MEDIA_EXT_RE.test(path)) {
    errors.push('matrix: img[src] только существующий raster /media/**');
    return;
  }
  const entry = manifest[path];
  if (!isRasterManifestEntry(entry)) {
    errors.push('matrix: img[src] нет raster-записи media manifest');
    return;
  }
  if (!fileExists(path)) errors.push('matrix: img[src] отсутствует local asset');
}

function checkSrcset(
  srcset: string,
  errors: string[],
  manifest: Record<string, MediaManifestEntry>,
  fileExists: (urlPath: string) => boolean,
): void {
  const parts = srcset.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    errors.push('matrix: пустой srcset');
    return;
  }
  const urls = new Set<string>();
  const widths = new Set<string>();
  for (const part of parts) {
    const match = SRCSET_CANDIDATE_RE.exec(part);
    if (!match) {
      errors.push('matrix: srcset candidate не /media/_w/<width>/<path> <width>w');
      continue;
    }
    const [, url, urlWidth, , descriptorWidth] = match;
    if (urlWidth !== descriptorWidth) {
      errors.push('matrix: srcset descriptor не совпадает с width в URL');
      continue;
    }
    if (urls.has(url) || widths.has(urlWidth)) {
      errors.push('matrix: srcset повтор URL либо width');
      continue;
    }
    urls.add(url);
    widths.add(urlWidth);
    const base = `/media/${url.slice(`/media/_w/${urlWidth}/`.length)}`;
    const entry = manifest[base];
    if (!isRasterManifestEntry(entry) || !(entry.widths ?? []).includes(Number(urlWidth))) {
      errors.push('matrix: srcset width нет в media manifest');
      continue;
    }
    if (!fileExists(url)) errors.push('matrix: srcset отсутствует derivative file');
  }
}

function isValidDatetime(value: string): boolean {
  if (!DATETIME_RE.test(value)) return false;
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return !Number.isNaN(parsed);
}

export function validateClosedMatrixHtml(html: string, opts?: MatrixValidateOpts): string[] {
  const errors: string[] = [];
  const nodes: Node[] = [...iterateTags(html)].map((tag) => ({ tag, close: elementEnd(html, tag) }));
  const knownSinks = opts?.knownSinkIds ?? [];
  const manifest = opts?.mediaManifest ?? loadDefaultManifest();
  const fileExists = opts?.mediaFileExists ?? defaultMediaFileExists;

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
      if (tag.name === 'img' && name === 'src') {
        checkImgSrc(value, errors, manifest, fileExists);
      } else if (tag.name === 'img' && name === 'srcset') {
        checkSrcset(value, errors, manifest, fileExists);
      } else if (tag.name !== 'iframe' && (URL_ATTRS.has(name) || name === 'srcset')) {
        if (!isAllowedHref(value)) errors.push(`matrix: запрещённый URL в ${tag.name}[${name}]`);
      }
      if (name === 'dir' && !DIR_VALUES.has(value)) {
        errors.push(`matrix: dir только ltr|rtl|auto`);
      }
      if (name === 'lang' && !LANG_RE.test(value)) {
        errors.push(`matrix: невалидный lang`);
      }
      if ((name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan') && !INT_RE.test(value)) {
        errors.push(`matrix: ${name} должен быть положительным целым`);
      }
      if (name === 'datetime' && !isValidDatetime(value)) {
        errors.push('matrix: невалидный datetime');
      }
      if (name === 'loading' && tag.name === 'img' && value !== 'lazy' && value !== 'eager') {
        errors.push('matrix: img[loading] только lazy|eager');
      }
      if (name === 'decoding' && !['async', 'sync', 'auto'].includes(value)) {
        errors.push('matrix: img[decoding] только async|sync|auto');
      }
      if (name === 'scope' && !['row', 'col', 'rowgroup', 'colgroup'].includes(value)) {
        errors.push('matrix: th/td[scope] не из закрытого списка');
      }
      if (name === 'role' && !(value === 'region' && isTableScroll(tag))) {
        errors.push('matrix: role только region на .table-scroll');
      }
      if (name === 'tabindex' && !isTableScroll(tag)) {
        errors.push('matrix: tabindex только на .table-scroll');
      }
      if (name === 'tabindex' && isTableScroll(tag) && value !== '0') {
        errors.push('matrix: .table-scroll[tabindex] только 0');
      }

      if (name === 'data-safe-rich-content') {
        if (tag.name !== MARKER_WRAPPER) {
          errors.push('matrix: data-safe-rich-content только на root wrapper div');
        }
        if (ancestorHasMarker(nodes, node)) {
          errors.push('matrix: вложенный data-safe-rich-content');
        }
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
      if (tag.name === 'a' && name === 'target') {
        if (value !== '_blank') {
          errors.push('matrix: a[target] только _blank');
        } else {
          const rel = new Set((tag.attrs.rel ?? '').split(/\s+/).filter(Boolean));
          if (!rel.has('noopener') || !rel.has('noreferrer')) {
            errors.push('matrix: a[target=_blank] обязан содержать rel noopener noreferrer');
          }
        }
      }
      if (tag.name === 'a' && name === 'rel') {
        for (const token of value.split(/\s+/).filter(Boolean)) {
          if (token === 'opener') errors.push('matrix: a[rel] не должен содержать opener');
          if (!REL_TOKENS.has(token)) errors.push(`matrix: a[rel] неизвестный токен ${token}`);
        }
      }
    }
  }
  return errors;
}
