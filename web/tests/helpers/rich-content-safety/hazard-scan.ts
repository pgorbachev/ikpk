/**
 * Whole-document hazard scanner. Не использует runtime sanitizer/parser:
 * это test-owned обход фактического HTML документа.
 */
import { createHash } from 'node:crypto';
import { elementEnd, iterateTags, type OpenTag } from './html-scan.js';
import {
  FORBIDDEN_URL_SCHEMES,
  NESTED_BROWSING_HAZARDS,
} from './closed-matrix.js';

export interface HazardHit {
  tag: string;
  attr: string;
  value: string;
  reason: string;
}

const EXECUTABLE_TAGS = new Set([
  'script',
  'style',
  'base',
  'link',
  'svg',
  'math',
  'template',
  ...NESTED_BROWSING_HAZARDS,
]);

const URL_ATTRS = new Set([
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'poster',
  'data',
  'xlink:href',
  'cite',
]);

/** Имена, которые occurrence registry обязан покрыть поштучно. */
export const OCCURRENCE_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'frame',
  'frameset',
  'base',
  'link',
  'svg',
  'math',
  'template',
] as const;

export type OccurrenceTag = (typeof OCCURRENCE_TAGS)[number];

export interface ProvenanceRule {
  /** Hash inner content в output identity (script/style). */
  body: boolean;
  /**
   * Security-relevant / identifying attrs after projection.
   * `*` — все projected non-directive attrs (svg/template).
   */
  attrs: readonly string[] | '*';
}

/** Явное правило source identity → output identity на каждый OCCURRENCE_TAGS. */
export const OCCURRENCE_PROVENANCE: Record<OccurrenceTag, ProvenanceRule> = {
  script: { body: true, attrs: ['src', 'type', 'integrity'] },
  style: { body: true, attrs: ['src', 'type'] },
  iframe: { body: false, attrs: ['src', 'srcdoc', 'sandbox', 'allow', 'referrerpolicy', 'name', 'title'] },
  object: { body: false, attrs: ['data', 'type', 'codebase', 'classid'] },
  embed: { body: false, attrs: ['src', 'type'] },
  frame: { body: false, attrs: ['src', 'srcdoc', 'name'] },
  frameset: { body: false, attrs: ['cols', 'rows'] },
  base: { body: false, attrs: ['href', 'target'] },
  link: { body: false, attrs: ['href', 'rel', 'as', 'type', 'integrity'] },
  svg: { body: false, attrs: '*' },
  math: { body: false, attrs: ['xmlns', 'display'] },
  template: { body: false, attrs: '*' },
};

function stripControls(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 32 && code !== 127) out += value[i];
  }
  return out;
}

function sha16(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function scanHtmlForHazards(html: string, opts?: { ignoreMarkedRegions?: boolean }): HazardHit[] {
  const hits: HazardHit[] = [];
  const marked = opts?.ignoreMarkedRegions ? stripMarkedRegions(html) : html;
  for (const tag of iterateTags(marked)) {
    const httpEquiv = (tag.attrs['http-equiv'] ?? '').toLowerCase();
    if (tag.name === 'meta' && httpEquiv === 'refresh') {
      hits.push({
        tag: 'meta',
        attr: 'http-equiv',
        value: tag.attrs.content ?? '',
        reason: 'refresh-meta',
      });
    }
    for (const [name, value] of Object.entries(tag.attrs)) {
      if (name === 'srcdoc') {
        hits.push({ tag: tag.name, attr: name, value, reason: 'srcdoc' });
      }
      if (name === 'contenteditable') {
        hits.push({ tag: tag.name, attr: name, value, reason: 'contenteditable' });
      }
      if (name.startsWith('on')) {
        hits.push({ tag: tag.name, attr: name, value, reason: 'event-handler' });
      }
      if (name.startsWith('xmlns:') || name.startsWith('xlink:') || name === 'xlink:href') {
        hits.push({ tag: tag.name, attr: name, value, reason: 'xml-xlink' });
      }
      if (URL_ATTRS.has(name) || name.endsWith(':href')) {
        let decoded = stripControls(safeDecode(value)).trim();
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          /* malformed percent-encoding остаётся как есть */
        }
        const lower = decoded.toLowerCase().replace(/\s+/g, '');
        if (lower.startsWith('//')) {
          hits.push({ tag: tag.name, attr: name, value, reason: 'protocol-relative' });
        }
        for (const scheme of FORBIDDEN_URL_SCHEMES) {
          if (lower.startsWith(scheme)) {
            hits.push({ tag: tag.name, attr: name, value, reason: `forbidden-scheme:${scheme}` });
          }
        }
      }
    }
    if (EXECUTABLE_TAGS.has(tag.name)) {
      if (tag.name === 'script' && (tag.attrs.type ?? '').split(';')[0].trim().toLowerCase() === 'application/ld+json') {
        continue;
      }
      if (tag.name === 'iframe' && isExactRutube(tag.attrs.src ?? '')) continue;
      hits.push({
        tag: tag.name,
        attr: '',
        value: tag.attrs.src ?? tag.attrs.href ?? '',
        reason: `executable-or-nested:${tag.name}`,
      });
    }
  }
  return hits;
}

function isExactRutube(src: string): boolean {
  return /^https:\/\/rutube\.ru\/play\/embed\/[A-Za-z0-9_-]+\/$/.test(src);
}

export function stripMarkedRegions(html: string): string {
  const ranges: [number, number][] = [];
  for (const tag of iterateTags(html)) {
    if (!tag.attrs['data-safe-rich-content']) continue;
    const end = elementEnd(html, tag);
    const nested = ranges.some(([start, close]) => tag.start >= start && end <= close);
    if (nested) continue;
    ranges.push([tag.start, end]);
  }
  ranges.sort((a, b) => b[0] - a[0]);
  let out = html;
  for (const [start, end] of ranges) out = `${out.slice(0, start)}${out.slice(end)}`;
  return out;
}

export interface MarkedRegion {
  sinkId: string;
  outer: string;
}

export function extractMarkedRegions(html: string): MarkedRegion[] {
  const regions: MarkedRegion[] = [];
  for (const tag of iterateTags(html)) {
    const sinkId = tag.attrs['data-safe-rich-content'];
    if (!sinkId) continue;
    const end = elementEnd(html, tag);
    regions.push({ sinkId, outer: html.slice(tag.start, end) });
  }
  return regions;
}

function safeDecode(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&#0*(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export interface OccurrenceRule {
  slotId: string;
  route: string;
  placement: string;
  identity: string;
  count: number;
}

export interface FoundOccurrence {
  identity: string;
  placement: string;
  tag: string;
}

export function occurrenceIdentity(tag: OpenTag, inner: string): string {
  const attrs = Object.entries(tag.attrs)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const parts = [tag.name, ...attrs];
  const rule = OCCURRENCE_PROVENANCE[tag.name as OccurrenceTag];
  if (rule?.body) {
    parts.push(`body:${sha16(inner)}`);
  }
  return parts.join('|');
}

export function collectOccurrences(html: string): FoundOccurrence[] {
  const found: FoundOccurrence[] = [];
  let index = 0;
  for (const tag of iterateTags(html)) {
    if (!(OCCURRENCE_TAGS as readonly string[]).includes(tag.name)) continue;
    if (tag.name === 'script' && (tag.attrs.type ?? '').split(';')[0].trim().toLowerCase() === 'application/ld+json') {
      continue;
    }
    const end = elementEnd(html, tag);
    const close = tag.selfClosing ? 0 : `</${tag.name}>`.length;
    const inner = html.slice(tag.end, end - close);
    const nearestId = nearestPrecedingId(html, tag.start);
    found.push({
      tag: tag.name,
      identity: occurrenceIdentity(tag, inner),
      placement: nearestId ? `after:#${nearestId}` : `doc-order:${index}:${tag.name}`,
    });
    index += 1;
  }
  return found;
}

const AST_ATTR_KIND = /^(quoted|empty|expression|template|shorthand)$/;
const ASTRO_DIRECTIVE = /^(is|set|define|client|class|style|animate):/;

export interface ProjectedIdentity {
  tag: string;
  body: string | null;
  staticAttrs: Map<string, string>;
  dynamicNames: Set<string>;
  /** `name → "expression:mapSrc"` / `"template:..."`. */
  dynamicAttrs: Map<string, string>;
}

const SECURITY_URL_ATTRS = new Set([
  'href',
  'src',
  'srcdoc',
  'srcset',
  'data',
  'poster',
  'action',
  'formaction',
  'cite',
]);

export const MAP_IFRAME_SRC = `https://yandex.ru/map-widget/v1/?text=${encodeURIComponent('Санкт-Петербург, Новочеркасский пр-т, д. 22/15, Лит А, помещение 4Н')}&z=16`;
export const TEST_MAP_B_SRC = 'https://yandex.ru/map-widget/v1/?text=other&z=1';

export type DynamicAttrProjection = { exact: string } | { pattern: RegExp };

/**
 * Test-owned source-slot → output projection для security-relevant dynamic attrs.
 * Отсутствие записи — fail-closed, а не «достаточно присутствия атрибута».
 */
export const DYNAMIC_ATTR_PROJECTION: Record<string, DynamicAttrProjection> = {
  'src=expression:mapSrc': { exact: MAP_IFRAME_SRC },
  'src=expression:testMapB': { exact: TEST_MAP_B_SRC },
  'href=expression:canonicalURL.href': { pattern: /^https:\/\/ikpk\.su(?:\/.*)?$/ },
};

/**
 * Test-owned проекция source AST identity (`name=kind:value`) и output identity
 * (`name=value`) в сравнимые tag/body/security-relevant attrs.
 */
export function projectIdentity(identity: string): ProjectedIdentity {
  const parts = identity.split('|');
  const tag = parts[0] ?? '';
  let body: string | null = null;
  const staticAttrs = new Map<string, string>();
  const dynamicNames = new Set<string>();
  const dynamicAttrs = new Map<string, string>();
  for (const part of parts.slice(1)) {
    if (part.startsWith('body:')) {
      body = part;
      continue;
    }
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).toLowerCase();
    if (ASTRO_DIRECTIVE.test(name)) continue;
    const rest = part.slice(eq + 1);
    const colon = rest.indexOf(':');
    const kind = colon === -1 ? '' : rest.slice(0, colon);
    if (AST_ATTR_KIND.test(kind)) {
      const value = rest.slice(colon + 1);
      if (kind === 'expression' || kind === 'template') {
        dynamicNames.add(name);
        dynamicAttrs.set(name, `${kind}:${value}`);
      } else {
        staticAttrs.set(name, value);
      }
    } else {
      staticAttrs.set(name, rest);
    }
  }
  return { tag, body, staticAttrs, dynamicNames, dynamicAttrs };
}

function projectionError(name: string, sourceKey: string, outVal: string | undefined): string | null {
  const projection = DYNAMIC_ATTR_PROJECTION[sourceKey];
  if (!projection) {
    return `dynamic attr ${name} (${sourceKey}) без test-owned projection`;
  }
  if (outVal === undefined) {
    return `dynamic attr ${name} отсутствует в output identity`;
  }
  if ('exact' in projection && outVal !== projection.exact) {
    return `dynamic attr ${name} output ${outVal} ≠ projected ${projection.exact}`;
  }
  if ('pattern' in projection && !projection.pattern.test(outVal)) {
    return `dynamic attr ${name} output ${outVal} не проходит projection constraint`;
  }
  return null;
}

export function provenanceError(sourceIdentity: string, outputIdentity: string): string | null {
  const source = projectIdentity(sourceIdentity);
  const output = projectIdentity(outputIdentity);
  if (source.tag !== output.tag) {
    return `tag=${source.tag} ≠ output ${output.tag}`;
  }
  const rule = OCCURRENCE_PROVENANCE[source.tag as OccurrenceTag];
  if (!rule) return `нет provenance rule для ${source.tag}`;
  if (rule.body && source.body !== output.body) {
    return `source body identity ${source.body ?? '∅'} ≠ output ${output.body ?? '∅'}`;
  }
  const names = rule.attrs === '*'
    ? new Set([...source.staticAttrs.keys(), ...source.dynamicNames, ...output.staticAttrs.keys(), ...output.dynamicNames])
    : new Set(rule.attrs);
  for (const name of names) {
    const srcVal = source.staticAttrs.get(name);
    const outVal = output.staticAttrs.get(name);
    const srcDyn = source.dynamicNames.has(name);
    const outDyn = output.dynamicNames.has(name);
    if (srcVal !== undefined && srcVal !== outVal) {
      return `attr ${name}=${srcVal} ≠ output ${outVal ?? '∅'}`;
    }
    if (srcDyn && SECURITY_URL_ATTRS.has(name)) {
      const sourceKey = `${name}=${source.dynamicAttrs.get(name)}`;
      const mismatch = projectionError(name, sourceKey, outVal);
      if (mismatch) return mismatch;
      continue;
    }
    if (srcDyn && outVal === undefined && !outDyn) {
      return `dynamic attr ${name} отсутствует в output identity`;
    }
  }
  return null;
}

function nearestPrecedingId(html: string, before: number): string | null {
  let last: string | null = null;
  for (const tag of iterateTags(html.slice(0, before))) {
    if (tag.attrs.id) last = tag.attrs.id;
  }
  return last;
}

/**
 * Сопоставляет найденные executable-узлы правилам по существующему slotId,
 * полной identity, точному placement и count. Неиспользованные правила маршрута
 * и лишние узлы — ошибки. placement="*" запрещён.
 */
export function matchOccurrences(
  html: string,
  route: string,
  rules: OccurrenceRule[],
  sourceSlots: { slotId: string; identity: string }[],
  opts?: { ignoreMarkedRegions?: boolean },
): string[] {
  const errors: string[] = [];
  const subject = opts?.ignoreMarkedRegions ? stripMarkedRegions(html) : html;
  const found = collectOccurrences(subject);
  const used = new Set<number>();
  const routeRules = rules.filter((r) => r.route === route);
  const slotsById = new Map(sourceSlots.map((s) => [s.slotId, s]));

  for (const rule of routeRules) {
    if (rule.placement === '*') {
      errors.push(`${route}: rule ${rule.slotId} placement="*" запрещён, нужен точный anchor`);
      continue;
    }
    const slot = slotsById.get(rule.slotId);
    if (!slot) {
      errors.push(`${route}: rule ${rule.slotId} нет в committed source-slot registry`);
      continue;
    }
    const mismatch = provenanceError(slot.identity, rule.identity);
    if (mismatch) {
      errors.push(`${route}: rule ${rule.slotId} source identity не проецируется в output: ${mismatch}`);
      continue;
    }
    const matches: number[] = [];
    for (let i = 0; i < found.length; i += 1) {
      if (used.has(i)) continue;
      const node = found[i];
      if (node.identity !== rule.identity) continue;
      if (node.placement !== rule.placement) continue;
      matches.push(i);
    }
    if (matches.length < rule.count) {
      errors.push(
        `${route}: rule ${rule.slotId} identity=${rule.identity.slice(0, 60)} placement=${rule.placement} ожидал count=${rule.count}, получил ${matches.length}`,
      );
    }
    const consume = matches.slice(0, rule.count);
    for (const i of consume) used.add(i);
  }

  for (let i = 0; i < found.length; i += 1) {
    if (used.has(i)) continue;
    errors.push(`${route}: нет occurrence rule для ${found[i].tag} (${found[i].identity.slice(0, 80)}) placement=${found[i].placement}`);
  }
  return errors;
}

/** Канонический маршрут страницы из пути html-файла dist (`/statyi/foo`, не `.../index.html`). */
export function htmlFileRoute(file: string, root: string): string {
  const rel = file.slice(root.length).replace(/\\/g, '/').replace(/\/index\.html$/, '');
  const trimmed = rel.replace(/^\//, '');
  return trimmed ? `/${trimmed}` : '/';
}

/** Hazard-ы, которые occurrence registry не покрывает и нельзя отфильтровывать. */
export function unmarkedDocumentHazards(html: string): HazardHit[] {
  return scanHtmlForHazards(html, { ignoreMarkedRegions: true }).filter((h) => {
    if (h.reason === 'refresh-meta') return true;
    if (h.reason === 'event-handler' || h.reason === 'srcdoc' || h.reason === 'xml-xlink') return true;
    if (h.reason === 'contenteditable') return true;
    if (h.reason.startsWith('forbidden-scheme') || h.reason === 'protocol-relative') return true;
    if (h.reason === 'executable-or-nested:frame' || h.reason === 'executable-or-nested:frameset') return true;
    if (h.reason === 'executable-or-nested:object' || h.reason === 'executable-or-nested:embed') return true;
    return false;
  });
}
