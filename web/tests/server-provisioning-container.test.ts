/**
 * Красные тесты change `server-provisioning`: сценарии, предмет которых — состояние
 * живого хоста. Цель проверки — одноразовый контейнер Debian 12 (design.md, Решение 2),
 * поднимаемый и уничтожаемый тестом.
 *
 * Что контейнер НЕ воспроизводит и где это сказано вслух:
 * - настоящий systemd (см. `tests/helpers/provision-target.ts`): вызовы `systemctl`
 *   записываются заглушкой, поэтому проверяется факт вызова и текст `unit`-файла;
 * - certbot с настоящим доменом — исключение 1 в `tasks.md`, раздел 0;
 * - объём данных при резервном копировании — исключение 2 там же.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { ProvisionTarget, ensureImage } from './helpers/provision-target';
import {
  DEFAULT_ENVIRONMENT,
  changeSummary,
  contractSecrets,
  listValue,
  readDeclared,
  requireKey,
  revisionFile,
} from './helpers/provision-contract';

const T = 240_000;
const started: ProvisionTarget[] = [];
const probes: string[] = [];

function target(): ProvisionTarget {
  const t = ProvisionTarget.start();
  started.push(t);
  return t;
}

beforeAll(() => {
  ensureImage();
}, 600_000);

afterEach(() => {
  while (started.length) started.pop()!.stop();
  while (probes.length) ProvisionTarget.stopProbe(probes.pop()!);
});

// Общее окружение НЕСЁТ обязательный секрет: спека требует безусловного отказа без него, и
// без секрета здесь фикстура требовала бы от одного и того же вызова одновременно упасть
// (сценарий «секрет отсутствует») и пройти (все остальные ~30). Ни одна реализация этого не
// может, и это дефект фикстуры, а не реализации — сценарий отсутствия ниже собирает своё
// окружение сам.
// Перечень секретов берётся из ОБЪЯВЛЕННОГО СОСТОЯНИЯ, а не переписывается здесь
// литералом. Литерал уже отстал один раз: SECRET_NAMES вырос с одного имени до шести,
// фикстура осталась с одним, и провижининг во ВСЕХ сценариях падал кодом 4 («секрет
// отсутствует») — то есть набор проверял отказ вместо предмета каждого сценария.
const ENV: Record<string, string> = {
  ENVIRONMENT: DEFAULT_ENVIRONMENT,
  ...contractSecrets(DEFAULT_ENVIRONMENT),
};

/**
 * Правка ОБЪЯВЛЕННОГО СОСТОЯНИЯ внутри цели: политика, ревизия и адреса живут в
 * `deploy/environments/<env>.env`, а не в окружении процесса, — так требует спека
 * («политика читается из объявленного состояния»). Через окружение передаются только
 * явный вход (обход отказа) и секреты.
 */
function setDeclared(t: ProvisionTarget, key: string, value: string): void {
  t.execOrThrow(
    `f=/repo/deploy/environments/${DEFAULT_ENVIRONMENT}.env; mkdir -p "$(dirname "$f")"; touch "$f"; ` +
      `sed -i "/^${key}=/d" "$f"; printf '%s=%s\n' ${JSON.stringify(key)} ${JSON.stringify(value)} >> "$f"`,
  );
}

/** Признак «раздача отвечает», измеренный снаружи цели. */
function answersFromOutside(t: ProvisionTarget): { code: string; body: string } {
  const ip = t.ip;
  const run = ProvisionTarget.probe(
    `curl -s -m 3 -o /tmp/body -w '%{http_code}' http://${ip}/ ; echo; cat /tmp/body`,
  );
  const [code, ...rest] = run.stdout.split('\n');
  return { code: code.trim(), body: rest.join('\n') };
}

function publish(t: ProvisionTarget, body: string): void {
  t.execOrThrow('mkdir -p /var/www/ikpk/current');
  t.write('/var/www/ikpk/current/index.html', body);
}

describe('server-provisioning: провижининг идемпотентен и повторно применим', () => {
  it('Сценарий: повторный запуск на приведённом сервере', async () => {
    const t = target();
    const first = t.provision(ENV);
    expect(first.status, `первый прогон упал:\n${first.output}`).toBe(0);
    const second = t.provision(ENV);
    expect(second.status, `повторный прогон не завершился успехом:\n${second.output}`).toBe(0);
    const summary = changeSummary(second.output);
    expect(summary.changed, `повторный прогон не назвал число изменений:\n${second.output}`).toBe(0);
    expect(
      summary.unchanged,
      'повторный прогон не назвал, что уже соответствовало объявленному: ' +
        '«ничего не изменилось» и «ничего не проверялось» неразличимы',
    ).toBeGreaterThan(0);
  }, T);

  it('Сценарий: запуск после прерывания', async () => {
    const t = target();
    expect(t.provision(ENV).status).toBe(0);
    // прерывание внутри шага, записывающего файл: конфигурация обрезана на середине
    t.execOrThrow('head -c 200 /etc/nginx/sites-available/ikpk.conf > /tmp/half && mv /tmp/half /etc/nginx/sites-available/ikpk.conf');
    t.execOrThrow(`rm -f ${revisionFile()}`);
    const again = t.provision(ENV);
    expect(again.status, `прогон после прерывания не довёл состояние:\n${again.output}`).toBe(0);
    expect(t.exec('nginx -t').status, 'конфигурация осталась обрезанной').toBe(0);
    expect(t.read('/etc/nginx/sites-available/ikpk.conf') ?? '').toContain('try_files');
  }, T);

  it('Сценарий: объявленное состояние изменено', async () => {
    const t = target();
    expect(t.provision(ENV).status).toBe(0);
    const changed = t.provision({ ...ENV, DOMAIN: 'other.example' });
    expect(changed.status, `прогон с новым значением упал:\n${changed.output}`).toBe(0);
    expect(t.read('/etc/nginx/sites-available/ikpk.conf') ?? '').toContain('server_name other.example');
    const summary = changeSummary(changed.output);
    expect(summary.changed, 'изменение не названо числом').toBeGreaterThan(0);
    expect(changed.output, 'изменение не названо предметно').toMatch(/server_name|DOMAIN|vhost/i);
  }, T);

  it('Сценарий: сервер приведён не этим артефактом', async () => {
    const t = target();
    t.write(
      '/etc/nginx/sites-available/ikpk.conf',
      'server {\n  listen 80;\n  server_name hand.made;\n  # поставлено руками\n}\n',
    );
    const run = t.provision(ENV);
    const policy = readDeclared(DEFAULT_ENVIRONMENT).get('POLICY_VHOST');
    if (policy === 'refuse') {
      expect(run.status, 'политика refuse: провижининг обязан отказать').not.toBe(0);
      expect(run.output, 'постороннее состояние не названо').toMatch(/hand\.made|поставлено руками/);
    } else {
      expect(run.status, `политика merge: прогон упал:\n${run.output}`).toBe(0);
      expect(run.output, 'изменения не названы').toMatch(/changed=/);
      expect(t.read('/etc/nginx/sites-available/ikpk.conf') ?? '', 'постороннее присвоено молча').toContain(
        'поставлено руками',
      );
    }
  }, T);

  it('Сценарий: попытка применить более старую ревизию', async () => {
    const t = target();
    setDeclared(t, 'PROVISION_REVISION', '2026-09-05.2');
    expect(t.provision(ENV).status).toBe(0);
    setDeclared(t, 'PROVISION_REVISION', '2026-09-05.1');
    const older = t.provision(ENV);
    expect(older.status, 'откат на более старую ревизию не отклонён').not.toBe(0);
    expect(older.output, 'не названы обе ревизии').toContain('2026-09-05.2');
    expect(older.output).toContain('2026-09-05.1');
  }, T);

  it('Сценарий: ревизия записывается после применения', async () => {
    const t = target();
    setDeclared(t, 'PROVISION_REVISION', 'rev-applied');
    const ok = t.provision(ENV);
    expect(ok.status, ok.output).toBe(0);
    expect((t.read(revisionFile()) ?? '').trim(), 'применённая ревизия не записана').toContain('rev-applied');

    // прогон, прерванный до завершения, не оставляет записанной ревизии от этого запуска
    const fresh = target();
    fresh.write('/etc/nginx/sites-available/ikpk.conf', 'server {\n  listen 80;\n  # постороннее\n}\n');
    // Политика задаётся ЯВНО: предмет этого сценария — «прерванный прогон не оставляет
    // ревизии», а не выбор умолчания. Умолчание для vhost по `design.md` — `merge` (из-за
    // 443-блока certbot), поэтому опора на него давала бы приведение вместо прерывания, и
    // сценарий проверял бы не то, что заявлено.
    setDeclared(fresh, 'POLICY_VHOST', 'refuse');
    setDeclared(fresh, 'PROVISION_REVISION', 'rev-refused');
    const refused = fresh.provision(ENV);
    expect(refused.status, 'прогон должен был прерваться на постороннем состоянии').not.toBe(0);
    expect(fresh.read(revisionFile()) ?? '', 'ревизия записана прогоном, который не завершился').not.toContain(
      'rev-refused',
    );
  }, T);

  it('Сценарий: записанной ревизии нет', async () => {
    const t = target();
    expect(t.exec(`test -e ${revisionFile()}`).status, 'на чистой машине записи быть не должно').not.toBe(0);
    setDeclared(t, 'PROVISION_REVISION', 'rev-first');
    const run = t.provision(ENV);
    expect(run.status, `отсутствие записанной ревизии не должно быть отказом:\n${run.output}`).toBe(0);
    expect((t.read(revisionFile()) ?? '').trim()).toContain('rev-first');
  }, T);
});

describe('server-provisioning: состояние, созданное вне провижининга, не затирается молча', () => {
  const FOREIGN_443 = [
    'server {',
    '  listen 443 ssl;',
    '  server_name stand.local;',
    '  ssl_certificate /etc/letsencrypt/live/stand.local/fullchain.pem; # managed by Certbot',
    '  root /var/www/ikpk/current;',
    '}',
  ].join('\n');

  function withForeignVhost(t: ProvisionTarget): void {
    t.write(
      '/etc/nginx/sites-available/ikpk.conf',
      `server {\n  listen 80;\n  server_name stand.local;\n  root /var/www/ikpk/current;\n  index index.html;\n}\n${FOREIGN_443}\n`,
    );
  }

  it('Сценарий: предмет с политикой merge приводится без замены', async () => {
    const t = target();
    publish(t, 'PUBLISHED');
    withForeignVhost(t);
    const run = t.provision(ENV);
    expect(run.status, `слияние не выполнено:\n${run.output}`).toBe(0);
    const vhost = t.read('/etc/nginx/sites-available/ikpk.conf') ?? '';
    expect(vhost, 'названное постороннее включение снесено').toContain('managed by Certbot');
    expect(vhost, 'объявленная директива не приведена к объявленному значению').toMatch(/include .*nginx-redirects\.conf;/);
    expect(vhost, 'объявленная директива не приведена к объявленному значению').toContain('gzip on;');
  }, T);

  it('Сценарий: предмет с политикой refuse останавливает провижининг', async () => {
    const t = target();
    withForeignVhost(t);
    const before = t.execOrThrow('md5sum /etc/nginx/sites-available/ikpk.conf').split(' ')[0];
    setDeclared(t, 'POLICY_VHOST', 'refuse');
    const run = t.provision(ENV);
    expect(run.status, 'политика refuse не остановила провижининг').not.toBe(0);
    expect(run.output, 'постороннее состояние не названо').toMatch(/Certbot|443/);
    const after = t.execOrThrow('md5sum /etc/nginx/sites-available/ikpk.conf').split(' ')[0];
    expect(after, 'предмет изменён при отказе').toBe(before);
  }, T);

  it('Сценарий: политика читается из объявленного состояния', async () => {
    const first = 'merge';
    const second = 'refuse';
    expect(first, 'политика между прогонами не менялась — непройденная проверка').not.toBe(second);

    const merge = target();
    withForeignVhost(merge);
    setDeclared(merge, 'POLICY_VHOST', first);
    const mergeRun = merge.provision(ENV);

    const refuse = target();
    withForeignVhost(refuse);
    setDeclared(refuse, 'POLICY_VHOST', second);
    const refuseRun = refuse.provision(ENV);
    expect(mergeRun.status, `merge:\n${mergeRun.output}`).toBe(0);
    expect(refuseRun.status, `refuse:\n${refuseRun.output}`).not.toBe(0);
  }, T);

  it('Сценарий: обход отказа снимает копию', async () => {
    const t = target();
    withForeignVhost(t);
    setDeclared(t, 'POLICY_VHOST', 'refuse');
    const run = t.provision({ ...ENV, FORCE_VHOST: '1' });
    expect(run.status, `обход отказа упал:\n${run.output}`).toBe(0);
    const paths = [...run.output.matchAll(/(\/[^\s'"]+\.bak[^\s'"]*)/g)].map((m) => m[1]);
    expect(paths.length, `путь резервной копии не назван в выводе:\n${run.output}`).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.includes('*'), `в выводе назван образец «${p}», а не путь резервной копии`).toBe(false);
      expect(t.exec(`test -s ${JSON.stringify(p)}`).status, `названная копия ${p} отсутствует или пуста`).toBe(0);
      expect(t.read(p) ?? '', 'копия снята не с того предмета').toContain('managed by Certbot');
    }
  }, T);

  it('Сценарий: обход отказа не снимает непрерывность', async () => {
    const t = target();
    publish(t, 'PUBLISHED');
    withForeignVhost(t);
    t.execOrThrow('nginx || true');
    setDeclared(t, 'POLICY_VHOST', 'refuse');
    setDeclared(t, 'SITE_ADDRESS', 'https://stand.local/');
    const run = t.provision({ ...ENV, FORCE_VHOST: '1' });
    expect(
      run.status,
      'обход, приводящий к потере ответа по объявленному адресу, обязан быть отклонён',
    ).not.toBe(0);
    expect(run.output, 'причина отказа не названа').toMatch(/https|443|непрерывн|ответ/i);
    expect(t.read('/etc/nginx/sites-available/ikpk.conf') ?? '', 'TLS-блок снесён').toContain('managed by Certbot');
  }, T);

  it('Сценарий: сертификаты переживают провижининг — ИСКЛЮЧЕНИЕ 1 (ручная приёмка)', () => {
    // tasks.md, раздел 0, пункт 0.3: нужен настоящий домен и настоящий сертификат.
    // Автоматической проверки нет намеренно; проверяется бухгалтерия исключения —
    // свойство объявлено ручным и у него есть свидетельство, привязанное к ревизии.
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const klass = declared.get('PROPERTY_TLS_SURVIVES_CLASS');
    expect(klass, 'свойство «TLS переживает провижининг» не объявлено').toBeDefined();
    expect(klass, 'исключение 1 обязано быть классом «проверяется вне автоматического прогона»').toBe('manual');
    expect(
      declared.get('PROPERTY_TLS_SURVIVES_EVIDENCE'),
      'у ручного свойства нет свидетельства — сценарий считается непроверенным, а не пройденным',
    ).toBeTruthy();
  });
});

describe('server-provisioning: секреты не утекают', () => {
  function secretName(): string {
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const names = listValue(declared, 'SECRET_NAMES');
    expect(names.length, 'перечень имён секретов пуст — корпус проверки пуст').toBeGreaterThan(0);
    return names[0];
  }

  it('Сценарий: секрет отсутствует', async () => {
    const t = target();
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    // Именно здесь окружение БЕЗ секрета — предмет этого сценария.
    const run = t.provision({ ENVIRONMENT: DEFAULT_ENVIRONMENT });
    expect(run.status, 'провижининг без обязательного секрета обязан отказать').not.toBe(0);
    expect(run.output, 'недостающий секрет не назван').toContain(secretName());
    const file = requireKey(declared, DEFAULT_ENVIRONMENT, 'SECRET_FILE');
    expect(t.exec(`test -e ${JSON.stringify(file)}`).status, 'состояние, зависящее от секрета, создано').not.toBe(0);
  }, T);

  it('Сценарий: секрет не попадает в вывод', async () => {
    const t = target();
    const name = secretName();
    const sentinel = 'SENTINEL-3f9c1a-DO-NOT-LEAK';
    const run = t.provision({ ...ENV, [name]: sentinel });
    expect(sentinel, 'контрольного значения не было в окружении — непройденная проверка').toMatch(/SENTINEL/);
    expect(run.status, `прогон с секретом упал:\n${run.output}`).toBe(0);
    expect(run.output.includes(sentinel), 'контрольное значение секрета попало в вывод').toBe(false);
    const grep = t.exec(
      `grep -rl ${JSON.stringify(sentinel)} /var/log /root /tmp /repo 2>/dev/null || true`,
    );
    expect(grep.stdout.trim(), 'контрольное значение найдено в логах или артефактах').toBe('');
    // Проверка утечки в argv не должна САМА нести секрет в argv, иначе она считает себя.
    // Снятие в файл этого не решает: обёртка `bash -lc '…grep "<секрет>"…'` тоже процесс, и
    // `ps` снимает её же — счётчик остаётся ненулевым при отсутствии утечки. Поэтому значение
    // читается ВНУТРИ контейнера из файла секрета в переменную: в командной строке остаётся
    // только путь.
    const secretFile = requireKey(readDeclared(DEFAULT_ENVIRONMENT), DEFAULT_ENVIRONMENT, 'SECRET_FILE');
    const ps = t.exec(
      `v=$(cut -d= -f2- ${JSON.stringify(secretFile)} | head -1); ` +
        `ps -eo args > /tmp/ps-snapshot.txt 2>/dev/null; ` +
        `if [ -n "$v" ]; then grep -c -- "$v" /tmp/ps-snapshot.txt || true; else echo НЕТ-СЕКРЕТА-НА-ДИСКЕ; fi`,
    );
    expect(ps.stdout.trim(), 'секрет виден в аргументах команд').toBe('0');
  }, T);

  it('Сценарий: секрет в покое ограничен по доступу', async () => {
    const t = target();
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const name = secretName();
    const file = requireKey(declared, DEFAULT_ENVIRONMENT, 'SECRET_FILE');
    const owner = requireKey(declared, DEFAULT_ENVIRONMENT, 'SECRET_OWNER');
    const mode = requireKey(declared, DEFAULT_ENVIRONMENT, 'SECRET_MODE');
    const run = t.provision({ ...ENV, [name]: 'value-at-rest' });
    expect(run.status, run.output).toBe(0);
    expect(t.exec(`test -f ${JSON.stringify(file)}`).status, 'файла секрета нет — непройденная проверка').toBe(0);
    const stat = t.execOrThrow(`stat -c '%U %a' ${JSON.stringify(file)}`).trim();
    expect(stat).toBe(`${owner} ${mode}`);
    const foreign = t.exec(
      `id -u nobody >/dev/null 2>&1 && su -s /bin/bash nobody -c 'cat ${file}' >/dev/null 2>&1; echo $?`,
    );
    expect(foreign.stdout.trim(), 'секрет читается учётной записью, которой он не предназначен').not.toBe('0');
  }, T);

  it('Сценарий: секрет изменён', async () => {
    const t = target();
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const name = secretName();
    const file = requireKey(declared, DEFAULT_ENVIRONMENT, 'SECRET_FILE');
    expect(t.provision({ ...ENV, [name]: 'value-one' }).status).toBe(0);
    const rotated = t.provision({ ...ENV, [name]: 'value-two' });
    expect(rotated.status, rotated.output).toBe(0);
    expect(changeSummary(rotated.output).changed, 'ротация секрета не признана изменением состояния').toBeGreaterThan(0);
    expect(rotated.output, 'факт изменения секрета не назван').toContain(name);
    expect(rotated.output.includes('value-two'), 'значение секрета попало в вывод').toBe(false);
    expect(t.read(file) ?? '', 'новое значение не применено').toContain('value-two');
  }, T);
});

describe('server-provisioning: юнит службы принимается настоящим systemd', () => {
  /**
   * Эти три проверки — регресс на дефекты, которые контейнер прежде не видел, а живая
   * машина показала сразу. Предмет у них общий: юнит, ПРИНЯТЫЙ systemd, а не юнит,
   * совпавший с ожидаемым текстом.
   */

  it('Сценарий: ни одна директива юнита не отброшена', async () => {
    const t = target();
    expect(t.provision(ENV).status).toBe(0);
    const unit = '/etc/systemd/system/ikpk-cms.service';
    expect(t.read(unit) ?? '', 'юнит не создан — проверять нечего').toContain('[Service]');
    const verify = t.exec(`systemd-analyze verify ${unit} 2>&1 || true`);
    // Код возврата у systemd-analyze нулевой и в случае отброшенной директивы (проверено
    // на стенде), поэтому признак — текст, а не код. Директива в неверной секции не
    // отвергается, а МОЛЧА игнорируется: именно так предел перезапусков оказался
    // декоративным, и счётчик дошёл до 185.
    expect(verify.output, 'systemd отбросил директиву юнита').not.toMatch(/Unknown (key|section|lvalue)/);
  }, T);

  it('Сценарий: служба может писать в свой домашний каталог и каталог данных', async () => {
    const t = target();
    expect(t.provision(ENV).status).toBe(0);
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const account = requireKey(declared, DEFAULT_ENVIRONMENT, 'SERVICE_ACCOUNT');
    const dataDir = requireKey(declared, DEFAULT_ENVIRONMENT, 'CMS_DATA_DIR');
    const unit = t.read('/etc/systemd/system/ikpk-cms.service') ?? '';
    // Учётная запись создаётся без домашнего каталога, а приложение туда пишет: без HOME
    // старт падает с EACCES на mkdir /home/<служба>.
    expect(unit, 'HOME не объявлен — служба будет писать в несуществующий /home').toContain('Environment=HOME=');
    const owner = t.execOrThrow(`stat -c '%U' ${dataDir}`).trim();
    expect(owner, 'каталог данных не принадлежит службе — база в нём не создастся').toBe(account);
    const probe = t.exec(`setpriv --reuid=${account} --regid=${account} --clear-groups touch ${dataDir}/.write-probe && echo ok`);
    expect(probe.stdout.trim(), 'служба не может писать в каталог данных').toBe('ok');
  }, T);
});

describe('server-provisioning: служба системы управления не доступна снаружи напрямую', () => {
  /** Годится любая программа на объявленном адресе (спека, требование об объёме). */
  function startDeclaredService(t: ProvisionTarget, addr: string): void {
    const [host, port] = addr.split(':');
    t.execOrThrow(
      `nohup python3 -c "import socket;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('${host}',${port}));s.listen(5)\nwhile True:\n c,_=s.accept();c.recv(1024);c.send(b'HTTP/1.1 200 OK\\r\\nContent-Length: 7\\r\\n\\r\\nSERVICE');c.close()" >/tmp/svc.log 2>&1 & sleep 1`,
    );
  }

  it('Сценарий: порт службы закрыт снаружи', async () => {
    const t = target();
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const addr = requireKey(declared, DEFAULT_ENVIRONMENT, 'SERVICE_ADDR');
    expect(t.provision(ENV).status).toBe(0);
    startDeclaredService(t, addr);
    const port = addr.split(':')[1];
    const local = t.exec(`curl -s -m 2 -o /dev/null -w '%{http_code}' http://${addr}/`);
    expect(local.stdout.trim(), 'служба не запущена — непройденная проверка, а не закрытость').toBe('200');
    const outside = ProvisionTarget.probe(`curl -s -m 3 -o /dev/null -w '%{http_code}' http://${t.ip}:${port}/ || echo REFUSED`);
    expect(outside.stdout, `порт службы отвечает снаружи (${t.ip}:${port})`).toMatch(/REFUSED|^000/);
  }, T);

  it('Сценарий: слушающие сокеты сверены с перечнем', async () => {
    const t = target();
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    // `ss` печатает адрес «любой интерфейс» по-разному: на живом стенде — `0.0.0.0:80`
    // (проверено по ssh), в контейнере — `*:80`. Это одна и та же запись, поэтому сравнивать
    // надо нормализованные формы, иначе тест падает на различии нотации, а не на дефекте.
    const normalizeSocket = (value: string): string =>
      value.replace(/^\*:/, '0.0.0.0:').replace(/^\[::\]:/, '[::]:');
    const allow = new Set(listValue(declared, 'LISTEN_ALLOWLIST').map(normalizeSocket));
    expect(allow.size, 'объявленный перечень слушающих сокетов пуст').toBeGreaterThan(0);
    expect(t.provision(ENV).status).toBe(0);
    const addr = requireKey(declared, DEFAULT_ENVIRONMENT, 'SERVICE_ADDR');
    startDeclaredService(t, addr);
    const sockets = t
      .execOrThrow("ss -H -ltn | awk '{print $4}'")
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(sockets.length, 'перечень фактически слушающих сокетов пуст — непройденная проверка').toBeGreaterThan(0);
    const unexpected = sockets.filter((s) => !allow.has(normalizeSocket(s)));
    for (const socket of unexpected) {
      const port = socket.split(':').pop();
      const outside = ProvisionTarget.probe(
        `curl -s -m 3 -o /dev/null -w '%{http_code}' http://${t.ip}:${port}/ || echo REFUSED`,
      );
      expect(outside.stdout, `сокет ${socket} вне объявленного перечня доступен снаружи`).toMatch(/REFUSED|^000/);
    }
  }, T);

  it('Сценарий: служба доступна через сервер раздачи', async () => {
    const t = target();
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const addr = requireKey(declared, DEFAULT_ENVIRONMENT, 'SERVICE_ADDR');
    const path = declared.get('SERVICE_PROXY_PATH') ?? '/admin';
    // Предмет сценария — САМА возможность отдавать службу через сервер раздачи. На стенде
    // проксирование объявлено ВЫКЛЮЧЕННЫМ (пустой SERVICE_PROXY_SNIPPET: админка не должна
    // быть доступна заказчику до появления журнала происхождения), поэтому проверка
    // включает его в объявленном состоянии цели явно. Без этого сценарий проверял бы не
    // возможность, а текущий выбор стенда — и падал бы, подтверждая ровно то, что объявлено.
    setDeclared(t, 'SERVICE_PROXY_SNIPPET', '/etc/nginx/snippets/ikpk-cms.conf');
    expect(t.provision(ENV).status).toBe(0);
    startDeclaredService(t, addr);
    const local = t.exec(`curl -s -m 2 -o /dev/null -w '%{http_code}' http://${addr}/`);
    expect(local.stdout.trim(), 'на объявленном адресе ничего не слушало — непройденная проверка').toBe('200');
    const outside = ProvisionTarget.probe(`curl -s -m 3 http://${t.ip}${path}`);
    expect(outside.stdout, 'обращение снаружи не доходит до службы через сервер раздачи').toContain('SERVICE');
  }, T);
});

describe('server-provisioning: резервная копия предшествует разрушающим действиям', () => {
  it('Сценарий: разрушающее действие без копии', async () => {
    const t = target();
    t.write('/etc/nginx/sites-available/ikpk.conf', 'server {\n  listen 80;\n  # постороннее\n}\n');
    const before = t.execOrThrow('md5sum /etc/nginx/sites-available/ikpk.conf').split(' ')[0];
    // Снятие копии невозможно: каталог копий не создать. `chmod 500` для этого не годится —
    // провижининг идёт под root, а root биты доступа игнорирует, и `mkdir -p` проходит. Делаем
    // родителя ОБЫЧНЫМ ФАЙЛОМ: `mkdir` внутрь файла не может даже root («Not a directory»).
    t.execOrThrow('rm -rf /var/backups/ikpk && mkdir -p /var/backups && : > /var/backups/ikpk');
    setDeclared(t, 'BACKUP_DIR', '/var/backups/ikpk/denied');
    const run = t.provision({ ...ENV, FORCE_VHOST: '1' });
    expect(run.status, 'разрушающее действие выполнено без снятой копии').not.toBe(0);
    expect(run.output, 'причина не названа').toMatch(/копи|backup/i);
    expect(t.execOrThrow('md5sum /etc/nginx/sites-available/ikpk.conf').split(' ')[0]).toBe(before);
  }, T);

  it('Сценарий: копия снята, но пуста', async () => {
    const t = target();
    // предмет нулевого размера: копия снимется с кодом 0 и будет пустой
    t.write('/etc/nginx/sites-available/ikpk.conf', '');
    const run = t.provision({ ...ENV, FORCE_VHOST: '1' });
    expect(
      run.status,
      'копия нулевого размера при коде возврата 0 принята за снятую — разрушающее действие выполнено',
    ).not.toBe(0);
    expect(run.output, 'признак непустоты копии не назван').toMatch(/пуст|нулев|empty|size/i);
  }, T);

  it('Сценарий: копия свежая', async () => {
    const t = target();
    t.write('/etc/nginx/sites-available/ikpk.conf', 'server {\n  listen 80;\n  # первая\n}\n');
    const first = t.provision({ ...ENV, FORCE_VHOST: '1' });
    expect(first.status, first.output).toBe(0);
    const stale = t.execOrThrow('ls /etc/nginx/sites-available/*.bak* | head -1').trim();
    expect(stale, 'копия первого прогона не найдена').not.toBe('');
    t.execOrThrow(`touch -d '2020-01-01' ${JSON.stringify(stale)}`);
    t.write('/etc/nginx/sites-available/ikpk.conf', 'server {\n  listen 80;\n  # вторая\n}\n');
    const startedAt = Number(t.execOrThrow('date +%s').trim());
    const second = t.provision({ ...ENV, FORCE_VHOST: '1' });
    expect(second.status, second.output).toBe(0);
    const used = [...second.output.matchAll(/(\/[^\s'"]+\.bak[^\s'"]*)/g)].map((m) => m[1]);
    expect(used.length, 'использованная копия не названа в выводе').toBeGreaterThan(0);
    for (const p of used) {
      expect(p.includes('*'), `в выводе назван образец «${p}», а не путь использованной копии`).toBe(false);
      const stat = t.exec(`stat -c %Y ${JSON.stringify(p)}`);
      expect(stat.status, `названной копии ${p} на сервере нет`).toBe(0);
      expect(Number(stat.stdout.trim()), `названная копия ${p} снята не в этом запуске`).toBeGreaterThanOrEqual(
        startedAt,
      );
    }
  }, T);

  it('Сценарий: восстановление подтверждается сравнением', async () => {
    const t = target();
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const restore = requireKey(declared, DEFAULT_ENVIRONMENT, 'RESTORE_CMD');
    expect(t.provision(ENV).status).toBe(0);
    publish(t, 'ORIGINAL');
    const backup = t.provision({ ...ENV, BACKUP_ONLY: '1' });
    expect(backup.status, `снятие копии упало:\n${backup.output}`).toBe(0);
    publish(t, 'DAMAGED');
    const run = t.exec(`bash -lc ${JSON.stringify(restore)}`, ENV);
    expect(run.status, `восстановление упало:\n${run.output}`).toBe(0);
    const compared = Number((run.output.match(/^\s*compared\s*=\s*(\d+)\s*$/m) ?? [])[1] ?? '0');
    expect(compared, 'сравнение не выполнило ни одного сопоставления — непройденная проверка').toBeGreaterThan(0);
    expect(run.output, 'предикат сравнения не назван').toMatch(/predicate=|предикат/i);
    expect(t.read('/var/www/ikpk/current/index.html') ?? '').toContain('ORIGINAL');
  }, T);

  it('Сценарий: объём данных при копировании — ИСКЛЮЧЕНИЕ 2 (ручная приёмка)', () => {
    // tasks.md, раздел 0, пункт 0.4: на контейнере данных нет.
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const klass = declared.get('PROPERTY_BACKUP_VOLUME_CLASS');
    expect(klass, 'свойство «объём данных при копировании» не объявлено').toBeDefined();
    expect(klass).toBe('manual');
    expect(
      declared.get('PROPERTY_BACKUP_VOLUME_EVIDENCE'),
      'у ручного свойства нет свидетельства — сценарий считается непроверенным',
    ).toBeTruthy();
  });
});

describe('server-provisioning: раздача не прерывается провижинингом', () => {
  it('Сценарий: адрес отвечает во время провижининга', async () => {
    const t = target();
    expect(t.provision(ENV).status, 'подготовительный прогон').toBe(0);
    publish(t, 'PUBLISHED-BEFORE');
    t.execOrThrow('pgrep -x nginx >/dev/null || nginx');
    const before = answersFromOutside(t);
    expect(before.code, 'до провижининга ничего не опубликовано — непройденная проверка').toBe('200');

    t.execOrThrow('rm -f /var/log/systemctl-stub.log');
    const probeId = ProvisionTarget.startProbe(
      `for i in $(seq 1 2000); do curl -s -m 2 -o /dev/null -w '%{http_code}\\n' http://${t.ip}/; sleep 0.05; done`,
    );
    probes.push(probeId);
    const run = t.provision({ ...ENV, DOMAIN: 'reload.example' });
    expect(run.status, `провижининг упал:\n${run.output}`).toBe(0);
    const codes = ProvisionTarget.probeOutput(probeId).split('\n').map((s) => s.trim()).filter(Boolean);
    ProvisionTarget.stopProbe(probes.pop()!);

    const reloaded = (t.read('/var/log/systemctl-stub.log') ?? '').includes('reload nginx');
    expect(reloaded, 'перезагрузка сервера раздачи не выполнялась — непройденная проверка').toBe(true);
    expect(codes.length, 'наблюдатель снаружи не снял ни одного измерения').toBeGreaterThan(3);
    expect(codes.filter((c) => c !== '200'), `адрес переставал отвечать: ${codes.join(',')}`).toEqual([]);
    expect(answersFromOutside(t).code, 'после провижининга адрес не отвечает').toBe('200');
  }, T);

  it('Сценарий: опубликованное содержимое не подменено', async () => {
    const t = target();
    expect(t.provision(ENV).status).toBe(0);
    publish(t, 'PUBLISHED-BODY');
    t.execOrThrow('pgrep -x nginx >/dev/null || nginx');
    const before = answersFromOutside(t);
    expect(before.body, 'до провижининга ничего не опубликовано — непройденная проверка').toContain('PUBLISHED-BODY');
    const run = t.provision({ ...ENV, DOMAIN: 'reload.example' });
    expect(run.status, run.output).toBe(0);
    const after = answersFromOutside(t);
    expect(after.body).toBe(before.body);
  }, T);
});
