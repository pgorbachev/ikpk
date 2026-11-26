import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export interface SitemapUrlEntry {
  loc: string;
  lastmod?: string;
}

export interface SitemapIndexEntry {
  loc: string;
  lastmod?: string;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function optionalTag(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
  return match ? decodeXml(match[1]) : undefined;
}

function requiredTag(block: string, tag: string, context: string): string {
  const value = optionalTag(block, tag);
  if (!value) throw new Error(`${context}: отсутствует <${tag}>`);
  return value;
}

function childPath(dist: string, loc: string): string {
  const url = new URL(loc);
  const path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
  const rel = relative(resolve(dist), path);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`путь дочерней карты выходит за пределы dist: ${loc}`);
  }
  return path;
}

/** Parse the actual sitemap index and every child file; missing/empty/duplicate output is an error. */
export function readSitemapTree(dist: string): {
  index: SitemapIndexEntry[];
  urls: Map<string, SitemapUrlEntry>;
} {
  const indexPath = join(dist, 'sitemap-index.xml');
  if (!existsSync(indexPath)) throw new Error(`нет sitemap index: ${indexPath}`);
  const indexXml = readFileSync(indexPath, 'utf8');
  const index: SitemapIndexEntry[] = [...indexXml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)].map((m) => ({
    loc: requiredTag(m[1], 'loc', 'sitemap index entry'),
    lastmod: optionalTag(m[1], 'lastmod'),
  }));
  if (index.length === 0) throw new Error('sitemap index не перечисляет дочерние карты');
  if (new Set(index.map((entry) => entry.loc)).size !== index.length) {
    throw new Error('sitemap index содержит повторный loc');
  }

  const urls = new Map<string, SitemapUrlEntry>();
  for (const map of index) {
    const file = childPath(dist, map.loc);
    if (!existsSync(file)) throw new Error(`нет перечисленной дочерней карты: ${file}`);
    const xml = readFileSync(file, 'utf8');
    const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
      loc: requiredTag(m[1], 'loc', `url entry в ${file}`),
      lastmod: optionalTag(m[1], 'lastmod'),
    }));
    if (entries.length === 0) throw new Error(`пустая дочерняя карта: ${file}`);
    for (const entry of entries) {
      if (urls.has(entry.loc)) throw new Error(`повторный URL в sitemap: ${entry.loc}`);
      urls.set(entry.loc, entry);
    }
  }
  if (urls.size === 0) throw new Error('sitemap не содержит URL');
  return { index, urls };
}
