import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSources, matchJsonSelector } from './source-discovery.js';
import { fingerprintHtml, type SourceFingerprint } from './fingerprint.js';
import { htmlOf } from './html-of.js';
import { visibleText } from './html-scan.js';
import { ENTITIES_DIR } from './paths.js';
import { cleanBodyHtml } from '../../../src/lib/html-cleaner.js';
import { localizeAssetUrls } from '../../../src/lib/media.js';

const LOCAL_RASTER = /^\/media\/(?!_w\/).+\.(webp|png|jpg|jpeg)$/i;

export interface FingerprintComparisonRow {
  selectorId: string;
  entityId: string;
  jsonPath: string;
  error: string | null;
  losses: string[];
  source: StructureCounts;
  cleaned: StructureCounts | null;
}

export interface StructureCounts {
  headings: number;
  headingsNoH1: number;
  lists: number;
  tables: number;
  times: number;
  links: number;
  localImages: number;
  details: number;
  checkboxes: number;
  rutube: number;
}

export interface FingerprintComparisonReport {
  generatedAt: string;
  compared: 'localized-source vs cleaned-pipeline';
  records: number;
  withLosses: number;
  withErrors: number;
  comparisons: FingerprintComparisonRow[];
}

function keepableHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return !(
    lower.startsWith('javascript:')
    || lower.startsWith('vbscript:')
    || lower.startsWith('data:')
    || lower.startsWith('file:')
  );
}

function countsOf(fp: SourceFingerprint): StructureCounts {
  return {
    headings: fp.headings.length,
    headingsNoH1: fp.headings.filter((h) => !h.startsWith('h1:')).length,
    lists: fp.lists.length,
    tables: fp.tables.length,
    times: fp.times.length,
    links: fp.links.filter((l) => keepableHref(l.href)).length,
    localImages: fp.images.filter((img) => LOCAL_RASTER.test(img.src.split('?')[0] ?? '')).length,
    details: fp.details.length,
    checkboxes: fp.checkboxes.length,
    rutube: fp.rutube.length,
  };
}

function normalizeHref(href: string): string {
  const trimmed = href.trim();
  try {
    return decodeURI(trimmed);
  } catch {
    return trimmed;
  }
}

export function compareSafeStructure(
  source: SourceFingerprint,
  cleaned: SourceFingerprint,
  cleanedHtml: string,
  sourceHtml: string,
): string[] {
  const losses: string[] = [];
  const srcHeadings = source.headings.filter((h) => !h.startsWith('h1:'));
  let headingFrom = 0;
  for (const heading of srcHeadings) {
    const idx = cleaned.headings.indexOf(heading, headingFrom);
    if (idx !== -1) {
      headingFrom = idx + 1;
      continue;
    }
    const text = heading.slice(3);
    if (text && cleanedHtml.includes(text)) continue;
    losses.push(`heading:${heading}`);
  }
  if (cleaned.tables.length < source.tables.length) {
    losses.push(`tables:${source.tables.length}->${cleaned.tables.length}`);
  }
  if (cleaned.details.length < source.details.length) {
    losses.push(`details:${source.details.length}->${cleaned.details.length}`);
  }
  for (const src of source.rutube) {
    const id = src.replace(/\/+$/, '').split('/').pop() ?? src;
    if (!cleaned.rutube.some((item) => item.includes(id))) losses.push(`rutube:${src}`);
  }
  const cleanedSrcs = new Set(cleaned.images.map((img) => img.src.split('?')[0] ?? ''));
  for (const img of source.images) {
    const src = img.src.split('?')[0] ?? '';
    if (!LOCAL_RASTER.test(src)) continue;
    if (!cleanedSrcs.has(src)) losses.push(`image:${src}`);
  }
  const cleanedHrefs = new Set(cleaned.links.map((link) => normalizeHref(link.href)));
  for (const link of source.links) {
    if (!keepableHref(link.href)) continue;
    if (hrefOnlyInsideSvg(sourceHtml, link.href) || hrefInLegacyForm(sourceHtml, link.href)) continue;
    if (!cleanedHrefs.has(normalizeHref(link.href))) losses.push(`link:${link.href}`);
  }
  if (cleaned.checkboxes.length < source.checkboxes.length) {
    losses.push(`checkbox:${source.checkboxes.length}->${cleaned.checkboxes.length}`);
  }
  if (source.svgCount === 0 && cleaned.lists.length < source.lists.length) {
    losses.push(`lists:${source.lists.length}->${cleaned.lists.length}`);
  }
  return losses;
}

function hrefOnlyInsideSvg(html: string, href: string): boolean {
  const svgBlocks = html.match(/<svg\b[\s\S]*?<\/svg>/gi) ?? [];
  if (!svgBlocks.some((block) => block.includes(href))) return false;
  const withoutSvg = html.replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
  return !withoutSvg.includes(href);
}

function hrefInLegacyForm(html: string, href: string): boolean {
  let from = 0;
  let seen = false;
  while (from < html.length) {
    const idx = html.indexOf(href, from);
    if (idx === -1) break;
    seen = true;
    const lookback = html.slice(Math.max(0, idx - 800), idx);
    if (!/subscribe-news-form_|PhoneInput|<form[\s>]/i.test(lookback)) return false;
    from = idx + href.length;
  }
  return seen;
}

let panelsByPath: Record<string, Record<string, string>> | null = null;

function loadPanels(): Record<string, Record<string, string>> {
  if (!panelsByPath) {
    panelsByPath = JSON.parse(
      readFileSync(join(ENTITIES_DIR, 'collapsible_panels.json'), 'utf-8'),
    ) as Record<string, Record<string, string>>;
  }
  return panelsByPath;
}

function panelsForHtml(html: string): Record<string, string> | undefined {
  const titles = [...html.matchAll(/data-collapsible-title="true"[^>]*>([\s\S]*?)<\/h\d>/gi)]
    .flatMap((match) => {
      const raw = match[1].trim();
      const text = visibleText(match[1]).trim();
      return [raw, text].filter(Boolean);
    });
  if (!titles.length) return undefined;
  const merged: Record<string, string> = {};
  for (const rec of Object.values(loadPanels())) {
    for (const title of titles) {
      if (rec[title]) merged[title] = rec[title];
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

export function buildFingerprintComparison(): FingerprintComparisonReport {
  const discovered = discoverSources();
  const hits = discovered.htmlBearing.filter((hit) => matchJsonSelector(hit));
  const comparisons: FingerprintComparisonRow[] = [];
  for (const hit of hits) {
    const selector = matchJsonSelector(hit)!;
    const jsonPath = `${hit.file}${hit.jsonPath}`;
    const meta = { jsonPath, selectorId: selector.id, entityId: hit.entityId };
    const localized = localizeAssetUrls(hit.value);
    const sourceFp = fingerprintHtml(localized, meta);
    try {
      const cleaned = htmlOf(cleanBodyHtml(localized, {
        sourceType: selector.id,
        sourceId: hit.entityId,
        panels: panelsForHtml(localized),
      }));
      const cleanedFp = fingerprintHtml(cleaned, meta);
      comparisons.push({
        selectorId: selector.id,
        entityId: hit.entityId,
        jsonPath,
        error: null,
        losses: compareSafeStructure(sourceFp, cleanedFp, cleaned, localized),
        source: countsOf(sourceFp),
        cleaned: countsOf(cleanedFp),
      });
    } catch (err) {
      comparisons.push({
        selectorId: selector.id,
        entityId: hit.entityId,
        jsonPath,
        error: err instanceof Error ? err.message : String(err),
        losses: ['clean-error'],
        source: countsOf(sourceFp),
        cleaned: null,
      });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    compared: 'localized-source vs cleaned-pipeline',
    records: comparisons.length,
    withLosses: comparisons.filter((row) => row.losses.length > 0).length,
    withErrors: comparisons.filter((row) => row.error).length,
    comparisons,
  };
}

export function unexplainedLosses(report: FingerprintComparisonReport): FingerprintComparisonRow[] {
  return report.comparisons.filter((row) => row.losses.length > 0 || row.error);
}
