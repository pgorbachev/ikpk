/**
 * Готовит каталог снимка для сборки: копирует закреплённую фикстуру (или
 * CONTENT_SNAPSHOT_DIR) в web/.snapshot и web/dist-snapshot.
 *
 * Публикующий прогон подменяет источник живым артефактом до этого шага.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeInto } from './lib/content-media-store.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');

const fromEnv = process.env.CONTENT_SNAPSHOT_DIR;
const declaredSource = process.env.SNAPSHOT_SOURCE;
const pinned = join(repoRoot, 'fixtures', 'content-snapshot');

// Заданный каталог съёма БЕЗ `snapshot.json` — это ровно то, что оставляет за собой отказ
// живого съёма: `capture-content-snapshot` удаляет файл перед работой и не пишет его, когда
// отказывает. Прежде это состояние молча означало «взять закреплённую фикстуру», и отказ съёма
// превращался в сборку из фикстуры: съём и выкладка — две отдельные команды, `deploy-web.sh`
// съёма не запускает и происхождения снимка не проверяет. Стенд выглядел бы обновлённым.
//
// Отличить отказ от ЗАКОННОГО посева по одному отсутствию файла нельзя: джобы «Prepare content
// snapshot artifact» (test.yml) и «Prepare pinned snapshot for manual dispatch» (deploy.yml)
// специально зовут этот скрипт с заданным пустым каталогом, чтобы разложить туда фикстуру.
// Поэтому намерение объявляется явно, а необъявленный случай — отказ: «не смогли измерить» не
// должно выглядеть как «нарушений нет». Умолчания у объявления нет намеренно.
// Отдельной проверки значения `SNAPSHOT_SOURCE` здесь нет намеренно: опечатку ловит тот же
// отказ ниже. `SNAPSHOT_SOURCE=pinnned` не равен `'pinned'`, поэтому объявление не засчитано и
// шаг падает с названной причиной. Проверено мутацией: снятие отдельной валидации не красило
// ни одного теста — ветвь без наблюдаемого поведения, а такая ветвь есть обещание, а не гейт.
const liveReady = fromEnv !== undefined && existsSync(join(fromEnv, 'snapshot.json'));
if (fromEnv !== undefined && !liveReady && declaredSource !== 'pinned') {
  throw new Error(
    `prepare-snapshot: в CONTENT_SNAPSHOT_DIR (${fromEnv}) нет snapshot.json. Так выглядит ` +
      'отказ живого съёма, и подставлять вместо него закреплённую фикстуру нельзя — сборка ' +
      "выглядела бы обновлённой. Если фикстура нужна намеренно, объявите SNAPSHOT_SOURCE=pinned",
  );
}

const source = liveReady ? fromEnv! : pinned;

if (!existsSync(join(source, 'snapshot.json'))) {
  throw new Error(`prepare-snapshot: нет snapshot.json в ${source}`);
}

for (const dest of [join(webRoot, '.snapshot'), join(webRoot, 'dist-snapshot')]) {
  mkdirSync(dest, { recursive: true });
  cpSync(join(source, 'snapshot.json'), join(dest, 'snapshot.json'));
  const panels = join(source, 'collapsible_panels.json');
  if (existsSync(panels)) cpSync(panels, join(dest, 'collapsible_panels.json'));
  // Карта адресов — часть артефакта снимка (задача 6.3): генератор редиректов читает её отсюда.
  const urlMap = join(source, 'url_map.csv');
  if (existsSync(urlMap)) cpSync(urlMap, join(dest, 'url_map.csv'));
  // Хранилище содержимого переносится вместе со снимком, а не остаётся в каталоге съёма.
  // Иначе снимок, доехавший до сборки артефактом (джоб `content-snapshot` копирует
  // `.snapshot/.`), несёт ссылки на медиа и не несёт байтов: следующий запуск этого же
  // скрипта в сборочном джобе не находит хранилища и валит prebuild. Пока в закреплённой
  // фикстуре нет ни одной записи `/media/uploads/**`, отказ не наступает — то есть зелёный
  // цвет здесь означал бы «медиа CMS ещё не появились», а не «перенос работает».
  const store = join(source, 'media');
  if (existsSync(store) && resolve(store) !== resolve(join(dest, 'media'))) {
    cpSync(store, join(dest, 'media'), { recursive: true });
  }
}

// CMS originals are an input to the same derivative generator as repository originals, but
// remain inside the generated snapshot area. This keeps a live capture reproducible without
// adding mutable CMS files to the tracked `media-originals/` tree.
const materializedDir = join(webRoot, '.snapshot', 'media-originals');
rmSync(materializedDir, { recursive: true, force: true });
const prepared = JSON.parse(readFileSync(join(webRoot, '.snapshot', 'snapshot.json'), 'utf-8')) as {
  content?: { media?: { ref: string; contentId: string }[] };
};
const cmsMedia = (prepared.content?.media ?? []).filter((item) => item.ref.startsWith('/media/uploads/'));
if (cmsMedia.length > 0) {
  // Хранилище берётся из уже перенесённого `.snapshot/media`, а не из каталога-источника:
  // во втором прогоне (сборочный джоб) источником служит артефакт, и путь совпадает; в
  // первом — перенос только что состоялся. Одно место чтения вместо двух.
  const result = materializeInto({
    storeDir: join(webRoot, '.snapshot', 'media'),
    destDir: materializedDir,
    media: cmsMedia,
  });
  if (!result.ok) {
    throw new Error(
      `prepare-snapshot: медиа ${result.ref} не подготовлено (${result.reason}, ${result.contentId})`,
    );
  }
}

// Убеждаемся, что идентификаторы на месте (для build-гейтов).
const snap = JSON.parse(readFileSync(join(webRoot, 'dist-snapshot', 'snapshot.json'), 'utf-8')) as {
  fingerprint?: string;
  snapshotId?: string;
  referenceDate: string;
};
if (!snap.fingerprint || !snap.snapshotId) {
  const { contentFingerprint, snapshotId } = await import('./lib/content-snapshot.ts');
  const full = JSON.parse(readFileSync(join(webRoot, 'dist-snapshot', 'snapshot.json'), 'utf-8'));
  full.fingerprint = contentFingerprint(full.content);
  full.snapshotId = snapshotId({ fingerprint: full.fingerprint, referenceDate: full.referenceDate });
  writeFileSync(join(webRoot, 'dist-snapshot', 'snapshot.json'), JSON.stringify(full));
  writeFileSync(join(webRoot, '.snapshot', 'snapshot.json'), JSON.stringify(full));
}

console.log(`prepare-snapshot: ${source} → web/.snapshot, web/dist-snapshot`);
