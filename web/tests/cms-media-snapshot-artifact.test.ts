import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentIdOf } from '../scripts/lib/content-media-store.ts';

/**
 * Регресс на дефект: хранилище содержимого не переживало передачу снимка артефактом.
 *
 * Конвейер публикации разнесён по двум джобам. Первый снимает содержимое и складывает
 * артефакт как `cp -R .snapshot/.` (`.github/workflows/test.yml`, шаг «Prepare content
 * snapshot artifact»); второй скачивает артефакт, подставляет его каталог в
 * `CONTENT_SNAPSHOT_DIR` и собирает. То есть `prepare-snapshot` выполняется ДВАЖДЫ, и
 * второй раз источником служит то, что первый положил в `.snapshot`.
 *
 * Пока хранилище оставалось в каталоге съёма, второй прогон не находил байтов и валил
 * prebuild. На закреплённой фикстуре это не проявлялось: в ней нет ни одной записи
 * `/media/uploads/**`, и материализация не запускалась вовсе — зелёный цвет означал
 * «медиа CMS ещё не появились», а не «перенос работает».
 */

const webRoot = join(import.meta.dirname, '..');
const repoRoot = join(webRoot, '..');
const pinned = join(repoRoot, 'fixtures', 'content-snapshot');

function prepare(snapshotDir: string): { status: number; output: string } {
  const run = spawnSync('npx', ['tsx', 'scripts/prepare-snapshot.ts'], {
    cwd: webRoot,
    encoding: 'utf-8',
    env: { ...process.env, CONTENT_SNAPSHOT_DIR: snapshotDir },
  });
  return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

const BYTES = 'байты картинки, загруженной редактором';
const REF = '/media/uploads/redaktor-zagruzil.webp';

function captureDirWithMedia(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-capture-'));
  const contentId = contentIdOf(BYTES);
  mkdirSync(join(dir, 'media'), { recursive: true });
  writeFileSync(join(dir, 'media', contentId), BYTES);
  writeFileSync(
    join(dir, 'snapshot.json'),
    JSON.stringify({
      referenceDate: '2026-09-06',
      content: { types: {}, media: [{ ref: REF, contentId }] },
    }),
  );
  return dir;
}

describe('снимок, переданный артефактом, несёт байты медиа, а не только ссылки', () => {
  afterAll(() => {
    // Каталог снимка — общий рабочий предмет сборки. Возвращаем его к закреплённой
    // фикстуре, иначе следующая локальная сборка возьмёт остаток от теста.
    prepare(pinned);
  });

  it('второй прогон подготовки — из артефакта, а не из каталога съёма — материализует медиа', () => {
    // Сборочный джоб начинает с чистого клона, где `.snapshot` не существует. Без этой
    // уборки остаток предыдущего прогона подменяет предмет: артефакт копирует хранилище,
    // залежавшееся в рабочем дереве, и проверка проходит даже со снятым переносом.
    rmSync(join(webRoot, '.snapshot'), { recursive: true, force: true });
    const capture = captureDirWithMedia();

    const first = prepare(capture);
    expect(first.status, `первый прогон подготовки:\n${first.output}`).toBe(0);

    // Так собирается артефакт в джобе `content-snapshot`: копируется содержимое `.snapshot`.
    const artifact = mkdtempSync(join(tmpdir(), 'ikpk-artifact-'));
    cpSync(join(webRoot, '.snapshot'), artifact, { recursive: true });

    // И так он используется в сборочном джобе: каталог артефакта становится источником.
    const second = prepare(artifact);
    expect(second.status, `второй прогон подготовки:\n${second.output}`).toBe(0);
    expect(
      existsSync(join(webRoot, '.snapshot', 'media-originals', 'uploads', 'redaktor-zagruzil.webp')),
      'медиа не материализовано для генератора производных',
    ).toBe(true);

    rmSync(capture, { recursive: true, force: true });
    rmSync(artifact, { recursive: true, force: true });
  }, 60_000);
});
