/**
 * Производные изображений для отдачи посетителю.
 *
 * Схема из трёх уровней: ОРИГИНАЛ в репозитории (media-originals/, не
 * отдаётся), ПРОИЗВОДНЫЕ на странице (web/public/media/, генерируются этим
 * скриптом), замена файла не меняет структуру страницы.
 *
 * Зачем так. Загрузчик раньше уменьшал всё шире 1200px прямо при скачивании и
 * уничтожал исходники безвозвратно: у 37 файлов оригинал оказался крупнее,
 * вплоть до 3520×1980. Из-за этого сложился ложный вывод «крупных кадров нет».
 * Убрали уменьшение — и в public/ легли оригиналы, из-за чего /statyi стала
 * тянуть 8,3 МБ картинок. Ни то ни другое не годится, поэтому уровни разделены.
 *
 * Что генерируется:
 *   /media/<путь>              базовая версия, ширина до 1200px. Имя 1:1 с
 *                              оригиналом: на него ссылаются данные и код.
 *   /media/_w/<ширина>/<путь>  адаптивный набор для srcset.
 *
 * Почему набор в ОТДЕЛЬНОМ дереве, а не суффиксом в имени: файлы называются
 * вида `1-1727024776370.webp`, и суффикс `-480` от такого имени не отличить
 * никаким разумным шаблоном (на этом первая версия скрипта и сломалась —
 * половина манифеста была принята за варианты). Отдельный каталог исключает
 * коллизию полностью.
 *
 * Апскейла нет: вариант шире оригинала не создаётся — это дало бы мыло вместо
 * детализации.
 *
 * Запуск: из web/ — `npm run media:derivatives` (или `tsx scripts/make-derivatives.ts`).
 *
 * Скрипт лежит именно в web/, а не в корневом scripts/: prebuild выполняется в
 * окружении, где установлен только web/node_modules. Пока генератор жил в
 * корневом scripts/, Node разрешал `sharp` из scripts/node_modules — локально
 * это работало, а в CI и при деплое чистая сборка падала с ERR_MODULE_NOT_FOUND.
 * Вызывается автоматически перед сборкой (prebuild в web/package.json).
 */

import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type Sharp } from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINALS = join(ROOT, 'media-originals');
const SNAPSHOT_ORIGINALS = join(ROOT, 'web', '.snapshot', 'media-originals');
const ORIGINAL_ROOTS = [ORIGINALS, SNAPSHOT_ORIGINALS];
const SHIPPED = join(ROOT, 'web', 'public', 'media');
const VARIANTS_DIR = join(SHIPPED, '_w');
const MANIFEST_PATH = join(ROOT, 'web', 'src', 'lib', 'media-manifest.json');

/** Ширина базовой версии — того файла, на который ссылаются данные. */
const BASE_WIDTH = 1200;
const QUALITY = 80;

/**
 * Ширины адаптивного набора. Список статей показывает 68 карточек примерно по
 * 300–400px, а базовый файл отдаётся на 1200px — отсюда 2,7 МБ на странице.
 * Одновременно герой рассчитан на подлинный портрет 2477px, которому 1200px не
 * хватает. Одной шириной эти два требования не закрыть.
 */
const TARGET_WIDTHS = [480, 768, 1200, 1600, 2400];

const force = process.argv.includes('--force');
const RASTER = /\.(webp|jpe?g|png)$/i;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Производная свежее источника — пересобирать нечего. */
function isFresh(out: string, src: string): boolean {
  return !force && existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs;
}

function encode(pipeline: Sharp, ext: string): Sharp {
  if (ext === 'png') return pipeline.png();
  if (ext === 'webp') return pipeline.webp({ quality: QUALITY });
  return pipeline.jpeg({ quality: QUALITY });
}

async function writeAtomic(target: string, buf: Buffer): Promise<void> {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, target);
}

if (!existsSync(ORIGINALS)) {
  console.error(`нет каталога оригиналов: ${ORIGINALS}`);
  process.exit(1);
}

let base = 0;
let copied = 0;
let variants = 0;
let upToDate = 0;
let failed = 0;

for (const originalsRoot of ORIGINAL_ROOTS) {
  if (!existsSync(originalsRoot)) continue;
  for (const src of walk(originalsRoot)) {
    const rel = relative(originalsRoot, src);
    const out = join(SHIPPED, rel);

    // PDF, SVG и прочее переносим как есть: уменьшать нечего
    if (!RASTER.test(src)) {
      if (isFresh(out, src)) {
        upToDate++;
      } else {
        mkdirSync(dirname(out), { recursive: true });
        copyFileSync(src, out);
        copied++;
      }
      continue;
    }

    try {
      const meta = await sharp(src).metadata();
      const origWidth = meta.width ?? 0;
      const ext = src.match(/\.([a-z0-9]+)$/i)![1].toLowerCase();

      // ── базовая версия
      if (isFresh(out, src)) {
        upToDate++;
      } else {
        let pipeline = sharp(src);
        if (origWidth > BASE_WIDTH) pipeline = pipeline.resize({ width: BASE_WIDTH });
        const buf = await encode(pipeline, ext).toBuffer();
        // уже оптимизированный файл не портим: если пережатие не даёт выигрыша,
        // отдаём оригинал как есть
        await writeAtomic(out, buf.length < statSync(src).size ? buf : readFileSync(src));
        base++;
      }

      // ── адаптивный набор
      for (const w of TARGET_WIDTHS) {
        if (w > origWidth) continue; // без апскейла
        const variant = join(VARIANTS_DIR, String(w), rel);
        if (isFresh(variant, src)) continue;
        const buf = await encode(sharp(src).resize({ width: w }), ext).toBuffer();
        await writeAtomic(variant, buf);
        variants++;
      }
    } catch (err) {
      console.error(`  ✗ ${rel}: ${(err as Error).message}`);
      failed++;
    }
  }
}

// ── Манифест
//
// Размеры берутся от БАЗОВОЙ версии: она подставляется в src, и именно её
// геометрия должна попасть в width/height. Размеры оригинала дали бы <img>
// атрибуты на 3520px при картинке 1200px — то есть вернули бы сдвиг макета,
// от которого манифест и защищает.
const manifest: Record<string, { width?: number; height?: number; widths?: number[] }> = {};

for (const shipped of walk(SHIPPED)) {
  const rel = relative(SHIPPED, shipped);
  if (rel.split(/[\\/]/)[0] === '_w') continue; // варианты перечислены в widths

  const key = `/media/${rel.split(/[\\/]/).join('/')}`;
  if (!RASTER.test(shipped) && !/\.gif$/i.test(shipped)) {
    manifest[key] = {};
    continue;
  }

  try {
    const { width, height } = await sharp(shipped).metadata();
    const widths = TARGET_WIDTHS.filter((w) => existsSync(join(VARIANTS_DIR, String(w), rel)));
    manifest[key] = widths.length ? { width, height, widths } : { width, height };
  } catch {
    manifest[key] = {};
  }
}

writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `базовых собрано: ${base}, адаптивных вариантов: ${variants}, ` +
    `скопировано как есть: ${copied}, актуальны: ${upToDate}, ошибок: ${failed}`,
);
console.log(`манифест: ${Object.keys(manifest).length} записей, ширины ${TARGET_WIDTHS.join('/')}`);

// Ошибки генерации — это отсутствующие на сайте изображения, а не примечание.
// Прежде счётчик печатался, а процесс завершался нулём: prebuild продолжал
// сборку, и деплой мог уехать без части картинок при зелёном прогоне.
if (failed > 0) {
  console.error(`\nне собрано изображений: ${failed} — сборка остановлена`);
  process.exit(1);
}
