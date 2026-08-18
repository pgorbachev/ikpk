import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('deploy-web.sh — адрес сайта отделён от ssh-цели', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'deploy-web.sh'), 'utf-8');

  // Проверка идёт ПОСЛЕ переключения релиза, поэтому ошибка адреса стоит ложного
  // «деплой провален» на исправной выкладке. Аргумент скрипта — ssh-цель (runbook
  // зовёт его с IP), и совпадает с адресом сайта только пока нет домена и TLS.
  it('health-check идёт по SITE_URL, а не по ssh-хосту', () => {
    expect(
      /health_check\s+"\$SITE_URL"|health_check\s+"\$\{SITE_URL\}"/.test(src),
      'health-check зовётся не по SITE_URL — после появления домена он сломается на исправном деплое',
    ).toBe(true);
    expect(
      /health_check\s+"http:\/\/\$\{HOST\}\//.test(src),
      'ssh-хост используется как адрес сайта',
    ).toBe(false);
  });

  it('SITE_URL по умолчанию собирается из хоста — текущий стенд без TLS работает', () => {
    expect(/SITE_URL="\$\{SITE_URL:-http:\/\/\$\{HOST\}\/\}"/.test(src)).toBe(true);
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

// ─── Гейты платёжной формы: адрес и секреты (задачи 6.1, 6.2; негативная 6.4) ──
//
// Проверяется ПОВЕДЕНИЕ функций на подставных каталогах сборки, а не текст скрипта:
// греп исходника утверждал бы, что гейт написан, но не что он что-то ловит. Каждая
// ветка отказа пройдена хотя бы раз — непройденная ветка такое же обещание, как
// непроверенный гейт.
describe('payment_endpoint_matches — адрес платёжной формы в сборке', () => {
  const mkDist = (html: string | null): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-dist-'));
    if (html !== null) writeFileSync(join(dir, 'index.html'), html, 'utf-8');
    return dir;
  };
  const page = (endpoint: string, demo: string) =>
    `<!doctype html><form data-payment-form data-payment-endpoint="${endpoint}" data-payment-demo="${demo}"></form>`;

  it('верный адрес и признак режима проходят', async () => {
    const dist = mkDist(page('https://api.ikpk.su', 'false'));
    expect(
      await runFn(`payment_endpoint_matches '${dist}' 'https://api.ikpk.su' 'false'`),
    ).toBe(0);
  });

  it('чужой адрес не проходит', async () => {
    const dist = mkDist(page('https://evil.example/pay', 'false'));
    expect(
      await runFn(`payment_endpoint_matches '${dist}' 'https://api.ikpk.su' 'false'`),
    ).not.toBe(0);
  });

  it('демо-адрес в боевом режиме не проходит', async () => {
    const dist = mkDist(page('https://demo-api.ikpk.invalid', 'true'));
    expect(
      await runFn(`payment_endpoint_matches '${dist}' 'https://api.ikpk.su' 'false'`),
    ).not.toBe(0);
  });

  it('похожий адрес не проходит: сверка буквальная, а не по образцу хоста', async () => {
    const dist = mkDist(page('https://api.ikpk.su.evil.example', 'false'));
    expect(
      await runFn(`payment_endpoint_matches '${dist}' 'https://api.ikpk.su' 'false'`),
    ).not.toBe(0);
  });

  it('верный адрес при неверном data-payment-demo не проходит', async () => {
    const dist = mkDist(page('https://api.ikpk.su', 'true'));
    expect(
      await runFn(`payment_endpoint_matches '${dist}' 'https://api.ikpk.su' 'false'`),
    ).not.toBe(0);
  });

  it('НЕТ атрибута вовсе — отказ, а не проход: проверять нечего', async () => {
    const dist = mkDist('<!doctype html><p>страница без формы оплаты</p>');
    expect(
      await runFn(`payment_endpoint_matches '${dist}' 'https://api.ikpk.su' 'false'`),
    ).not.toBe(0);
  });

  it('каталога сборки нет — отказ', async () => {
    expect(
      await runFn(`payment_endpoint_matches '/nonexistent-dist-ikpk' 'https://api.ikpk.su' 'false'`),
    ).not.toBe(0);
  });

  it('один верный адрес не покрывает второй неверный', async () => {
    const dist = mkDist(page('https://api.ikpk.su', 'false'));
    writeFileSync(join(dist, 'other.html'), page('https://evil.example/pay', 'false'), 'utf-8');
    expect(
      await runFn(`payment_endpoint_matches '${dist}' 'https://api.ikpk.su' 'false'`),
    ).not.toBe(0);
  });
});

describe('dist_has_no_secret_values — значения секретов в сборке', () => {
  const mkDist = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-dist-'));
    writeFileSync(join(dir, 'index.html'), body, 'utf-8');
    return dir;
  };

  it('чистая сборка проходит', async () => {
    const dist = mkDist('<!doctype html><p>без секретов</p>');
    expect(
      await runFn(`dist_has_no_secret_values '${dist}' 'YOOKASSA_SECRET_KEY=test_secret_value_42'`),
    ).toBe(0);
  });

  it('значение секрета в сборке — отказ', async () => {
    const dist = mkDist('<!doctype html><script>const k="test_secret_value_42";</script>');
    expect(
      await runFn(`dist_has_no_secret_values '${dist}' 'YOOKASSA_SECRET_KEY=test_secret_value_42'`),
    ).not.toBe(0);
  });

  it('ключ отпечатка ловится наравне с секретом оператора', async () => {
    const dist = mkDist('<!doctype html><script>const h="hmac_current_abc";</script>');
    expect(
      await runFn(
        `dist_has_no_secret_values '${dist}' 'YOOKASSA_SECRET_KEY=zzz' 'HMAC_KEY_CURRENT=hmac_current_abc'`,
      ),
    ).not.toBe(0);
  });

  it('утечка не в HTML тоже ловится: ищется весь каталог, не только *.html', async () => {
    const dist = mkDist('<!doctype html><p>чисто</p>');
    writeFileSync(join(dist, 'app.js'), 'const k="test_secret_value_42";', 'utf-8');
    expect(
      await runFn(`dist_has_no_secret_values '${dist}' 'YOOKASSA_SECRET_KEY=test_secret_value_42'`),
    ).not.toBe(0);
  });

  it('ни одного значения не передано — отказ, а не проход', async () => {
    const dist = mkDist('<!doctype html><p>без секретов</p>');
    expect(await runFn(`dist_has_no_secret_values '${dist}'`)).not.toBe(0);
  });

  it('пустое значение — отказ: искать нечего', async () => {
    const dist = mkDist('<!doctype html><p>без секретов</p>');
    expect(await runFn(`dist_has_no_secret_values '${dist}' 'HMAC_KEY_CURRENT='`)).not.toBe(0);
  });

  it('каталога сборки нет — отказ', async () => {
    expect(
      await runFn(`dist_has_no_secret_values '/nonexistent-dist-ikpk' 'YOOKASSA_SECRET_KEY=x'`),
    ).not.toBe(0);
  });
});
