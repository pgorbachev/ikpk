/**
 * Marker inventory: production и demo paths/counts из rendered-registry.
 */
export interface RenderedSink {
  id: string;
  production: { paths: string[]; count: number };
  demo: { sameAsProduction?: boolean; paths?: string[]; count?: number };
}

export function sinkTargets(
  sink: RenderedSink,
  mode: 'production' | 'demo',
): { paths: string[]; count: number } {
  if (mode === 'production') return sink.production;
  if (sink.demo.sameAsProduction) return sink.production;
  return { paths: sink.demo.paths ?? [], count: sink.demo.count ?? 0 };
}

export function collectMarkerInventoryErrors(
  sinks: RenderedSink[],
  mode: 'production' | 'demo',
  loadPage: (path: string) => { exists: boolean; html: string },
): string[] {
  const missing: string[] = [];
  for (const sink of sinks) {
    const { paths, count } = sinkTargets(sink, mode);
    if (count === 0) {
      if (paths.length > 0) missing.push(`${mode} ${sink.id}: count=0, но paths непусты`);
      continue;
    }
    let markers = 0;
    for (const path of paths) {
      const page = loadPage(path);
      if (!page.exists) {
        missing.push(`${mode} ${sink.id} ${path} (нет файла)`);
        continue;
      }
      const n = page.html.split(`data-safe-rich-content="${sink.id}"`).length - 1;
      if (n === 0) missing.push(`${mode} ${sink.id} ${path}`);
      markers += n;
    }
    if (markers !== count) {
      missing.push(`${mode} ${sink.id} count: registry=${count} live=${markers}`);
    }
  }
  return missing;
}
