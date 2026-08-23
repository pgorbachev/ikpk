import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { PAYMENT_ENDPOINT_BASE } from './helpers/payment-contract';

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
  // Ошибка потока гасится ОСОЗНАННО, до записи. Проверяемая функция вправе завершиться,
  // не дочитав ввод (`grep -q` выходит на первом совпадении, часть функций stdin не
  // читает вовсе), и тогда запись получает EPIPE. Без подписки это необработанная
  // ошибка процесса: vitest печатает «Unhandled Errors», шаг CI выходит с кодом 1 —
  // ПРИ ВСЕХ ЗЕЛЁНЫХ ТЕСТАХ. Так и случилось на прогоне 32559835666: «Tests 1027 passed»
  // и рядом «Errors 1 error». Сигнал при этом худший из возможных: красный шаг, по
  // которому не видно ни одного упавшего теста.
  //
  // Гасится именно ошибка ЗАПИСИ В ДОЧЕРНИЙ ПРОЦЕСС, а не результат проверки: код
  // выхода функции по-прежнему возвращается ниже и ни на что не подменяется.
  child.child.stdin?.on('error', () => {});
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

// ─── payment_endpoint_matches — блок СНЯТ задачей 6.14 ─────────────────────────
//
// Прежний блок (до этой правки — describe «payment_endpoint_matches — адрес платёжной
// формы в сборке») проверял функцию по УСТАРЕВШЕЙ матрице: третий аргумент — булев
// `data-payment-demo`, признак решением владельца 2026-08-18 удалён (design.md,
// Решение 13). Сама функция теперь ожидает РОЛЬ (`ci|preview|stand|prod`) третьим
// аргументом — прежние фикстуры (`data-payment-demo="..."`, без `data-payment-role`)
// сверяются с новым контрактом ошибочно: артефакт без объявленной роли — непройденная
// проверка при любой ожидаемой роли, поэтому «верный адрес» здесь стал бы отказом не по
// адресу, а по потерянной роли.
//
// Дублировать поведение здесь и там нельзя (AGENTS.md: «если над тем же предметом есть
// другая проверка, их ответы обязаны совпадать, либо расхождение названо») — полное,
// более строгое покрытие той же функции по НОВОЙ матрице уже есть в
// `deploy-checks-payment-role.test.ts` (роль в артефакте, роль не объявлена, ноль форм в
// установленном контуре, прежний булев признак без роли и т.д.), поэтому блок снят, а не
// переписан на месте.
//
// ДВА СЛУЧАЯ ИЗ СНЯТОГО БЛОКА ВОССТАНОВЛЕНЫ НИЖЕ под новой сигнатурой — не как копия, а
// потому что независимое ревью (2026-08-20) нашло у каждого предмет, для которого в
// `deploy-checks-payment-role.test.ts` нет отдельного случая, а этот файл — не защищённый
// красный тест этого change, и его можно расширять:
//  - F-13: буквальное сравнение адреса (`grep -vxF`), а не по образцу хоста — снятый блок
//    проверял это фикстурой-«двойником» (`https://api.ikpk.su.evil.example`); в новом
//    файле такого случая нет вовсе, только сравнение с ПОЛНОСТЮ другим доменом;
//  - F-3: опознавательный признак формы (`data-payment-form`) проверяется НЕЗАВИСИМО от
//    роли и эндпоинта — прежняя редакция читала только `data-payment-role`/
//    `data-payment-endpoint`, которые могли стоять на любом элементе без единой формы на
//    странице.
describe('payment_endpoint_matches — восстановленные случаи (F-3, F-13, независимое ревью)', () => {
  const mkDist = (html: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-dist-role-'));
    writeFileSync(join(dir, 'index.html'), html, 'utf-8');
    return dir;
  };
  const withForm = (base: string, role: string) =>
    `<!doctype html><html data-payment-role="${role}"><body>` +
    `<form data-payment-form data-payment-endpoint="${base}" hidden></form></body></html>`;

  it('F-13: похожий адрес (домен-двойник с суффиксом) не проходит — сверка буквальная, не по образцу хоста', async () => {
    const dist = mkDist(withForm(`${PAYMENT_ENDPOINT_BASE.stand}.evil.example`, 'stand'));
    expect(
      await runFn(`payment_endpoint_matches '${dist}' '${PAYMENT_ENDPOINT_BASE.stand}' 'stand'`),
    ).not.toBe(0);
  });

  it('F-3: роль и эндпоинт объявлены НЕ на <form> без единой формы на странице — отказ, а не проход', async () => {
    const dist = mkDist(
      `<!doctype html><html data-payment-role="stand"><body>` +
        `<div data-payment-endpoint="${PAYMENT_ENDPOINT_BASE.stand}"></div>` +
        `<p>формы нет вовсе</p></body></html>`,
    );
    expect(
      await runFn(`payment_endpoint_matches '${dist}' '${PAYMENT_ENDPOINT_BASE.stand}' 'stand'`),
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

// ─── Резервное копирование состояния платежей (задача 4.3a) ───────────────────
//
// Проверяется ПОВЕДЕНИЕ скрипта на подставных каталогах, а не его текст: греп по исходнику
// утверждал бы, что копирование написано, но не что копия появляется и что отказ наступает
// там, где копировать нечего. Ветви отказа пройдены каждая: нет каталога состояния, нет ни
// одного файла состояния.
describe('ikpk-payments-backup.sh — копия состояния платежей', () => {
  const BACKUP = join(ROOT, 'payments', 'deploy', 'ikpk-payments-backup.sh');

  const runBackup = async (data: string, backup: string, keep = '42'): Promise<number> => {
    try {
      await execFileAsync('bash', [BACKUP], {
        env: { ...process.env, PAYMENT_DATA_DIR: data, BACKUP_DIR: backup, KEEP_BACKUPS: keep },
      });
      return 0;
    } catch (err) {
      return (err as { code?: number }).code ?? 1;
    }
  };

  const mkData = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-state-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf-8');
    return dir;
  };

  it('копия появляется и совпадает с исходником', async () => {
    const data = mkData({ 'payments.json': '{"records":[{"requestId":"a"}]}' });
    const backup = mkdtempSync(join(tmpdir(), 'ikpk-backup-'));
    expect(await runBackup(data, backup)).toBe(0);
    const made = readdirSync(backup).filter((f) => f.endsWith('.payments.json'));
    expect(made.length, `в каталоге копий: ${readdirSync(backup).join(',')}`).toBe(1);
    expect(readFileSync(join(backup, made[0]!), 'utf-8')).toBe('{"records":[{"requestId":"a"}]}');
  });

  it('копируются все четыре файла состояния, а не только хранилище', async () => {
    const data = mkData({
      'payments.json': '{}',
      'verification-journal.json': '[]',
      'hmac-canary.json': '{}',
      'duplicate-tokens.json': '[]',
    });
    const backup = mkdtempSync(join(tmpdir(), 'ikpk-backup-'));
    expect(await runBackup(data, backup)).toBe(0);
    expect(readdirSync(backup).length).toBe(4);
  });

  it('незавершённых `.part` после успешной копии не остаётся', async () => {
    const data = mkData({ 'payments.json': '{}' });
    const backup = mkdtempSync(join(tmpdir(), 'ikpk-backup-'));
    await runBackup(data, backup);
    expect(readdirSync(backup).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('каталога состояния нет — ОТКАЗ, а не «копировать нечего»', async () => {
    const backup = mkdtempSync(join(tmpdir(), 'ikpk-backup-'));
    expect(await runBackup('/nonexistent-state-ikpk', backup)).not.toBe(0);
  });

  it('каталог есть, но файлов состояния в нём нет — ОТКАЗ', async () => {
    const data = mkData({ 'unrelated.txt': 'x' });
    const backup = mkdtempSync(join(tmpdir(), 'ikpk-backup-'));
    expect(await runBackup(data, backup)).not.toBe(0);
    expect(readdirSync(backup)).toEqual([]);
  });

  it('старые копии вытесняются по KEEP_BACKUPS, свежая остаётся', async () => {
    const data = mkData({ 'payments.json': '{"n":1}' });
    const backup = mkdtempSync(join(tmpdir(), 'ikpk-backup-'));
    for (const n of [1, 2, 3]) {
      writeFileSync(join(data, 'payments.json'), `{"n":${n}}`, 'utf-8');
      expect(await runBackup(data, backup, '2')).toBe(0);
      // Метка копии — с точностью до секунды, поэтому между прогонами нужна пауза,
      // иначе три копии получат одно имя и вытеснять будет нечего.
      await new Promise((r) => setTimeout(r, 1100));
    }
    const made = readdirSync(backup).filter((f) => f.endsWith('.payments.json'));
    expect(made.length, `копий осталось: ${made.join(',')}`).toBe(2);
    const newest = made.sort().at(-1)!;
    expect(readFileSync(join(backup, newest), 'utf-8')).toBe('{"n":3}');
  });
});

describe('ikpk-payments-backup.timer — интервал не дольше границы решения', () => {
  it('OnUnitActiveSec не больше 4 часов', () => {
    const timer = readFileSync(join(ROOT, 'payments', 'deploy', 'ikpk-payments-backup.timer'), 'utf-8');
    const raw = timer.match(/OnUnitActiveSec=(\S+)/)?.[1] ?? '';
    expect(raw, 'интервал не объявлен вовсе').toBeTruthy();
    const m = raw.match(/^(\d+)(s|min|h)$/);
    expect(m, `нераспознанный интервал: ${raw}`).toBeTruthy();
    const seconds = Number(m![1]) * (m![2] === 'h' ? 3600 : m![2] === 'min' ? 60 : 1);
    expect(seconds, `интервал ${raw} превышает 4 часа`).toBeLessThanOrEqual(4 * 3600);
  });

  it('таймер переживает простой хоста: Persistent=true', () => {
    const timer = readFileSync(join(ROOT, 'payments', 'deploy', 'ikpk-payments-backup.timer'), 'utf-8');
    expect(timer).toMatch(/^Persistent=true$/m);
  });
});
