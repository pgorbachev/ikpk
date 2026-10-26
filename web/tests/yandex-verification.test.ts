import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSitePageHtml } from './helpers/walk';

describe('Yandex Webmaster verification', () => {
  it('keeps the exact verification file in the public site root', () => {
    const file = join(import.meta.dirname, '..', 'public', 'yandex_ee694e7be59ffcf0.html');
    expect(readFileSync(file, 'utf8')).toBe(
      '<html>\n    <head>\n        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">\n    </head>\n    <body>Verification: ee694e7be59ffcf0</body>\n</html>\n'
    );
  });

  it('treats the verification HTML as a static resource, not an Astro page', () => {
    expect(isSitePageHtml('dist/yandex_ee694e7be59ffcf0.html')).toBe(false);
    expect(isSitePageHtml('dist/index.html')).toBe(true);
    expect(isSitePageHtml('dist/404.html')).toBe(true);
  });
});
