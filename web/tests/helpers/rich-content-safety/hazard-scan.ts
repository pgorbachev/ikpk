/**
 * Whole-document hazard scanner. Не использует runtime sanitizer/parser:
 * это test-owned обход фактического HTML документа.
 */
import { iterateTags } from './html-scan.js';
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
  'meta',
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

export function scanHtmlForHazards(html: string, opts?: { ignoreMarkedRegions?: boolean }): HazardHit[] {
  const hits: HazardHit[] = [];
  const marked = opts?.ignoreMarkedRegions ? stripMarkedRegions(html) : html;
  for (const tag of iterateTags(marked)) {
    for (const [name, value] of Object.entries(tag.attrs)) {
      if (name === 'srcdoc') {
        hits.push({ tag: tag.name, attr: name, value, reason: 'srcdoc' });
      }
      if (name.startsWith('on')) {
        hits.push({ tag: tag.name, attr: name, value, reason: 'event-handler' });
      }
      if (name.startsWith('xmlns:') || name.startsWith('xlink:') || name === 'xlink:href') {
        hits.push({ tag: tag.name, attr: name, value, reason: 'xml-xlink' });
      }
      if (URL_ATTRS.has(name) || name.endsWith(':href')) {
        const decoded = decodeURIComponent(safeDecode(value)).replace(/[\u0000-\u001F\u007F]/g, '').trim();
        const lower = decoded.toLowerCase();
        if (lower.startsWith('//')) {
          hits.push({ tag: tag.name, attr: name, value, reason: 'protocol-relative' });
        }
        for (const scheme of FORBIDDEN_URL_SCHEMES) {
          if (lower.startsWith(scheme) || lower.replace(/\s+/g, '').startsWith(scheme)) {
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

function stripMarkedRegions(html: string): string {
  return html.replace(
    /<([a-z0-9]+)([^>]*\bdata-safe-rich-content=)[\s\S]*?<\/\1>/gi,
    '',
  );
}

function safeDecode(value: string): string {
  try {
    return value.replace(/&amp;/g, '&').replace(/&#0*(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  } catch {
    return value;
  }
}

export interface OccurrenceRule {
  slotId: string;
  route: string;
  placement: string;
  identity: string;
  count: number;
}

export function matchOccurrences(
  html: string,
  route: string,
  rules: OccurrenceRule[],
): string[] {
  const errors: string[] = [];
  const routeRules = rules.filter((r) => r.route === route);
  const used = new Set<number>();
  for (const tag of iterateTags(html)) {
    if (!['script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'link'].includes(tag.name)) {
      continue;
    }
    if (tag.name === 'script' && (tag.attrs.type ?? '').split(';')[0].trim().toLowerCase() === 'application/ld+json') {
      continue;
    }
    const identity = [
      tag.name,
      ...Object.entries(tag.attrs).map(([k, v]) => `${k}=${v}`).sort(),
    ].join('|');
    const idx = routeRules.findIndex((r, i) => !used.has(i) && r.identity.split('|')[0] === tag.name);
    if (idx === -1) {
      errors.push(`${route}: нет occurrence rule для ${tag.name} (${identity.slice(0, 80)})`);
      continue;
    }
    used.add(idx);
  }
  return errors;
}
