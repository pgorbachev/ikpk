import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Отказ живого съёма обязан ОСТАНАВЛИВАТЬ сборку, а не подменяться фикстурой. После
// `capture-content-snapshot` отказ выглядит как заданный `CONTENT_SNAPSHOT_DIR` БЕЗ
// `snapshot.json` (скрипт удаляет файл перед работой и не пишет его при отказе).
//
// Прежде ровно это состояние означало «взять закреплённую фикстуру»: съём и выкладка —
// две отдельные команды, ничего их не связывает, и `deploy-web.sh` съём не запускает и
// происхождение снимка не проверяет. То есть при недоступной CMS стенд собирался из
// фикстуры и выглядел обновлённым. Гарантия «отказ, а не подмена» держалась на процессе
// (оператор увидит ненулевой код), но не на артефакте.
//
// Отличить это от ЗАКОННОГО посева невозможно по одному лишь отсутствию файла: джобы
// «Prepare content snapshot artifact» (test.yml) и «Prepare pinned snapshot for manual
// dispatch» (deploy.yml) специально зовут этот скрипт с заданным каталогом и пустым
// каталогом, чтобы разложить туда фикстуру. Поэтому намерение объявляется явно —
// `SNAPSHOT_SOURCE=pinned`, — а необъявленный случай становится отказом. Умолчания нет
// намеренно: «не смогли измерить» не должно выглядеть как «нарушений нет».

const webRoot = join(import.meta.dirname, '..');
const pinnedFixture = join(webRoot, '..', 'fixtures', 'content-snapshot');

function prepare(env: Record<string, string | undefined>): { status: number; output: string } {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) merged[k] = v;
  }
  const run = spawnSync('npx', ['tsx', 'scripts/prepare-snapshot.ts'], {
    cwd: webRoot,
    encoding: 'utf-8',
    env: merged,
  });
  return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

const emptyDir = (): string => mkdtempSync(join(tmpdir(), 'prep-empty-'));

function dirWithSnapshot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prep-live-'));
  cpSync(join(pinnedFixture, 'snapshot.json'), join(dir, 'snapshot.json'));
  return dir;
}

describe('prepare-snapshot: источник снимка', () => {
  it('заданный каталог без snapshot.json — отказ, а не тихая подмена фикстурой', () => {
    const run = prepare({ CONTENT_SNAPSHOT_DIR: emptyDir(), SNAPSHOT_SOURCE: undefined });

    expect(
      run.status,
      `подстановка фикстуры принята за успех — отказ съёма стал бы сборкой из фикстуры:\n${run.output}`,
    ).not.toBe(0);
    expect(run.output, 'отказ не называет причину').toMatch(/SNAPSHOT_SOURCE|snapshot\.json/);
  });

  it('явно объявленный посев фикстурой проходит — на нём стоят оба джоба подготовки', () => {
    const run = prepare({ CONTENT_SNAPSHOT_DIR: emptyDir(), SNAPSHOT_SOURCE: 'pinned' });

    expect(run.status, `объявленный посев отказал:\n${run.output}`).toBe(0);
  });

  it('заданный каталог со снимком используется как источник', () => {
    const run = prepare({ CONTENT_SNAPSHOT_DIR: dirWithSnapshot(), SNAPSHOT_SOURCE: undefined });

    expect(run.status, `живой снимок отвергнут:\n${run.output}`).toBe(0);
  });

  it('без CONTENT_SNAPSHOT_DIR источник — закреплённая фикстура (локальная сборка)', () => {
    const run = prepare({ CONTENT_SNAPSHOT_DIR: undefined, SNAPSHOT_SOURCE: undefined });

    expect(run.status, `локальная сборка без каталога съёма отказала:\n${run.output}`).toBe(0);
  });
});
