import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CMS_API_DIR, CONTENT_JSON_DIR } from './paths.js';
import { hasElementNode } from './html-scan.js';
import { CMS_RICHTEXT_SELECTORS, JSON_SELECTORS, type JsonSelector } from './normative.js';

export interface StringHit {
  file: string;
  jsonPath: string;
  field: string;
  value: string;
  entityId: string;
  htmlBearing: boolean;
  reason: 'suffix-_html' | 'element-node' | 'all-strings-selector';
}

export interface CmsRichtextHit {
  schemaPath: string;
  singularName: string;
  attr: string;
  selectorId: string;
}

export interface DiscoveryResult {
  files: string[];
  strings: StringHit[];
  htmlBearing: StringHit[];
  cmsRichtext: CmsRichtextHit[];
}

export interface DiscoveryOptions {
  contentJsonDir?: string;
  contentJsonGlob?: string;
  cmsApiDir?: string;
  extraEntityFiles?: { name: string; json: unknown }[];
  extraCmsAttributes?: { singularName: string; attr: string; schemaPath: string }[];
}

function walkDir(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkDir(full, suffix));
    else if (full.endsWith(suffix)) out.push(full);
  }
  return out.sort();
}

function fieldOfPath(jsonPath: string): string {
  const m = /\.([^.[\]]+)$/.exec(jsonPath);
  if (m) return m[1];
  const bracket = /\["([^"]+)"\]$/.exec(jsonPath);
  return bracket ? bracket[1] : jsonPath;
}

function recordId(record: unknown, index: number): string {
  if (record && typeof record === 'object') {
    const rec = record as Record<string, unknown>;
    for (const key of ['legacy_id', 'slug', 'id']) {
      if (typeof rec[key] === 'string' && rec[key]) return rec[key];
      if (typeof rec[key] === 'number') return String(rec[key]);
    }
  }
  return String(index);
}

function walkValue(
  value: unknown,
  file: string,
  jsonPath: string,
  entityId: string,
  acc: StringHit[],
): void {
  if (typeof value === 'string') {
    const field = fieldOfPath(jsonPath);
    const suffix = field.endsWith('_html');
    const element = hasElementNode(value);
    acc.push({
      file,
      jsonPath,
      field,
      value,
      entityId,
      htmlBearing: suffix || element,
      reason: suffix ? 'suffix-_html' : element ? 'element-node' : 'all-strings-selector',
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkValue(item, file, `${jsonPath}[${i}]`, entityId, acc));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walkValue(v, file, `${jsonPath}["${k}"]`, entityId, acc);
    }
  }
}

export function matchJsonSelector(hit: StringHit): JsonSelector | undefined {
  const base = hit.file.split(/[/\\]/).pop() ?? hit.file;
  return JSON_SELECTORS.find((sel) => {
    if (sel.file !== base) return false;
    if (sel.kind === 'all-strings') return true;
    return sel.field === hit.field;
  });
}

export function discoverSources(opts: DiscoveryOptions = {}): DiscoveryResult {
  const contentJsonDir = opts.contentJsonDir ?? CONTENT_JSON_DIR;
  const pattern = opts.contentJsonGlob ?? '*.json';
  if (!existsSync(contentJsonDir)) {
    throw new Error(`каталог входных JSON недоступен: ${contentJsonDir}`);
  }
  const allJson = walkDir(contentJsonDir, '.json');
  const files = pattern === '*.json'
    ? allJson.filter((f) => f.slice(contentJsonDir.length + 1).split(/[/\\]/).length === 1)
    : allJson.filter((f) => f.endsWith(pattern.replace('*', '')));

  if (files.length === 0) {
    throw new Error(
      `source-scan: zero-match input glob ${pattern} в ${contentJsonDir} — проверять нечего`,
    );
  }

  const strings: StringHit[] = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const rel = file.split(/[/\\]/).pop() ?? file;
    if (Array.isArray(parsed)) {
      parsed.forEach((record, i) => {
        walkValue(record, rel, `$[${i}]`, recordId(record, i), strings);
      });
    } else {
      walkValue(parsed, rel, '$', rel, strings);
    }
  }

  for (const extra of opts.extraEntityFiles ?? []) {
    const parsed = extra.json;
    if (Array.isArray(parsed)) {
      parsed.forEach((record, i) => {
        walkValue(record, extra.name, `$[${i}]`, recordId(record, i), strings);
      });
    } else {
      walkValue(parsed, extra.name, '$', extra.name, strings);
    }
  }

  const htmlBearing = strings.filter((s) => {
    const sel = matchJsonSelector(s);
    if (sel?.kind === 'all-strings') return true;
    return s.htmlBearing;
  });

  const cmsApiDir = opts.cmsApiDir ?? CMS_API_DIR;
  const schemas = walkDir(cmsApiDir, 'schema.json');
  const cmsRichtext: CmsRichtextHit[] = [];
  for (const extra of opts.extraCmsAttributes ?? []) {
    cmsRichtext.push({
      schemaPath: extra.schemaPath,
      singularName: extra.singularName,
      attr: extra.attr,
      selectorId: `cms:${extra.singularName}.${extra.attr}`,
    });
  }
  for (const schemaPath of schemas) {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as {
      info?: { singularName?: string };
      attributes?: Record<string, { type?: string }>;
    };
    const singularName = schema.info?.singularName ?? '';
    for (const [attr, def] of Object.entries(schema.attributes ?? {})) {
      if (def?.type !== 'richtext') continue;
      const listed = CMS_RICHTEXT_SELECTORS.find(
        (s) => s.singularName === singularName && s.attr === attr,
      );
      cmsRichtext.push({
        schemaPath,
        singularName,
        attr,
        selectorId: listed?.id ?? `cms:${singularName}.${attr}`,
      });
    }
  }

  return { files, strings, htmlBearing, cmsRichtext };
}

export interface SourceRegistryEntry {
  selectorId: string;
  kind: 'json-field' | 'json-all-strings' | 'cms-richtext';
  file?: string;
  field?: string | null;
  singularName?: string;
  attr?: string;
  entityId: string;
  jsonPath: string;
  byteLength: number;
  empty: boolean;
}

export interface SourceRegistry {
  generatedFromSha: string;
  selectors: string[];
  entries: SourceRegistryEntry[];
}

export function buildSourceRegistry(discovered: DiscoveryResult, sha: string): SourceRegistry {
  const entries: SourceRegistryEntry[] = [];

  for (const hit of discovered.htmlBearing) {
    const sel = matchJsonSelector(hit);
    if (!sel) continue;
    entries.push({
      selectorId: sel.id,
      kind: sel.kind === 'all-strings' ? 'json-all-strings' : 'json-field',
      file: sel.file,
      field: sel.field,
      entityId: hit.entityId,
      jsonPath: `${hit.file}${hit.jsonPath}`,
      byteLength: Buffer.byteLength(hit.value, 'utf8'),
      empty: hit.value.trim().length === 0,
    });
  }

  for (const listed of CMS_RICHTEXT_SELECTORS) {
    entries.push({
      selectorId: listed.id,
      kind: 'cms-richtext',
      file: listed.jsonFile ?? undefined,
      field: listed.jsonField,
      singularName: listed.singularName,
      attr: listed.attr,
      entityId: `${listed.singularName}.${listed.attr}`,
      jsonPath: `cms:${listed.singularName}.${listed.attr}`,
      byteLength: 0,
      empty: true,
    });
  }

  entries.sort((a, b) => a.jsonPath.localeCompare(b.jsonPath) || a.selectorId.localeCompare(b.selectorId));
  return {
    generatedFromSha: sha,
    selectors: [...JSON_SELECTORS.map((s) => s.id), ...CMS_RICHTEXT_SELECTORS.map((s) => s.id)],
    entries,
  };
}

export function assertDiscoveryMatchesRegistry(
  discovered: DiscoveryResult,
  registry: SourceRegistry,
): string[] {
  const errors: string[] = [];
  const registryPaths = new Set(registry.entries.map((e) => e.jsonPath));
  const registrySelectors = new Set(registry.selectors);

  for (const hit of discovered.htmlBearing) {
    const sel = matchJsonSelector(hit);
    if (!sel) {
      errors.push(`unlisted HTML-bearing field ${hit.file}${hit.jsonPath} (${hit.reason})`);
      continue;
    }
    if (!registrySelectors.has(sel.id)) {
      errors.push(`selector ${sel.id} отсутствует в registry`);
    }
    const path = `${hit.file}${hit.jsonPath}`;
    if (!registry.entries.some((e) => e.selectorId === sel.id && (e.jsonPath === path || e.kind === 'cms-richtext'))) {
      if (!registry.entries.some((e) => e.jsonPath === path)) {
        errors.push(`selector ${sel.id} без registry entry для ${path}`);
      }
    }
  }

  for (const cms of discovered.cmsRichtext) {
    const listed = CMS_RICHTEXT_SELECTORS.find(
      (s) => s.singularName === cms.singularName && s.attr === cms.attr,
    );
    if (!listed) {
      errors.push(`unlisted CMS type:richtext ${cms.singularName}.${cms.attr} (${cms.schemaPath})`);
      continue;
    }
    if (!registry.entries.some((e) => e.selectorId === listed.id)) {
      errors.push(`CMS richtext ${listed.id} без registry entry`);
    }
  }

  for (const id of registry.selectors) {
    if (!registry.entries.some((e) => e.selectorId === id)) {
      errors.push(`selector ${id} без registry entry`);
    }
  }

  void registryPaths;
  return errors;
}
