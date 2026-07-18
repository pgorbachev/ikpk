/**
 * Этап 2 (план 004): миграция медиа со storage.yandexcloud.net.
 *
 * Собирает все URL бакета из discovery/entities/*.json и web/src/**, скачивает
 * файлы в web/public/** (путь после /ikpk-image/ сохраняется 1:1, поэтому
 * рерайт URL — простая замена префикса) и генерирует манифест размеров
 * web/src/lib/media-manifest.json для проставления width/height у <img>
 * (защита от CLS).
 *
 * Канонизация путей: ключи манифеста и пути на диске хранятся ДЕКОДИРОВАННЫМИ
 * (кириллица как есть); percent-encoding применяется только при fetch.
 *
 * Идемпотентен: уже скачанные файлы пропускаются (--force для перекачки);
 * запись через tmp+rename — обрыв не оставляет усечённый файл под финальным
 * именем.
 *
 * Usage: npx tsx download-media.ts [--force]
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const ENTITIES_DIR = join(ROOT, 'discovery', 'entities');
const PUBLIC_DIR = join(ROOT, 'web', 'public');
const MANIFEST_PATH = join(ROOT, 'web', 'src', 'lib', 'media-manifest.json');

// Тот же префикс продублирован в web/src/lib/media.ts (BUCKET_PREFIX) —
// разные npm-пакеты; при изменении бакета править ОБА места.
const BUCKET_PREFIX = 'https://storage.yandexcloud.net/ikpk-image';
const URL_RE = /https:\/\/storage\.yandexcloud\.net\/ikpk-image(\/[^"'\\\s)<>]+)/g;
const LOCAL_RE = /["'`(](\/(?:media|terms)\/[^"'`\\\s)<>]+\.(?:webp|jpe?g|png|gif|svg|pdf))/g;

/**
 * Контентные изображения старой CMS бывают сильно оверсайз (до 2591px при
 * отображении ≤800px) — это валит LCP-бюджет ≤2.5s на мобильном троттлинге.
 * Всё шире MAX_WIDTH даунскейлится при скачивании В ИСХОДНОМ ФОРМАТЕ
 * (расширение файла остаётся честным). Оригиналы остаются в бакете.
 */
const MAX_WIDTH = 1200;
const QUALITY = 80;

const force = process.argv.includes('--force');

// ---------- collect unique bucket paths ----------
// Источники: discovery/entities/*.json + web/src/** (там есть supplement-файлы
// с прямыми ссылками). Ищем и полные URL бакета, и уже локализованные
// локальные пути — так скрипт остаётся полным после рерайта ссылок в src.

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSourceFiles(full);
    else if (/\.(ts|astro|json)$/.test(entry.name) && !entry.name.includes('media-manifest'))
      yield full;
  }
}

/** decodeURI с guard: битая %-последовательность не должна ронять весь прогон. */
function safeDecode(path: string): string | null {
  try {
    return decodeURI(path);
  } catch {
    console.warn(`  ! skipping malformed percent-encoding: ${path}`);
    return null;
  }
}

const paths = new Set<string>();
const sources = [
  ...readdirSync(ENTITIES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(ENTITIES_DIR, f)),
  ...walkSourceFiles(join(ROOT, 'web', 'src')),
];
for (const file of sources) {
  const raw = readFileSync(file, 'utf-8');
  for (const match of raw.matchAll(URL_RE)) {
    // отбрасываем пути без расширения (константы-базы вроде .../images)
    if (!/\.[a-z0-9]+$/i.test(match[1])) continue;
    const decoded = safeDecode(match[1]);
    if (decoded) paths.add(decoded);
  }
  for (const match of raw.matchAll(LOCAL_RE)) {
    const decoded = safeDecode(match[1]);
    if (decoded) paths.add(decoded);
  }
}
console.log(`Found ${paths.size} unique bucket assets`);

// ---------- download ----------

interface ManifestEntry {
  width?: number;
  height?: number;
}
const manifest: Record<string, ManifestEntry> = {};

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const path of [...paths].sort()) {
  const url = BUCKET_PREFIX + encodeURI(path);
  const localPath = join(PUBLIC_DIR, ...path.split('/').filter(Boolean));

  if (!force && existsSync(localPath) && statSync(localPath).size > 0) {
    skipped++;
  } else {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let buf = Buffer.from(await res.arrayBuffer());
      let resized = '';
      const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
      if (ext && ['webp', 'jpg', 'jpeg', 'png'].includes(ext)) {
        const meta = await sharp(buf).metadata();
        if ((meta.width ?? 0) > MAX_WIDTH) {
          // кодируем в ИСХОДНЫЙ формат — расширение файла остаётся честным
          const pipeline = sharp(buf).resize({ width: MAX_WIDTH });
          if (ext === 'webp') pipeline.webp({ quality: QUALITY });
          else if (ext === 'png') pipeline.png();
          else pipeline.jpeg({ quality: QUALITY });
          buf = Buffer.from(await pipeline.toBuffer());
          resized = ` [resized ${meta.width}→${MAX_WIDTH}px]`;
        }
      }
      mkdirSync(dirname(localPath), { recursive: true });
      // tmp + rename: обрыв записи не оставляет усечённый файл под финальным именем
      const tmpPath = localPath + '.tmp-download';
      writeFileSync(tmpPath, buf);
      renameSync(tmpPath, localPath);
      downloaded++;
      console.log(`  ✓ ${path} (${(buf.length / 1024).toFixed(0)} KB)${resized}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${path}: ${(err as Error).message}`);
      continue;
    }
  }

  const entry: ManifestEntry = {};
  if (!path.endsWith('.pdf') && !path.endsWith('.svg')) {
    try {
      const dim = await sharp(readFileSync(localPath)).metadata();
      entry.width = dim.width;
      entry.height = dim.height;
    } catch {
      console.warn(`  ? no dimensions for ${path}`);
    }
  }
  manifest[path] = entry;
}

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `\nDone: ${downloaded} downloaded, ${skipped} already present, ${failed} FAILED.` +
    `\nManifest: ${MANIFEST_PATH} (${Object.keys(manifest).length} entries)`
);
if (failed > 0) process.exit(1);
