import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { SaxesParser } from 'saxes';

export interface SitemapUrlEntry { loc: string; lastmod?: string }
export interface SitemapIndexEntry { loc: string; lastmod?: string }
const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function parseEntries(xml: string, root: 'sitemapindex' | 'urlset', entry: 'sitemap' | 'url'): SitemapUrlEntry[] {
  const parser = new SaxesParser({ xmlns: true });
  const stack: string[] = [];
  const entries: SitemapUrlEntry[] = [];
  let current: Partial<SitemapUrlEntry> | undefined;
  let text = '';
  parser.on('opentag', (tag) => {
    if (tag.uri !== NS) throw new Error(`неверное пространство имён sitemap: ${tag.name}`);
    stack.push(tag.local);
    if (stack.length === 1 && tag.local !== root) throw new Error(`неверный корень sitemap: ${tag.local}`);
    if (stack.length === 2 && tag.local === entry) current = {};
    if (stack.length === 3 && current && (tag.local === 'loc' || tag.local === 'lastmod')) text = '';
  });
  parser.on('text', (value) => { if (stack.length === 3) text += value; });
  parser.on('closetag', (tag) => {
    if (stack.length === 3 && current && (tag.local === 'loc' || tag.local === 'lastmod')) {
      if (current[tag.local] !== undefined) throw new Error(`повторный ${tag.local}`);
      current[tag.local] = text.trim();
      if (!current[tag.local]) throw new Error(`пустой ${tag.local}`);
    }
    if (stack.length === 2 && tag.local === entry) {
      if (!current?.loc) throw new Error('отсутствует <loc>');
      entries.push({ loc: current.loc, ...(current.lastmod === undefined ? {} : { lastmod: current.lastmod }) });
      current = undefined;
    }
    stack.pop();
  });
  parser.write(xml).close();
  return entries;
}

function childPath(dist: string, loc: string): string {
  const url = new URL(loc);
  const path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
  const rel = relative(resolve(dist), path);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..') throw new Error(`путь дочерней карты выходит за пределы dist: ${loc}`);
  return path;
}

export function readSitemapTree(dist: string): { index: SitemapIndexEntry[]; urls: Map<string, SitemapUrlEntry> } {
  const indexPath = join(dist, 'sitemap-index.xml');
  if (!existsSync(indexPath)) throw new Error(`нет sitemap index: ${indexPath}`);
  const index = parseEntries(readFileSync(indexPath, 'utf8'), 'sitemapindex', 'sitemap');
  if (index.length === 0) throw new Error('sitemap index не перечисляет дочерние карты');
  if (new Set(index.map((e) => e.loc)).size !== index.length) throw new Error('sitemap index содержит повторный loc');
  const urls = new Map<string, SitemapUrlEntry>();
  for (const map of index) {
    const file = childPath(dist, map.loc);
    if (!existsSync(file)) throw new Error(`нет перечисленной дочерней карты: ${file}`);
    const entries = parseEntries(readFileSync(file, 'utf8'), 'urlset', 'url');
    if (entries.length === 0) throw new Error(`пустая дочерняя карта: ${file}`);
    for (const e of entries) {
      if (urls.has(e.loc)) throw new Error(`повторный URL в sitemap: ${e.loc}`);
      urls.set(e.loc, e);
    }
  }
  return { index, urls };
}
