import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { join } from 'path';

const execFileAsync = promisify(execFile);

// Дефект B12 (docs/security-audit-2026-08-08.md): обе проверки деплоя зелёные
// вхолостую.
//
//  - health-check: `curl -fsS` без `-L` — `-f` роняет только на кодах ≥400, поэтому
//    на 301 curl выходит с нулём, печатается «Health check OK», и сайт не открывался
//    ни разу. Станет актуально ровно в момент появления 80→443 (certbot).
//  - preflight: вторая альтернатива grep матчит ЛЮБОЕ упоминание имени файла в
//    выводе `nginx -T`, поэтому закомментированный `# include …` проходит проверку
//    при мёртвых правилах перенаправления.
//
// Проверяется ПОВЕДЕНИЕ функций, а не текст скрипта: греп исходника утверждал бы,
// что проверка написана, но не что она что-то ловит.

const ROOT = join(import.meta.dirname, '..', '..');
const LIB = join(ROOT, 'scripts', 'lib', 'deploy-checks.sh');

/**
 * Запускает функцию из библиотеки, возвращает код выхода.
 *
 * Асинхронно намеренно: `execFileSync` блокирует поток, и тестовый HTTP-сервер,
 * поднятый в этом же процессе, не успевал бы принять соединение — curl упирался бы
 * в `--max-time` и все проверки падали бы по таймауту, включая заведомо исправную.
 */
async function runFn(script: string, stdin = ''): Promise<number> {
  const child = execFileAsync('bash', ['-c', `set -uo pipefail; source '${LIB}'; ${script}`]);
  child.child.stdin?.end(stdin);
  try {
    await child;
    return 0;
  } catch (err) {
    return (err as { code?: number }).code ?? 1;
  }
}

describe('redirects_include_active — include файла редиректов', () => {
  const ACTIVE = `
server {
    listen 80;
    include /var/www/ikpk/shared/nginx-redirects.conf;
}
`;
  const COMMENTED = `
server {
    listen 80;
    # include /var/www/ikpk/shared/nginx-redirects.conf;
}
`;
  const MENTION_ONLY = `
# файл /var/www/ikpk/shared/nginx-redirects.conf лежит на месте, но не подключён
server {
    listen 80;
}
`;

  it('активный include распознаётся', async () => {
    expect(await runFn('redirects_include_active', ACTIVE)).toBe(0);
  });

  it('закомментированный include НЕ считается подключением', async () => {
    expect(
      await runFn('redirects_include_active', COMMENTED),
      'закомментированный include принят за рабочий — правила перенаправления мертвы, ' +
        'а деплой выглядит успешным',
    ).not.toBe(0);
  });

  it('упоминание имени файла в комментарии не считается подключением', async () => {
    expect(await runFn('redirects_include_active', MENTION_ONLY)).not.toBe(0);
  });

  // Формы записи, которые nginx допускает. Ложное «include отсутствует» здесь не
  // безобидно: оно останавливает ИСПРАВНЫЙ деплой и посылает оператора править
  // рабочий боевой конфиг руками.
  it('путь в кавычках распознаётся', async () => {
    const quoted = `
server {
    include "/var/www/ikpk/shared/nginx-redirects.conf";
}
`;
    expect(await runFn('redirects_include_active', quoted)).toBe(0);
  });

  it('директива не первой в строке распознаётся', async () => {
    const inline = `
server { include /etc/nginx/other.conf; include /var/www/ikpk/shared/nginx-redirects.conf; }
`;
    expect(await runFn('redirects_include_active', inline)).toBe(0);
  });

  // Привязка к каталогу сайта. Без аргумента-маркера проверка засчитывала бы файл
  // редиректов ПОСТОРОННЕГО vhost на том же хосте — старый шаблон такую привязку
  // имел, и при переписывании она была потеряна.
  it('файл редиректов чужого сайта не засчитывается', async () => {
    const foreign = `
server {
    server_name other.example;
    include /var/www/drugoysite/shared/nginx-redirects.conf;
}
`;
    expect(
      await runFn("redirects_include_active 'ikpk'", foreign),
      'засчитан include постороннего vhost — проверка не привязана к каталогу сайта',
    ).not.toBe(0);
  });

  it('свой файл редиректов с маркером засчитывается', async () => {
    expect(await runFn("redirects_include_active 'ikpk'", ACTIVE)).toBe(0);
  });
});

describe('health_check — фактический ответ сайта', () => {
  let server: Server;
  let other: Server;
  let port = 0;
  let otherPort = 0;
  // Что отдавать: меняется от теста к тесту.
  let mode: 'ok' | 'redirect' | 'error' | 'redirect-same-host' = 'ok';

  beforeAll(async () => {
    // Второй сервер — ЖИВОЙ и отдаёт 200. Прежняя версия теста редиректила на
    // `example.invalid`, который не резолвится, поэтому «редирект отвергнут»
    // получалось из-за недостижимости адреса, а не из-за проверки. Проверено
    // запуском: с живым чужим хостом старая функция возвращала 0.
    other = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>совсем другой сайт</title>');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    otherPort = (other.address() as { port: number }).port;

    server = createServer((req, res) => {
      if (mode === 'redirect') {
        // Чужой хост, отвечающий 200: localhost и 127.0.0.1 — разные имена хоста.
        res.writeHead(301, { Location: `http://localhost:${otherPort}/` });
        res.end();
        return;
      }
      // Штатный случай: редирект в пределах своего хоста (аналог 80 → 443).
      // Редиректим только корень, иначе цель редиректа вернула бы 301 на себя же
      // и curl упёрся бы в петлю — тест падал бы, ничего не проверив.
      if (mode === 'redirect-same-host' && req.url === '/') {
        res.writeHead(301, { Location: `http://127.0.0.1:${port}/landing` });
        res.end();
        return;
      }
      if (mode === 'error') {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>ok</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => other.close(() => resolve()));
  });

  it('отвечающий сайт проходит проверку', async () => {
    mode = 'ok';
    expect(await runFn(`health_check http://127.0.0.1:${port}/`)).toBe(0);
  });

  // Ключевой тест: чужой хост ЖИВОЙ и отдаёт 200, поэтому красное берётся из самой
  // проверки, а не из недостижимости адреса.
  it('редирект на чужой хост, отдающий 200, НЕ считается успешной проверкой', async () => {
    mode = 'redirect';
    expect(
      await runFn(`health_check http://127.0.0.1:${port}/`),
      'проверка засчитала 200, полученный с другого сайта, куда увёл редирект',
    ).not.toBe(0);
  });

  // Обратная сторона: штатный редирект в пределах своего хоста (80 → 443) обязан
  // проходить, иначе проверка сломает деплой сразу после появления certbot.
  it('редирект в пределах своего хоста проходит', async () => {
    mode = 'redirect-same-host';
    expect(
      await runFn(`health_check http://127.0.0.1:${port}/`),
      'штатный редирект на своём же хосте отвергнут — проверка сломает деплой после certbot',
    ).toBe(0);
  });

  it('ошибка сервера роняет проверку', async () => {
    mode = 'error';
    expect(await runFn(`health_check http://127.0.0.1:${port}/`)).not.toBe(0);
  });
});
