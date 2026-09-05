import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLegacyId } from './legacy-id.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTITIES = join(REPO_ROOT, 'discovery', 'entities');

describe('приведение legacy_id к строке', () => {
  // РЕГРЕСС: импорт терял 28 преподавателей из 29 на HTTP 400
  // «legacy_id must be a `string` type, but the final value was: `85`».
  it('число становится строкой', () => {
    expect(normalizeLegacyId(85)).toBe('85');
  });

  it('строка остаётся собой', () => {
    expect(normalizeLegacyId('ikpk.su/prepodavatel/85')).toBe('ikpk.su/prepodavatel/85');
  });

  // Отсутствующий legacy_id молча пропускать нельзя: по нему импорт отличает
  // существующую запись от новой, и без него повторный прогон создаст дубль.
  it('отсутствие — отказ, а не пустая строка', () => {
    expect(() => normalizeLegacyId(null)).toThrow(/отсутствует/);
    expect(() => normalizeLegacyId(undefined)).toThrow(/отсутствует/);
  });

  it('непригодный тип — отказ', () => {
    expect(() => normalizeLegacyId({ id: 1 })).toThrow(/недопустимого типа/);
  });

  // Корпус из данных: каждый legacy_id во всех сущностях обязан приводиться.
  it('все legacy_id в discovery приводятся', () => {
    let seen = 0;
    const failures: string[] = [];
    for (const file of readdirSync(ENTITIES)) {
      if (!file.endsWith('.json')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(ENTITIES, file), 'utf-8'));
      } catch {
        failures.push(`${file}: не разобрался`);
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const record of parsed as Record<string, unknown>[]) {
        if (!('legacy_id' in record)) continue;
        seen += 1;
        try {
          normalizeLegacyId(record.legacy_id);
        } catch (error) {
          failures.push(`${file}: ${(error as Error).message}`);
        }
      }
    }
    expect(seen, 'ни одного legacy_id не встретилось — проверка вакуумна').toBeGreaterThan(0);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
