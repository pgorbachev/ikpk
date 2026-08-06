import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// Правила репозитория, которые ломаются молча и потому нуждаются в гейте.
const ROOT = join(import.meta.dirname, '..', '..');

/** `git check-ignore` возвращает 0, если путь игнорируется, 1 — если нет. */
function ignored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: ROOT });
    return true;
  } catch (err) {
    const code = (err as { status?: number }).status;
    // 1 — не игнорируется. Любой другой код — сбой самой проверки, и его нельзя
    // выдавать за «не игнорируется»: это разница между «дефектов нет» и «я не
    // смогла проверить».
    if (code === 1) return false;
    throw new Error(`git check-ignore завершился с кодом ${code} на пути ${path}`);
  }
}

describe('гигиена репозитория', () => {
  // После перехода на SDD в `.codex/` лежит ОБЩАЯ интеграция OpenSpec
  // (`.codex/skills/**`), а не только личные настройки. Правило на весь каталог
  // заставляло `git add` отказывать без `-f`, и новые файлы после апгрейда
  // генератора пропадали бы молча — дефект без единого сигнала.
  it('общая интеграция в .codex не игнорируется', () => {
    expect(
      ignored('.codex/skills/openspec-propose.md'),
      '.codex/skills/** игнорируется — общие файлы интеграции OpenSpec будут молча пропадать',
    ).toBe(false);
  });

  it('личные настройки в .codex игнорируются', () => {
    expect(
      ignored('.codex/config.toml'),
      '.codex/config.toml не игнорируется — личные настройки уедут в репозиторий',
    ).toBe(true);
  });

  // Скрипты развёртывания вызываются из документации как `./scripts/<имя>`, и без
  // бита это не работает: `permission denied`. В git режим хранится, поэтому
  // проверяем индекс, а не права в рабочем дереве.
  it('скрипты развёртывания исполняемые в индексе git', () => {
    const listed = execFileSync('git', ['ls-files', '-s', 'scripts/'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    const shellScripts = listed
      .split('\n')
      .filter((line) => line.endsWith('.sh'))
      .map((line) => ({ mode: line.slice(0, 6), path: line.split('\t')[1] }));

    expect(
      shellScripts.length,
      'в scripts/ не найдено ни одного .sh — проверять нечего',
    ).toBeGreaterThan(0);
    const notExecutable = shellScripts.filter((s) => s.mode !== '100755').map((s) => s.path);
    expect(
      notExecutable,
      `скрипты без бита исполнения (документация зовёт их как ./scripts/…):\n${notExecutable.join('\n')}`,
    ).toEqual([]);
  });

  // Режим форм: проверяется ПОВЕДЕНИЕ скрипта, а не наличие строк в тексте.
  //
  // Первая редакция искала `DEPLOY_MODE` и `exit 2` где угодно в файле и была
  // декоративной: замена всего блока обязательности на
  // `DEPLOY_MODE="${DEPLOY_MODE:-stand}"` оставляла её зелёной, то есть умолчание
  // возвращалось незамеченным (проверено ревью). Скрипт отказывает до сборки и до
  // обращений к сети, поэтому его можно просто запустить.
  it('деплой отказывается работать без явного режима форм', () => {
    const run = (env: Record<string, string>): { status: number; out: string } => {
      try {
        const out = execFileSync('bash', [join(ROOT, 'scripts', 'deploy-web.sh'), '203.0.113.1'], {
          cwd: ROOT,
          encoding: 'utf-8',
          env: { ...process.env, ...env },
          stdio: 'pipe',
        });
        return { status: 0, out };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };

    const noMode = run({ DEPLOY_MODE: '', DEMO_FORMS: '' });
    expect(noMode.status, `без DEPLOY_MODE скрипт не отказал:\n${noMode.out}`).toBe(2);
    expect(noMode.out, 'отказ не называет допустимые режимы').toMatch(/stand/);

    const both = run({ DEPLOY_MODE: 'prod', DEMO_FORMS: 'stub' });
    expect(both.status, `prod + DEMO_FORMS не отвергнут:\n${both.out}`).toBe(2);

    const wrong = run({ DEPLOY_MODE: 'staging-maybe', DEMO_FORMS: '' });
    expect(wrong.status, `неизвестный режим принят:\n${wrong.out}`).toBe(2);

    // Runbook обязан показывать режим: иначе оператор снова позовёт скрипт без него.
    const runbook = readFileSync(join(ROOT, 'docs', 'deploy-vps.md'), 'utf-8');
    expect(/DEPLOY_MODE=(stand|prod)/.test(runbook), 'runbook не показывает явный режим').toBe(true);
  });

  // Файл редиректов должен попадать на сервер: генератор его создаёт, но пока
  // bootstrap не подключал `include`, а deploy не загружал файл, 265 правил
  // существовали только в репозитории.
  it('конфигурация стенда подключает файл редиректов, а деплой его загружает', () => {
    const bootstrap = readFileSync(join(ROOT, 'scripts', 'bootstrap-vps.sh'), 'utf-8');
    const deploy = readFileSync(join(ROOT, 'scripts', 'deploy-web.sh'), 'utf-8');

    expect(
      existsSync(join(ROOT, 'deploy', 'nginx-redirects.conf')),
      'нет deploy/nginx-redirects.conf — запустите npm run redirects:gen',
    ).toBe(true);
    // Смотрим на ИСПОЛНЯЕМЫЙ код, а не на любое упоминание имени файла: первая
    // редакция искала подстроку по всему тексту, и удаление блока загрузки с
    // оставленным комментарием её не роняло (проверено ревью).
    const strip = (text: string): string =>
      text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');

    expect(
      /include\s+\S*nginx-redirects\.conf/.test(strip(bootstrap)),
      'include файла редиректов закомментирован или отсутствует в vhost — правила на сервере не действуют',
    ).toBe(true);
    // Требуем именно передачу файла на сервер, а не упоминание его имени.
    const deployCode = strip(deploy);
    expect(
      /nginx-redirects\.conf/.test(deployCode),
      'deploy-web.sh не обращается к файлу редиректов',
    ).toBe(true);
    expect(
      /shared\/nginx-redirects\.conf/.test(deployCode) && /\bcat\b/.test(deployCode),
      'deploy-web.sh не загружает файл редиректов на сервер (блок передачи отсутствует)',
    ).toBe(true);
  });

  // Деплой обязан проверять то, что реально уедет на сервер, и отказываться до
  // необратимых шагов. Проверяем присутствие обеих проверок в исполняемом коде и их
  // ПОРЯДОК: сверка артефакта и preflight должны стоять раньше переключения релиза.
  it('деплой сверяет артефакт с режимом и подключение редиректов до переключения релиза', () => {
    const code = readFileSync(join(ROOT, 'scripts', 'deploy-web.sh'), 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    // Артефакт сверяется по ВСЕМУ набору адресов форм и против заказанного режима:
    // подсчёт файлов этого не доказывал — заглушку могла внести сама служебная
    // страница, а прод-проверке хватало одного совпадения.
    expect(
      /form_links=/.test(code) && /EXPECT_RE/.test(code),
      'набор адресов форм не извлекается и не сверяется с ожидаемым',
    ).toBe(true);
    expect(
      /form_count == 0/.test(code),
      'вакуумный результат (ноль ссылок на формы) не считается провалом',
    ).toBe(true);
    // Режимы различаются: stub, кастомный host и прод — три разных ожидания.
    expect(
      /DEMO_FORMS" == "stub"/.test(code) && /bitrix24site/.test(code),
      'режимы stub и кастомного портала не различаются',
    ).toBe(true);

    // Preflight по развёрнутой конфигурации, а не по загруженному файлу.
    expect(/nginx -T/.test(code), 'нет preflight по развёрнутой конфигурации nginx').toBe(true);

    const posArtifact = code.indexOf('form_links=');
    const posPreflight = code.indexOf('nginx -T');
    const posSwitch = code.indexOf('Switching current symlink');
    expect(posArtifact, 'сверки артефакта нет').toBeGreaterThan(0);
    expect(posPreflight, 'preflight отсутствует').toBeGreaterThan(0);
    expect(posSwitch, 'переключение релиза не найдено').toBeGreaterThan(0);
    expect(
      posArtifact < posSwitch && posPreflight < posSwitch,
      'проверки стоят ПОСЛЕ переключения релиза — отказ уже ничего не спасает',
    ).toBe(true);

    // Провал health-check — провал деплоя.
    expect(
      /Health check ПРОВАЛЕН/.test(code) && /exit 1/.test(code),
      'провал health-check не роняет деплой',
    ).toBe(true);
  });

  // Bootstrap не должен перезаписывать существующий vhost: там правки certbot.
  it('bootstrap отказывается перезаписывать существующий vhost', () => {
    const code = readFileSync(join(ROOT, 'scripts', 'bootstrap-vps.sh'), 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(
      /-f "\$VHOST"/.test(code) && /exit 3/.test(code),
      'существующий vhost перезаписывается молча — конфигурация certbot будет снесена',
    ).toBe(true);
    expect(/FORCE_VHOST/.test(code), 'нет осознанного обхода для перезаписи').toBe(true);
  });

  // Генераторы не должны сообщать об ошибках и завершаться нулём. Проверяем
  // ПОВЕДЕНИЕ, запуская генератор на негодных данных, а не наличие строки
  // `process.exit(1)` в тексте.
  //
  // Первая редакция искала именно строку — и была декоративной дважды: её
  // удовлетворял комментарий вида «раньше здесь был process.exit(1)», а по
  // `make-derivatives.ts` она была зелёной ДО исправления, потому что `exit(1)` там
  // уже стоял в другой ветке (отсутствие каталога оригиналов). То есть негативную
  // проверку эта строка пройти не могла, хотя я утверждала обратное.
  it('генератор редиректов падает на конфликте в карте адресов', () => {
    const map = join(ROOT, 'discovery', 'url_map.csv');
    const rows = readFileSync(map, 'utf-8').split('\n');
    const idx = rows.findIndex((r) => r.startsWith('https://ikpk.su/contacts,'));
    expect(idx, 'в карте нет опорной строки для проверки — предмет изменился').toBeGreaterThan(0);

    const cols = rows[idx].split(',');
    cols[2] = '/konflikt-proverka';
    const withConflict = [...rows.slice(0, idx + 1), cols.join(','), ...rows.slice(idx + 1)].join(
      '\n',
    );

    // Карта передаётся генератору отдельным файлом, рабочая копия не трогается.
    const probe = join(ROOT, 'discovery', 'url_map.conflict-probe.csv');
    try {
      writeFileSync(probe, withConflict, 'utf-8');
      let status = 0;
      let output = '';
      try {
        output = execFileSync(
          'npx',
          ['tsx', 'scripts/gen-redirects.ts', '--map=discovery/url_map.conflict-probe.csv'],
          { cwd: join(ROOT, 'web'), encoding: 'utf-8', stdio: 'pipe' },
        );
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        status = e.status ?? -1;
        output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      expect(status, `генератор завершился нулём на конфликте:\n${output}`).not.toBe(0);
      expect(output, 'генератор не назвал конфликт в выводе').toMatch(/КОНФЛИКТ/);
    } finally {
      // Убираем и подменённую карту, и конфиг, который генератор мог успеть
      // записать: иначе прогон со снятым отказом оставляет файл в рабочем дереве —
      // ровно тот мусор, от которого правило про постусловие мутации и написано.
      rmSync(probe, { force: true });
      rmSync(join(ROOT, 'deploy', 'nginx-redirects.probe.conf'), { force: true });
    }
  });

  // Скрипт восстановления секций должен работать из чистого checkout: прежде он
  // читал `scratch-empty.json`, которого в репозитории нет.
  it('список адресов для восстановления секций есть в репозитории', () => {
    const targets = join(ROOT, 'discovery', 'collapsible_targets.json');
    expect(existsSync(targets), `нет ${targets} — скрипт невоспроизводим из чистого checkout`).toBe(
      true,
    );
    const list = JSON.parse(readFileSync(targets, 'utf-8')) as unknown;
    expect(Array.isArray(list) && list.length > 0, 'список адресов пуст — обходить нечего').toBe(
      true,
    );

    // Ищем в КОДЕ, а не во всём файле: в пояснении к правке черновое имя названо
    // намеренно, и проверка по всему тексту краснела бы на объяснении дефекта.
    const script = readFileSync(join(ROOT, 'web', 'scripts', 'recover-collapsibles.mjs'), 'utf-8');
    const code = script
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(
      /scratch-empty\.json/.test(code),
      'скрипт снова читает черновой scratch-empty.json, которого нет в репозитории',
    ).toBe(false);
    expect(
      /collapsible_targets\.json/.test(code),
      'скрипт не берёт список адресов из репозитория',
    ).toBe(true);
  });
});
