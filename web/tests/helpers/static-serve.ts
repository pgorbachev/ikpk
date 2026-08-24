import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * Крошечный статический сервер над каталогом собранного вывода.
 *
 * ── ЗАЧЕМ ОН, ЕСЛИ ЕСТЬ `astro preview` ─────────────────────────────────────
 * `webServer` конфигурации Playwright раздаёт ОДИН каталог — боевой `dist`, — а браузерным
 * сценариям этой возможности нужен вывод, собранный с ЗАДАННЫМ состоянием конфигурации
 * чата. Иначе почти весь набор (кнопка вызова, фокус, перекрытие, доступность) теряет
 * предмет в состоянии «отсутствие объявлено явно», которое спека объявляет публикуемым, —
 * то есть прогон зависел бы от того, что кто-то объявил в дереве, а не от требования.
 *
 * Порт берётся НУЛЕВОЙ, то есть выдаётся системой. Это не мелочь: worktree не изолируют
 * порты, и параллельный прогон в соседнем каталоге уже сталкивался на фиксированном
 * номере — прогон падал не по своему предмету.
 *
 * `trailingSlash: 'never'` и каталоги с `index.html` — форма вывода этой сборки, поэтому
 * `/kontakty` разрешается в `/kontakty/index.html`. Обход за пределы корня отклоняется: у
 * сервера, поднятого в прогоне, нет причин отдавать что-либо снаружи.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
};

export interface StaticSite {
  /** Базовый адрес вида `http://127.0.0.1:<порт>`. */
  readonly origin: string;
  close(): Promise<void>;
}

export async function serveStatic(root: string): Promise<StaticSite> {
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`нечего раздавать: '${root}' не существует либо это не каталог`);

  const server: Server = createServer((req, res) => {
    const raw = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]);
    const rel = normalize(raw).replace(/^([/\\])+/, '');
    if (rel.split(sep).includes('..')) {
      res.writeHead(403).end('нельзя выходить за корень');
      return;
    }
    const candidates = [
      join(root, rel),
      join(root, rel, 'index.html'),
      // Адреса без слэша на конце — форма вывода этой сборки. Каталог с `index.html`
      // разрешается именно так, а не редиректом: редирект подменил бы предмет проверок,
      // которым важен сам код ответа.
      join(root, `${rel}.html`),
    ];
    const file = candidates.find((c) => existsSync(c) && statSync(c).isFile());
    if (file === undefined) {
      const notFound = join(root, '404.html');
      if (existsSync(notFound)) {
        res.writeHead(404, { 'content-type': MIME['.html'] });
        createReadStream(notFound).pipe(res);
        return;
      }
      res.writeHead(404).end('нет такого файла');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
