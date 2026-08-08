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
});

describe('health_check — фактический ответ сайта', () => {
  let server: Server;
  let port = 0;
  // Что отдавать: меняется от теста к тесту.
  let mode: 'ok' | 'redirect' | 'error' = 'ok';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (mode === 'redirect') {
        // Ровно то, что появится на сервере после certbot: 80 → 443.
        res.writeHead(301, { Location: 'https://example.invalid/' });
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
  });

  it('отвечающий сайт проходит проверку', async () => {
    mode = 'ok';
    expect(await runFn(`health_check http://127.0.0.1:${port}/`)).toBe(0);
  });

  it('редирект НЕ считается успешной проверкой', async () => {
    mode = 'redirect';
    expect(
      await runFn(`health_check http://127.0.0.1:${port}/`),
      '301 принят за рабочий сайт: проверка вышла с нулём, ни разу не открыв страницу',
    ).not.toBe(0);
  });

  it('ошибка сервера роняет проверку', async () => {
    mode = 'error';
    expect(await runFn(`health_check http://127.0.0.1:${port}/`)).not.toBe(0);
  });
});
