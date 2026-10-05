// Тестовый резолвер только для `npm test` (см. package.json): production-исходники ходят
// без расширений, потому что `strapi build` компилирует их через собственный тулчейн, где
// это резолвится штатно. Прямой прогон `.ts` через `node --test` — ESM-режим Node, а он
// (в отличие от tsc с moduleResolution "Node") требует явное расширение у относительных
// путей. Хук добивает расширение `.ts` только при резолве, не трогая сами файлы.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(`${specifier}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}
