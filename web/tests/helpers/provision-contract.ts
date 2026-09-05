/**
 * Контракт, который красные тесты предъявляют реализации change `server-provisioning`.
 *
 * Спека описывает ПОВЕДЕНИЕ, но не имена файлов, ключей и формат вывода. Тест без
 * этих имён написать нельзя, поэтому они выбраны здесь — в одном месте, а не
 * россыпью по тестам, — и перечислены в отчёте как допущения. Реализация вправе
 * выбрать другие имена; тогда меняется этот файл, а не тридцать проверок.
 *
 * Источники выбора:
 * - `deploy/environments/<env>.env` — design.md, Решение 3;
 * - `scripts/bootstrap-vps.sh` — design.md, Решение 1;
 * - имя проверки состояния (`scripts/verify-server-state.sh`) спекой НЕ задано —
 *   это пробел спеки, отмеченный в отчёте.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './provision-target';

export const ENV_DIR = 'deploy/environments';
export const ENVIRONMENTS = ['stand', 'prod'] as const;
export const PROVISION_SCRIPT = process.env.PROVISION_SCRIPT ?? 'scripts/bootstrap-vps.sh';
export const VERIFY_SCRIPT = process.env.PROVISION_VERIFY ?? 'scripts/verify-server-state.sh';

export type Declared = Map<string, string>;

export function declaredStatePath(env: string): string {
  return join(REPO_ROOT, ENV_DIR, `${env}.env`);
}

export function declaredStateExists(env: string): boolean {
  return existsSync(declaredStatePath(env));
}

/** Читает объявленное состояние окружения. Отсутствие файла — провал, а не пропуск. */
export function readDeclared(env: string): Declared {
  const path = declaredStatePath(env);
  if (!existsSync(path)) {
    throw new Error(
      `Объявленного состояния окружения «${env}» нет: ${ENV_DIR}/${env}.env. ` +
        'Проверять нечего — это непройденная проверка, а не отсутствие нарушений.',
    );
  }
  const map: Declared = new Map();
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const value = line.slice(eq + 1).trim();
    map.set(line.slice(0, eq).trim(), value.replace(/^(['"])(.*)\1$/, '$2'));
  }
  if (map.size === 0) {
    throw new Error(`Объявленное состояние «${env}» пусто: ноль значений — непройденная проверка.`);
  }
  return map;
}

export function requireKey(declared: Declared, env: string, key: string): string {
  const value = declared.get(key);
  if (value === undefined || value === '') {
    throw new Error(`В объявленном состоянии «${env}» нет значения ${key}.`);
  }
  return value;
}

export function listValue(declared: Declared, key: string): string[] {
  return (declared.get(key) ?? '').split(/[,\s]+/).filter(Boolean);
}

/** Политики обращения с посторонним: ключи вида POLICY_<предмет>. */
export function policies(declared: Declared): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of declared) if (k.startsWith('POLICY_')) out.set(k.slice('POLICY_'.length), v);
  return out;
}

export type Property = { name: string; klass: string; evidence?: string; reason?: string; deadline?: string };

/** Объявленные свойства как ДАННЫЕ: ключи PROPERTY_<имя>_CLASS. */
export function properties(declared: Declared): Property[] {
  const out: Property[] = [];
  for (const [k, v] of declared) {
    const m = /^PROPERTY_(.+)_CLASS$/.exec(k);
    if (!m) continue;
    const name = m[1];
    out.push({
      name,
      klass: v,
      evidence: declared.get(`PROPERTY_${name}_EVIDENCE`),
      reason: declared.get(`PROPERTY_${name}_REASON`),
      deadline: declared.get(`PROPERTY_${name}_DEADLINE`),
    });
  }
  return out;
}

/** Число из вывода вида `ключ=42`. null — значения в выводе нет. */
export function numberFromOutput(output: string, key: string): number | null {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(output);
  return m ? Number(m[1]) : null;
}

export function valueFromOutput(output: string, key: string): string | null {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(output);
  return m ? m[1] : null;
}

/**
 * Итог прогона провижининга: сколько изменено, сколько уже соответствовало.
 * Спека требует различать это; форма вывода спекой не задана — выбрана здесь.
 */
export function changeSummary(output: string): { changed: number | null; unchanged: number | null } {
  return { changed: numberFromOutput(output, 'changed'), unchanged: numberFromOutput(output, 'unchanged') };
}

export const EXIT = { OK: 0, MISMATCH: 1, UNMEASURED: 2 } as const;

/** Где на сервере лежит применённая ревизия. Спекой путь не задан — выбран здесь. */
export const DEFAULT_REVISION_FILE = '/var/lib/ikpk-provision/revision';

export function revisionFile(env = 'stand'): string {
  try {
    return readDeclared(env).get('REVISION_FILE') ?? DEFAULT_REVISION_FILE;
  } catch {
    return DEFAULT_REVISION_FILE;
  }
}

/** Значение окружения, с которым запускается провижининг. */
export const DEFAULT_ENVIRONMENT = 'stand';
