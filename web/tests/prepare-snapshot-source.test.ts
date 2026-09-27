import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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

const LIVE_MARK = 'live-capture-not-pinned-fixture';

describe('prepare-snapshot: источник снимка', () => {
  afterAll(() => {
    const restored = prepare({ CONTENT_SNAPSHOT_DIR: pinnedFixture, SNAPSHOT_SOURCE: undefined });
    if (restored.status !== 0) throw new Error(restored.output);
  });

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

  it('источник web/.snapshot не копирует снимок сам в себя и не подменяет его фикстурой', () => {
    const liveDir = join(webRoot, '.snapshot');
    mkdirSync(liveDir, { recursive: true });
    const snap = JSON.parse(readFileSync(join(pinnedFixture, 'snapshot.json'), 'utf8')) as { liveCaptureMark?: string };
    snap.liveCaptureMark = LIVE_MARK;
    writeFileSync(join(liveDir, 'snapshot.json'), JSON.stringify(snap));
    writeFileSync(join(liveDir, 'collapsible_panels.json'), JSON.stringify({ liveCaptureMark: LIVE_MARK }));
    writeFileSync(join(liveDir, 'url_map.csv'), `liveCaptureMark,${LIVE_MARK}\n`);

    const run = prepare({ CONTENT_SNAPSHOT_DIR: liveDir, SNAPSHOT_SOURCE: undefined });

    expect(run.status, `живой снимок в web/.snapshot не подготовился:\n${run.output}`).toBe(0);
    const kept = JSON.parse(readFileSync(join(liveDir, 'snapshot.json'), 'utf8')) as { liveCaptureMark?: string };
    expect(kept.liveCaptureMark, 'web/.snapshot подменён фикстурой').toBe(LIVE_MARK);
    const published = JSON.parse(readFileSync(join(webRoot, 'dist-snapshot', 'snapshot.json'), 'utf8')) as {
      liveCaptureMark?: string;
    };
    expect(published.liveCaptureMark, 'dist-snapshot взят не из живого снимка').toBe(LIVE_MARK);
    expect(readFileSync(join(liveDir, 'collapsible_panels.json'), 'utf8')).toContain(LIVE_MARK);
    expect(readFileSync(join(liveDir, 'url_map.csv'), 'utf8')).toContain(LIVE_MARK);
  });
});
