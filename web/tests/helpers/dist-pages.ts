import { readFileSync } from 'fs';
import { join } from 'path';
import { walkFiles } from './walk';

/** Общие хелперы обхода собранного dist/ для build-гейтов. */

export const dist = join(import.meta.dirname, '..', '..', 'dist');

export { walkFiles };

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
