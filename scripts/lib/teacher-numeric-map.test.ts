import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTeacherNumericMap } from './teacher-numeric-map.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('соответствие числового id преподавателя и legacy_id', () => {
  // РЕГРЕСС: импорт падал с `lid.split is not a function` на первом же преподавателе.
  // Причина — допущение о форме `legacy_id`, которого данные не выполняют.
  it('числовой legacy_id не роняет разбор', () => {
    const map = buildTeacherNumericMap([{ legacy_id: 85 }]);
    expect(map.get('85')).toBe('85');
  });

  it('путь с числом на конце по-прежнему разбирается', () => {
    const map = buildTeacherNumericMap([{ legacy_id: 'ikpk.su/prepodavatel/85' }]);
    expect(map.get('85')).toBe('ikpk.su/prepodavatel/85');
  });

  it('запись без числового хвоста в соответствие не попадает', () => {
    const map = buildTeacherNumericMap([
      { legacy_id: 'ikpk.su/prepodavatel/ivanov' },
      { legacy_id: null },
      {},
    ]);
    expect(map.size).toBe(0);
  });

  // Корпус из ДАННЫХ, а не из литералов: допущение о форме и сломалось на настоящих
  // данных, поэтому проверять надо их, а не выдуманные примеры.
  it('на настоящих данных discovery соответствие непусто', () => {
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, 'discovery', 'entities', 'teachers.json'), 'utf-8'),
    ) as unknown;
    const teachers = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
    expect(teachers.length, 'преподавателей в данных нет — проверка вакуумна').toBeGreaterThan(0);

    const map = buildTeacherNumericMap(teachers);
    expect(
      map.size,
      'ни один преподаватель не попал в соответствие — импорт связей семинаров развалится',
    ).toBe(teachers.length);
  });
});
