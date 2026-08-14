/**
 * Fail-closed rich-HTML sanitizer: parse5 tree-construction, closed allowlist,
 * two terminal trust modes. Runtime authentication of SafeRichHtml lives in
 * html-cleaner.ts (module-private WeakSet, not an exported factory).
 *
 * Test oracle MUST NOT import this module. Chromium oracle uses Playwright DOMParser.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment, serialize, defaultTreeAdapter as T } from 'parse5';
import { html as parse5Html } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import manifestJson from './media-manifest.json';

type Element = DefaultTreeAdapterMap['element'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Attribute = { name: string; value: string; namespace?: string; prefix?: string };

function resolveWebRoot(): string {
  const fromCwd = process.cwd();
  if (existsSync(join(fromCwd, 'src', 'lib', 'media-manifest.json'))) return fromCwd;
  const fromModule = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (existsSync(join(fromModule, 'src', 'lib', 'media-manifest.json'))) return fromModule;
  return fromCwd;
}
const MANIFEST = manifestJson as Record<string, { width?: number; height?: number; widths?: number[] }>;

export const BYTE_LIMIT = 2_097_152;
export const NODE_LIMIT = 50_000;
export const DEPTH_LIMIT = 256;

const KNOWN_REMOTE_UPLOAD =
  'https://ikpk.su/api/upload/file/0acd713c-1477-4c6c-93ad-1596d2a17304';
const LOCAL_UPLOAD_WEBP = '/media/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp';

const ALLOWED = new Set([
  'p', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'section', 'article',
  'aside', 'address', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'details', 'summary',
  'strong', 'b', 'em', 'i', 'u', 's', 'sup', 'sub', 'code', 'pre', 'blockquote',
  'a', 'img', 'figure', 'figcaption', 'time', 'label', 'input', 'table', 'caption',
  'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'iframe',
]);

const DISCARD = new Set([
  'script', 'style', 'object', 'embed', 'svg', 'math', 'template', 'base', 'meta', 'link',
  'frame', 'frameset', 'applet', 'noscript', 'noframes',
]);

const GLOBAL_ATTRS = new Set(['id', 'class', 'title', 'lang', 'dir']);
const RESERVED_ATTRS = new Set([
  'data-wrapped',
  'data-legacy-cta',
  'data-legacy-cta-unresolved',
  'data-safe-rich-content',
]);
const RESERVED_CLASSES = new Set(['table-scroll', 'legacy-cta-unresolved']);
const REL_TOKENS = new Set(['nofollow', 'noopener', 'noreferrer', 'sponsored', 'ugc']);
const DIR_VALUES = new Set(['ltr', 'rtl', 'auto']);
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const INT_RE = /^[1-9]\d*$/;
const RUTUBE_SRC_RE = /^https:\/\/rutube\.ru\/play\/embed\/[A-Za-z0-9_-]+\/$/;
const MEDIA_SRC_RE = /^\/media\/(?!_w\/).+\.(webp|png|jpg|jpeg)$/i;
const SRCSET_CANDIDATE_RE = /^(\/media\/_w\/(\d+)\/\S+) (\d+)w$/;
const RASTER_EXT_RE = /\.(webp|png|jpg|jpeg)$/i;
const ORACLE_BASE = 'https://oracle.test/page';

const RUTUBE_ATTRS = {
  sandbox: 'allow-scripts allow-same-origin allow-presentation',
  allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
  referrerpolicy: 'no-referrer',
  loading: 'lazy',
  title: 'Видео RUTUBE',
} as const;

const FONT: Record<string, string> = {
  '14px': 'rc-font-14',
  '18px': 'rc-font-18',
  '20px': 'rc-font-20',
  '22px': 'rc-font-22',
  inherit: 'rc-font-inherit',
  'var(--font-size-s)': 'rc-font-s',
};

export type TrustMode = 'untrusted' | 'authenticated';

export interface SanitizeContext {
  sourceType: string;
  sourceId: string;
}

export class RichHtmlResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RichHtmlResourceError';
  }
}

function fail(ctx: SanitizeContext, reason: string): never {
  throw new RichHtmlResourceError(
    `Недопустимый rich HTML (${reason}) для тип=${ctx.sourceType} ID=${ctx.sourceId}`,
  );
}

function tagName(el: Element): string {
  return T.getTagName(el).toLowerCase();
}

function attrMap(el: Element): Map<string, string> {
  const map = new Map<string, string>();
  for (const attr of T.getAttrList(el)) {
    map.set(attr.name.toLowerCase(), attr.value);
  }
  return map;
}

function setAttrs(el: Element, attrs: Attribute[]): void {
  el.attrs = attrs;
}

function classSet(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

function rewriteKnownRemote(value: string): string {
  return value.split(KNOWN_REMOTE_UPLOAD).join(LOCAL_UPLOAD_WEBP);
}

export function assertByteLimit(html: string, ctx: SanitizeContext): void {
  if (Buffer.byteLength(html, 'utf8') > BYTE_LIMIT) {
    fail(ctx, 'превышен лимит байт 2MiB');
  }
}

function countAndDepth(node: ParentNode): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const walk = (current: ParentNode, d: number): void => {
    for (const child of T.getChildNodes(current)) {
      nodes += 1;
      const next = T.isElementNode(child) ? d + 1 : d;
      if (next > depth) depth = next;
      if (T.isElementNode(child)) walk(child, next);
    }
  };
  walk(node, 0);
  return { nodes, depth };
}

export function assertTreeLimits(html: string, ctx: SanitizeContext): DefaultTreeAdapterMap['documentFragment'] {
  const tree = parseFragment(html);
  const { nodes, depth } = countAndDepth(tree);
  if (nodes > NODE_LIMIT) fail(ctx, 'превышен лимит узлов 50000');
  if (depth > DEPTH_LIMIT) fail(ctx, 'превышена глубина 256');
  return tree;
}

function colorClass(value: string): string {
  const id = createHash('sha256').update(value.trim()).digest('hex').slice(0, 8);
  return `rc-color-${id}`;
}

function replacementForDeclaration(property: string, value: string): string | null {
  const prop = property.trim().toLowerCase();
  const val = value.trim().toLowerCase().replace(/\s+/g, '');
  if (prop === 'text-align' && val === 'center') return 'rc-align-center';
  if (prop === 'text-align' && val === 'right') return 'rc-align-right';
  if (prop === 'font-size' && FONT[val]) return FONT[val];
  if (prop === 'color' && value.trim()) return colorClass(value.trim());
  if (prop === 'display' && val === 'flex') return 'rc-display-flex';
  if (prop === 'flex-direction' && val === 'column') return 'rc-flex-column';
  if (prop === 'gap' && val === '24px') return 'rc-gap-24';
  if (prop === 'margin-left' && val === '15px') return 'rc-ml-15';
  return null;
}

function splitDeclarations(style: string): { property: string; value: string }[] {
  return style
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(':');
      if (idx === -1) return { property: part.trim().toLowerCase(), value: '' };
      return {
        property: part.slice(0, idx).trim().toLowerCase(),
        value: part.slice(idx + 1).trim(),
      };
    })
    .filter((d) => d.property);
}

function migrateStyleClasses(style: string): string[] {
  const classes: string[] = [];
  for (const decl of splitDeclarations(style)) {
    const cls = replacementForDeclaration(decl.property, decl.value);
    if (cls) classes.push(cls);
  }
  return classes;
}

function isLocalDocumentUrl(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || /^https?:/i.test(trimmed) || trimmed.startsWith('//')) return false;
  return /\.pdf($|[?#])/i.test(trimmed) || /\/media\/.*\.pdf($|[?#])/i.test(trimmed);
}

function visibleText(parent: ParentNode, skip?: ChildNode): string {
  let text = '';
  for (const child of T.getChildNodes(parent)) {
    if (child === skip) continue;
    if (T.isTextNode(child)) text += T.getTextNodeContent(child);
    else if (T.isElementNode(child) && tagName(child) === 'svg') continue;
    else if (T.isElementNode(child)) text += visibleText(child);
  }
  return text.replace(/\s+/g, ' ').trim();
}

function unwrap(el: Element): void {
  const parent = T.getParentNode(el);
  if (!parent) {
    T.detachNode(el);
    return;
  }
  const children = [...T.getChildNodes(el)];
  for (const child of children) {
    T.insertBefore(parent, child, el);
  }
  T.detachNode(el);
}

function parentElement(node: ChildNode): Element | null {
  const parent = T.getParentNode(node);
  if (!parent || parent.nodeName === '#document-fragment' || parent.nodeName === '#document') return null;
  return parent as Element;
}

function firstElementChild(el: Element): Element | null {
  for (const child of T.getChildNodes(el)) {
    if (T.isElementNode(child)) return child;
  }
  return null;
}

function hasClass(el: Element, token: string): boolean {
  return classSet(attrMap(el).get('class')).includes(token);
}

function isTableScroll(el: Element): boolean {
  const attrs = attrMap(el);
  return tagName(el) === 'div'
    && classSet(attrs.get('class')).includes('table-scroll')
    && attrs.get('role') === 'region'
    && attrs.get('tabindex') === '0';
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
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function rawCanonical(value: string): string {
  return stripControls(decodeEntities(value)).trim();
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function specialUrl(value: string): string {
  return rawCanonical(value).replace(/\\/g, '/');
}

function schemeProbe(value: string): string {
  return percentDecode(specialUrl(value)).toLowerCase().replace(/\s+/g, '');
}

function parseBrowserUrl(value: string): URL | null {
  const special = specialUrl(value);
  if (!special) return null;
  try {
    return new URL(special, ORACLE_BASE);
  } catch {
    return null;
  }
}

function forbiddenUrl(value: string): boolean {
  const probe = schemeProbe(value);
  if (probe.startsWith('//')) return true;
  return ['javascript:', 'vbscript:', 'file:', 'data:'].some((scheme) => probe.startsWith(scheme));
}

function isAllowedHref(value: string): boolean {
  const special = specialUrl(value);
  if (!special) return false;
  if (forbiddenUrl(value)) return false;
  const probe = schemeProbe(value);
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    if (!['http', 'https', 'mailto', 'tel'].includes(scheme)) return false;
    if (scheme === 'http' || scheme === 'https') {
      const parsed = parseBrowserUrl(value);
      if (!parsed || parsed.username || parsed.password) return false;
    }
    return true;
  }
  const parsed = parseBrowserUrl(value);
  if (!parsed) return false;
  return parsed.origin === new URL(ORACLE_BASE).origin;
}

function isRasterEntry(entry: { width?: number; height?: number } | undefined): boolean {
  return Boolean(
    entry
    && typeof entry.width === 'number'
    && entry.width > 0
    && Number.isInteger(entry.width)
    && typeof entry.height === 'number'
    && entry.height > 0
    && Number.isInteger(entry.height),
  );
}

function mediaFileExists(urlPath: string): boolean {
  const webRoot = resolveWebRoot();
  const repoRoot = join(webRoot, '..');
  const rel = urlPath.replace(/^\//, '');
  if (existsSync(join(webRoot, 'public', rel))) return true;
  if (urlPath.startsWith('/media/_w/')) {
    const variantsDir = join(webRoot, 'public', 'media', '_w');
    const match = /^\/media\/_w\/(\d+)\/(.+)$/.exec(urlPath);
    if (!match) return false;
    if (existsSync(variantsDir)) return false;
    return existsSync(join(repoRoot, 'media-originals', match[2]));
  }
  return existsSync(join(repoRoot, 'media-originals', urlPath.replace(/^\/media\//, '')));
}

function looksLocal(candidateUrl: string): boolean {
  const raw = specialUrl(candidateUrl);
  if (!raw) return false;
  if (raw.startsWith('//')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
  return true;
}

type SrcsetVerdict = 'keep' | 'strip' | 'broken-local';

function classifySrcset(srcset: string, ctx: SanitizeContext): { verdict: SrcsetVerdict; kept?: string } {
  const parts = srcset.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { verdict: 'strip' };
  const urls = new Set<string>();
  const widths = new Set<string>();
  let broken = false;
  let strip = false;
  const kept: string[] = [];
  for (const part of parts) {
    const match = SRCSET_CANDIDATE_RE.exec(part);
    if (!match) {
      const tokens = part.trim().split(/\s+/);
      const url = tokens[0] ?? '';
      const descriptor = tokens[1] ?? '';
      const localAbs = looksLocal(url) && (url.startsWith('/') || url.startsWith('.') || url.startsWith('../'));
      const wDescriptor = /^\d+w$/.test(descriptor);
      if (localAbs && wDescriptor) {
        broken = true;
      } else {
        strip = true;
      }
      continue;
    }
    const [, url, urlWidth, descriptorWidth] = match;
    if (urlWidth !== descriptorWidth) {
      broken = true;
      continue;
    }
    if (urls.has(url) || widths.has(urlWidth)) {
      strip = true;
      continue;
    }
    urls.add(url);
    widths.add(urlWidth);
    const base = `/media/${url.slice(`/media/_w/${urlWidth}/`.length)}`;
    const entry = MANIFEST[base];
    if (!isRasterEntry(entry) || !(entry.widths ?? []).includes(Number(urlWidth)) || !mediaFileExists(url)) {
      broken = true;
      continue;
    }
    kept.push(part);
  }
  if (broken) {
    fail(ctx, 'broken-local media srcset');
  }
  if (strip || kept.length === 0) return { verdict: 'strip' };
  return { verdict: 'keep', kept: kept.join(', ') };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function yearNumber(raw: string): number | null {
  if (!/^\d{4,}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1 ? year : null;
}

function monthNumber(raw: string): number | null {
  if (!/^\d{2}$/.test(raw)) return null;
  const month = Number(raw);
  return month >= 1 && month <= 12 ? month : null;
}

function validCalendarDate(year: number, month: number, dayRaw: string): boolean {
  if (!/^\d{2}$/.test(dayRaw)) return false;
  const day = Number(dayRaw);
  return day >= 1 && day <= daysInMonth(year, month);
}

function validTimeString(raw: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(raw);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  return hour <= 23 && minute <= 59 && second <= 59;
}

function validTimeZoneOffset(raw: string): boolean {
  if (raw === 'Z') return true;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(raw);
  if (!match) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return false;
  return match[1] !== '-' || hours !== 0 || minutes !== 0;
}

function validDateString(raw: string): boolean {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;
  const year = yearNumber(match[1]);
  const month = monthNumber(match[2]);
  return year !== null && month !== null && validCalendarDate(year, month, match[3]);
}

function isoWeeksInYear(year: number): number {
  const p = (y: number) => (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400)) % 7;
  return p(year) === 4 || p(year - 1) === 3 ? 53 : 52;
}

function isWs(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isValidDuration(value: string): boolean {
  if (/^P/.test(value)) {
    return /^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d{1,3})?S)?)?$/.test(value);
  }
  let pos = 0;
  const seen = new Set<string>();
  const skipWs = () => {
    while (pos < value.length && isWs(value[pos])) pos += 1;
  };
  skipWs();
  if (pos >= value.length) return false;
  let components = 0;
  while (pos < value.length) {
    skipWs();
    if (pos >= value.length) break;
    const numStart = pos;
    while (pos < value.length && value[pos] >= '0' && value[pos] <= '9') pos += 1;
    if (pos === numStart) return false;
    if (value[pos] === '.') {
      pos += 1;
      const fracStart = pos;
      while (pos < value.length && value[pos] >= '0' && value[pos] <= '9') pos += 1;
      if (pos - fracStart < 1 || pos - fracStart > 3) return false;
      skipWs();
      if (pos >= value.length || value[pos].toLowerCase() !== 's' || seen.has('s')) return false;
      seen.add('s');
      pos += 1;
      components += 1;
      continue;
    }
    skipWs();
    if (pos >= value.length) return false;
    const unit = value[pos].toLowerCase();
    if (!'wdhms'.includes(unit) || seen.has(unit)) return false;
    seen.add(unit);
    pos += 1;
    components += 1;
  }
  return components > 0;
}

function isValidDatetime(value: string): boolean {
  if (!value) return false;
  if (yearNumber(value) !== null) return true;
  const month = /^(\d{4,})-(\d{2})$/.exec(value);
  if (month) return yearNumber(month[1]) !== null && monthNumber(month[2]) !== null;
  if (validDateString(value)) return true;
  const yearless = /^(?:--)?(\d{2})-(\d{2})$/.exec(value);
  if (yearless) {
    const monthNum = monthNumber(yearless[1]);
    return monthNum !== null && validCalendarDate(4, monthNum, yearless[2]);
  }
  if (validTimeString(value)) return true;
  const week = /^(\d{4,})-W(\d{2})$/.exec(value);
  if (week && yearNumber(week[1]) !== null) {
    const number = Number(week[2]);
    return number >= 1 && number <= isoWeeksInYear(Number(week[1]));
  }
  const local = /^(\d{4,}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (local) {
    return validDateString(local[1]) && validTimeString(local[2]) && (!local[3] || validTimeZoneOffset(local[3]));
  }
  if (value === 'Z' || validTimeZoneOffset(value)) return true;
  return isValidDuration(value);
}

function booleanValue(raw: string | undefined, name: string): boolean {
  if (raw === undefined) return false;
  const v = raw.toLowerCase();
  return v === '' || v === name;
}

function extraAllowed(tag: string): Set<string> {
  switch (tag) {
    case 'a':
      return new Set(['href', 'target', 'rel', 'aria-label', 'data-legacy-cta']);
    case 'img':
      return new Set(['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'aria-label']);
    case 'iframe':
      return new Set(['src', 'sandbox', 'allow', 'referrerpolicy', 'loading', 'title', 'allowfullscreen']);
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
  if (tag === 'input' || tag === 'iframe') return extraAllowed(tag);
  return new Set([...GLOBAL_ATTRS, ...extraAllowed(tag)]);
}

function handleDiscard(el: Element): void {
  if (tagName(el) === 'svg') {
    const parent = parentElement(el);
    if (parent && tagName(parent) === 'a' && visibleText(parent, el).length === 0) {
      const href = attrMap(parent).get('href') ?? '';
      const label = isLocalDocumentUrl(href) ? 'Скачать документ' : 'Открыть ссылку';
      T.insertTextBefore(parent, label, el);
    }
  }
  T.detachNode(el);
}

function rebuildIframe(el: Element, src: string): void {
  const children = [...T.getChildNodes(el)];
  for (const child of children) T.detachNode(child);
  setAttrs(el, [
    { name: 'src', value: src },
    { name: 'sandbox', value: RUTUBE_ATTRS.sandbox },
    { name: 'allow', value: RUTUBE_ATTRS.allow },
    { name: 'referrerpolicy', value: RUTUBE_ATTRS.referrerpolicy },
    { name: 'loading', value: RUTUBE_ATTRS.loading },
    { name: 'title', value: RUTUBE_ATTRS.title },
    { name: 'allowfullscreen', value: '' },
  ]);
}

function sanitizeImg(el: Element, ctx: SanitizeContext, mode: TrustMode): Attribute[] | null {
  const attrs = attrMap(el);
  const srcset = attrs.get('srcset');
  let srcsetKept: string | undefined;
  if (srcset) {
    const verdict = classifySrcset(srcset, ctx);
    if (verdict.verdict === 'keep' && verdict.kept) srcsetKept = verdict.kept;
  }
  let src = rewriteKnownRemote(attrs.get('src') ?? '');
  if (!src || forbiddenUrl(src)) return null;
  const raw = rawCanonical(src);
  const parsed = parseBrowserUrl(src);
  if (!MEDIA_SRC_RE.test(raw) || !RASTER_EXT_RE.test(raw)) {
    if (raw.startsWith('/') || raw.startsWith('../') || raw.startsWith('./')) {
      fail(ctx, 'неканонический локальный img src');
    }
    return null;
  }
  if (!parsed || parsed.origin !== new URL(ORACLE_BASE).origin || parsed.pathname !== raw) {
    if (raw.startsWith('/') || raw.startsWith('../') || raw.startsWith('./')) {
      fail(ctx, 'неканонический локальный img src');
    }
    return null;
  }
  const entry = MANIFEST[raw];
  if (!isRasterEntry(entry)) fail(ctx, `document/pdf img src для тип=${ctx.sourceType}`);
  if (!mediaFileExists(raw)) fail(ctx, 'отсутствует local asset');
  src = raw;
  const out: Attribute[] = [{ name: 'src', value: src }];
  if (srcsetKept) out.push({ name: 'srcset', value: srcsetKept });
  const sizes = attrs.get('sizes');
  if (sizes) out.push({ name: 'sizes', value: sizes });
  if (attrs.has('alt')) out.push({ name: 'alt', value: attrs.get('alt') ?? '' });
  const width = attrs.get('width');
  const height = attrs.get('height');
  if (width && INT_RE.test(width)) out.push({ name: 'width', value: width });
  else if (entry.width) out.push({ name: 'width', value: String(entry.width) });
  if (height && INT_RE.test(height)) out.push({ name: 'height', value: String(entry.height) });
  else if (entry.height) out.push({ name: 'height', value: String(entry.height) });
  const loading = attrs.get('loading');
  if (loading === 'lazy' || loading === 'eager') out.push({ name: 'loading', value: loading });
  const decoding = attrs.get('decoding');
  if (decoding === 'async' || decoding === 'sync' || decoding === 'auto') {
    out.push({ name: 'decoding', value: decoding });
  }
  copyGlobal(attrs, out, el, mode);
  const aria = attrs.get('aria-label');
  if (aria) out.push({ name: 'aria-label', value: aria });
  return out;
}

function sanitizeAnchor(el: Element, mode: TrustMode): Attribute[] {
  const attrs = attrMap(el);
  const out: Attribute[] = [];
  let href = rewriteKnownRemote(attrs.get('href') ?? '');
  if (href && isAllowedHref(href)) {
    href = specialUrl(href);
    out.push({ name: 'href', value: href });
  }
  const target = attrs.get('target');
  const relTokens = (attrs.get('rel') ?? '').split(/\s+/).filter((t) => REL_TOKENS.has(t) && t !== 'opener');
  if (target === '_blank' && href) {
    out.push({ name: 'target', value: '_blank' });
    if (!relTokens.includes('noopener')) relTokens.push('noopener');
    if (!relTokens.includes('noreferrer')) relTokens.push('noreferrer');
  }
  if (relTokens.length) out.push({ name: 'rel', value: [...new Set(relTokens)].join(' ') });
  copyGlobal(attrs, out, el, mode);
  const aria = attrs.get('aria-label');
  if (aria) out.push({ name: 'aria-label', value: aria });
  if (
    mode === 'authenticated'
    && attrs.has('data-legacy-cta')
    && href
    && /^#[^#]/.test(href)
    && !forbiddenUrl(href)
  ) {
    out.push({ name: 'data-legacy-cta', value: '' });
  }
  return out;
}

function copyGlobal(attrs: Map<string, string>, out: Attribute[], el: Element, mode: TrustMode): void {
  const id = attrs.get('id');
  if (id) out.push({ name: 'id', value: id });
  const title = attrs.get('title');
  if (title) out.push({ name: 'title', value: title });
  const lang = attrs.get('lang');
  if (lang && LANG_RE.test(lang)) out.push({ name: 'lang', value: lang });
  const dir = attrs.get('dir');
  if (dir && DIR_VALUES.has(dir)) out.push({ name: 'dir', value: dir });
  const classes = new Set(classSet(attrs.get('class')));
  const style = attrs.get('style');
  if (style) for (const cls of migrateStyleClasses(style)) classes.add(cls);
  if (mode === 'untrusted') {
    for (const reserved of RESERVED_CLASSES) classes.delete(reserved);
  } else {
    if (classes.has('table-scroll') && !isTableScroll(el)) classes.delete('table-scroll');
    if (classes.has('legacy-cta-unresolved') && tagName(el) !== 'span') {
      classes.delete('legacy-cta-unresolved');
    }
  }
  if (classes.size) out.push({ name: 'class', value: [...classes].join(' ') });
}

function filterAttrs(el: Element, mode: TrustMode, ctx: SanitizeContext): void {
  const tag = tagName(el);
  const attrs = attrMap(el);
  if (tag === 'iframe') {
    const src = specialUrl(attrs.get('src') ?? '');
    if (RUTUBE_SRC_RE.test(src)) rebuildIframe(el, src);
    else T.detachNode(el);
    return;
  }
  if (tag === 'img') {
    const next = sanitizeImg(el, ctx, mode);
    if (!next) T.detachNode(el);
    else setAttrs(el, next);
    return;
  }
  if (tag === 'a') {
    setAttrs(el, sanitizeAnchor(el, mode));
    return;
  }
  if (tag === 'input') {
    if (attrs.get('type') !== 'checkbox') {
      unwrap(el);
      return;
    }
    const next: Attribute[] = [
      { name: 'type', value: 'checkbox' },
      { name: 'disabled', value: '' },
    ];
    if (attrs.has('checked') && booleanValue(attrs.get('checked'), 'checked')) {
      next.push({ name: 'checked', value: '' });
    }
    setAttrs(el, next);
    return;
  }

  const allowed = allowedNames(tag);
  const next: Attribute[] = [];
  copyGlobal(attrs, next, el, mode);

  for (const [name, value] of attrs) {
    if (name === 'class' || name === 'id' || name === 'title' || name === 'lang' || name === 'dir' || name === 'style') {
      continue;
    }
    if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') continue;
    if (name.includes(':') || name.startsWith('xmlns')) continue;
    if (mode === 'untrusted' && RESERVED_ATTRS.has(name)) continue;
    if (!allowed.has(name)) continue;

    if (name === 'datetime') {
      if (isValidDatetime(value)) next.push({ name, value });
      continue;
    }
    if (name === 'for' && tag === 'label') {
      next.push({ name, value });
      continue;
    }
    if ((name === 'colspan' || name === 'rowspan') && INT_RE.test(value)) {
      next.push({ name, value });
      continue;
    }
    if (name === 'scope' && ['row', 'col', 'rowgroup', 'colgroup'].includes(value)) {
      next.push({ name, value });
      continue;
    }
    if (name === 'headers') {
      next.push({ name, value });
      continue;
    }
    if (name === 'open' && booleanValue(value, 'open')) {
      next.push({ name, value: '' });
      continue;
    }
    if (name === 'aria-label' && (['a', 'img', 'figure', 'table'].includes(tag) || hasClass(el, 'table-scroll'))) {
      next.push({ name, value });
      continue;
    }
    if (
      (name === 'aria-labelledby' || name === 'aria-describedby')
      && ['section', 'article', 'aside', 'details', 'figure', 'table'].includes(tag)
    ) {
      next.push({ name, value });
      continue;
    }
    if (name === 'role' && value === 'region' && tag === 'div' && classSet(next.find((a) => a.name === 'class')?.value).includes('table-scroll')) {
      next.push({ name, value });
      continue;
    }
    if (name === 'tabindex' && value === '0' && tag === 'div' && classSet(next.find((a) => a.name === 'class')?.value).includes('table-scroll')) {
      next.push({ name, value });
      continue;
    }
    if (name === 'data-wrapped' && mode === 'authenticated' && tag === 'table') {
      const parent = parentElement(el);
      if (parent && isTableScroll(parent)) next.push({ name, value: '' });
      continue;
    }
    if (name === 'data-legacy-cta-unresolved' && mode === 'authenticated' && tag === 'span') {
      next.push({ name, value: '' });
      continue;
    }
  }

  if (mode === 'authenticated' && tag === 'div') {
    const classes = classSet(next.find((a) => a.name === 'class')?.value);
    if (classes.includes('table-scroll')) {
      const child = firstElementChild(el);
      const role = next.find((a) => a.name === 'role')?.value;
      const tab = next.find((a) => a.name === 'tabindex')?.value;
      if (!(child && tagName(child) === 'table' && attrMap(child).has('data-wrapped') && role === 'region' && tab === '0')) {
        const cls = next.find((a) => a.name === 'class');
        if (cls) {
          cls.value = classSet(cls.value).filter((t) => t !== 'table-scroll').join(' ');
          if (!cls.value) next.splice(next.indexOf(cls), 1);
        }
        const roleIdx = next.findIndex((a) => a.name === 'role');
        if (roleIdx >= 0) next.splice(roleIdx, 1);
        const tabIdx = next.findIndex((a) => a.name === 'tabindex');
        if (tabIdx >= 0) next.splice(tabIdx, 1);
      }
    }
  }
  if (mode === 'authenticated' && tag === 'span') {
    const classes = classSet(next.find((a) => a.name === 'class')?.value);
    if (classes.includes('legacy-cta-unresolved') && !next.some((a) => a.name === 'data-legacy-cta-unresolved')) {
      const cls = next.find((a) => a.name === 'class');
      if (cls) {
        cls.value = classSet(cls.value).filter((t) => t !== 'legacy-cta-unresolved').join(' ');
        if (!cls.value) next.splice(next.indexOf(cls), 1);
      }
    }
  }

  setAttrs(el, next);
}

function sanitizeChildren(parent: ParentNode, mode: TrustMode, ctx: SanitizeContext): void {
  const children = [...T.getChildNodes(parent)];
  for (const child of children) sanitizeNode(child, mode, ctx);
}

function sanitizeNode(node: ChildNode, mode: TrustMode, ctx: SanitizeContext): void {
  if (T.isCommentNode(node) || T.isDocumentTypeNode(node)) {
    T.detachNode(node);
    return;
  }
  if (!T.isElementNode(node)) return;
  const el = node;
  if (el.namespaceURI !== parse5Html.NS.HTML) {
    handleDiscard(el);
    return;
  }
  const tag = tagName(el);
  if (DISCARD.has(tag)) {
    handleDiscard(el);
    return;
  }
  if (!ALLOWED.has(tag)) {
    sanitizeChildren(el, mode, ctx);
    unwrap(el);
    return;
  }
  sanitizeChildren(el, mode, ctx);
  if (!T.getParentNode(el)) return;
  filterAttrs(el, mode, ctx);
}

function preScrub(tree: ParentNode): void {
  const walk = (parent: ParentNode): void => {
    for (const child of [...T.getChildNodes(parent)]) {
      if (!T.isElementNode(child)) continue;
      const attrs = T.getAttrList(child).filter((attr) => {
        const name = attr.name.toLowerCase();
        return !RESERVED_ATTRS.has(name);
      });
      const cls = attrs.find((a) => a.name.toLowerCase() === 'class');
      if (cls) {
        const kept = classSet(cls.value).filter((t) => !RESERVED_CLASSES.has(t));
        if (kept.length) cls.value = kept.join(' ');
        else {
          const idx = attrs.indexOf(cls);
          attrs.splice(idx, 1);
        }
      }
      child.attrs = attrs;
      walk(child);
    }
  };
  walk(tree);
}

export function terminalSanitize(html: string, mode: TrustMode, ctx: SanitizeContext = { sourceType: 'fragment', sourceId: 'unknown' }): string {
  assertByteLimit(html, ctx);
  const tree = assertTreeLimits(html, ctx);
  if (mode === 'untrusted') preScrub(tree);
  sanitizeChildren(tree, mode, ctx);
  const out = serialize(tree);
  assertByteLimit(out, ctx);
  return out;
}

export function sanitizeUntrustedTree(html: string, ctx: SanitizeContext): string {
  assertByteLimit(html, ctx);
  const tree = assertTreeLimits(html, ctx);
  preScrub(tree);
  return serialize(tree);
}
