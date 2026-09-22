/**
 * Серверный отказ при неполном составе миграций в релизе.
 *
 * Предмет — ПОВЕДЕНИЕ, а не текст скрипта: тест извлекает функцию `check_release_migrations`
 * из `scripts/bootstrap-vps.sh` по маркерам и исполняет именно её. Второй копии логики нет,
 * поэтому расхождение между проверяемым и выполняемым невозможно.
 *
 * Зачем вообще: миграция, не доехавшая в релиз, не даёт ошибки. Strapi выполняет ноль
 * миграций, затем приводит базу к схеме обычной сверкой — `dropColumn` + `createColumn`, —
 * и значения статусов обнуляются молча. Сайт фильтрует `status === 'active'` в восьми местах,
 * так что расписание исчезает, а контракт снимка этого поля не покрывает.
 *
 * Почему тест появился позже самой проверки: её снятие не красило НИЧЕГО. Оба исправления
 * в пути выкатки были внесены без красного прогона, чего правила проекта не допускают.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'bootstrap-vps.sh');

/** Текст функции из выкатки — ровно тот, что уходит на сервер. */
function gateSource(): string {
  const src = readFileSync(SCRIPT, 'utf-8');
  const from = src.indexOf('# --- BEGIN check_release_migrations ---');
  const to = src.indexOf('# --- END check_release_migrations ---');
  if (from < 0 || to < 0) {
    throw new Error('маркеры функции не найдены: проверять нечего');
  }
  return src.slice(from, to);
}

/**
 * Собирает каталог релиза и прогоняет по нему функцию. Возвращает код возврата И причину.
 *
 * Причина обязательна: по одному коду «отказ по делу» неотличим от «функция упала». Снятие
 * проверки происхождения давало тот же код 1 — файла нет, `tr` падает, `set -e` прерывает, —
 * и проверка по коду оставалась зелёной на снятом гейте.
 */
function runGate(opts: { migrations: string[]; expected?: string }): { code: number; err: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-rel-'));
  try {
    mkdirSync(join(dir, 'database', 'migrations'), { recursive: true });
    for (const m of opts.migrations) writeFileSync(join(dir, 'database', 'migrations', m), '');
    if (opts.expected !== undefined) {
      writeFileSync(join(dir, 'database', '.migrations-expected'), opts.expected);
    }
    // `set -euo pipefail` — те же опции, что стоят в самом `bootstrap-vps.sh`. Без них
    // обстановка теста беднее production: упавший `tr` не прерывает функцию, и проверка
    // возвращает отказ по соседней ветке, маскируя снятие нужной.
    const script = `set -euo pipefail\n${gateSource()}\ncheck_release_migrations "${dir}"\n`;
    try {
      execFileSync('bash', ['-c', script], { stdio: 'pipe' });
      return { code: 0, err: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      return { code: err.status ?? -1, err: String(err.stderr ?? '') };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('состав миграций в релизе', () => {
  it('пропускает релиз, где миграций столько же, сколько объявлено', () => {
    expect(runGate({ migrations: ['2026.01.01.a.js'], expected: '1\n' }).code).toBe(0);
  });

  it('отказывает, когда миграция не доехала', () => {
    const r = runGate({ migrations: [], expected: '1\n' });
    expect(r.code, 'пустой каталог при объявленной миграции пропущен').toBe(1);
    expect(r.err, 'отказ не назвал расхождение числа — значит упал, а не проверил').toContain(
      'миграций в релизе 0, ожидалось 1',
    );
  });

  // Ради этого случая проверка и сверяет число, а не «хотя бы одну»: когда последнюю
  // миграцию законно уберут, требование «хотя бы одна» отказывало бы на каждой выкатке.
  it('пропускает законный ноль миграций', () => {
    expect(runGate({ migrations: [], expected: '0\n' }).code).toBe(0);
  });

  it('отказывает, когда происхождение артефакта не подтверждено', () => {
    const r = runGate({ migrations: ['2026.01.01.a.js'] });
    expect(r.code, 'артефакт без .migrations-expected принят').toBe(1);
    expect(
      r.err,
      'отказ не назвал неподтверждённое происхождение: проверка снята, а код 1 пришёл от ' +
        'падения `tr` под `set -e` — по коду это неотличимо',
    ).toContain('артефакт собран мимо');
  });

  it('отказывает на нечисловом объявлении, а не молча пропускает', () => {
    const r = runGate({ migrations: [], expected: 'сколько-то\n' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('ожидалось <не число>');
  });
});
