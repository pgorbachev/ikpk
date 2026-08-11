import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDemoForms } from '../lib/forms';

/**
 * `robots.txt` зависит от режима сборки.
 *
 * Прежде файл лежал статически в `public/` и разрешал обход в ЛЮБОЙ сборке — то есть
 * демо-стенд был открыт поисковикам и конкурировал с ikpk.su как дубль: тексты те же,
 * адрес другой. `canonical` на боевой домен спасает лишь частично, а `noindex` на
 * отдельных страницах стенда не закрывает стенд целиком.
 *
 * Режим на сборке уже известен (`DEMO_FORMS`), поэтому стенд закрывается тем же
 * переключателем, что и формы: одно решение вместо двух, которые могут разойтись.
 *
 * Боевые правила держим отдельным файлом `src/robots-prod.txt`, а не строкой в коде:
 * их правят как текст (Sitemap, Clean-param, запреты), и в виде шаблонной строки они
 * ломались бы на экранировании. В `public/` файлу вернуться нельзя — он перекрыл бы
 * этот маршрут молча, поэтому в `tests/repo-hygiene.test.ts` есть гейт на его отсутствие.
 */
export const GET: APIRoute = () => {
  const plainText = { headers: { 'Content-Type': 'text/plain; charset=utf-8' } };

  if (isDemoForms) {
    return new Response(
      [
        '# Демонстрационный стенд: обход запрещён целиком.',
        '# Боевая сборка (npm run build, без DEMO_FORMS) отдаёт полные правила.',
        '#',
        '# Sitemap здесь намеренно НЕ объявлен: карта — приглашение к обходу, и',
        '# объявлять её рядом с полным запретом значит подавать два разных сигнала.',
        'User-agent: *',
        'Disallow: /',
        '',
      ].join('\n'),
      plainText,
    );
  }

  // Путь от корня пакета: сборка запускается из `web/` (и локально, и в CI, где у джоба
  // задан working-directory: web).
  const prod = readFileSync(join(process.cwd(), 'src', 'robots-prod.txt'), 'utf-8');
  return new Response(prod, plainText);
};
