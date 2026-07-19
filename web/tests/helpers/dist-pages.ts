import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/** Общие хелперы обхода собранного dist/ для build-гейтов. */

export const dist = join(import.meta.dirname, '..', '..', 'dist');

export function* walkFiles(dir: string, exts: string[]): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walkFiles(full, exts);
    } else if (exts.some((e) => name.endsWith(e))) {
      yield full;
    }
  }
}

export function* walkHtml(dir: string = dist): Generator<string> {
  yield* walkFiles(dir, ['.html']);
}

/** Все html-страницы dist как канонические пути ('/', '/statyi/', …). */
export function allPages(): string[] {
  return [...walkHtml()]
    .filter((f) => f.endsWith('index.html'))
    .map((f) => f.replace(dist, '').replace(/index\.html$/, ''));
}

export function readPage(path: string): string {
  return readFileSync(join(dist, path, 'index.html'), 'utf-8');
}
