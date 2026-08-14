import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationRow } from './migration.js';

export interface MigrationPageInventoryRow {
  route: string;
  style: number;
  svg: number;
  classes: string[];
  exists: boolean;
  missingClasses: string[];
  leftoverSvgInRich: boolean;
  leftoverStyleInRich: boolean;
}

export interface MigrationPageInventory {
  generatedAt: string;
  renderedRoutes: number;
  missingPages: string[];
  pagesWithMissingClasses: MigrationPageInventoryRow[];
  pagesWithSvgInRich: string[];
  pagesWithStyleInRich: string[];
  note: string;
}

function htmlPathForRoute(dist: string, route: string): string | null {
  if (route === '/') return join(dist, 'index.html');
  const file = join(dist, route.replace(/^\//, ''), 'index.html');
  return existsSync(file) ? file : null;
}

export function buildMigrationPageInventory(
  manifest: MigrationRow[],
  dist: string,
): MigrationPageInventory {
  const byRoute = new Map<string, { style: number; svg: number; classes: Set<string> }>();
  for (const row of manifest) {
    if (row.route === 'source-only') continue;
    if (!byRoute.has(row.route)) byRoute.set(row.route, { style: 0, svg: 0, classes: new Set() });
    const record = byRoute.get(row.route)!;
    record[row.kind] += 1;
    if (row.replacementClass) record.classes.add(row.replacementClass);
  }

  const pages = [...byRoute.entries()].map(([route, record]): MigrationPageInventoryRow => {
    const file = htmlPathForRoute(dist, route);
    if (!file) {
      return {
        route,
        style: record.style,
        svg: record.svg,
        classes: [...record.classes],
        exists: false,
        missingClasses: [],
        leftoverSvgInRich: false,
        leftoverStyleInRich: false,
      };
    }
    const html = readFileSync(file, 'utf-8');
    const missingClasses = [...record.classes].filter((className) => !html.includes(className));
    const richBlocks = [...html.matchAll(/data-safe-rich-content="[^"]+"[^>]*>([\s\S]*?)<\/div>/g)]
      .map((match) => match[1]);
    return {
      route,
      style: record.style,
      svg: record.svg,
      classes: [...record.classes],
      exists: true,
      missingClasses,
      leftoverSvgInRich: richBlocks.some((block) => /<svg[\s>]/i.test(block)),
      leftoverStyleInRich: richBlocks.some((block) => /\sstyle="/i.test(block)),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    renderedRoutes: pages.length,
    missingPages: pages.filter((page) => !page.exists).map((page) => page.route),
    pagesWithMissingClasses: pages.filter((page) => page.exists && page.missingClasses.length > 0),
    pagesWithSvgInRich: pages.filter((page) => page.leftoverSvgInRich).map((page) => page.route),
    pagesWithStyleInRich: pages.filter((page) => page.leftoverStyleInRich).map((page) => page.route),
    note: 'Inventory построен из текущего production dist; source fingerprint gate отдельно проверяет mapped classes для каждого source fragment.',
  };
}
