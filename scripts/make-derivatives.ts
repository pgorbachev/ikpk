/**
 * Производные изображений для отдачи посетителю.
 *
 * Схема из трёх частей: ОРИГИНАЛ в репозитории (media-originals/, не
 * отдаётся), ПРОИЗВОДНАЯ на странице (web/public/media/, генерируется этим
 * скриптом), замена файла без изменения структуры страницы.
 *
 * Зачем так. Загрузчик раньше уменьшал всё шире 1200px прямо при скачивании и
 * уничтожал исходники безвозвратно: у 37 файлов оригинал оказался крупнее,
 * вплоть до 3520×1980. Из-за этого сложился ложный вывод «крупных кадров нет».
 * Убрали уменьшение — и в public/ легли оригиналы, из-за чего /statyi стала
 * тянуть 8,3 МБ картинок (гейты веса этого не видели, они считают только HTML;
 * дыру закрыл гейт «no page pulls more than its image budget»).
 *
 * Ни то ни другое не годится, поэтому уровни разделены. Бакет старого сайта
 * умрёт при переключении DNS, так что оригиналы — единственная копия и должны
 * храниться нетронутыми.
 *
 * Запуск: npx tsx scripts/make-derivatives.ts [--force]
 * Вызывается автоматически перед сборкой (prebuild в web/package.json).
 */

import {
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINALS = join(ROOT, 'media-originals');
const SHIPPED = join(ROOT, 'web', 'public', 'media');

/** Максимальная ширина отдаваемой версии. Больше на странице нигде не выводится. */
const MAX_WIDTH = 1200;
const QUALITY = 80;

const force = process.argv.includes('--force');
const RASTER = /\.(webp|jpe?g|png)$/i;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

if (!existsSync(ORIGINALS)) {
  console.error(`нет каталога оригиналов: ${ORIGINALS}`);
  process.exit(1);
}

let made = 0;
let copied = 0;
let upToDate = 0;
let failed = 0;
let savedBytes = 0;

for (const src of walk(ORIGINALS)) {
  const rel = relative(ORIGINALS, src);
  const out = join(SHIPPED, rel);

  // производная свежее оригинала — пересобирать нечего
  if (!force && existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
    upToDate++;
    continue;
  }

  mkdirSync(dirname(out), { recursive: true });

  // PDF, SVG и прочее переносим как есть: уменьшать нечего
  if (!RASTER.test(src)) {
    copyFileSync(src, out);
    copied++;
    continue;
  }

  try {
    const meta = await sharp(src).metadata();
    const ext = src.match(/\.([a-z0-9]+)$/i)![1].toLowerCase();

    let pipeline = sharp(src);
    if ((meta.width ?? 0) > MAX_WIDTH) pipeline = pipeline.resize({ width: MAX_WIDTH });
    if (ext === 'png') pipeline = pipeline.png();
    else if (ext === 'webp') pipeline = pipeline.webp({ quality: QUALITY });
    else pipeline = pipeline.jpeg({ quality: QUALITY });

    const buf = await pipeline.toBuffer();
    const origSize = statSync(src).size;

    // если производная не меньше оригинала — отдаём оригинал: пережимать
    // уже оптимизированный файл незачем
    const tmp = `${out}.tmp`;
    if (buf.length < origSize) {
      writeFileSync(tmp, buf);
      savedBytes += origSize - buf.length;
    } else {
      copyFileSync(src, tmp);
    }
    renameSync(tmp, out);
    made++;
  } catch (err) {
    console.error(`  ✗ ${rel}: ${(err as Error).message}`);
    failed++;
  }
}

// Манифест размеров — от ОТДАВАЕМОЙ версии. Он кормит подстановку width/height
// у <img>: размеры оригинала здесь дали бы неверную геометрию и сдвиг макета.
const MANIFEST_PATH = join(ROOT, 'web', 'src', 'lib', 'media-manifest.json');
const manifest: Record<string, { width?: number; height?: number }> = {};

for (const shipped of walk(SHIPPED)) {
  const key = '/media/' + relative(SHIPPED, shipped).split(/[\\/]/).join('/');
  if (!RASTER.test(shipped) && !/\.gif$/i.test(shipped)) {
    manifest[key] = {};
    continue;
  }
  try {
    const { width, height } = await sharp(shipped).metadata();
    manifest[key] = { width, height };
  } catch {
    manifest[key] = {};
  }
}
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
console.log(
  `производных собрано: ${made}, скопировано как есть: ${copied}, ` +
    `актуальны: ${upToDate}, ошибок: ${failed}`,
);
console.log(`манифест: ${Object.keys(manifest).length} записей`);
console.log(`экономия против оригиналов: ${mb(savedBytes)} МБ (порог ширины ${MAX_WIDTH}px)`);
