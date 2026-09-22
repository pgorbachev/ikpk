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
const LIB = join(ROOT, 'scripts', 'lib', 'release-migrations.sh');

/** Тело функции — из того файла, который выкатка вливает в поток; доставку проверяет
 * отдельный describe выше, потому что тело и его достижимость — разные утверждения. */
function gateSource(): string {
  return readFileSync(LIB, 'utf-8');
}

/**
 * Что РЕАЛЬНО уходит на сервер: скрипт собирает поток из `cat`-ов и heredoc и отдаёт его
 * `ssh ... bash -s`. Проверяется именно сборка, а не тело функции.
 *
 * РЕГРЕСС, ради которого проверка и написана: функция жила в `bootstrap-vps.sh` ВНЕ
 * heredoc, поэтому на сервер не попадала. Вызов давал `command not found` (127), `if !`
 * инвертировал, и каждая выкатка CMS падала — после rsync и `npm ci`. Тест тела при этом
 * был зелёный: он исполнял функцию в своей оболочке и к достижимости слеп по устройству.
 */
function remoteStream(): string {
  const src = readFileSync(SCRIPT, 'utf-8');
  const open = src.indexOf('\n{\n');
  const close = src.indexOf("\n} | /usr/bin/ssh");
  if (open < 0 || close < 0) throw new Error('блок сборки потока не найден: проверять нечего');
  const block = src.slice(open, close);

  // Файлы, которые блок вливает в поток, подставляются содержимым — как это делает `cat`.
  const withLibs = block.replace(/cat "\$\{ROOT\}\/(scripts\/lib\/[\w.-]+)"/g, (_m, rel) =>
    readFileSync(join(ROOT, rel), 'utf-8'),
  );
  const hd = withLibs.indexOf("cat <<'REMOTE'");
  return hd < 0 ? withLibs : withLibs.slice(0, hd) + withLibs.slice(hd + "cat <<'REMOTE'".length);
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

describe('доставка проверки на сервер', () => {
  it('поток, уходящий по ssh, определяет функцию до её вызова', () => {
    const stream = remoteStream();
    const defined = /^\s*check_release_migrations\s*\(\)/m.test(stream);
    const called = stream.indexOf('check_release_migrations "$new_release"');
    expect(called, 'вызова проверки в потоке нет — тогда она не выполняется вовсе').toBeGreaterThan(
      0,
    );
    expect(
      defined,
      'функция вызывается на сервере, но в поток не попадает: `command not found` даёт 127, ' +
        '`if !` превращает его в отказ, и каждая выкатка CMS падает',
    ).toBe(true);
  });

  it('определение идёт раньше вызова', () => {
    const stream = remoteStream();
    const def = stream.search(/^\s*check_release_migrations\s*\(\)/m);
    const call = stream.indexOf('check_release_migrations "$new_release"');
    expect(def, 'определение не найдено').toBeGreaterThanOrEqual(0);
    expect(def, 'функция определяется после вызова').toBeLessThan(call);
  });
});

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
