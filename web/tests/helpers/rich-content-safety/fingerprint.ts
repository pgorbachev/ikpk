import { createHash } from 'node:crypto';
import {
  findElements,
  findSvgHits,
  iterateTags,
  splitDeclarations,
  visibleText,
} from './html-scan.js';

export interface SourceFingerprint {
  jsonPath: string;
  selectorId: string;
  entityId: string;
  byteLength: number;
  sha256: string;
  textHash: string;
  headings: string[];
  lists: string[];
  tables: string[];
  times: string[];
  links: { href: string; text: string }[];
  images: { src: string; srcset: string; alt: string; width: string; height: string }[];
  details: string[];
  checkboxes: { checked: boolean; disabled: boolean }[];
  markers: string[];
  rutube: string[];
  svgCount: number;
  mappedStyles: string[];
  mappedClasses: string[];
}

const MARKER_ATTRS = [
  'data-wrapped',
  'data-legacy-cta',
  'data-legacy-cta-unresolved',
  'data-safe-rich-content',
];

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function fingerprintHtml(
  html: string,
  meta: { jsonPath: string; selectorId: string; entityId: string },
): SourceFingerprint {
  const headings: string[] = [];
  const lists: string[] = [];
  const tables: string[] = [];
  const times: string[] = [];
  const links: SourceFingerprint['links'] = [];
  const images: SourceFingerprint['images'] = [];
  const details: string[] = [];
  const checkboxes: SourceFingerprint['checkboxes'] = [];
  const markers: string[] = [];
  const rutube: string[] = [];
  const mappedStyles: string[] = [];
  const mappedClasses: string[] = [];

  for (const h of findElements(html, 'h1')) headings.push(`h1:${visibleText(h.inner)}`);
  for (const h of findElements(html, 'h2')) headings.push(`h2:${visibleText(h.inner)}`);
  for (const h of findElements(html, 'h3')) headings.push(`h3:${visibleText(h.inner)}`);
  for (const h of findElements(html, 'h4')) headings.push(`h4:${visibleText(h.inner)}`);
  for (const h of findElements(html, 'h5')) headings.push(`h5:${visibleText(h.inner)}`);
  for (const h of findElements(html, 'h6')) headings.push(`h6:${visibleText(h.inner)}`);

  for (const li of findElements(html, 'li')) lists.push(visibleText(li.inner));
  for (const table of findElements(html, 'table')) tables.push(visibleText(table.outer));
  for (const time of findElements(html, 'time')) {
    times.push(time.tag.attrs.datetime ?? visibleText(time.inner));
  }
  for (const a of findElements(html, 'a')) {
    links.push({ href: a.tag.attrs.href ?? '', text: visibleText(a.inner) });
  }
  for (const img of findElements(html, 'img')) {
    images.push({
      src: img.tag.attrs.src ?? '',
      srcset: img.tag.attrs.srcset ?? '',
      alt: img.tag.attrs.alt ?? '',
      width: img.tag.attrs.width ?? '',
      height: img.tag.attrs.height ?? '',
    });
  }
  for (const d of findElements(html, 'details')) details.push(visibleText(d.outer));
  for (const input of findElements(html, 'input')) {
    if ((input.tag.attrs.type ?? '').toLowerCase() !== 'checkbox') continue;
    checkboxes.push({
      checked: 'checked' in input.tag.attrs,
      disabled: 'disabled' in input.tag.attrs,
    });
  }
  for (const iframe of findElements(html, 'iframe')) {
    const src = iframe.tag.attrs.src ?? '';
    if (/rutube\.ru\/play\/embed/i.test(src)) rutube.push(src);
  }

  for (const tag of iterateTags(html)) {
    for (const attr of MARKER_ATTRS) {
      if (attr in tag.attrs) markers.push(`${tag.name}[${attr}=${tag.attrs[attr]}]`);
    }
    const cls = tag.attrs.class ?? '';
    for (const token of cls.split(/\s+/).filter(Boolean)) {
      if (/^rc-(?:align|font|color|display|flex|gap|ml)-/.test(token)) {
        mappedClasses.push(token);
      }
    }
    if (/\btable-scroll\b/.test(cls)) markers.push(`${tag.name}.table-scroll`);
    if (/\blegacy-cta-unresolved\b/.test(cls)) markers.push(`${tag.name}.legacy-cta-unresolved`);
    if (tag.attrs.style) {
      for (const decl of splitDeclarations(tag.attrs.style)) {
        if (isMappedDeclaration(decl.property, decl.value)) {
          mappedStyles.push(`${decl.property}:${decl.value}`);
        }
      }
    }
  }

  const svgCount = findSvgHits(html).length;
  const text = visibleText(html);

  return {
    jsonPath: meta.jsonPath,
    selectorId: meta.selectorId,
    entityId: meta.entityId,
    byteLength: Buffer.byteLength(html, 'utf8'),
    sha256: sha(html),
    textHash: sha(text),
    headings,
    lists: lists.map((t) => sha(t).slice(0, 16)),
    tables: tables.map((t) => sha(t).slice(0, 16)),
    times,
    links,
    images,
    details: details.map((t) => sha(t).slice(0, 16)),
    checkboxes,
    markers,
    rutube,
    svgCount,
    mappedStyles,
    mappedClasses,
  };
}

export function isMappedDeclaration(property: string, value: string): boolean {
  const prop = property.trim().toLowerCase();
  const val = value.trim().toLowerCase().replace(/\s+/g, '');
  if (prop === 'text-align' && (val === 'center' || val === 'right')) return true;
  if (prop === 'font-size' && ['14px', '18px', '20px', '22px', 'inherit', 'var(--font-size-s)'].includes(val)) {
    return true;
  }
  if (prop === 'color' && val.length > 0) return true;
  if (prop === 'display' && val === 'flex') return true;
  if (prop === 'flex-direction' && val === 'column') return true;
  if (prop === 'gap' && val === '24px') return true;
  if (prop === 'margin-left' && val === '15px') return true;
  return false;
}

export function fingerprintHash(fp: SourceFingerprint): string {
  const { sha256, ...rest } = fp;
  return sha(`${sha256}:${JSON.stringify(rest)}`);
}
