/**
 * Marker inventory: полный multiset route/sink-id по всем built pages,
 * сверка с production/demo paths+counts из rendered-registry.
 */
import { iterateTags } from './html-scan.js';

export interface RenderedSink {
  id: string;
  production: { paths: string[]; count: number };
  demo: { sameAsProduction?: boolean; paths?: string[]; count?: number };
}

export interface InventoryPage {
  route: string;
  html: string;
}

export function sinkTargets(
  sink: RenderedSink,
  mode: 'production' | 'demo',
): { paths: string[]; count: number } {
  if (mode === 'production') return sink.production;
  if (sink.demo.sameAsProduction) return sink.production;
  return { paths: sink.demo.paths ?? [], count: sink.demo.count ?? 0 };
}

export function markersOnPage(html: string): string[] {
  const ids: string[] = [];
  for (const tag of iterateTags(html)) {
    const id = tag.attrs['data-safe-rich-content'];
    if (id) ids.push(id);
  }
  return ids;
}

function canonRoute(route: string): string {
  if (route === '/') return '/';
  return route.replace(/\/+$/, '');
}

/**
 * Сверяет полный live-multiset (все переданные страницы) с registry.
 * Лишний известный sink-id на незарегистрированном route — ошибка.
 */
export function collectMarkerInventoryErrors(
  sinks: RenderedSink[],
  mode: 'production' | 'demo',
  pages: InventoryPage[],
): string[] {
  const errors: string[] = [];
  const liveBySinkRoute = new Map<string, number>();
  const liveBySink = new Map<string, number>();
  const pageByRoute = new Map<string, InventoryPage>();

  for (const page of pages) {
    const route = canonRoute(page.route);
    pageByRoute.set(route, page);
    for (const sinkId of markersOnPage(page.html)) {
      const key = `${sinkId}\t${route}`;
      liveBySinkRoute.set(key, (liveBySinkRoute.get(key) ?? 0) + 1);
      liveBySink.set(sinkId, (liveBySink.get(sinkId) ?? 0) + 1);
    }
  }

  const expectedSinks = new Set(sinks.map((s) => s.id));
  const expectedKeys = new Set<string>();

  for (const sink of sinks) {
    const { paths, count } = sinkTargets(sink, mode);
    if (count === 0) {
      if (paths.length > 0) errors.push(`${mode} ${sink.id}: count=0, но paths непусты`);
      if ((liveBySink.get(sink.id) ?? 0) > 0) {
        errors.push(`${mode} extra ${sink.id}: registry count=0, live=${liveBySink.get(sink.id)}`);
      }
      continue;
    }
    let markers = 0;
    for (const rawPath of paths) {
      const path = canonRoute(rawPath);
      expectedKeys.add(`${sink.id}\t${path}`);
      const page = pageByRoute.get(path);
      if (!page) {
        errors.push(`${mode} ${sink.id} ${path} (нет файла)`);
        continue;
      }
      const n = markersOnPage(page.html).filter((id) => id === sink.id).length;
      if (n === 0) errors.push(`${mode} ${sink.id} ${path}`);
      markers += n;
    }
    if (markers !== count) {
      errors.push(`${mode} ${sink.id} count: registry=${count} live=${markers}`);
    }
  }

  for (const [key, n] of liveBySinkRoute) {
    const [sinkId, route] = key.split('\t');
    if (!expectedSinks.has(sinkId)) {
      errors.push(`${mode} unknown sink-id ${sinkId} на ${route} (×${n})`);
      continue;
    }
    if (!expectedKeys.has(key)) {
      errors.push(`${mode} extra ${sinkId} на ${route}`);
    }
  }

  return errors;
}
