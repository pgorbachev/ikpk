import { createHash } from 'node:crypto';
import { findSvgHits, isSvgOnlyNamingContent, iterateTags, splitDeclarations } from './html-scan.js';
import { isMappedDeclaration } from './fingerprint.js';
import type { StringHit } from './source-discovery.js';
import { matchJsonSelector } from './source-discovery.js';

export interface MigrationRow {
  selectorId: string;
  entityId: string;
  jsonPath: string;
  kind: 'svg' | 'style';
  context: string;
  sourceValue: string;
  replacementClass: string;
  replacementText: string;
  accessibleName: string;
  route: string;
}

const FONT: Record<string, string> = {
  '14px': 'rc-font-14',
  '18px': 'rc-font-18',
  '20px': 'rc-font-20',
  '22px': 'rc-font-22',
  inherit: 'rc-font-inherit',
  'var(--font-size-s)': 'rc-font-s',
};

function colorClass(value: string): string {
  const id = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `rc-color-${id}`;
}

export function replacementForDeclaration(property: string, value: string): string | null {
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

function isLocalDocumentUrl(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || /^https?:/i.test(trimmed) || trimmed.startsWith('//')) return false;
  return /\.pdf($|[?#])/i.test(trimmed) || /\/media\/.*\.pdf($|[?#])/i.test(trimmed);
}

export function routeForHit(
  hit: StringHit,
  lookup: {
    courseGroups: { legacy_id: string; slug: string; institute_legacy_id: string }[];
    seminars: { legacy_id: string; slug: string; course_group_legacy_id: string }[];
    teachers: { slug: string; institute_legacy_id: string; legacy_id: string }[];
  },
): string {
  const sel = matchJsonSelector(hit)?.id ?? '';
  const rec = hit.entityId;
  if (sel === 'articles[*].body_html') return `/statyi/${rec.split('/').pop() ?? rec}`;
  if (sel === 'institutes[*].description_html') return `/${rec}`;
  if (sel === 'course_groups[*].description_html') {
    const cg = lookup.courseGroups.find((c) => c.legacy_id === rec || c.slug === rec);
    return cg ? `/${cg.institute_legacy_id}/${cg.slug}` : 'source-only';
  }
  if (sel === 'seminars[*].description_html') {
    const seminar = lookup.seminars.find((s) => s.legacy_id === rec || s.slug === rec);
    if (!seminar) return 'source-only';
    const cg = lookup.courseGroups.find((c) => c.legacy_id === seminar.course_group_legacy_id);
    return cg ? `/${cg.institute_legacy_id}/${cg.slug}/${seminar.slug}` : 'source-only';
  }
  if (sel === 'static_pages[*].body_html') {
    const map: Record<string, string> = {
      homepage: '/',
      'aktsii-i-skidki': '/aktsii-i-skidki',
      kontakty: '/kontakty',
      oplata: '/oplata',
      'raspisanie-i-tseny': '/raspisanie-i-tseny',
      'sotrudnichestvo-s-nami': '/sotrudnichestvo-s-nami',
      statyi: '/statyi',
      'svedeniya-ob-obrazovatelnoy-organizatsii': '/svedeniya-ob-obrazovatelnoy-organizatsii',
      video: '/video',
    };
    const slug = rec.includes('/') ? rec.split('/').pop()! : rec;
    return map[slug] ?? 'source-only';
  }
  if (sel === 'teachers[*].bio_html') {
    const t = lookup.teachers.find((x) => x.legacy_id === rec || x.slug === rec);
    return t ? `/${t.institute_legacy_id}/prepodavatel/${t.slug}` : 'source-only';
  }
  if (sel === 'video_playlists[*].description_html') return 'source-only';
  if (sel === 'news[*].description') return '/';
  if (sel === 'promotions[*].description') return '/aktsii-i-skidki';
  if (sel === 'collapsible_panels.json') {
    const page = /^\$\["([^"]+)"\]/.exec(hit.jsonPath)?.[1];
    return page || 'source-only';
  }
  return 'source-only';
}

export function buildMigrationManifest(
  hits: StringHit[],
  lookup: Parameters<typeof routeForHit>[1],
): MigrationRow[] {
  const rows: MigrationRow[] = [];
  for (const hit of hits) {
    const sel = matchJsonSelector(hit);
    if (!sel) continue;
    const route = routeForHit(hit, lookup);
    const jsonPath = `${hit.file}${hit.jsonPath}`;

    for (const svg of findSvgHits(hit.value)) {
      const svgOnly = svg.insideAnchor ? isSvgOnlyNamingContent(svg.insideAnchor.inner) : false;
      let replacementText = '';
      let accessibleName = '';
      if (svgOnly && svg.insideAnchor) {
        replacementText = isLocalDocumentUrl(svg.insideAnchor.href)
          ? 'Скачать документ'
          : 'Открыть ссылку';
        accessibleName = replacementText;
      }
      rows.push({
        selectorId: sel.id,
        entityId: hit.entityId,
        jsonPath,
        kind: 'svg',
        context: svg.insideAnchor
          ? `a[href=${svg.insideAnchor.href}] svg-only=${svgOnly}`
          : 'decorative-or-block-svg',
        sourceValue: svg.html.slice(0, 200),
        replacementClass: '',
        replacementText,
        accessibleName,
        route,
      });
    }

    for (const tag of iterateTags(hit.value)) {
      if (!tag.attrs.style) continue;
      for (const decl of splitDeclarations(tag.attrs.style)) {
        if (!isMappedDeclaration(decl.property, decl.value)) continue;
        const cls = replacementForDeclaration(decl.property, decl.value);
        if (!cls) continue;
        rows.push({
          selectorId: sel.id,
          entityId: hit.entityId,
          jsonPath,
          kind: 'style',
          context: `${tag.name}[style]`,
          sourceValue: `${decl.property}:${decl.value}`,
          replacementClass: cls,
          replacementText: '',
          accessibleName: '',
          route,
        });
      }
    }
  }

  rows.sort((a, b) =>
    a.jsonPath.localeCompare(b.jsonPath)
    || a.kind.localeCompare(b.kind)
    || a.sourceValue.localeCompare(b.sourceValue)
    || a.context.localeCompare(b.context),
  );
  return rows;
}

export function assertManifestComplete(hits: StringHit[], manifest: MigrationRow[]): string[] {
  const errors: string[] = [];
  const keys = new Set(
    manifest.map((r) => `${r.jsonPath}|${r.kind}|${r.sourceValue}|${r.context}`),
  );
  const expected = buildMigrationManifest(hits, { courseGroups: [], seminars: [], teachers: [] });
  // Re-discover independently: every svg/mapped style must have a row with same jsonPath+kind+source.
  for (const hit of hits) {
    const sel = matchJsonSelector(hit);
    if (!sel) continue;
    const jsonPath = `${hit.file}${hit.jsonPath}`;
    for (const svg of findSvgHits(hit.value)) {
      const svgOnly = svg.insideAnchor ? isSvgOnlyNamingContent(svg.insideAnchor.inner) : false;
      const context = svg.insideAnchor
        ? `a[href=${svg.insideAnchor.href}] svg-only=${svgOnly}`
        : 'decorative-or-block-svg';
      const sourceValue = svg.html.slice(0, 200);
      if (!manifest.some((r) => r.jsonPath === jsonPath && r.kind === 'svg' && r.context === context && r.sourceValue === sourceValue)) {
        errors.push(`SVG без строки manifest: ${jsonPath} ${context}`);
      }
    }
    for (const tag of iterateTags(hit.value)) {
      if (!tag.attrs.style) continue;
      for (const decl of splitDeclarations(tag.attrs.style)) {
        if (!isMappedDeclaration(decl.property, decl.value)) continue;
        const sourceValue = `${decl.property}:${decl.value}`;
        const context = `${tag.name}[style]`;
        if (!manifest.some((r) => r.jsonPath === jsonPath && r.kind === 'style' && r.sourceValue === sourceValue && r.context === context)) {
          errors.push(`mapped style без строки manifest: ${jsonPath} ${sourceValue}`);
        }
      }
    }
  }
  void keys;
  void expected;
  return errors;
}
