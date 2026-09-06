/**
 * Красные тесты change `server-provisioning`: часть, проверяемая по дереву репозитория.
 *
 * Предмет — ОБЪЯВЛЕННОЕ СОСТОЯНИЕ (`deploy/environments/<env>.env`, design.md Решение 3):
 * инвентарь, размещение данных, политики обращения с посторонним, модель свойств и
 * отсутствие значений секретов в отслеживаемых файлах. Контейнер здесь не нужен.
 *
 * Имена ключей выбраны в `tests/helpers/provision-contract.ts` и перечислены в отчёте
 * как допущения: спека задаёт поведение, а не формат.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/provision-target';
import {
  ENVIRONMENTS,
  listValue,
  policies,
  properties,
  readDeclared,
  requireKey,
} from './helpers/provision-contract';

const POLICY_VALUES = new Set(['merge', 'refuse']);
const PROPERTY_CLASSES = new Set(['auto', 'manual', 'unverifiable']);

function trackedFiles(): string[] {
  const out = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = out.split('\n').filter(Boolean);
  if (files.length === 0) throw new Error('git ls-files вернул пусто — измерить не удалось');
  return files;
}

describe('server-provisioning: объявленное состояние', () => {
  // Требование «Объявленное состояние включает инвентарь и размещение данных»
  describe('Сценарий: инвентарь объявлен', () => {
    for (const env of ENVIRONMENTS) {
      it(`${env}: дистрибутив, перечень пакетов и правило выбора версий`, () => {
        const declared = readDeclared(env);
        expect(requireKey(declared, env, 'DISTRO')).toMatch(/\S/);
        const packages = listValue(declared, 'PACKAGES');
        expect(packages.length, 'перечень пакетов пуст — непройденная проверка').toBeGreaterThan(0);
        expect(requireKey(declared, env, 'PACKAGE_VERSION_RULE')).toMatch(/\S/);
      });
    }
  });

  // Требование «Объявленное состояние включает инвентарь и размещение данных»
  it('Сценарий: версии совпадают между окружениями', () => {
    const [a, b] = ENVIRONMENTS.map((env) => readDeclared(env));
    const packagesA = new Set(listValue(a, 'PACKAGES'));
    const packagesB = new Set(listValue(b, 'PACKAGES'));
    const compared = [...packagesA].filter((p) => packagesB.has(p));
    expect(compared.length, 'сверка не сопоставила ни одного пакета — непройденная проверка').toBeGreaterThan(0);
    const ruleA = requireKey(a, ENVIRONMENTS[0], 'PACKAGE_VERSION_RULE');
    const ruleB = requireKey(b, ENVIRONMENTS[1], 'PACKAGE_VERSION_RULE');
    const differenceNamed = a.get('PACKAGE_VERSION_RULE_DIFFERENCE_REASON') ?? b.get('PACKAGE_VERSION_RULE_DIFFERENCE_REASON');
    expect(
      ruleA === ruleB || Boolean(differenceNamed),
      `правила выбора версий различаются (${ruleA} ≠ ${ruleB}) и различие не названо объявленным значением`,
    ).toBe(true);
  });

  // Требование «Объявленное состояние включает инвентарь и размещение данных»
  describe('Сценарий: размещение данных объявлено', () => {
    for (const env of ENVIRONMENTS) {
      it(`${env}: клиент базы, каталог данных и его вхождение в резервную копию`, () => {
        const declared = readDeclared(env);
        expect(requireKey(declared, env, 'CMS_DB_CLIENT')).toMatch(/\S/);
        const dataDir = requireKey(declared, env, 'CMS_DATA_DIR');
        const backup = listValue(declared, 'BACKUP_INCLUDES');
        expect(backup.length, 'предмет резервного копирования пуст — непройденная проверка').toBeGreaterThan(0);
        expect(
          backup.some((p) => p === dataDir || dataDir.startsWith(p.endsWith('/') ? p : `${p}/`)),
          `каталог данных ${dataDir} не входит в предмет резервного копирования: ${backup.join(', ')}`,
        ).toBe(true);
      });
    }
  });

  // Требование «Состояние, созданное вне провижининга, не затирается молча»
  describe('Политика обращения с посторонним объявлена значением', () => {
    for (const env of ENVIRONMENTS) {
      it(`${env}: у каждого управляемого предмета политика из двух значений`, () => {
        const declared = readDeclared(env);
        const items = policies(declared);
        expect(items.size, 'ни у одного предмета нет политики — непройденная проверка').toBeGreaterThan(0);
        const wrong = [...items].filter(([, v]) => !POLICY_VALUES.has(v));
        expect(wrong, `политика вне {merge, refuse}: ${JSON.stringify(wrong)}`).toEqual([]);
      });

      it(`${env}: конфигурация раздачи объявлена как merge`, () => {
        const declared = readDeclared(env);
        const vhost = policies(declared).get('VHOST');
        expect(vhost, 'политика конфигурации раздачи не объявлена (ключ POLICY_VHOST)').toBeDefined();
        expect(vhost).toBe('merge');
      });
    }
  });

  // Требование «Провижининг проверяет достигнутое состояние по покрытию»
  describe('Модель объявленных свойств', () => {
    for (const env of ENVIRONMENTS) {
      it(`${env}: у каждого свойства класс, у ручного — свидетельство, у непроверяемого — причина и срок`, () => {
        const declared = readDeclared(env);
        const list = properties(declared);
        expect(list.length, 'объявлено ноль свойств — проверять нечего').toBeGreaterThan(0);
        const badClass = list.filter((p) => !PROPERTY_CLASSES.has(p.klass));
        expect(badClass.map((p) => `${p.name}=${p.klass}`), 'класс вне {auto, manual, unverifiable}').toEqual([]);
        const manualWithoutEvidence = list.filter((p) => p.klass === 'manual' && !p.evidence);
        expect(manualWithoutEvidence.map((p) => p.name), 'ручное свойство без свидетельства').toEqual([]);
        const unverifiableIncomplete = list.filter((p) => p.klass === 'unverifiable' && (!p.reason || !p.deadline));
        expect(unverifiableIncomplete.map((p) => p.name), 'непроверяемое свойство без причины или срока').toEqual([]);
      });
    }
  });

  // Требование «Секреты не хранятся в репозитории и не утекают в историю»
  it('Сценарий: секретов нет в отслеживаемых файлах', () => {
    const declared = readDeclared('stand');
    const names = listValue(declared, 'SECRET_NAMES');
    expect(names.length, 'перечень имён секретов пуст — корпус проверки пуст, измерять нечего').toBeGreaterThan(0);
    const files = trackedFiles().filter((f) => f.startsWith('deploy/') || f.startsWith('scripts/'));
    expect(files.length, 'ни одного отслеживаемого файла провижининга — непройденная проверка').toBeGreaterThan(0);
    const leaks: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const name of names) {
        const assigned = new RegExp(`^\\s*(export\\s+)?${name}\\s*=\\s*(?!\\s*$)(?!["']{2}\\s*$).+$`, 'm').exec(text);
        if (assigned) leaks.push(`${rel}: ${assigned[0].trim()}`);
      }
    }
    expect(leaks, 'значение секрета присвоено в отслеживаемом файле — должно быть только имя').toEqual([]);
  });

  // Требование «Секреты не хранятся в репозитории и не утекают в историю»
  it('Форма передачи секрета названа и запрещает аргументы команд', () => {
    const declared = readDeclared('stand');
    const transport = requireKey(declared, 'stand', 'SECRET_TRANSPORT');
    expect(['process-env', 'stdin'], `способ передачи «${transport}» не из названных`).toContain(transport);
    const script = readFileSync(join(REPO_ROOT, 'scripts/bootstrap-vps.sh'), 'utf8');
    const names = listValue(declared, 'SECRET_NAMES');
    for (const name of names) {
      expect(
        new RegExp(`--[\\w-]+[= ]\\$\\{?${name}`).test(script),
        `секрет ${name} передаётся аргументом команды`,
      ).toBe(false);
    }
  });
});
