import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
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

  // Режим форм не должен иметь умолчания: прежде скрипт по умолчанию ставил
  // DEMO_FORMS=stub, а runbook звал его без переопределения — оператор развернул бы
  // боевой сайт, где заявки уходят на заглушку, и узнал бы об этом от клиентов.
  it('деплой требует явный режим форм и не подставляет умолчание', () => {
    const deploy = readFileSync(join(ROOT, 'scripts', 'deploy-web.sh'), 'utf-8');
    expect(
      /DEMO_FORMS="\$\{DEMO_FORMS-/.test(deploy),
      'у DEMO_FORMS снова появилось умолчание на уровне скрипта',
    ).toBe(false);
    expect(
      /DEPLOY_MODE/.test(deploy) && /exit 2/.test(deploy),
      'скрипт не требует явный DEPLOY_MODE с отказом',
    ).toBe(true);

    const runbook = readFileSync(join(ROOT, 'docs', 'deploy-vps.md'), 'utf-8');
    expect(
      /DEPLOY_MODE=(stand|prod)/.test(runbook),
      'runbook не показывает явный режим — оператор снова запустит скрипт без него',
    ).toBe(true);
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
    expect(
      /include\s+\S*nginx-redirects\.conf/.test(bootstrap),
      'bootstrap-vps.sh не подключает файл редиректов в vhost — правила на сервере не действуют',
    ).toBe(true);
    expect(
      /nginx-redirects\.conf/.test(deploy),
      'deploy-web.sh не загружает файл редиректов на сервер',
    ).toBe(true);
  });

  // Генераторы данных не должны сообщать об ошибках и завершаться нулём: prebuild
  // и деплой продолжали работу на неполных данных при зелёном прогоне.
  it('генераторы завершаются ненулевым кодом при потере данных', () => {
    const cases: Array<{ file: string; what: string }> = [
      { file: join('web', 'scripts', 'make-derivatives.ts'), what: 'ошибки генерации изображений' },
      { file: join('web', 'scripts', 'gen-redirects.ts'), what: 'конфликты в карте адресов' },
      { file: join('web', 'scripts', 'refresh-catalog.ts'), what: 'потеря данных каталога' },
      {
        file: join('web', 'scripts', 'recover-collapsibles.mjs'),
        what: 'незавершённое восстановление секций',
      },
    ];
    const silent = cases
      .filter(({ file }) => !/process\.exit\(1\)/.test(readFileSync(join(ROOT, file), 'utf-8')))
      .map(({ file, what }) => `${file}: ${what} не роняет процесс`);
    expect(silent, silent.join('\n')).toEqual([]);
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
